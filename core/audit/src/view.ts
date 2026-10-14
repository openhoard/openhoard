import { auditEvents, type Database } from "@openhoard/core-db";
import { and, desc, eq, lt } from "drizzle-orm";
import type { AuditEvent } from "./chain.js";
import {
  exportAudit,
  filterConditions,
  type AuditFilter,
  type ExportFormat,
  type Sink,
} from "./export.js";
import { appendAudit } from "./store.js";

/*
 * Reading the log for people (T-905): a page of events, newest first, and an export that records
 * itself. The admin CLI and the admin API both go through these, so an export is audited the same
 * way whichever door it left by.
 */

/** The most events one page holds. */
export const MAX_AUDIT_PAGE = 200;

/** A page of events, newest first, and the seq to pass as `before` for the next (older) page. */
export interface AuditPage {
  events: AuditEvent[];
  /** Null when there are no older events matching. */
  next: number | null;
}

/**
 * `tenantId`'s events matching `filter`, newest first: at most `limit` (1 to
 * {@link MAX_AUDIT_PAGE}, default 50), with seq below `before` when given. One short read-only
 * transaction. Events are as hashed, with their hash; an event whose stored JSON doesn't parse
 * is said to be broken (run verifyAudit()), never skipped silently.
 */
export async function listAudit(
  db: Database,
  tenantId: string,
  filter: AuditFilter,
  options: { before?: number; limit?: number } = {},
): Promise<AuditPage> {
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_AUDIT_PAGE) {
    throw new RangeError(`limit must be 1 to ${MAX_AUDIT_PAGE}`);
  }
  const { before } = options;
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) {
    throw new RangeError("before must be a sequence number");
  }
  for (const d of [filter.from, filter.to]) {
    if (d !== undefined && !Number.isFinite(d.getTime())) throw new RangeError("invalid date");
  }
  const rows = await db.withTenant(
    tenantId,
    (tx) =>
      tx
        .select({ seq: auditEvents.seq, event: auditEvents.event, hash: auditEvents.hash })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.tenantId, tenantId),
            ...(before === undefined ? [] : [lt(auditEvents.seq, before)]),
            ...filterConditions(filter),
          ),
        )
        .orderBy(desc(auditEvents.seq))
        // One more than asked: whether an older page exists.
        .limit(limit + 1),
    { accessMode: "read only" },
  );
  const page = rows.slice(0, limit);
  const events = page.map((row) => {
    try {
      return { ...(JSON.parse(row.event) as object), hash: row.hash } as AuditEvent;
    } catch (e) {
      throw new Error(`audit event ${row.seq} is not valid JSON; run verifyAudit`, { cause: e });
    }
  });
  return { events, next: rows.length > limit ? (page.at(-1)?.seq ?? null) : null };
}

/** Who took an export, and what they asked for, for its record. */
export interface ExportTaker {
  /** `user:usr_…` through the admin API, `system:admin-cli` from the command line. */
  actor: string;
  /** The client it went through, when any (the admin web app). */
  client?: string;
  /** The filter as asked, for the record: names to text values (dates as ISO 8601). */
  asked: Record<string, string>;
}

/** Thrown by auditedExport() when the export failed; `events` went out before it did. */
export class ExportFailed extends Error {
  constructor(
    readonly events: number,
    /** Whether the failure could be recorded too. */
    readonly recorded: boolean,
    options: { cause: unknown },
  ) {
    super(`the audit export failed after ${events} events`, options);
    this.name = "ExportFailed";
  }
}

/**
 * Exports `tenantId`'s events matching `filter` to `sink` (exportAudit()), then records it
 * (`audit.export`: format, how many events, what was asked) after the export, so the record
 * isn't in it: the next export shows this one was taken. If the export fails part way (the
 * reader went away), what got out is recorded as taken, `incomplete`, and ExportFailed is thrown.
 * Returns how many events went out. If the record itself can't be written after a full export,
 * that error is thrown: the caller decides what to do with what it already handed out.
 */
