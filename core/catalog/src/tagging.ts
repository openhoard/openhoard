import {
  facets,
  facetValues,
  grants,
  newId,
  objects,
  objectTags,
  queryRows,
  tagOf,
  tagReviews,
  type TAG_SOURCES,
  type Tx,
} from "@openhoard/core-db";
import { and, asc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { EXPOSURE, VISIBILITY } from "@openhoard/core-policy";
import { lockObject, lockTagValue } from "./locks.js";
import { makePrimary } from "./primary.js";
import { TagError } from "./tag-error.js";

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
 * On a single-value facet (T-409) the object already has another value of, a person's value
 * replaces it; anyone else's waits in review (`conflict`, unless another reason came first), and
 * approving it replaces the other value. The home moves to the value that replaced it.
 *
 * A tag with an open review item waits for that item, whoever proposes it again, with one
 * exception: a trusted source (rule, pack, person) proposing an approved value that waits only
 * because a model proposed it applies it. A person's proposal also closes the model's item, as
 * approved by that person; a rule's or pack's leaves it open, since the rule may stop giving the
 * tag (the file moves) while the model's guess still stands and still tightens visibility.
 *
 * Likewise a trusted source proposing a tag the object carries as an unreviewed model tag takes
 * it over, so grants match it from then on. A rule or pack keeps the model's provenance on the
 * tag, and when the rule stops giving it (rules.ts applyRuleTags) it goes back to being the
 * model's unreviewed tag instead of disappearing. A person proposing a tag the object carries
 * from any other source makes it theirs: it stays when rules change.
 *
 * Levels and grants can be added to a value after a model tagged objects with it, so the check
 * above can't be the only guard: decisions read tags through tagsForDecisions(), where an
 * unreviewed model tag can tighten visibility and exposure but never widen access through a
 * grant.
 *
 * Who may propose or decide is the API's question (authorize(), action "tag"); these functions
 * trust their caller and record who acted. `appliedBy` must name the same kind as `source`.
 *
 * Every input is checked before anything is written; a refused one throws TagError with a code.
 * Locks follow locks.ts: a decision takes the value's lock, then the object's, then the item.
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
  /** Display label for a value the vocabulary doesn't have yet: 1 to 200 characters. */
  label?: string;
}

/** Why a tag waits for a person. (`primary` items are proposals of a home: primary.ts.) */
export type ReviewReason = "new-value" | "low-confidence" | "sensitive" | "conflict";

export type TagOutcome =
  { applied: true; tag: string } | { applied: false; reviewId: string; reason: ReviewReason };

export { TagError, type TagErrorCode } from "./tag-error.js";

/** Model tags below this confidence go to review. */
export const DEFAULT_MIN_CONFIDENCE = 0.75;

// core/db's own checks on facets, values, labels and principals, made here first.
const FACET_KEY = /^[a-z][a-z0-9-]{0,63}$/;
const VALUE_SLUG = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PRINCIPAL = /^[a-z]+:[^\0]+$/;
const PRINCIPAL_MAX = 1024;
const LABEL_MAX = 200;

