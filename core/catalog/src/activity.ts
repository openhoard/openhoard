import {
  ACTIVITY_TYPES,
  activityEvents,
  CLIENT_TRUSTS,
  isId,
  newId,
  queryRows,
  type Tx,
} from "@openhoard/core-db";
import type { AuthzClient, Exposure } from "@openhoard/core-policy";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";

/*
 * Activity (T-205): who viewed, opened, edited or shared which file, and through which client.
 * `recent` (T-506) answers from it, and the M365 audit feed (T-307) adds to it.
 *
 * Every catalog read that serves one file records a `view` or an `open` (read-surface.test.ts
 * checks each one does, and that listings and search don't); ingest records an `edit` when it
 * saves a new version by an author the source names. Gated reads run in a read-only snapshot
 * (VIEW_TRANSACTION), which can't write, so they record into the request's ActivityRecorder
 * and the caller writes what it holds once the snapshot ends:
 *
 *   const activity = new ActivityBuffer();
 *   const view = await db.withTenant(t, (tx) => viewObject(tx, t, authz, { ...req, activity }, id),
 *     VIEW_TRANSACTION);
 *   await db.withTenant(t, (tx) => writeActivity(tx, t, activity.take()));
 *
 * Never nest the write inside the snapshot (on PGlite, one connection, that waits forever), and
 * write even when the read returned nothing: the buffer is then empty.
 *
 * This is not the audit log (core/audit): no hash chain and no advisory lock, repeat views merge,
 * and old events can be pruned. Each insert does take FOR KEY SHARE on its object's row (the
 * foreign key), so it waits for an ingest holding that row; in a transaction that also appends
 * audit, write activity first (audit's lock is last, see core/audit). An AI read is a view or open made through a client that isn't
 * first-party; the event keeps the client's id and trust.
 */

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/** One event, as a read or a writer records it. */
export interface ActivityInput {
  type: ActivityType;
  /** The principal who acted: `user:usr_…`. */
  actor: string;
  objectId: string;
  /** The version opened or saved. */
  versionId?: string | null;
  /** The client the request came through. */
  client?: AuthzClient | null;
  /** Who observed it: `openhoard` (the default), a connector's source, a feed. */
  origin?: string;
  /** The event's id at its origin (imported events): a re-import adds nothing. */
  externalId?: string;
  /** When it happened (imported events); the transaction's time otherwise. */
  at?: Date;
}

/**
 * Content an AI client asked for and didn't get because of the file's exposure (T-604): a reader
 * whose grants allow the open, through a client whose trust label the exposure doesn't reach.
 * It isn't activity (nothing was read) but a policy decision, which the caller audits (the MCP
 * server does, as `object.open` denied): an admin can see why an assistant came back empty.
 * Cards shown as metadata only aren't recorded; they are what exposure is for.
 */
export interface WithheldContent {
  /** The principal who asked: `user:usr_…`. */
  actor: string;
  objectId: string;
  client: AuthzClient;
  /** The file's exposure, which the client's trust doesn't reach. */
  exposure: Exposure;
}

/** Where gated reads record activity (ViewRequest.activity), and content they withheld. */
export interface ActivityRecorder {
  record(event: ActivityInput): void;
  withhold(event: WithheldContent): void;
}

/** An ActivityRecorder that holds events until the caller writes them. */
export class ActivityBuffer implements ActivityRecorder {
  #events: ActivityInput[] = [];
  #withheld = new Map<string, WithheldContent>();

  record(event: ActivityInput): void {
    this.#events.push({ ...event });
  }

