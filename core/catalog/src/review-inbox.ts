import { appendAudit } from "@openhoard/core-audit";
import { facetValues, isId, tagOf, tagReviews, type Tx } from "@openhoard/core-db";
import { isAdmin, resolvePrincipal } from "@openhoard/core-identity";
import type { Authorizer, AuthzClient } from "@openhoard/core-policy";
import { and, asc, eq, inArray, isNull, min } from "drizzle-orm";
import { lockObject, lockTagValue } from "./locks.js";
import {
  approveReview,
  decisionReach,
  mergeReview,
  rejectReview,
  type DecisionKind,
  type ReviewReason,
  type TagSource,
} from "./tagging.js";
import { MAX_OBJECT_IDS, requireSnapshot, viewObjects, type ViewRequest } from "./visibility.js";

/*
 * The review inbox as a person sees it (T-1403): the open items they may decide, and their
 * decisions, checked and audited. tagging.ts holds what a decision does; this is who may make
 * one, which tagging.ts leaves to its caller.
 *
 * A person may decide an item when they may tag its file: they read it and authorize() allows
 * them `tag` on it, both asked of viewObjects() like any listing. A tenant admin as such may
 * not: an admin reads what their grants let them read, like anyone. An item on a file the
 * person can't read is, to them, not there; `refused` is said only of a file they can read.
 *
 * Some decisions reach further than tagging a file does (tagging.ts decisionReach()), and
 * take a tenant admin who may also tag the file:
 *
 * - approving or rejecting a value the vocabulary doesn't have: it approves the value for every
 *   file, or closes every open item proposing it, on files this person may not see;
 * - taking a restriction off the file: rejecting a value that sets a visibility or exposure
 *   level (it tightens the file while it waits), merging it into a value that doesn't set its
 *   levels as tightly, or approving or merging in place of a tighter value of a single-value
 *   facet. A person tagging the file can do none of these.
 *
 * Merging a new value into an approved one is not such a decision: anyone who may tag the file
 * may. An item on a file no admin may tag waits until one may.
 *
 * Checking and deciding are two transactions, as for the `tag` tool: reviewInbox() and
 * reviewItemFor() read one snapshot (VIEW_TRANSACTION); decideReview() writes (READ
 * COMMITTED) for a person its caller has just asked reviewItemFor() about. It checks again
 * what it can there: that the person is still current, and how far the decision reaches, under
 * the decision's own locks. A write grant taken away in the moment between is not seen.
 */

const FIRST_PARTY: AuthzClient = { id: "openhoard-web", trust: "first-party" };
export const REVIEW_INBOX_MAX = 500;

export type ReviewAccessErrorCode =
  /** No such current user. */
  | "unknown-reviewer"
  /** No such open item, or one on a file the reviewer may not read. */
  | "not-found"
  /** The reviewer reads the file but may not tag it. */
  | "refused"
  /** The reviewer may tag the file, but this decision reaches further: a tenant admin's. */
  | "not-admin";

export class ReviewAccessError extends Error {
  constructor(
    readonly code: ReviewAccessErrorCode,
    message: string,
    /** The item's file, for the audit record only: never shown to the reviewer. */
    readonly objectId?: string,
  ) {
    super(message);
    this.name = "ReviewAccessError";
  }
}

export interface Reviewer {
  userId: string;
  /** The client the reviewer works through. Default: OpenHoard's own app. */
  client?: AuthzClient;
  /** The tenant's admin group (the server's configuration), for decisions that take an admin. */
  adminGroupId?: string | undefined;
}

/** An open item, as shown to someone who may decide it. */
export interface ReviewItem {
  id: string;
  objectId: string;
  /** The file's title, as the reviewer's card of it shows. */
  title: string;
  /** `facet:value`; for a `primary` item, the tag proposed as the file's home. */
  tag: string;
  reason: ReviewReason | "primary";
  source: TagSource;
  appliedBy: string | null;
  confidence: number;
  createdAt: Date;
}