export async function proposeTag(
  tx: Tx,
  tenantId: string,
  proposal: TagProposal,
  options: { minConfidence?: number; now?: Date } = {},
): Promise<TagOutcome> {
  const { facet, value } = splitTag(proposal.tag);
  checkProposal(proposal, facet, value);
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const trusted = proposal.source !== "model";
  const appliedBy = proposal.appliedBy ?? null;
  await lockObject(tx, tenantId, proposal.objectId);

  const [objectRow] = await tx
    .select({ id: objects.id })
    .from(objects)
    .where(and(eq(objects.tenantId, tenantId), eq(objects.id, proposal.objectId)));
  if (!objectRow) throw new TagError("unknown-object", `no object ${proposal.objectId}`);
  const [facetRow] = await tx
    .select({ key: facets.key, single: facets.single })
    .from(facets)
    .where(and(eq(facets.tenantId, tenantId), eq(facets.key, facet)));
  // Facets come from packs and admins; a tag can't invent one.
  if (!facetRow) throw new TagError("unknown-facet", `unknown facet: ${facet}`);

  const tagKey = and(
    eq(objectTags.tenantId, tenantId),
    eq(objectTags.objectId, proposal.objectId),
    eq(objectTags.facet, facet),
    eq(objectTags.value, value),
  );
  const [already] = await tx
    .select({
      source: objectTags.source,
      reviewed: objectTags.reviewed,
      appliedBy: objectTags.appliedBy,
      confidence: objectTags.confidence,
    })
    .from(objectTags)
    .where(tagKey);
  if (already) {
    const person = proposal.source === "user";
    // A person picking one of several values of a single-value facet (it became single while
    // the object had several): the others go, if that loosens nothing.
    const crowded =
      person && facetRow.single
        ? await otherValues(tx, tenantId, proposal.objectId, facet, value)
        : [];
    let home = false;
    if (crowded.length > 0) {
      if (await loosens(tx, tenantId, facet, value, crowded)) {
        const [open] = await openItemFor(tx, tenantId, proposal.objectId, facet, value);
        if (open) return { applied: false, reviewId: open.id, reason: open.reason };
        return fileItem(tx, tenantId, proposal, facet, value, "conflict");
      }
      home = await replaceValues(tx, tenantId, proposal.objectId, facet, crowded);
    }
    // The home moves in the same statement that makes the tag the person's: a home is never an
    // unreviewed model guess, even for an instant.
    const homeBy = home ? { primaryBy: appliedBy ?? "user:unknown" } : {};
    if (person && already.source !== "user") {
      // A person decides this object carries the tag: it is theirs from now on, whatever gave
      // it first, and no rule change takes it off. A model's item for it is settled too.
      await tx
        .update(objectTags)
        .set({
          source: "user",
          appliedBy,
          confidence: 1,
          modelAppliedBy: null,
          modelConfidence: null,
          ...homeBy,
        })
        .where(tagKey);
      await settleModelItem(tx, tenantId, proposal, facet, value);
    } else if (home) {
      await tx.update(objectTags).set(homeBy).where(tagKey);
    } else if (trusted && already.source === "model" && !already.reviewed) {
      // A rule or pack vouches for a model's unreviewed guess: grants match the tag from now
      // on, and the model's guess is kept, for when the rule stops giving it.
      await tx
        .update(objectTags)
        .set({
          source: proposal.source,
          appliedBy,
          confidence: proposal.confidence,
          modelAppliedBy: already.appliedBy,
          modelConfidence: already.confidence,
        })
        .where(tagKey);
    }
    // Already on the object: nothing to decide, and never a review item for a settled tag.
    return { applied: true, tag: proposal.tag };
  }

  const known = await findValue(tx, tenantId, facet, value);
  // An open item for this tag decides it; proposing again changes nothing. Except: a model's
  // item on an approved value waits only because a model can't be trusted with it, and a
  // trusted source can. It applies the tag and closes the item as approved by the proposer.
  // A single-value facet the object already has another value of: only a person replaces it
  // straight away, and only when that loosens nothing; anything else waits for a person.
  const others = facetRow.single
    ? await otherValues(tx, tenantId, proposal.objectId, facet, value)
    : [];
  let [open] = await openItemFor(tx, tenantId, proposal.objectId, facet, value);
  if (open?.reason === "conflict" && others.length === 0) {
    // What it waited on is gone (the other value was taken off): nothing is left to decide.
    await withdraw(tx, tenantId, [open.id]);
    open = undefined;
  }
  if (open) {
    const settles =
      trusted && open.source === "model" && open.reason !== "new-value" && known?.approved;
    if (!settles) return { applied: false, reviewId: open.id, reason: open.reason };
  }
  let reason: ReviewReason | undefined;
  if (!known?.approved) reason = "new-value";
  else if (proposal.source === "model") {
    const levels = known.visibility !== null || known.exposure !== null;
    if (levels || (await hasLiveGrant(tx, tenantId, facet, value, options.now))) {
      reason = "sensitive";
    } else if (proposal.confidence < minConfidence) reason = "low-confidence";
  }
  if (
    reason === undefined &&
    others.length > 0 &&
    (proposal.source !== "user" || (await loosens(tx, tenantId, facet, value, others)))
  ) {
    reason = "conflict";
  }
  // The model's item waits on this tag already, and there can be only one open item for it.
  if (reason !== undefined && open) {
    return { applied: false, reviewId: open.id, reason: open.reason };
  }

  if (reason === undefined) {
    // The home moves to the person's value, as theirs.
    const primaryBy = (await replaceValues(tx, tenantId, proposal.objectId, facet, others))
      ? (appliedBy ?? "user:unknown")
      : null;
    await tx.insert(objectTags).values({
      tenantId,
      objectId: proposal.objectId,
      facet,
      value,
      source: proposal.source,
      appliedBy,
      confidence: proposal.confidence,
      primaryBy,
    });
    // Only a person settles the model's item; a rule's or pack's tag leaves it for a person
    // (see above). Nothing automated records a sensitive tag as approved.
    if (open && proposal.source === "user") {
      await resolve(tx, tenantId, [open.id], {
        decision: "approved",
        resolvedBy: appliedBy ?? "user:unknown",
      });
    }
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
  return fileItem(tx, tenantId, proposal, facet, value, reason);
}

/** Files a review item for the proposal. */
async function fileItem(
  tx: Tx,
  tenantId: string,
  proposal: TagProposal,
  facet: string,
  value: string,
  reason: ReviewReason,
): Promise<TagOutcome> {
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
 * Whether `value` in place of `others` would loosen a level: some other value sets a visibility
 * or exposure that `value` doesn't set as tightly. (Taking off a value's grants only narrows who
 * can see the object.)
 */
async function loosens(
  tx: Tx,
  tenantId: string,
  facet: string,
  value: string,
  others: readonly { value: string }[],
): Promise<boolean> {
  const rows = await tx
    .select({
      value: facetValues.value,
      visibility: facetValues.visibility,
      exposure: facetValues.exposure,
    })
    .from(facetValues)
    .where(
      and(
        eq(facetValues.tenantId, tenantId),
        eq(facetValues.facet, facet),
        inArray(facetValues.value, [value, ...others.map((o) => o.value)]),
      ),
    );
  // A value a pack's policies name (a forbid, most likely) may guard more than levels show:
  // taking it off counts as loosening, to be safe.
  const named = await queryRows<{ n: number }>(
    tx,
    sql`select count(*)::int as n from tenant_packs
        where tenant_id = ${tenantId}
          and (${sql.join(
            others.map(
              (o) =>
                sql`position(${tagOf(facet, o.value)} in coalesce(content->'policies', '{}')::text) > 0`,
            ),
            sql` or `,
          )})`,
  );
  if ((named[0]?.n ?? 0) > 0) return true;
  const mine = rows.find((r) => r.value === value);
  const looser = <T extends string>(
    order: readonly T[],
    to: T | null | undefined,
    from: T | null,
  ) =>
    from !== null && (to === null || to === undefined || order.indexOf(to) > order.indexOf(from));
  return rows
    .filter((r) => r.value !== value)
    .some(
      (r) =>
        looser(VISIBILITY, mine?.visibility, r.visibility) ||
        looser(EXPOSURE, mine?.exposure, r.exposure),
    );
}

/** The object's values of `facet` other than `value`. */
async function otherValues(
  tx: Tx,
  tenantId: string,
  objectId: string,
  facet: string,
  value: string,
): Promise<{ value: string; primaryBy: string | null }[]> {
  return tx
    .select({ value: objectTags.value, primaryBy: objectTags.primaryBy })
    .from(objectTags)
    .where(
      and(
        eq(objectTags.tenantId, tenantId),
        eq(objectTags.objectId, objectId),
        eq(objectTags.facet, facet),
        ne(objectTags.value, value),
      ),
    );
}

/**
 * Takes `others` (values of a single-value facet) off the object, for the value a person chose.
 * Returns whether one of them was the home, so the new value becomes the home in its place.
 */
async function replaceValues(
  tx: Tx,
  tenantId: string,
  objectId: string,
  facet: string,
  others: readonly { value: string; primaryBy: string | null }[],
): Promise<boolean> {
  if (others.length === 0) return false;
  // Items waiting to apply one of these values, or to make one the home, decide nothing now.
  const stale = await tx
    .select({ id: tagReviews.id })
    .from(tagReviews)
    .where(
      and(
        eq(tagReviews.tenantId, tenantId),
        eq(tagReviews.objectId, objectId),
        eq(tagReviews.facet, facet),
        inArray(
          tagReviews.value,
          others.map((o) => o.value),
        ),
        isNull(tagReviews.resolvedAt),
      ),
    );
  await withdraw(
    tx,
    tenantId,
    stale.map((r) => r.id),
  );
  await tx.delete(objectTags).where(
    and(
      eq(objectTags.tenantId, tenantId),
      eq(objectTags.objectId, objectId),
      eq(objectTags.facet, facet),
      inArray(
        objectTags.value,
        others.map((o) => o.value),
      ),
    ),
  );
  return others.some((o) => o.primaryBy !== null);
}

/** Closes items nobody needs to decide any more, as withdrawn by whoever proposed them. */
async function withdraw(tx: Tx, tenantId: string, reviewIds: readonly string[]) {
  if (reviewIds.length === 0) return;
  await tx
    .update(tagReviews)
    .set({
      decision: "withdrawn",
      resolvedBy: sql`coalesce(${tagReviews.appliedBy}, ${tagReviews.source} || ':unknown')`,
      resolvedAt: sql`greatest(now(), ${tagReviews.createdAt})`,
    })
    .where(
      and(
        eq(tagReviews.tenantId, tenantId),
        inArray(tagReviews.id, [...reviewIds]),
        isNull(tagReviews.resolvedAt),
      ),
    );
}

/** Closes a model's open item for this tag (not a new value) as approved by a person. */
async function settleModelItem(
  tx: Tx,
  tenantId: string,
  proposal: TagProposal,
  facet: string,
  value: string,
) {
  const [open] = await openItemFor(tx, tenantId, proposal.objectId, facet, value);
  if (open?.source !== "model" || open.reason === "new-value") return;
  await resolve(tx, tenantId, [open.id], {
    decision: "approved",
    resolvedBy: proposal.appliedBy ?? "user:unknown",
  });
}

/** The checks core/db's constraints make, as TagErrors raised before any write. */
function checkProposal(proposal: TagProposal, facet: string, value: string) {
  const invalid = (message: string) => {
    throw new TagError("invalid", message);
  };
  if (!FACET_KEY.test(facet)) invalid(`${facet} is not a facet key`);
  if (!VALUE_SLUG.test(value)) {
    invalid(`${value} is not a value: 1 to 128 lower-case letters, digits, '.', '_' or '-'`);
  }
  if (!(proposal.confidence >= 0 && proposal.confidence <= 1)) {
    invalid("confidence must be in [0, 1]");
  }
  const { appliedBy, label } = proposal;
  if (appliedBy !== undefined) {
    if (!appliedBy.startsWith(`${proposal.source}:`)) {
      invalid(`appliedBy must be a ${proposal.source}: principal`);
    }
    if (!PRINCIPAL.test(appliedBy) || appliedBy.length > PRINCIPAL_MAX) {
      invalid(`appliedBy must be a principal of up to ${PRINCIPAL_MAX} characters`);
    }
  }
  if (label !== undefined) {
    const n = [...label].length;
    if (n < 1 || n > LABEL_MAX || label.includes("\0") || label.trim() === "") {
      invalid(`a label is 1 to ${LABEL_MAX} characters, not blank`);
    }
  }
}

/**
 * An object's tags for access decisions (authorize(), search filters).
 *
 * - `levels`: every tag. For visibility and exposure use visibility.ts levelsFor(), which lets
 *   an unreviewed model tag tighten them but never loosen them past what trusted tags and the
 *   tenant default say.
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
  options: DecisionOptions = {},
): Promise<void> {
  const { now } = options;
  const item = await openItem(tx, tenantId, reviewId);
  if (item.reason === "primary") {
    // Not a tag to apply: the model's pick of the object's home, which the person confirms.
    checkPerson(reviewer, "confirms a primary tag");
    await makePrimary(tx, tenantId, item.objectId, tagOf(item.facet, item.value), reviewer);
    await resolve(tx, tenantId, [reviewId], { decision: "approved", resolvedBy: reviewer }, now);
    return;
  }
  const others = await replacing(tx, tenantId, item, item.value, reviewer, options);
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
  await applyReviewed(tx, tenantId, item, item.value, others, reviewer);
  await resolve(tx, tenantId, [reviewId], { decision: "approved", resolvedBy: reviewer }, now);
}

export interface DecisionOptions {
  /** When the decision was made; the database's clock by default. */
  now?: Date;
  /**
   * On a single-value facet the object carries another value of: the reviewer confirms that
   * this value replaces it. Without it such a decision is refused (`conflict`), so a reviewer
   * never takes a value off without seeing it.
   */
  replace?: boolean;
}

