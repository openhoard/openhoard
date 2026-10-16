import { randomBytes, randomUUID } from "node:crypto";
import type { Operator } from "opendal";
import { operatorFor, type StorageConfig } from "./store.js";

/*
 * Trying a place before blobs go there (the admin app's "Test"): a small object is written under
 * the tenant's own `.probe/` folder, read back, compared and removed. Each step says how it went,
 * and a failure is put in an admin's terms (no such bucket, keys refused, unreachable), with the
 * service's own error code where it gives one. Nothing of the service's answer beyond that code
 * is passed on: it can carry addresses and request ids, never anything an admin needs.
 */

export type ProbeStep = "check" | "write" | "read" | "delete";

/** Why a step failed, for an admin. */
export type ProbeProblem =
  /** The bucket or container isn't there (or not under that name in that account). */
  | "not-found"
  /** The keys were refused, or don't allow this. */
  | "denied"
  /**
   * Asking for a file that isn't there was refused rather than answered "not found": on S3, the
   * key may not list the bucket (s3:ListBucket), which OpenHoard needs to tell the two apart.
   */
  | "cant-list"
  /** The bucket is in another region than the one given. */
  | "wrong-region"
  /** Nothing answered: the address, the network or a firewall. */
  | "unreachable"
  /** The service asked to slow down. */
  | "busy"
  /** Read back, the bytes weren't those written. */
  | "mismatch"
  /** No answer in time. */
  | "timeout"
  | "failed";

export interface ProbeResult {
  ok: boolean;
  steps: { step: ProbeStep; ok: boolean; problem?: ProbeProblem; code?: string }[];
}

const CODE =
  /(?:S3|Azblob)Error \{ code: "([A-Za-z]{1,64})"|x-ms-error-code":\s*"([A-Za-z]{1,64})"|<Code>([A-Za-z]{1,64})<\/Code>/;
const STATUS = /status:\s*(\d{3})/;

/** A storage error, in an admin's terms, with the service's error code when it gave one. */
export function classifyStorageError(e: unknown): { problem: ProbeProblem; code?: string } {
  const message = e instanceof Error ? e.message : String(e);
  const m = CODE.exec(message);
  const code = m?.[1] ?? m?.[2] ?? m?.[3];
  const status = Number(STATUS.exec(message)?.[1] ?? 0);
  const withCode = (problem: ProbeProblem) =>
    code === undefined ? { problem } : { problem, code };
  if (
    status === 301 ||
    /PermanentRedirect|AuthorizationHeaderMalformed|IllegalLocationConstraint/.test(message)
  ) {
    return withCode("wrong-region");
  }
  if (message.startsWith("PermissionDenied") || status === 401 || status === 403) {
    return withCode("denied");
  }
  if (message.startsWith("NotFound") || status === 404) return withCode("not-found");
  if (message.startsWith("RateLimited") || status === 429 || status === 503)
    return withCode("busy");
  if (message.startsWith("Unexpected") && status === 0) return withCode("unreachable");
  return withCode("failed");
}

/** `work`, or a timeout after `ms` (OpenDAL can't be cancelled: it is left to finish). */
async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeout()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
class ProbeTimeout extends Error {}

/**
 * Writes, reads back and deletes a small object at `<tenant>/.probe/<uuid>` in the place
 * `config` names, each step within `timeoutMs` (default 15 s). Stops at the first failure,
 * removing what it wrote where it can.
 */
export async function probeStorage(
  config: StorageConfig,
  tenantId: string,
  options: { timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const steps: ProbeResult["steps"] = [];
  let op: Operator;
  try {
    op = operatorFor(config);
  } catch (e) {
    steps.push({ step: "write", ok: false, ...classifyStorageError(e) });
    return { ok: false, steps };
  }
  const path = `${tenantId}/.probe/${randomUUID()}`;
  // First, a file that isn't there: the store must answer "not found" (S3 answers 403 instead
  // to a key that can't list the bucket, and every upload would then fail).
  try {
    await within(timeoutMs, op.stat(`${tenantId}/.probe/${randomUUID()}-absent`));
    steps.push({ step: "check", ok: false, problem: "failed" });
    return { ok: false, steps };
  } catch (e) {
    if (e instanceof ProbeTimeout) {
      steps.push({ step: "check", ok: false, problem: "timeout" });
      return { ok: false, steps };
    }
    const found = classifyStorageError(e);
    if (found.problem !== "not-found" || /NoSuchBucket|ContainerNotFound/.test(found.code ?? "")) {
      steps.push({
        step: "check",
        ok: false,
        // A refusal only S3 gives a key that can't list; Azure answers "not found" to any key
        // that may read, and a key S3 doesn't know or a signature it rejects is just denied.
        ...(found.problem === "denied" &&
        config.kind === "s3" &&
        !/InvalidAccessKeyId|SignatureDoesNotMatch/.test(found.code ?? "")
          ? { ...found, problem: "cant-list" as const }
          : found),
      });
      return { ok: false, steps };
    }
    steps.push({ step: "check", ok: true });
  }
  const bytes = randomBytes(64);
  const fail = (step: ProbeStep, e: unknown): ProbeResult => {
    steps.push({
      step,
      ok: false,
      ...(e instanceof ProbeTimeout ? { problem: "timeout" as const } : classifyStorageError(e)),
    });
    return { ok: false, steps };
  };
  try {
    await within(timeoutMs, op.write(path, bytes));
    steps.push({ step: "write", ok: true });
  } catch (e) {
    return fail("write", e);
  }
  try {
    const back = await within(timeoutMs, op.read(path));
    if (!Buffer.from(back).equals(bytes)) {
      steps.push({ step: "read", ok: false, problem: "mismatch" });
      await op.delete(path).catch(() => {});
      return { ok: false, steps };
    }
    steps.push({ step: "read", ok: true });
  } catch (e) {
    await op.delete(path).catch(() => {});
    return fail("read", e);
  }
  try {
    await within(timeoutMs, op.delete(path));
    steps.push({ step: "delete", ok: true });
  } catch (e) {
    return fail("delete", e);
  }
  return { ok: true, steps };
}
