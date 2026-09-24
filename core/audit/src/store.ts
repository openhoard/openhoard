import { auditEvents, queryRows, type Database, type Tx } from "@openhoard/core-db";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import {
  appendEvent,
  ChainVerifier,
  hashedText,
  type AuditEvent,
  type AuditInput,
} from "./chain.js";

/*
 * The audit store (T-701): each tenant's hash chain in audit.events (core/db).
 *
 * Appends are serialized per tenant with a transaction-scoped advisory lock, so two writers
 * can never both extend the same head. The lock lasts until the caller's transaction ends:
 * keep transactions that append short.
 */

/** What callers record; the store sets the tenant (from the transaction) and the time. */
export type AuditRecord = Omit<AuditInput, "tenantId" | "at">;

/** Advisory lock namespace for audit appends (the tenant fills the second key). */
const APPEND_LOCK = 7421;

/**
 * Appends one event to `tenantId`'s chain inside `tx`, which must be a withTenant() transaction
 * for that tenant (row-level security rejects anything else) at READ COMMITTED, the default. The
 * event commits or rolls back with the rest of the transaction, so an action and its audit
 * record stand or fall together.
 */
export async function appendAudit(
  tx: Tx,
  tenantId: string,
  record: AuditRecord,
  now: Date = new Date(),
): Promise<AuditEvent> {
  checkRecord(record, now);
  // A REPEATABLE READ or SERIALIZABLE snapshot is taken before the lock, so it would read a
  // stale head and collide with the writer that held the lock.
  const [level] = await queryRows<{ level: string }>(
    tx,
    sql`select current_setting('transaction_isolation') as level`,
  );
  if (level?.level !== "read committed") {
    throw new Error(`appendAudit needs a READ COMMITTED transaction, not ${String(level?.level)}`);
  }
  await tx.execute(sql`select pg_advisory_xact_lock(${APPEND_LOCK}, hashtext(${tenantId}))`);
  const [head] = await tx
    .select({ seq: auditEvents.seq, hash: auditEvents.hash })
    .from(auditEvents)
    .where(eq(auditEvents.tenantId, tenantId))
    .orderBy(desc(auditEvents.seq))
    .limit(1);
  const event = appendEvent(head, { ...record, tenantId, at: now.toISOString() });
  await tx.insert(auditEvents).values({
    tenantId,
    seq: event.seq,
    at: now,
    actor: event.actor,
    action: event.action,
    decision: event.decision,
    client: event.client ?? null,
    object: event.object ?? null,
    version: event.version ?? null,
    event: hashedText(event),
    prevHash: event.prevHash,
    hash: event.hash,
  });
  return event;
}

/** Round-trips text through UTF-8, as the database does; lone surrogates don't survive. */
const survives = (t: string) => Buffer.from(t, "utf8").toString("utf8") === t;

/**
 * Refuses what the database would store differently from the hashed JSON, which would make the
 * chain fail verification forever: text that is not well-formed Unicode (a lone surrogate turns
 * into U+FFFD) or holds NUL, and times Postgres reads back as another year.
 */
function checkRecord(record: AuditRecord, now: Date): void {
  const year = now.getUTCFullYear();
  if (!Number.isFinite(now.getTime()) || year < 1970 || year > 9999) {
    throw new RangeError("audit time out of range");
  }
  const fields = { ...record, ...record.detail };
  for (const [key, value] of Object.entries(fields)) {
    for (const text of [key, value]) {
      if (typeof text === "string" && (!survives(text) || text.includes("\0"))) {
        throw new TypeError(`audit field ${key} is not well-formed text`);
      }
    }
  }
}

export type AuditVerifyResult =
  | { ok: true; count: number; head: string }
  | { ok: false; count: number; seq: number; problem: string };

/**
 * Verifies `tenantId`'s whole chain (T-701, T-702): every hash, link and sequence number, and
 * that the query columns agree with the hashed event. Reads in pages from one snapshot, so it
 * runs in flat memory at any length. `count` is how many events checked out before a problem.
 *
 * It cannot see events removed from the end of the chain, or the newest events rewritten with
 * fresh hashes: nothing after them links back. Compare `head` with an anchor for that.
 */
export async function verifyAudit(
  db: Database,
  tenantId: string,
  options: { pageSize?: number } = {},
): Promise<AuditVerifyResult> {
  const pageSize = options.pageSize ?? 5_000;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new RangeError("invalid pageSize");
  return db.withTenant(
    tenantId,
    async (tx) => {
      const verifier = new ChainVerifier(tenantId);
      let after = 0;
      for (;;) {
        const rows = await tx
          .select()
          .from(auditEvents)
          .where(and(eq(auditEvents.tenantId, tenantId), gt(auditEvents.seq, after)))
          .orderBy(asc(auditEvents.seq))
          .limit(pageSize);
        for (const row of rows) {
          const fail = (problem: string) =>
            ({ ok: false, count: verifier.count, seq: row.seq, problem }) as const;
          let event: AuditEvent;
          try {
            event = { ...(JSON.parse(row.event) as Omit<AuditEvent, "hash">), hash: row.hash };
          } catch {
            return fail("event is not valid JSON");
          }
          if (hashedText(event) !== row.event) return fail("event text is not canonical");
          const mismatch = columnMismatch(row, event);
          if (mismatch) return fail(`column ${mismatch} disagrees with the event`);
          const result = verifier.push(event);
          // Report the row's position, which is what an operator looks up.
          if (!result.ok) return fail(result.problem);
        }
        if (rows.length < pageSize) break;
        after = rows.at(-1)?.seq ?? after;
        // PGlite runs queries without yielding; let the rest of the process run between pages.
        await new Promise((resolve) => setImmediate(resolve));
      }
      return { ok: true, count: verifier.count, head: verifier.head };
    },
    // One consistent snapshot for the whole walk, and no writes.
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** The first query column that says something other than the hashed event, if any. */
function columnMismatch(row: typeof auditEvents.$inferSelect, e: AuditEvent): string | undefined {
  const checks: [string, unknown, unknown][] = [
    ["tenant_id", row.tenantId, e.tenantId],
    ["seq", row.seq, e.seq],
    ["prev_hash", row.prevHash, e.prevHash],
    ["at", row.at.toISOString(), e.at],
    ["actor", row.actor, e.actor],
    ["action", row.action, e.action],
    ["decision", row.decision, e.decision],
    ["client", row.client, e.client ?? null],
    ["object", row.object, e.object ?? null],
    ["version", row.version, e.version ?? null],
  ];
  return checks.find(([, a, b]) => a !== b)?.[0];
}