function checkPerson(reviewer: string, what: string) {
  if (
    !reviewer.startsWith("user:") ||
    !PRINCIPAL.test(reviewer) ||
    reviewer.length > PRINCIPAL_MAX
  ) {
    throw new TagError("invalid", `a person (user:…) ${what}`);
  }
}

/**
 * The values of a single-value facet that deciding `item` as `value` takes off the object:
 * refused (`conflict`) unless the reviewer, a person, confirmed it with `replace`.
 */
async function replacing(
  tx: Tx,
  tenantId: string,
  item: ReviewRow,
  value: string,
  reviewer: string,
  options: DecisionOptions,
): Promise<{ value: string; primaryBy: string | null }[]> {
  const [facet] = await tx
    .select({ single: facets.single })
    .from(facets)
    .where(and(eq(facets.tenantId, tenantId), eq(facets.key, item.facet)));
  if (!facet?.single) return [];
  const others = await otherValues(tx, tenantId, item.objectId, item.facet, value);
  if (others.length === 0) return others;
  const names = others.map((o) => tagOf(item.facet, o.value)).join(", ");
  if (!options.replace) {
    throw new TagError(
      "conflict",
      `${tagOf(item.facet, value)} would replace ${names}: decide again with replace`,
    );
  }
  checkPerson(reviewer, `replaces ${names}`);
  return others;
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
  options: Pick<DecisionOptions, "now"> = {},
): Promise<void> {
  const { now } = options;
  const item = await openItem(tx, tenantId, reviewId);
  if (item.reason === "primary") {
    // The tag itself stays; only the model's pick of the home is turned down.
    await resolve(tx, tenantId, [reviewId], { decision: "rejected", resolvedBy: reviewer }, now);
    return;
  }
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
    // The value's lock (taken by openItem) keeps other decisions on these items out; id order
    // keeps this in line with anything else that locks several of them.
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
      .orderBy(asc(tagReviews.id))
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
  options: DecisionOptions = {},
): Promise<void> {
  const { now } = options;
  const item = await openItem(tx, tenantId, reviewId);
  if (item.reason === "primary") {
    throw new TagError("invalid", "a primary proposal is approved or rejected, not merged");
  }
  if (intoValue === item.value) {
    throw new TagError("invalid", "merging a value into itself; approve it instead");
  }
  const target = VALUE_SLUG.test(intoValue)
    ? await findValue(tx, tenantId, item.facet, intoValue)
    : undefined;
  if (!target?.approved) {
    throw new TagError(
      "invalid",
      `cannot merge into ${item.facet}:${intoValue}: not an approved value`,
    );
  }
  const others = await replacing(tx, tenantId, item, intoValue, reviewer, options);
  await applyReviewed(tx, tenantId, item, intoValue, others, reviewer);
  await resolve(
    tx,
    tenantId,
    [reviewId],
    { decision: "merged", mergedInto: intoValue, resolvedBy: reviewer },
    now,
  );
}

