import {
  facets,
  facetValues,
  grants,
  newId,
  objectTags,
  tagOf,
  tagReviews,
  type TAG_SOURCES,
  type Tx,
} from "@openhoard/core-db";
import { and, asc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import { lockObject } from "./locks.js";

/*
 * Applying tags, and the review inbox (T-406). The one rule: nothing creates vocabulary, and
 * nothing a model guesses changes who can see a file, without a person saying yes.
 *
 * proposeTag() applies a tag straight away only when it is safe to:
 *
 * | the value is …                                    | rule, pack, person | model                  |
 * | ------------------------------------------------- | ------------------ | ---------------------- |
 * | not in the approved vocabulary                    | review: new-value  | review: new-value      |
 * | approved, with visibility/exposure or a live grant | applied            | review: sensitive      |
 * | approved, below the confidence threshold          | applied            | review: low-confidence |
 * | approved otherwise                                | applied            | applied                |
 *
 * A tag with an open review item waits for that item, whoever proposes it again.
 *
 * Levels and grants can be added to a value after a model tagged objects with it, so the check
 * above can't be the only guard: decisions read tags through tagsForDecisions(), where an
 * unreviewed model tag can tighten visibility and exposure but never widen access through a
 * grant.
 *
 * Who may propose or decide is the API's question (authorize(), action "tag"); these functions
 * trust their caller and record who acted. `appliedBy` must name the same kind as `source`.
 */

export type TagSource = (typeof TAG_SOURCES)[number];

export interface TagProposal {
  objectId: string;
  /** `facet:value`. The facet must exist; the value may be new. */
  tag: string;
  source: TagSource;
  /** Who or what exactly, of the source's kind: `user:…`, `model:…`, `rule:…`, `pack:…`. */
  appliedBy?: string;
  /** In [0, 1]; 1 for rules, packs and people. */
  confidence: number;
  /** Display label for a value the vocabulary doesn't have yet. */
  label?: string;
}

export type ReviewReason = "new-value" | "low-confidence" | "sensitive";

export type TagOutcome =
  { applied: true; tag: string } | { applied: false; reviewId: string; reason: ReviewReason };

/** Model tags below this confidence go to review. */
export const DEFAULT_MIN_CONFIDENCE = 0.75;

export async function proposeTag(
  tx: Tx,
  tenantId: string,
  proposal: TagProposal,
  options: { minConfidence?: number; now?: Date } = {},
): Promise<TagOutcome> {
  const { facet, value } = splitTag(proposal.tag);
  if (!(proposal.confidence >= 0 && proposal.confidence <= 1)) {
    throw new RangeError("confidence must be in [0, 1]");
  }
  if (proposal.appliedBy !== undefined && !proposal.appliedBy.startsWith(`${proposal.source}:`)) {
    throw new TypeError(`appliedBy must be a ${proposal.source}: principal`);
  }
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const now = options.now ?? new Date();
  await lockObject(tx, tenantId, proposal.objectId);

  const [facetRow] = await tx
    .select({ key: facets.key })
    .from(facets)
    .where(and(eq(facets.tenantId, tenantId), eq(facets.key, facet)));
  // Facets come from packs and admins; a tag can't invent one.
  if (!facetRow) throw new Error(`unknown facet: ${facet}`);

  const [already] = await tx
    .select({ reviewed: objectTags.reviewed })
    .from(objectTags)
    .where(
      and(
        eq(objectTags.tenantId, tenantId),
        eq(objectTags.objectId, proposal.objectId),
        eq(objectTags.facet, facet),
        eq(objectTags.value, value),
      ),
    );
  // Already on the object: nothing to decide, and never a review item for a settled tag.
  if (already) return { applied: true, tag: proposal.tag };

  // An open item for this tag decides it; proposing again changes nothing.
  const [open] = await openItemFor(tx, tenantId, proposal.objectId, facet, value);
  if (open) return { applied: false, reviewId: open.id, reason: open.reason };

  const known = await findValue(tx, tenantId, facet, value);
  let reason: ReviewReason | undefined;
  if (!known?.approved) reason = "new-value";
  else if (proposal.source === "model") {
    const levels = known.visibility !== null || known.exposure !== null;
    if (levels || (await hasLiveGrant(tx, tenantId, facet, value, now))) reason = "sensitive";
    else if (proposal.confidence < minConfidence) reason = "low-confidence";
  }

  if (reason === undefined) {
    await tx.insert(objectTags).values({
      tenantId,
      objectId: proposal.objectId,
      facet,
      value,
      source: proposal.source,
      appliedBy: proposal.appliedBy ?? null,
      confidence: proposal.confidence,
    });
    return { applied: true, tag: proposal.tag };
  }

  if (!known) {
    // Proposed, not created: the value exists only to be reviewed, and grants and levels
    // ignore it until it is approved.
    await tx
      .insert(facetValues)
      .values({ tenantId, facet, value, label: proposal.label ?? value, approved: false })
      .onConflictDoNothing();
  }
  const reviewId = newId("review");
  await tx.insert(tagReviews).values({
    tenantId,
    id: reviewId,
    objectId: proposal.objectId,
    facet,
    value,
    reason,
    source: proposal.source,
    appliedBy: proposal.appliedBy ?? null,
    confidence: proposal.confidence,
  });
  return { applied: false, reviewId, reason };
}

/**
 * An object's tags for access decisions (authorize(), search filters).
 *
 * - `levels`: every tag. Visibility and exposure resolve most-restrictive-wins, so a tag can only
 *   tighten them, and an unreviewed guess that tightens is the safe way to be wrong.
 * - `grantable`: the tags grants may match. An unreviewed model tag is left out: a grant widens
 *   access, and only a person or a trusted source may decide an object carries it.
 */
export async function tagsForDecisions(
  tx: Tx,
  tenantId: string,
  objectId: string,
): Promise<{ levels: string[]; grantable: string[] }> {
  const rows = await tx
    .select({
      facet: objectTags.facet,
      value: objectTags.value,
      source: objectTags.source,
      reviewed: objectTags.reviewed,
    })
    .from(objectTags)
    .where(and(eq(objectTags.tenantId, tenantId), eq(objectTags.objectId, objectId)));
  const levels = rows.map((r) => tagOf(r.facet, r.value)).sort();
  const grantable = rows
    .filter((r) => r.source !== "model" || r.reviewed)
    .map((r) => tagOf(r.facet, r.value))
    .sort();
  return { levels, grantable };
}

/** Open review items, oldest first. */
export function listOpenReviews(tx: Tx, tenantId: string, limit = 100) {
  return tx
    .select()
    .from(tagReviews)
    .where(and(eq(tagReviews.tenantId, tenantId), isNull(tagReviews.resolvedAt)))
    .orderBy(asc(tagReviews.createdAt), asc(tagReviews.id))
    .limit(limit);
}

/**
 * Approves an open item: the tag applies, marked reviewed, and a new value joins the approved
 * vocabulary.
 */
export async function approveReview(
  tx: Tx,
  tenantId: string,
  reviewId: string,
  reviewer: string,
  now?: Date,
): Promise<void> {
  const item = await openItem(tx, tenantId, reviewId);
  await tx
    .update(facetValues)
    .set({ approved: true })
    .where(
      and(
        eq(facetValues.tenantId, tenantId),
        eq(facetValues.facet, item.facet),
        eq(facetValues.value, item.value),
      ),
    );
  await applyReviewed(tx, tenantId, item, item.value);
  await resolve(tx, tenantId, [reviewId], { decision: "approved", resolvedBy: reviewer }, now);
}

/**
 * Rejects an open item: nothing is applied, and an unreviewed model tag already on the object is
 * taken off. Rejecting a new value rejects it everywhere: every other open item proposing the
 * same value is closed too, and the value stays unapproved (it is kept, as the record).
 */
export async function rejectReview(
  tx: Tx,
  tenantId: string,
  reviewId: string,
  reviewer: string,
  now?: Date,
): Promise<void> {
  const item = await openItem(tx, tenantId, reviewId);
  await tx
    .delete(objectTags)
    .where(
      and(
        eq(objectTags.tenantId, tenantId),
        eq(objectTags.objectId, item.objectId),
        eq(objectTags.facet, item.facet),
        eq(objectTags.value, item.value),
        eq(objectTags.source, "model"),
        eq(objectTags.reviewed, false),
      ),
    );
  const ids = [reviewId];
  if (item.reason === "new-value") {
    const others = await tx
      .select({ id: tagReviews.id })
      .from(tagReviews)
      .where(
        and(
          eq(tagReviews.tenantId, tenantId),
          eq(tagReviews.facet, item.facet),
          eq(tagReviews.value, item.value),
          eq(tagReviews.reason, "new-value"),
          isNull(tagReviews.resolvedAt),
          ne(tagReviews.id, reviewId),
        ),
      )
      .for("update");
    ids.push(...others.map((o) => o.id));
  }
  await resolve(tx, tenantId, ids, { decision: "rejected", resolvedBy: reviewer }, now);
}

/**
 * Resolves an open item by applying an existing approved value of the same facet instead
 * (the model said "client:acme-corp"; the vocabulary calls it "client:acme").
 */
export async function mergeReview(
  tx: Tx,
  tenantId: string,
  reviewId: string,
  intoValue: string,
  reviewer: string,
  now?: Date,
): Promise<void> {
  const item = await openItem(tx, tenantId, reviewId);
  if (intoValue === item.value) throw new Error("merging a value into itself; approve it instead");
  const target = await findValue(tx, tenantId, item.facet, intoValue);
  if (!target?.approved) {
    throw new Error(`cannot merge into ${item.facet}:${intoValue}: not an approved value`);
  }
  await applyReviewed(tx, tenantId, item, intoValue);
  await resolve(
    tx,
    tenantId,
    [reviewId],
    { decision: "merged", mergedInto: intoValue, resolvedBy: reviewer },
    now,
  );
}

type ReviewRow = typeof tagReviews.$inferSelect;

/** The open item, locked, so two reviewers can't both resolve it. */
async function openItem(tx: Tx, tenantId: string, reviewId: string): Promise<ReviewRow> {
  const [peek] = await tx
    .select({ objectId: tagReviews.objectId })
    .from(tagReviews)
    .where(and(eq(tagReviews.tenantId, tenantId), eq(tagReviews.id, reviewId)));
  if (!peek) throw new Error(`no review item ${reviewId}`);
  await lockObject(tx, tenantId, peek.objectId);
  const [item] = await tx
    .select()
    .from(tagReviews)
    .where(and(eq(tagReviews.tenantId, tenantId), eq(tagReviews.id, reviewId)))
    .for("update");
  if (!item || item.resolvedAt !== null) {
    throw new Error(`review item ${reviewId} is already resolved`);
  }
  return item;
}

function openItemFor(tx: Tx, tenantId: string, objectId: string, facet: string, value: string) {
  return tx
    .select({ id: tagReviews.id, reason: tagReviews.reason })
    .from(tagReviews)
    .where(
      and(
        eq(tagReviews.tenantId, tenantId),
        eq(tagReviews.objectId, objectId),
        eq(tagReviews.facet, facet),
        eq(tagReviews.value, value),
        isNull(tagReviews.resolvedAt),
      ),
    );
}

async function applyReviewed(tx: Tx, tenantId: string, item: ReviewRow, value: string) {
  await tx
    .insert(objectTags)
    .values({
      tenantId,
      objectId: item.objectId,
      facet: item.facet,
      value,
      source: item.source,
      appliedBy: item.appliedBy,
      confidence: item.confidence,
      reviewed: true,
    })
    .onConflictDoUpdate({
      target: [objectTags.tenantId, objectTags.objectId, objectTags.facet, objectTags.value],
      set: { reviewed: true },
    });
}

/** Closes items. The time is the database's unless given, so it can't predate their creation. */
async function resolve(
  tx: Tx,
  tenantId: string,
  reviewIds: string[],
  set: Pick<ReviewRow, "decision" | "resolvedBy"> & { mergedInto?: string },
  now?: Date,
) {
  for (const id of reviewIds) {
    await tx
      .update(tagReviews)
      .set({ ...set, resolvedAt: now ?? sql`greatest(now(), ${tagReviews.createdAt})` })
      .where(and(eq(tagReviews.tenantId, tenantId), eq(tagReviews.id, id)));
  }
}

async function findValue(tx: Tx, tenantId: string, facet: string, value: string) {
  const [row] = await tx
    .select({
      approved: facetValues.approved,
      visibility: facetValues.visibility,
      exposure: facetValues.exposure,
    })
    .from(facetValues)
    .where(
      and(
        eq(facetValues.tenantId, tenantId),
        eq(facetValues.facet, facet),
        eq(facetValues.value, value),
      ),
    );
  return row;
}

/** Whether any grant names this tag that is live at `at` or will be (not revoked or expired by then). */
async function hasLiveGrant(tx: Tx, tenantId: string, facet: string, value: string, at: Date) {
  const [row] = await tx
    .select({ id: grants.id })
    .from(grants)
    .where(
      and(
        eq(grants.tenantId, tenantId),
        eq(grants.facet, facet),
        eq(grants.value, value),
        or(isNull(grants.revokedAt), gt(grants.revokedAt, at)),
        or(isNull(grants.expiresAt), gt(grants.expiresAt, at)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

function splitTag(tag: string): { facet: string; value: string } {
  const at = tag.indexOf(":");
  if (at <= 0 || at === tag.length - 1) throw new TypeError("a tag is facet:value");
  return { facet: tag.slice(0, at), value: tag.slice(at + 1) };
}