export async function auditedExport(
  db: Database,
  tenantId: string,
  taker: ExportTaker,
  filter: AuditFilter,
  format: ExportFormat,
  sink: Sink,
  /** Runs after the last event, before the record (a buffered writer's last flush, a close): its failure is the export's. */
  finish?: () => Promise<void> | void,
): Promise<number> {
  let events = 0;
  let header = format === "csv";
  const record = (incomplete: boolean) =>
    db.withTenant(tenantId, (tx) =>
      appendAudit(tx, tenantId, {
        actor: taker.actor,
        action: "audit.export",
        decision: "allow",
        ...(taker.client === undefined ? {} : { client: taker.client }),
        detail: { format, events, ...(incomplete ? { incomplete: true } : {}), ...taker.asked },
      }),
    );
  try {
    await exportAudit(db, tenantId, filter, format, async (chunk) => {
      // (A CSV's first line is its header, not an event.)
      if (header) header = false;
      else events++;
      await sink(chunk);
    });
    await finish?.();
  } catch (e) {
    let recorded = true;
    try {
      await record(true);
    } catch {
      recorded = false;
    }
    throw new ExportFailed(events, recorded, { cause: e });
  }
  await record(false);
  return events;
}

/** The filter's fields, as text from a person: a command line's flags, a URL's query. */
export interface AuditFilterText {
  actor?: string | undefined;
  action?: string | undefined;
  actionPrefix?: string | undefined;
  decision?: string | undefined;
  client?: string | undefined;
  object?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/** A filter field that isn't one the log can be asked by: `field` says which, `message` why. */
export class AuditFilterError extends Error {
  constructor(
    readonly field: keyof AuditFilterText,
    message: string,
  ) {
    super(message);
    this.name = "AuditFilterError";
  }
}

const TEXT_FIELDS = ["actor", "action", "actionPrefix", "client", "object"] as const;

/** Text with no lone surrogates: what the log can hold (store.ts). */
const wellFormed = (text: string) =>
  !/[\ud800-\udfff]/u.test(text.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""));

/**
 * A date (`2026-10-01`, UTC) or a time with its zone (`2026-10-01T09:30:00Z`), refused when it
 * isn't one: a day the month doesn't have, or hour 24, is never read as a later one.
 */
export function auditTime(value: string): Date | null {
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
  const m = iso.exec(value);
  if (!m) return null;
  const at = new Date(value);
  const [, y, mo, d, h = "00"] = m;
  const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  const real =
    Number.isFinite(at.getTime()) &&
    day.getUTCMonth() === Number(mo) - 1 &&
    day.getUTCDate() === Number(d) &&
    Number(h) < 24 &&
    at.getUTCFullYear() >= 1970 &&
    at.getUTCFullYear() <= 9999;
  return real ? at : null;
}

/**
 * The filter a person asked for, checked, and what they asked as text for an export's record
 * (dates as ISO 8601). Throws AuditFilterError for a value the log can't hold (empty, over 1,024
 * characters, a NUL or a lone surrogate), a decision other than allow or deny, a time that isn't
 * one, or `from` not before `to`. The admin CLI and the admin API both read filters through this.
 */
export function parseAuditFilter(text: AuditFilterText): {
  filter: AuditFilter;
  asked: Record<string, string>;
} {
  const filter: AuditFilter = {};
  const asked: Record<string, string> = {};
  for (const key of TEXT_FIELDS) {
    const value = text[key];
    if (value === undefined) continue;
    if (value === "" || value.length > 1024 || !wellFormed(value) || value.includes("\0")) {
      throw new AuditFilterError(key, `${key} is not a value the audit log holds`);
    }
    filter[key] = value;
    asked[key] = value;
  }
  const { decision } = text;
  if (decision !== undefined) {
    if (decision !== "allow" && decision !== "deny") {
      throw new AuditFilterError("decision", "decision is allow or deny");
    }
    filter.decision = decision;
    asked.decision = decision;
  }
  for (const key of ["from", "to"] as const) {
    const value = text[key];
    if (value === undefined) continue;
    const at = auditTime(value);
    if (at === null) {
      throw new AuditFilterError(
        key,
        `${key} is a date (2026-10-01, UTC) or a time with its zone (2026-10-01T09:30:00Z)`,
      );
    }
    filter[key] = at;
    asked[key] = at.toISOString();
  }
  if (filter.from && filter.to && filter.from >= filter.to) {
    throw new AuditFilterError("from", "from must be before to");
  }
  return { filter, asked };
}