type ReviewRow = typeof tagReviews.$inferSelect;

/**
 * The open item, locked, so two reviewers can't both resolve it. Locks in the order of locks.ts:
 * the value (every decision about it), then the object, then the item's row.
 */
async function openItem(tx: Tx, tenantId: string, reviewId: string): Promise<ReviewRow> {
  const [peek] = await tx
    .select({ objectId: tagReviews.objectId, facet: tagReviews.facet, value: tagReviews.value })
    .from(tagReviews)
    .where(and(eq(tagReviews.tenantId, tenantId), eq(tagReviews.id, reviewId)));
  if (!peek) throw new TagError("unknown-review", `no review item ${reviewId}`);
  // An item's object, facet and value never change, so the unlocked peek names the right locks.
  await lockTagValue(tx, tenantId, peek.facet, peek.value);
  await lockObject(tx, tenantId, peek.objectId);
  const [item] = await tx
    .select()
    .from(tagReviews)
    .where(and(eq(tagReviews.tenantId, tenantId), eq(tagReviews.id, reviewId)))
    .for("update");
  if (!item || item.resolvedAt !== null) {
    throw new TagError("already-resolved", `review item ${reviewId} is already resolved`);
  }
  return item;
}

/** The open item deciding whether this tag applies (a primary proposal decides nothing of that). */
async function openItemFor(
  tx: Tx,
  tenantId: string,
  objectId: string,
  facet: string,
  value: string,
): Promise<{ id: string; reason: ReviewReason; source: TagSource }[]> {
  const rows = await tx
    .select({ id: tagReviews.id, reason: tagReviews.reason, source: tagReviews.source })
    .from(tagReviews)
    .where(
      and(
        eq(tagReviews.tenantId, tenantId),
        eq(tagReviews.objectId, objectId),
        eq(tagReviews.facet, facet),
        eq(tagReviews.value, value),
        isNull(tagReviews.resolvedAt),
        ne(tagReviews.reason, "primary"),
      ),
    );
  return rows as { id: string; reason: ReviewReason; source: TagSource }[];
}