/** An item in a listing, with what can be told of who may decide it without asking each. */
export interface ListedReviewItem extends ReviewItem {
  /**
   * Some decision on it takes a tenant admin, as far as its value says: the value isn't
   * approved vocabulary (approve, reject), or sets a level (reject). A replacement that loosens
   * isn't known here; reviewItemFor() says, for the decision meant.
   */
  admin: boolean;
}

export interface ReviewInbox {
  items: ListedReviewItem[];
  /** There are more: decide some of these and ask again. */
  more: boolean;
  /**
   * So many files have open items that not all were looked at: nothing the reviewer decides
   * brings the rest into view.
   */
  capped: boolean;
}

/** Files with open items looked at for one listing: this many pages of MAX_OBJECT_IDS. */
const SCAN_PAGES = 10;

type Row = typeof tagReviews.$inferSelect;

const shown = (row: Row, title: string): ReviewItem => ({
  id: row.id,
  objectId: row.objectId,
  title,
  tag: tagOf(row.facet, row.value),
  reason: row.reason as ReviewItem["reason"],
  source: row.source,
  appliedBy: row.appliedBy,
  confidence: row.confidence,
  createdAt: row.createdAt,
});

/** The reviewer, as the gate takes them, and whether they are an admin now. */
async function reviewerOf(
  tx: Tx,
  tenantId: string,
  reviewer: Reviewer,
): Promise<{ request: ViewRequest; admin: boolean }> {
  const principal =
    typeof reviewer.userId === "string" && isId("user", reviewer.userId)
      ? await resolvePrincipal(tx, tenantId, reviewer.userId)
      : null;
  if (!principal) throw new ReviewAccessError("unknown-reviewer", "no such user");
  const admin = await isAdmin(tx, tenantId, reviewer.userId, {
    ...(reviewer.adminGroupId === undefined ? {} : { adminGroupId: reviewer.adminGroupId }),
  });
  return { request: { principal, client: reviewer.client ?? FIRST_PARTY }, admin };
}

/**
 * The open items on files the reviewer may tag, oldest first, `limit` at most (100 by default,
 * {@link REVIEW_INBOX_MAX} at most). Files are looked at in the order of their oldest open
 * item, {@link MAX_OBJECT_IDS} at a time, until the limit is passed; with more files than one
 * such page the order is the oldest first among what was looked at.
 */
export async function reviewInbox(
  tx: Tx,
  tenantId: string,
  authz: Authorizer,
  reviewer: Reviewer,
  limit = 100,
  /** How many files a page looks at, and how many pages: smaller in tests. */
  scan: { files: number; pages: number } = { files: MAX_OBJECT_IDS, pages: SCAN_PAGES },
): Promise<ReviewInbox> {
  await requireSnapshot(tx, "reviewInbox");
  if (!Number.isInteger(limit) || limit < 1 || limit > REVIEW_INBOX_MAX) {
    throw new RangeError(`limit must be 1 to ${REVIEW_INBOX_MAX}`);
  }
  const { request } = await reviewerOf(tx, tenantId, reviewer);
  const open = and(eq(tagReviews.tenantId, tenantId), isNull(tagReviews.resolvedAt));
  const found: (Row & { title: string; admin: boolean })[] = [];
  let capped = false;
  for (let page = 0; found.length <= limit; page++) {
    if (page === scan.pages) {
      capped = true;
      break;
    }
    // One snapshot: the pages don't shift under the offset.
    const waiting = await tx
      .select({ objectId: tagReviews.objectId })
      .from(tagReviews)
      .where(open)
      .groupBy(tagReviews.objectId)
      .orderBy(asc(min(tagReviews.createdAt)), asc(tagReviews.objectId))
      .limit(scan.files + 1)
      .offset(page * scan.files);
    if (waiting.length === 0) break;
    const ids = waiting.slice(0, scan.files).map((w) => w.objectId);
    const views = await viewObjects(tx, tenantId, authz, request, ids, { tag: true });
    const titles = new Map(
      views.flatMap((v) => (v.shape === "card" && v.readable ? [[v.id, v.title] as const] : [])),
    );
    if (titles.size > 0) {
      const rows = await tx
        .select({
          item: tagReviews,
          approved: facetValues.approved,
          visibility: facetValues.visibility,
          exposure: facetValues.exposure,
        })
        .from(tagReviews)
        .innerJoin(
          facetValues,
          and(
            eq(facetValues.tenantId, tagReviews.tenantId),
            eq(facetValues.facet, tagReviews.facet),
            eq(facetValues.value, tagReviews.value),
          ),
        )
        .where(and(open, inArray(tagReviews.objectId, [...titles.keys()])))
        .orderBy(asc(tagReviews.createdAt), asc(tagReviews.id))
        .limit(limit + 1);
      for (const r of rows) {
        found.push({
          ...r.item,
          title: titles.get(r.item.objectId) as string,
          admin:
            r.item.reason !== "primary" &&
            (!r.approved || r.visibility !== null || r.exposure !== null),
        });
      }
    }
    if (waiting.length <= scan.files) break;
  }
  found.sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return {
    items: found.slice(0, limit).map((row) => ({ ...shown(row, row.title), admin: row.admin })),
    more: found.length > limit,
    capped,
  };
}

