import type { Tx } from "@openhoard/core-db";
import type { Authorizer } from "@openhoard/core-policy";
import { ACTIVITY_PAGE, listActivity, type ActivityType } from "./activity.js";
import { requireSnapshot, viewObjects, type ObjectView, type ViewRequest } from "./visibility.js";

/*
 * `recent` (T-506): the files a person viewed, opened or edited lately, from their own activity
 * (T-205; T-307 will add what the M365 audit feed saw), for "what CSVs was I looking at
 * yesterday?". It reads no content: the answer is the gate's views of the files the events name.
 *
 * Only the caller's own events: the actor is always the request's principal, never a parameter,
 * so nobody lists someone else's reading. The events come from listActivity(), which is trusted
 * (it names files regardless of policy), so every file goes through viewObjects() before
 * anything about it is shown: a file the caller has since lost, or that was deleted, is left
 * out, and one they may now only discover shows as its title card. It records nothing (a
 * listing, like search).
 *
 * Runs in a snapshot (VIEW_TRANSACTION), like the other gated reads.
 */

/** What recentObjects() looks for; every field narrows. */
export interface RecentQuery {
  /** Which of the caller's actions count. Default view, open and edit. */
  types?: readonly Exclude<ActivityType, "share">[];
  /** From this time on (inclusive). */
  from?: Date;
  /** Before this time. */
  to?: Date;
  /** Only files whose current media type is one of these (as the caller's view shows it). */
  mimes?: readonly string[];
  /** Files to return, 1 to 100. Default 20. */
  limit?: number;
  /** Files to skip, for the next page: 0 to 999. */
  offset?: number;
}

/** One file from the caller's activity: the gate's view of it, and their latest action on it. */
export interface RecentItem {
  view: ObjectView;
  /** The caller's newest event on it in the range. */
  lastType: ActivityType;
  lastAt: Date;
  /** Their events on it in the range (repeat views within 15 minutes are already one). */
  events: number;
}

export interface RecentResult {
  items: RecentItem[];
  /** Files that matched (after the gate and the media-type filter), newest first. */
  total: number;
  /**
   * The range held more than ACTIVITY_PAGE events: only the newest that many were read, so
   * older files may be missing. Narrow the range to see them.
   */
  historyTruncated: boolean;
}

const TYPES: readonly Exclude<ActivityType, "share">[] = ["view", "open", "edit"];

export async function recentObjects(
  tx: Tx,
  tenantId: string,
  authz: Authorizer,
  request: ViewRequest,
  query: RecentQuery = {},
): Promise<RecentResult> {
  await requireSnapshot(tx, "recentObjects");
  const limit = query.limit ?? 20;
  const offset = query.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("limit must be 1 to 100");
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= ACTIVITY_PAGE) {
    throw new RangeError(`offset must be 0 to ${ACTIVITY_PAGE - 1}`);
  }
  const types = query.types ?? TYPES;
  if (!types.every((t) => TYPES.includes(t))) throw new RangeError("types: view, open or edit");
  for (const at of [query.from, query.to]) {
    if (at !== undefined && (!(at instanceof Date) || Number.isNaN(at.getTime()))) {
      throw new RangeError("from and to must be valid dates");
    }
  }
  const none: RecentResult = { items: [], total: 0, historyTruncated: false };
  if (types.length === 0 || query.mimes?.length === 0) return none;
  if (query.from && query.to && query.from.getTime() >= query.to.getTime()) return none;
  // The caller's own events, never anyone else's: the actor comes from the request.
  const events = await listActivity(tx, tenantId, {
    actor: `user:${request.principal.userId}`,
    types,
    ...(query.from ? { from: query.from } : {}),
    ...(query.to ? { to: query.to } : {}),
    limit: ACTIVITY_PAGE,
  });
  const byObject = new Map<string, { lastType: ActivityType; lastAt: Date; events: number }>();
  for (const e of events) {
    const seen = byObject.get(e.objectId);
    if (seen) seen.events++;
    else byObject.set(e.objectId, { lastType: e.type, lastAt: e.at, events: 1 });
  }
  if (byObject.size === 0) return none;
  // The gate decides what the caller may see of each, in the order asked (newest first).
  const views = await viewObjects(tx, tenantId, authz, request, [...byObject.keys()]);
  const mimes = query.mimes === undefined ? null : new Set(query.mimes);
  const matched = views.filter((v) => mimes === null || mimes.has(v.mime));
  return {
    items: matched.slice(offset, offset + limit).map((view) => {
      const e = byObject.get(view.id) as { lastType: ActivityType; lastAt: Date; events: number };
      return { view, lastType: e.lastType, lastAt: e.lastAt, events: e.events };
    }),
    total: matched.length,
    historyTruncated: events.length === ACTIVITY_PAGE,
  };
}