async function applyReviewed(
  tx: Tx,
  tenantId: string,
  item: ReviewRow,
  value: string,
  others: readonly { value: string; primaryBy: string | null }[],
  reviewer: string,
) {
  if (others.length > 0) {
    // The reviewer chose this value over the others (replacing() checked they may): it is
    // theirs, so no rule change takes it off and leaves the facet empty, and it takes the home.
    const home = await replaceValues(tx, tenantId, item.objectId, item.facet, others);
    const theirs = {
      source: "user" as const,
      appliedBy: reviewer,
      confidence: 1,
      reviewed: true,
      modelAppliedBy: null,
      modelConfidence: null,
      ...(home ? { primaryBy: reviewer } : {}),
    };
    await tx
      .insert(objectTags)
      .values({ tenantId, objectId: item.objectId, facet: item.facet, value, ...theirs })
      .onConflictDoUpdate({
        target: [objectTags.tenantId, objectTags.objectId, objectTags.facet, objectTags.value],
        set: theirs,
      });
    return;
  }
  // A person decided a model's or person's item: its provenance replaces a rule's or pack's on
  // the tag, so it no longer follows the rule. A reviewed rule or pack item stays theirs (and a
  // rule's tag does follow the rule), and a person's own tag is never handed to a rule.
  const takesOver = item.source === "model" || item.source === "user";
  const ruled = sql`${objectTags.source} in ('rule', 'pack')`;
  const pick = <T>(
    mine: T,
    column: typeof objectTags.source | typeof objectTags.appliedBy | typeof objectTags.confidence,
  ) => (takesOver ? sql`case when ${ruled} then ${mine} else ${column} end` : column);
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
      set: {
        source: pick(item.source, objectTags.source),
        appliedBy: pick(item.appliedBy, objectTags.appliedBy),
        confidence: pick(item.confidence, objectTags.confidence),
        reviewed: true,
        ...(takesOver ? { modelAppliedBy: null, modelConfidence: null } : {}),
      },
    });
}

