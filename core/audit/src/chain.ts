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

function hashOf(event: Omit<AuditEvent, "hash">): string {
  return createHash("sha256").update(canonicalJson(event)).digest("hex");
}

/** Appends an event after `prev` (or starts a chain when `prev` is undefined). */
export function appendEvent(prev: AuditEvent | undefined, input: AuditInput): AuditEvent {
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
 * LIMIT: a hash chain is only tamper-EVIDENT against someone who cannot rewrite the whole chain.
 * A database admin could recompute every hash. The planned defence (T-701) is periodic anchors
 * of the latest hash to WORM storage (S3 Object Lock / Azure immutable blobs), verified here.
 */
export function verifyChain(events: readonly AuditEvent[]): VerifyResult {
  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;
  const tenantId = events[0]?.tenantId;
  for (const e of events) {
    if (e.tenantId !== tenantId) return { ok: false, seq: e.seq, problem: "mixed tenants" };
    if (e.seq !== expectedSeq)
      return { ok: false, seq: e.seq, problem: `expected seq ${expectedSeq}` };
    if (e.prevHash !== prevHash) return { ok: false, seq: e.seq, problem: "prevHash mismatch" };
    const { hash, ...body } = e;
    if (hashOf(body) !== hash) return { ok: false, seq: e.seq, problem: "content altered" };
    prevHash = hash;
    expectedSeq++;
  }
  return { ok: true };
}
