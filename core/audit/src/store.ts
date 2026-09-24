import { auditEvents, queryRows, sqlState, type Database, type Tx } from "@openhoard/core-db";
import { and, asc, desc, eq, gt, lte, sql } from "drizzle-orm";
import {
  appendEvent,
  ChainVerifier,
  hashedText,
  type AuditEvent,
  type AuditInput,
} from "./chain.js";
import { chainEnd, chainPages } from "./pages.js";

/*
 * The audit store (T-701): each tenant's hash chain in audit.events (core/db).
 *
 * Appends are serialized per tenant with a transaction-scoped advisory lock, so two writers
 * can never both extend the same head. The lock lasts until the caller's transaction ends:
 * keep transactions that append short, and append last.
 *
 * Advisory lock order. Every package takes its transaction-scoped advisory locks in one order,
 * so two transactions can never each hold one the other waits for:
 *
 *   source item (7423, core/catalog) → vocabulary value (7425, core/catalog)
 *     → object (7422, core/catalog) → audit append (7421, here)
 *
 * The audit lock comes last: append the audit record at the end of the transaction, after the
 * action it records, and take no other lock after it. (7420 is core/db's migration lock, held
 * alone.)
 *
 * Reads that are audited, sequencing. A read-only transaction can't append, so a read made in
 * a read-only snapshot (core/catalog's VIEW_TRANSACTION) records its audit event in a
 * transaction of its own, after the read has returned: never nested inside the read's
 * callback. Nesting would also hang on PGlite, which is one connection: the inner transaction
 * waits for the outer to finish, and the outer for the inner.
 *
 *   const rows = await db.withTenant(tenant, (tx) => viewObjects(tx, …), VIEW_TRANSACTION);
 *   await db.withTenant(tenant, (tx) => appendAudit(tx, tenant, { action: "search", … }));
 */

/** What callers record; the store sets the tenant (from the transaction) and the time. */
export type AuditRecord = Omit<AuditInput, "tenantId" | "at">;

/** Advisory lock namespace for audit appends (the tenant fills the second key). */
const APPEND_LOCK = 7421;

/** Thrown when two SERIALIZABLE appends raced; the caller runs its transaction again. */
class AppendConflict extends Error {
  /** serialization_failure, so core/db's isRetryable() says to retry. */
  readonly code = "40001";
  constructor(cause: unknown) {
    super("a concurrent transaction extended the audit chain first; retry the transaction", {
      cause,
    });
    this.name = "AppendConflict";
  }
}

/**
 * Appends one event to `tenantId`'s chain inside `tx`, which must be a withTenant() transaction
 * for that tenant (row-level security rejects anything else). The event commits or rolls back
 * with the rest of the transaction, so an action and its audit record stand or fall together.
 *
 * The transaction must be read-write, and READ COMMITTED (the default) or SERIALIZABLE:
 *
 * - READ COMMITTED: appends wait for each other on the lock and never fail for concurrency.
 * - SERIALIZABLE (e.g. core/catalog's applyPack): the snapshot is taken before the lock, so a
 *   concurrent append may already have extended the chain. The transaction then fails with
 *   SQLSTATE 40001 (serialization failure), as SERIALIZABLE transactions do; run it again
 *   (core/db isRetryable()). The chain never forks.
 * - REPEATABLE READ is refused: it has the same stale snapshot, but a race would surface as a
 *   unique violation that callers can't tell from a bug.
 */
export async function appendAudit(
  tx: Tx,
  tenantId: string,
  record: AuditRecord,
  now: Date = new Date(),
): Promise<AuditEvent> {
  checkRecord(record, now);
  const [settings] = await queryRows<{ level: string; readOnly: string }>(
    tx,
    sql`select current_setting('transaction_isolation') as level,
               current_setting('transaction_read_only') as "readOnly"`,
  );
  if (settings?.readOnly !== "off") {
    throw new Error(
      "appendAudit can't write in a read-only transaction: record the event in its own " +
        "transaction after the read (see core/audit's README)",
    );
  }
  const level = settings.level;
  if (level !== "read committed" && level !== "serializable") {
    throw new Error(
      `appendAudit needs a READ COMMITTED or SERIALIZABLE transaction, not ${String(level)}`,
    );
  }
  await tx.execute(sql`select pg_advisory_xact_lock(${APPEND_LOCK}, hashtext(${tenantId}))`);
  const [head] = await tx
    .select({ seq: auditEvents.seq, hash: auditEvents.hash })
    .from(auditEvents)
    .where(eq(auditEvents.tenantId, tenantId))
    .orderBy(desc(auditEvents.seq))
    .limit(1);
  const event = appendEvent(head, { ...record, tenantId, at: now.toISOString() });
  const row = {
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
  };
  try {
    await tx.insert(auditEvents).values(row);
  } catch (e) {
    // Under SERIALIZABLE, a concurrent append that committed after our snapshot took this seq.
    // PostgreSQL usually reports that as 40001 itself; when it reports the duplicate key
    // instead, say what it is.
    if (level === "serializable" && sqlState(e) === "23505") throw new AppendConflict(e);
    throw e;
  }
  return event;
}

