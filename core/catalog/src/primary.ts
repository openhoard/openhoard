import {
  facetValues,
  newId,
  objects,
  objectTags,
  tagOf,
  tagReviews,
  type Tx,
} from "@openhoard/core-db";
import { and, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { lockObject } from "./locks.js";
import { TagError } from "./tag-error.js";

/*
 * The primary tag (T-409, FR-21): an object's home, the one tag that says where it belongs, as a
 * folder used to. It decides the default view and breadcrumb, the path when the object is opened
 * in a native app or synced, who it goes to at offboarding, and the project's email-in and
 * digest. It grants nothing: access still comes from the tag itself, like any other.
 *
 * - At most one per object, and always one of the object's trusted tags (a person's, a rule's or
 *   a pack's, or a model's a person reviewed). The database holds both rules; a tag that stops
 *   being trusted (rules.ts hands a rule's tag back to the model) stops being primary.
 * - A person sets or clears it (the API records who; these functions trust their caller, as
 *   tagging.ts does). A rule marked `primary` sets it, unless a person chose the home: rules
 *   never override a person's choice (rules.ts applyRuleTags). A model only proposes it, through
 *   the review inbox (reason `primary`), and a person approves; a proposal whose tag has left
 *   the object is withdrawn when the model proposes again.
 * - It goes when its tag goes; nothing picks another one in its place. A single-value facet's
 *   value a person chose takes over the home from the value it replaces, as that person's
 *   (tagging.ts).
 *
 * Locks follow locks.ts: the object's lock, then its rows.
 */

export interface PrimaryTag {
  tag: string;
  /** Who made it the home: `user:…` (a person) or `rule:…` (`pack:…` is reserved). */
  by: string;
}

const PRINCIPAL = /^[a-z]+:[^\0]+$/;
const PRINCIPAL_MAX = 1024;
const principal = (p: string, kind: string) =>
  p.startsWith(`${kind}:`) && PRINCIPAL.test(p) && p.length <= PRINCIPAL_MAX;

/** The object's primary tag, or null when it has none. */
export async function primaryTagOf(
  tx: Tx,
  tenantId: string,
  objectId: string,
): Promise<PrimaryTag | null> {
  const [row] = await tx
    .select({ facet: objectTags.facet, value: objectTags.value, by: objectTags.primaryBy })
    .from(objectTags)
    .where(
      and(
        eq(objectTags.tenantId, tenantId),
        eq(objectTags.objectId, objectId),
        isNotNull(objectTags.primaryBy),
      ),
    );
  return row ? { tag: tagOf(row.facet, row.value), by: row.by as string } : null;
}

/** A person makes `tag`, which the object carries as a trusted tag, its primary tag. */
export async function setPrimaryTag(
  tx: Tx,
  tenantId: string,
  input: { objectId: string; tag: string; by: string },
): Promise<void> {
  if (!principal(input.by, "user")) {
    throw new TagError("invalid", "by must be the person setting it, user:…");
  }
  await makePrimary(tx, tenantId, input.objectId, input.tag, input.by);
}

/** Leaves the object with no primary tag. Returns whether it had one. */
export async function clearPrimaryTag(
  tx: Tx,
  tenantId: string,
  objectId: string,
): Promise<boolean> {
  await lockObject(tx, tenantId, objectId);
  const cleared = await tx
    .update(objectTags)
    .set({ primaryBy: null })
    .where(
      and(
        eq(objectTags.tenantId, tenantId),
        eq(objectTags.objectId, objectId),
        isNotNull(objectTags.primaryBy),
      ),
    )
    .returning({ value: objectTags.value });
  return cleared.length > 0;
}

export type PrimaryProposalOutcome =
  /** It is the primary tag already. */
  | { primary: true }
  /** Waiting for a person: this proposal's item, or one proposed earlier that still waits. */
  | { primary: false; reviewId: string; tag: string };

/**
 * A model proposes which of the object's trusted tags is its home. It never applies: it waits
 * in the review inbox for a person, one open proposal per object (a later one while it waits
 * changes nothing, and gets that item back).
 */
export async function proposePrimaryTag(
  tx: Tx,
  tenantId: string,
  input: { objectId: string; tag: string; appliedBy?: string; confidence: number },
): Promise<PrimaryProposalOutcome> {
  const { facet, value } = split(input.tag);
  if (!(input.confidence >= 0 && input.confidence <= 1)) {
    throw new TagError("invalid", "confidence must be in [0, 1]");
  }
  const appliedBy = input.appliedBy ?? null;
  if (appliedBy !== null && !principal(appliedBy, "model")) {
    throw new TagError("invalid", "appliedBy must be a model: principal");
  }
  await lockObject(tx, tenantId, input.objectId);
  const row = await trustedTag(tx, tenantId, input.objectId, facet, value);
  if (row.primaryBy !== null) return { primary: true };
  const [waiting] = await tx
    .select({
      id: tagReviews.id,
      facet: tagReviews.facet,
      value: tagReviews.value,
      appliedBy: tagReviews.appliedBy,
    })
    .from(tagReviews)
    .where(
      and(
        eq(tagReviews.tenantId, tenantId),
        eq(tagReviews.objectId, input.objectId),
        eq(tagReviews.reason, "primary"),
        isNull(tagReviews.resolvedAt),
      ),
    );
  if (waiting) {
    const stands = await trustedTag(tx, tenantId, input.objectId, waiting.facet, waiting.value)
      .then(() => true)
      .catch((e: unknown) => {
        if (e instanceof TagError && e.code === "not-on-object") return false;
        throw e;
      });
    if (stands) {
      return { primary: false, reviewId: waiting.id, tag: tagOf(waiting.facet, waiting.value) };
    }
    // Its tag left the object, or stopped being trusted: nobody can approve it any more.
    await tx
      .update(tagReviews)
      .set({
        decision: "withdrawn",
        resolvedBy: waiting.appliedBy ?? "model:unknown",
        resolvedAt: sql`greatest(now(), ${tagReviews.createdAt})`,
      })
      .where(and(eq(tagReviews.tenantId, tenantId), eq(tagReviews.id, waiting.id)));
  }
  const reviewId = newId("review");
  await tx.insert(tagReviews).values({
    tenantId,
    id: reviewId,
    objectId: input.objectId,
    facet,
    value,
    reason: "primary",
    source: "model",
    appliedBy,
    confidence: input.confidence,
  });
  return { primary: false, reviewId, tag: input.tag };
}

/**
 * Makes `tag` the object's primary tag, as `by`, in place of any other. For tagging.ts (a person
 * approving a model's proposal) and rules.ts (a rule marked primary); callers check `by`.
 */
export async function makePrimary(
  tx: Tx,
  tenantId: string,
  objectId: string,
  tag: string,
  by: string,
): Promise<void> {
  const { facet, value } = split(tag);
  await lockObject(tx, tenantId, objectId);
  const row = await trustedTag(tx, tenantId, objectId, facet, value);
  if (row.primaryBy === by) return;
  const onObject = and(eq(objectTags.tenantId, tenantId), eq(objectTags.objectId, objectId));
  // The old home first: the database allows one at a time.
  await tx
    .update(objectTags)
    .set({ primaryBy: null })
    .where(
      and(
        onObject,
        isNotNull(objectTags.primaryBy),
        or(ne(objectTags.facet, facet), ne(objectTags.value, value)),
      ),
    );
  await tx
    .update(objectTags)
    .set({ primaryBy: by })
    .where(and(onObject, eq(objectTags.facet, facet), eq(objectTags.value, value)));
}

/**
 * The object's tag, if it carries it as a trusted tag; `not-on-object` otherwise, and
 * `unknown-object` when there is no such object.
 */
async function trustedTag(
  tx: Tx,
  tenantId: string,
  objectId: string,
  facet: string,
  value: string,
) {
  const [row] = await tx
    .select({
      source: objectTags.source,
      reviewed: objectTags.reviewed,
      primaryBy: objectTags.primaryBy,
      approved: facetValues.approved,
    })
    .from(objectTags)
    .innerJoin(
      facetValues,
      and(
        eq(facetValues.tenantId, objectTags.tenantId),
        eq(facetValues.facet, objectTags.facet),
        eq(facetValues.value, objectTags.value),
      ),
    )
    .where(
      and(
        eq(objectTags.tenantId, tenantId),
        eq(objectTags.objectId, objectId),
        eq(objectTags.facet, facet),
        eq(objectTags.value, value),
      ),
    );
  if (!row) {
    const [object] = await tx
      .select({ id: objects.id })
      .from(objects)
      .where(and(eq(objects.tenantId, tenantId), eq(objects.id, objectId)));
    if (!object) throw new TagError("unknown-object", `no object ${objectId}`);
  }
  if (!row || !row.approved || (row.source === "model" && !row.reviewed)) {
    throw new TagError(
      "not-on-object",
      `${tagOf(facet, value)} is not one of the object's trusted tags`,
    );
  }
  return row;
}

function split(tag: string): { facet: string; value: string } {
  const at = tag.indexOf(":");
  if (at <= 0 || at === tag.length - 1) throw new TagError("invalid", "a tag is facet:value");
  return { facet: tag.slice(0, at), value: tag.slice(at + 1) };
}