/**
 * The open item, if the reviewer may decide it, and make the decision `how` when one is given.
 * Throws ReviewAccessError: `not-found` for an item that isn't open or whose file the reviewer
 * may not read; `refused` when they read the file but may not tag it; `not-admin` when they
 * may tag it, the decision reaches further than the file, and they aren't a tenant admin.
 */
export async function reviewItemFor(
  tx: Tx,
  tenantId: string,
  authz: Authorizer,
  reviewer: Reviewer,
  reviewId: string,
  how?: DecisionKind,
): Promise<ReviewItem> {
  await requireSnapshot(tx, "reviewItemFor");
  const missing = (objectId?: string) =>
    new ReviewAccessError("not-found", "no such open review item", objectId);
  const { request, admin } = await reviewerOf(tx, tenantId, reviewer);
  if (typeof reviewId !== "string" || !isId("review", reviewId)) throw missing();
  // Which file to ask the gate about: nothing of the item is told before it answers.
  const [row] = await tx
    .select()
    .from(tagReviews)
    .where(and(eq(tagReviews.tenantId, tenantId), eq(tagReviews.id, reviewId)));
  if (!row || row.resolvedAt !== null) throw missing();
  const [read] = await viewObjects(tx, tenantId, authz, request, [row.objectId]);
  if (read?.shape !== "card" || !read.readable) throw missing(row.objectId);
  const [mine] = await viewObjects(tx, tenantId, authz, request, [row.objectId], { tag: true });
  if (mine?.shape !== "card") {
    throw new ReviewAccessError("refused", "the reviewer may not tag this file", row.objectId);
  }
  if (how !== undefined && !admin) {
    const reach = await decisionReach(tx, tenantId, reviewId, how);
    if (reach !== "file" && reach !== null) throw notAdmin(reach, row.objectId);
  }
  return shown(row, mine.title);
}

const notAdmin = (reach: "vocabulary" | "loosens", objectId: string) =>
  new ReviewAccessError(
    "not-admin",
    reach === "vocabulary"
      ? "the value isn't in the vocabulary yet: approving or rejecting it is a tenant admin's decision (anyone who may tag the file may merge it into an approved value)"
      : "this takes a restriction off the file, which is a tenant admin's decision",
    objectId,
  );

export type ReviewDecision =
  | { decision: "approve"; replace?: boolean }
  | { decision: "reject" }
  | { decision: "merge"; into: string; replace?: boolean };

const OUTCOME = { approve: "approved", reject: "rejected", merge: "merged" } as const;

