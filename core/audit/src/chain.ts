import { createHash } from "node:crypto";

/**
 * What callers record. The chain fields are added by {@link appendEvent}.
 *
 * Each tenant has its own chain (security review #6): `tenantId` is part of every hash, so an
 * event can't be moved between tenants and one tenant's export never includes another's rows.
 */
export interface AuditInput {
  tenantId: string;
  at: string;
  actor: string;
  action: string;
  decision: "allow" | "deny";
  client?: string;
  object?: string;
  version?: string;
  detail?: Record<string, string | number | boolean>;
}

export interface AuditEvent extends AuditInput {
  seq: number;
  prevHash: string;
  hash: string;
}

export const GENESIS_HASH = "0".repeat(64);

/** Deterministic JSON: object keys sorted recursively, so the hash never depends on key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The exact text an event's hash covers: its canonical JSON without the hash itself. */
export function hashedText(event: Omit<AuditEvent, "hash"> | AuditEvent): string {
  return canonicalJson({ ...event, hash: undefined });
}

function hashOf(event: Omit<AuditEvent, "hash">): string {
  return createHash("sha256").update(hashedText(event)).digest("hex");
}

/**
 * Appends an event after `prev` (or starts a chain when `prev` is undefined). Only the previous
 * event's `seq` and `hash` matter, so a store can pass just its chain head.
 */
export function appendEvent(
  prev: Pick<AuditEvent, "seq" | "hash"> | undefined,
  input: AuditInput,
): AuditEvent {
  const body = {
    ...input,
    seq: prev ? prev.seq + 1 : 1,
    prevHash: prev ? prev.hash : GENESIS_HASH,
  };
  return { ...body, hash: hashOf(body) };
}

export type VerifyResult = { ok: true } | { ok: false; seq: number; problem: string };

/**
 * Detects edited, deleted, inserted, reordered or cross-tenant events in one tenant's chain.
 *
 * LIMIT: a hash chain is only tamper-EVIDENT. Removing the newest events, or rewriting them with
 * fresh hashes, leaves a chain that still verifies, because nothing after them links back; a
 * database admin could even recompute every hash. The planned defence is periodic anchors of
 * the latest hash to WORM storage (S3 Object Lock / Azure immutable blobs), verified here.
 */
export function verifyChain(events: readonly AuditEvent[]): VerifyResult {
  const verifier = new ChainVerifier(events[0]?.tenantId ?? "");
  for (const e of events) {
    const result = verifier.push(e);
    if (!result.ok) return result;
  }
  return { ok: true };
}

/**
 * {@link verifyChain} one event at a time, for chains too long to hold in memory. Feed events in
 * seq order; the first failure is sticky.
 */
export class ChainVerifier {
  private prevHash = GENESIS_HASH;
  private expectedSeq = 1;
  private failure: VerifyResult | undefined;

  constructor(private readonly tenantId: string) {}

  /** Events accepted so far. */
  get count(): number {
    return this.expectedSeq - 1;
  }

  /** The hash of the last accepted event: what an anchor must match. */
  get head(): string {
    return this.prevHash;
  }

  push(e: AuditEvent): VerifyResult {
    if (this.failure) return this.failure;
    const fail = (problem: string): VerifyResult =>
      (this.failure = { ok: false, seq: e.seq, problem });
    if (e.tenantId !== this.tenantId) return fail("mixed tenants");
    if (e.seq !== this.expectedSeq) return fail(`expected seq ${this.expectedSeq}`);
    if (e.prevHash !== this.prevHash) return fail("prevHash mismatch");
    const { hash, ...body } = e;
    if (hashOf(body) !== hash) return fail("content altered");
    this.prevHash = hash;
    this.expectedSeq++;
    return { ok: true };
  }
}