/**
 * Closes items, in one statement. The time is the database's unless given, so it can't predate
 * their creation.
 */
async function resolve(
  tx: Tx,
  tenantId: string,
  reviewIds: string[],
  set: Pick<ReviewRow, "decision" | "resolvedBy"> & { mergedInto?: string },
  now?: Date,
) {
  if (reviewIds.length === 0) return;
  await tx
    .update(tagReviews)
    .set({ ...set, resolvedAt: now ?? sql`greatest(now(), ${tagReviews.createdAt})` })
    .where(and(eq(tagReviews.tenantId, tenantId), inArray(tagReviews.id, reviewIds)));
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

/**
 * Whether any grant names this tag that is live at `at` (the database's now() by default, the
 * clock grants are enforced by) or will be: not revoked or expired by then.
 */
async function hasLiveGrant(
  tx: Tx,
  tenantId: string,
  facet: string,
  value: string,
  at: Date | undefined,
) {
  const moment = at ?? sql`now()`;
  const [row] = await tx
    .select({ id: grants.id })
    .from(grants)
    .where(
      and(
        eq(grants.tenantId, tenantId),
        eq(grants.facet, facet),
        eq(grants.value, value),
        or(isNull(grants.revokedAt), gt(grants.revokedAt, moment)),
        or(isNull(grants.expiresAt), gt(grants.expiresAt, moment)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

function splitTag(tag: string): { facet: string; value: string } {
  const at = tag.indexOf(":");
  if (at <= 0 || at === tag.length - 1) throw new TagError("invalid", "a tag is facet:value");
  return { facet: tag.slice(0, at), value: tag.slice(at + 1) };
}
