import { auditEvents, type Database } from "@openhoard/core-db";
import { and, asc, eq, gt, gte, lt, lte, type SQL } from "drizzle-orm";
import { canonicalJson, type AuditEvent } from "./chain.js";
import { chainEnd, chainPages } from "./pages.js";

/*
 * Audit export (T-703): one tenant's events, filtered, as NDJSON or CSV, streamed to a sink.
 *
 * NDJSON lines are the events exactly as hashed, plus their hash, so each line can be checked on
 * its own. CSV is for spreadsheets: it follows RFC 4180, and text that a spreadsheet would run as
 * a formula (starting with = + - @, a tab or a carriage return) gets a leading apostrophe, the
 * usual defence against CSV injection. Use NDJSON when the bytes must match the log.
 */

export interface AuditFilter {
  actor?: string;
  action?: string;
  decision?: "allow" | "deny";
  client?: string;
  object?: string;
  /** Events at or after this time. */
  from?: Date;
  /** Events before this time. */
  to?: Date;
}

export type ExportFormat = "ndjson" | "csv";

/** Receives the export in pieces; awaiting it applies backpressure. */
export type Sink = (chunk: string) => void | Promise<void>;

export const CSV_COLUMNS = [
  "seq",
  "at",
  "actor",
  "action",
  "decision",
  "client",
  "object",
  "version",
  "detail",
  "prev_hash",
  "hash",
] as const;

/**
 * Writes `tenantId`'s events that match `filter` to `sink`, oldest first, and returns how many
 * it wrote. It exports the chain as it was when the call started, read in pages, each in its own
 * short transaction (see pages.ts), and writes to the sink outside them, so a slow sink holds no
 * connection. The chain is append-only, so that is what one snapshot would give.
 */
export async function exportAudit(
  db: Database,
  tenantId: string,
  filter: AuditFilter,
  format: ExportFormat,
  sink: Sink,
  options: { pageSize?: number } = {},
): Promise<number> {
  const pageSize = options.pageSize ?? 5_000;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new RangeError("invalid pageSize");
  if (format !== "ndjson" && format !== "csv") throw new TypeError("unknown export format");
  for (const d of [filter.from, filter.to]) {
    if (d !== undefined && !Number.isFinite(d.getTime())) throw new RangeError("invalid date");
  }
  const conditions = filterConditions(filter);
  const end = await chainEnd(db, tenantId);
  if (format === "csv") await sink(`${CSV_COLUMNS.join(",")}\r\n`);
  let written = 0;
  const pages = chainPages(db, tenantId, end, pageSize, (tx, after) =>
    tx
      .select({ seq: auditEvents.seq, event: auditEvents.event, hash: auditEvents.hash })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, tenantId),
          gt(auditEvents.seq, after),
          lte(auditEvents.seq, end),
          ...conditions,
        ),
      )
      .orderBy(asc(auditEvents.seq))
      .limit(pageSize),
  );
  // Each page is read in its own transaction; the sink is awaited outside all of them.
  for await (const rows of pages) {
    for (const row of rows) {
      let parsed: object;
      try {
        parsed = JSON.parse(row.event) as object;
      } catch (e) {
        throw new Error(`audit event ${row.seq} is not valid JSON; run verifyAudit`, {
          cause: e,
        });
      }
      const event = { ...parsed, hash: row.hash } as AuditEvent;
      await sink(format === "ndjson" ? `${canonicalJson(event)}\n` : csvLine(event));
      written++;
    }
  }
  return written;
}

/** The filter as SQL conditions on the query columns (which verifyAudit keeps honest). */
export function filterConditions(filter: AuditFilter): SQL[] {
  const c: SQL[] = [];
  if (filter.actor !== undefined) c.push(eq(auditEvents.actor, filter.actor));
  if (filter.action !== undefined) c.push(eq(auditEvents.action, filter.action));
  if (filter.decision !== undefined) c.push(eq(auditEvents.decision, filter.decision));
  if (filter.client !== undefined) c.push(eq(auditEvents.client, filter.client));
  if (filter.object !== undefined) c.push(eq(auditEvents.object, filter.object));
  if (filter.from !== undefined) c.push(gte(auditEvents.at, filter.from));
  if (filter.to !== undefined) c.push(lt(auditEvents.at, filter.to));
  return c;
}

/** One CSV record for an event, CRLF-terminated. */
export function csvLine(e: AuditEvent): string {
  const cells = [
    String(e.seq),
    e.at,
    text(e.actor),
    text(e.action),
    e.decision,
    text(e.client),
    text(e.object),
    text(e.version),
    e.detail === undefined ? "" : text(canonicalJson(e.detail)),
    e.prevHash,
    e.hash,
  ];
  return `${cells.map(quote).join(",")}\r\n`;
}

/** Neutralizes text a spreadsheet would evaluate as a formula. */
function text(value: string | undefined): string {
  if (value === undefined) return "";
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** RFC 4180: quote a field holding a comma, quote or line break, doubling inner quotes. */
function quote(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}