  /** Once per actor, file and client: a client retrying in a loop is one refusal to audit. */
  withhold(event: WithheldContent): void {
    const key = JSON.stringify([event.actor, event.objectId, event.client.id, event.client.trust]);
    if (!this.#withheld.has(key))
      this.#withheld.set(key, { ...event, client: { ...event.client } });
  }

  /** The events recorded since the last take(), oldest first; empties the buffer. */
  take(): ActivityInput[] {
    const out = this.#events;
    this.#events = [];
    return out;
  }

  /** Content withheld since the last takeWithheld(), oldest first; empties that part. */
  takeWithheld(): WithheldContent[] {
    const out = [...this.#withheld.values()];
    this.#withheld.clear();
    return out;
  }

  get size(): number {
    return this.#events.length;
  }
}

/**
 * A view or open repeating one by the same actor, of the same file and version, through the same
 * client, less than this long after it merges into it (and doesn't move its time): an hour spent
 * in a file is about four events, not 300.
 */
export const REPEAT_WINDOW_MS = 15 * 60 * 1000;

/** At most this many events per writeActivity() call and per listActivity() page. */
export const ACTIVITY_PAGE = 1000;

const PRINCIPAL = /^[a-z]+:.+$/s;
const ORIGIN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MERGED: readonly ActivityType[] = ["view", "open"];
const TRUSTS: readonly string[] = CLIENT_TRUSTS;
const MIN_AT = Date.UTC(1970, 0, 1);
const MAX_AT = Date.UTC(10000, 0, 1);

interface Checked {
  type: ActivityType;
  actor: string;
  objectId: string;
  versionId: string | null;
  clientId: string | null;
  clientTrust: string | null;
  origin: string;
  externalId: string | null;
  at: Date | null;
}

/** Text the database stores as given: no NUL, and it survives UTF-8 (no lone surrogates). */
const storable = (s: string) => !s.includes("\0") && Buffer.from(s, "utf8").toString("utf8") === s;

function check(e: ActivityInput): Checked {
  const bad = (field: string) => new RangeError(`activity: invalid ${field}`);
  if (!(ACTIVITY_TYPES as readonly string[]).includes(e.type)) throw bad("type");
  if (typeof e.actor !== "string" || !PRINCIPAL.test(e.actor) || !storable(e.actor)) {
    throw bad("actor");
  }
  if (typeof e.objectId !== "string" || !isId("object", e.objectId)) throw bad("objectId");
  const versionId = e.versionId ?? null;
  if (versionId !== null && (typeof versionId !== "string" || !isId("version", versionId))) {
    throw bad("versionId");
  }
  const client = e.client ?? null;
  if (client !== null) {
    const n = typeof client.id === "string" ? [...client.id].length : 0;
    if (n < 1 || n > 256 || !storable(client.id)) throw bad("client.id");
    if (!TRUSTS.includes(client.trust)) throw bad("client.trust");
  }
  const origin = e.origin ?? "openhoard";
  if (typeof origin !== "string" || !ORIGIN.test(origin)) throw bad("origin");
  const externalId = e.externalId ?? null;
  if (externalId !== null) {
    const n = typeof externalId === "string" ? [...externalId].length : 0;
    if (n < 1 || n > 512 || !storable(externalId)) throw bad("externalId");
  }
  const at = e.at ?? null;
  if (at !== null) {
    const t = at instanceof Date ? at.getTime() : NaN;
    if (!(t >= MIN_AT && t < MAX_AT)) throw bad("at");
  }
  return {
    type: e.type,
    actor: e.actor,
    objectId: e.objectId,
    versionId,
    clientId: client?.id ?? null,
    clientTrust: client?.trust ?? null,
    origin,
    externalId,
    at,
  };
}

/**
 * Writes activity events, in a read-write transaction of the tenant; returns how many were added.
 * Every event is checked before any is written (a RangeError names the bad field).
 *
 * - A view or open repeating an earlier one (same actor, type, file, version, client and origin)
 *   within REPEAT_WINDOW_MS merges into it and adds nothing. Two concurrent requests can both
 *   add one; that costs a duplicate, never an error.
 * - An event with an externalId that its origin already delivered adds nothing.
 * - A file or version that is gone (purged since the read) fails the foreign key: the error is
 *   the caller's to swallow or retry, as it wishes; nothing of the batch is kept.
 */
export async function writeActivity(
  tx: Tx,
  tenantId: string,
  events: readonly ActivityInput[],
  options: { repeatWindowMs?: number } = {},
): Promise<number> {
  if (events.length > ACTIVITY_PAGE) {
    throw new RangeError(`activity: at most ${ACTIVITY_PAGE} events per call`);
  }
  const window = options.repeatWindowMs ?? REPEAT_WINDOW_MS;
  if (!Number.isSafeInteger(window) || window < 0) throw new RangeError("activity: invalid window");
  const checked = events.map(check);
  let added = 0;
  for (const e of checked) {
    // Whole milliseconds, as the table requires (a Date has no more).
    const at =
      e.at === null
        ? sql`date_trunc('milliseconds', now())`
        : sql`${e.at.toISOString()}::timestamptz`;
    const merge =
      MERGED.includes(e.type) && e.externalId === null
        ? sql`and not exists (
            select 1 from activity_events p
             where p.tenant_id = ${tenantId} and p.actor = ${e.actor} and p.type = ${e.type}
               and p.object_id = ${e.objectId}
               and p.version_id is not distinct from ${e.versionId}
               and p.client_id is not distinct from ${e.clientId}
               and p.origin = ${e.origin}
               and p.at > ${at} - make_interval(secs => ${window / 1000})
               and p.at <= ${at})`
        : sql``;
    const rows = await queryRows<{ id: string }>(
      tx,
      sql`insert into activity_events
            (tenant_id, id, at, actor, type, object_id, version_id, client_id, client_trust,
             origin, external_id)
          select ${tenantId}, ${newId("activity")}, ${at}, ${e.actor}, ${e.type}, ${e.objectId},
                 ${e.versionId}, ${e.clientId}, ${e.clientTrust}, ${e.origin}, ${e.externalId}
           where true ${merge}
          on conflict (tenant_id, origin, external_id) where external_id is not null do nothing
          returning id`,
    );
    added += rows.length;
  }
  return added;
}

/** What listActivity() filters on; every field narrows. */
export interface ActivityFilter {
  actor?: string;
  types?: readonly ActivityType[];
  objectId?: string;
  /** From this time on (inclusive). */
  from?: Date;
  /** Before this time. */
  to?: Date;
  /** Through these kinds of client only: `["local", "commercial", "consumer"]` is AI reads. */
  clientTrusts?: readonly AuthzClient["trust"][];
  /** The page after this event (the last one of the previous page), for paging. */
  after?: { at: Date; id: string };
  /** At most this many, newest first (default and maximum ACTIVITY_PAGE). */
  limit?: number;
}

/** An event as stored. */
export interface ActivityEvent {
  id: string;
  at: Date;
  actor: string;
  type: ActivityType;
  objectId: string;
  versionId: string | null;
  client: AuthzClient | null;
  origin: string;
  externalId: string | null;
}

/**
 * A tenant's activity, newest first. TRUSTED: it reads without a caller's policy, so the events
 * name files the caller may not know about. `recent` (T-506) passes the object ids through the
 * gate (viewObjects) before showing anything, and a person may list their own activity only.
 */
export async function listActivity(
  tx: Tx,
  tenantId: string,
  filter: ActivityFilter = {},
): Promise<ActivityEvent[]> {
  const limit = filter.limit ?? ACTIVITY_PAGE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ACTIVITY_PAGE) {
    throw new RangeError(`activity: limit is 1 to ${ACTIVITY_PAGE}`);
  }
  const t = activityEvents;
  const where = [eq(t.tenantId, tenantId)];
  if (filter.actor !== undefined) where.push(eq(t.actor, filter.actor));
  if (filter.types !== undefined) {
    if (filter.types.length === 0) return [];
    where.push(inArray(t.type, [...filter.types]));
  }
  if (filter.objectId !== undefined) where.push(eq(t.objectId, filter.objectId));
  if (filter.from !== undefined) where.push(gte(t.at, filter.from));
  if (filter.to !== undefined) where.push(lt(t.at, filter.to));
  if (filter.clientTrusts !== undefined) {
    if (filter.clientTrusts.length === 0) return [];
    where.push(inArray(t.clientTrust, [...filter.clientTrusts]));
  }
  if (filter.after !== undefined) {
    // Newest first: older than the last event seen, or as old with a smaller id.
    const { at, id } = filter.after;
    if (!(at instanceof Date) || Number.isNaN(at.getTime()) || !isId("activity", id)) {
      throw new RangeError("activity: invalid after");
    }
    where.push(sql`(${t.at}, ${t.id}) < (${at.toISOString()}::timestamptz, ${id})`);
  }
  const rows = await tx
    .select()
    .from(t)
    .where(and(...where))
    .orderBy(desc(t.at), desc(t.id))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    actor: r.actor,
    type: r.type as ActivityType,
    objectId: r.objectId,
    versionId: r.versionId,
    client:
      r.clientId === null ? null : { id: r.clientId, trust: r.clientTrust as AuthzClient["trust"] },
    origin: r.origin,
    externalId: r.externalId,
  }));
}

/**
 * Removes up to `limit` of a tenant's events from before `before` (retention), oldest first;
 * returns how many went. Call it again until it returns less than the limit.
 */
export async function pruneActivity(
  tx: Tx,
  tenantId: string,
  before: Date,
  limit = 10_000,
): Promise<number> {
  if (!(before instanceof Date) || Number.isNaN(before.getTime())) {
    throw new RangeError("activity: invalid time");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) {
    throw new RangeError("activity: limit is 1 to 100000");
  }
  const rows = await queryRows<{ id: string }>(
    tx,
    sql`delete from activity_events
         where tenant_id = ${tenantId} and id in (
           select id from activity_events
            where tenant_id = ${tenantId} and at < ${before.toISOString()}::timestamptz
            order by at limit ${limit})
        returning id`,
  );
  return rows.length;
}