/** Round-trips text through UTF-8, as the database does; lone surrogates don't survive. */
const survives = (t: string) => Buffer.from(t, "utf8").toString("utf8") === t;

const RECORD_KEYS = new Set([
  "actor",
  "action",
  "decision",
  "client",
  "object",
  "version",
  "detail",
]);
/** `kind:rest`, like every principal column in core/db. */
const PRINCIPAL = /^[a-z]+:.+$/s;
/** Lower-case words, dotted or hyphenated: `open`, `search`, `grant.add`, `pack:apply`. */
const ACTION = /^[a-z][a-z0-9._:-]{0,127}$/;

/**
 * Refuses a record that isn't one, and what the database would store differently from the
 * hashed JSON, which would make the chain fail verification forever: text that is not
 * well-formed Unicode (a lone surrogate turns into U+FFFD) or holds NUL, numbers JSON can't
 * hold, and times Postgres reads back as another year. Types are checked at run time too: a
 * record can come from JSON, whatever its static type says.
 */
function checkRecord(record: AuditRecord, now: Date): void {
  const year = now.getUTCFullYear();
  if (!Number.isFinite(now.getTime()) || year < 1970 || year > 9999) {
    throw new RangeError("audit time out of range");
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("an audit record is an object");
  }
  const text = (field: string, value: unknown, max = 2048): void => {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > max ||
      !survives(value) ||
      value.includes("\0")
    ) {
      throw new TypeError(`audit field ${field} is not well-formed text`);
    }
  };
  // Top-level fields and the detail separately, so a detail key can't stand in for one.
  for (const key of Object.keys(record)) {
    if (!RECORD_KEYS.has(key)) throw new TypeError(`audit field ${key} is not part of a record`);
  }
  text("actor", record.actor, 512);
  if (!PRINCIPAL.test(record.actor)) throw new TypeError("audit field actor is not a principal");
  text("action", record.action, 128);
  if (!ACTION.test(record.action)) throw new TypeError("audit field action is not an action name");
  if (record.decision !== "allow" && record.decision !== "deny") {
    throw new TypeError("audit field decision is not allow or deny");
  }
  for (const key of ["client", "object", "version"] as const) {
    if (record[key] !== undefined) text(key, record[key]);
  }
  const detail: unknown = record.detail;
  if (detail === undefined) return;
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) {
    throw new TypeError("audit field detail is not an object");
  }
  for (const [key, value] of Object.entries(detail)) {
    text(`detail key ${JSON.stringify(key)}`, key, 256);
    if (typeof value === "string") {
      if (value !== "") text(`detail.${key}`, value, 64 * 1024);
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError(`audit field detail.${key} is not finite`);
    } else if (typeof value !== "boolean") {
      throw new TypeError(`audit field detail.${key} is not a string, number or boolean`);
    }
  }
}

export type AuditVerifyResult =
  | { ok: true; count: number; head: string }
  | { ok: false; count: number; seq: number; problem: string };

/**
 * Verifies `tenantId`'s whole chain (T-701, T-702): every hash, link and sequence number, and
 * that the query columns agree with the hashed event. It checks the chain as it was when the
 * call started, reading it in pages, each in its own short transaction (see pages.ts), so it
 * runs in flat memory at any length and holds no transaction while it checks. `count` is how
 * many events checked out before a problem.
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
  const end = await chainEnd(db, tenantId);
  const verifier = new ChainVerifier(tenantId);
  const pages = chainPages(db, tenantId, end, pageSize, (tx, after) =>
    tx
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, tenantId),
          gt(auditEvents.seq, after),
          lte(auditEvents.seq, end),
        ),
      )
      .orderBy(asc(auditEvents.seq))
      .limit(pageSize),
  );
  for await (const rows of pages) {
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
  }
  return { ok: true, count: verifier.count, head: verifier.head };
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