export interface DecideInput {
  reviewId: string;
  /** Who decides: a person the caller has just asked reviewItemFor() about. */
  userId: string;
  adminGroupId?: string | undefined;
  /** Who the audit record names as acting, when not that person (`system:admin-cli`). */
  actor?: string;
}

export interface Decided {
  objectId: string;
  /** The item's tag. */
  tag: string;
  /** The tag the file now carries for it: none after a reject, the other value after a merge. */
  applied: string | null;
  /** Tags of a single-value facet taken off the file. */
  replaced: string[];
  /** How many other open items closed with this one (a rejected new value's). */
  alsoClosed: number;
}

/**
 * Decides an open item for a person, and appends the audit record (`tag.review`) in the same
 * transaction, last. Throws TagError as approveReview(), rejectReview() and mergeReview() do,
 * and ReviewAccessError when the person is no longer current (`unknown-reviewer`) or the
 * decision takes an admin and they aren't one (`not-admin`); nothing is written then.
 */
export async function decideReview(
  tx: Tx,
  tenantId: string,
  input: DecideInput,
  how: ReviewDecision,
): Promise<Decided> {
  const principal =
    typeof input.userId === "string" && isId("user", input.userId)
      ? await resolvePrincipal(tx, tenantId, input.userId)
      : null;
  if (!principal?.active) throw new ReviewAccessError("unknown-reviewer", "no such user");
  // How far the decision reaches, read under the locks the decision itself takes (the value,
  // then the file: locks.ts), so that what is checked is what is decided.
  const [peek] = await tx
    .select({ objectId: tagReviews.objectId, facet: tagReviews.facet, value: tagReviews.value })
    .from(tagReviews)
    .where(and(eq(tagReviews.tenantId, tenantId), eq(tagReviews.id, input.reviewId)));
  if (peek) {
    await lockTagValue(tx, tenantId, peek.facet, peek.value);
    await lockObject(tx, tenantId, peek.objectId);
    const reach = await decisionReach(tx, tenantId, input.reviewId, how);
    if (reach !== "file" && reach !== null) {
      const admin = await isAdmin(tx, tenantId, input.userId, {
        ...(input.adminGroupId === undefined ? {} : { adminGroupId: input.adminGroupId }),
      });
      if (!admin) throw notAdmin(reach, peek.objectId);
    }
  }
  const by = `user:${input.userId}`;
  const replace = "replace" in how && how.replace === true;
  const did =
    how.decision === "approve"
      ? await approveReview(tx, tenantId, input.reviewId, by, { replace })
      : how.decision === "merge"
        ? await mergeReview(tx, tenantId, input.reviewId, how.into, by, { replace })
        : await rejectReview(tx, tenantId, input.reviewId, by);
  const [row] = await tx
    .select()
    .from(tagReviews)
    .where(and(eq(tagReviews.tenantId, tenantId), eq(tagReviews.id, input.reviewId)));
  if (!row) throw new Error("decideReview: the item is gone");
  const tag = tagOf(row.facet, row.value);
  const applied =
    how.decision === "reject" ? null : how.decision === "merge" ? tagOf(row.facet, how.into) : tag;
  await appendAudit(tx, tenantId, {
    actor: input.actor ?? by,
    action: "tag.review",
    decision: "allow",
    object: row.objectId,
    detail: {
      review: row.id,
      tag,
      reason: row.reason,
      outcome: OUTCOME[how.decision],
      ...(how.decision === "merge" ? { into: tagOf(row.facet, how.into) } : {}),
      ...(did.replaced.length > 0 ? { replaced: did.replaced.join(" ") } : {}),
      ...(did.alsoClosed.length > 0 ? { alsoClosed: did.alsoClosed.length } : {}),
      ...(input.actor === undefined ? {} : { reviewer: by }),
    },
  });
  return {
    objectId: row.objectId,
    tag,
    applied,
    replaced: did.replaced,
    alsoClosed: did.alsoClosed.length,
  };
}
