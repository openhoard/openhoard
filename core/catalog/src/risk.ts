import {
  ensureBuiltInVocabulary,
  injectionReviews,
  isId,
  objectTags,
  type Tx,
} from "@openhoard/core-db";
import { and, eq, sql } from "drizzle-orm";
import { lockObject } from "./locks.js";
import { BUILTIN_RULE_PREFIX } from "./rules.js";
import { proposeTag } from "./tagging.js";

/*
 * Risk flags from built-in detectors (T-408). The injection detector (core/summarize
 * detectInjection(), run by core/jobs' injection-flag step) flags a version whose content or
 * name looks like it carries instructions for an AI. The flag is a tag, `risk:injection`, so it
 * works like any other level-bearing tag: its value sets `exposure: metadata-only`, which makes
 * the file metadata-only for every AI client (no summary, no content, core/policy decideRead())
 * and keeps its content from every model (core/policy mayProcess() refuses metadata-only),
 * while people in OpenHoard's own apps still read it.
 *
 * - The value is built-in vocabulary (core/db ensureBuiltInVocabulary()): every tenant has it,
 *   approved and metadata-only (createTenant(), migration 0046), and flagging puts it back first
 *   if a pack or an admin changed it. So a flag never depends on an admin, and never fails for
 *   want of vocabulary: a missing vocabulary can't leave files hidden.
 * - The tag is trusted: source `rule`, applied by `rule:builtin/injection-detector`, a name no
 *   pack rule can take (rule ids have no `/`), and applyRuleTags() leaves it alone.
 * - It is the detector's: when a later version (or a rename) no longer looks like an injection,
 *   the detector takes its own tag off again. A tag a person or a pack put on stays.
 * - A person can decide a file is fine (markNotInjection(): an owner or admin, object-scoped, so
 *   it survives edits): the detector then neither flags it nor keeps its own flag on it.
 */

/** The flag a detector puts on a file that looks like a prompt injection. */
export const INJECTION_TAG = "risk:injection";
/** Who applies it. */
export const INJECTION_DETECTOR = `${BUILTIN_RULE_PREFIX}injection-detector`;

/** What applyInjectionFlag() did. */
export type FlagChange = "flagged" | "already-flagged" | "cleared" | "not-flagged";

const tagKey = (tenantId: string, objectId: string) => {
  const [facet, value] = INJECTION_TAG.split(":") as [string, string];
  return and(
    eq(objectTags.tenantId, tenantId),
    eq(objectTags.objectId, objectId),
    eq(objectTags.facet, facet),
    eq(objectTags.value, value),
  );
};

/**
 * Makes the object's detector flag match `flagged`: adds `risk:injection` (as the detector's,
 * trusted) or takes the detector's own tag off. A file a person reviewed (markNotInjection()) is
 * never flagged: `flagged` is taken as false. Call it through enrichment's guarded write.
 */
export async function applyInjectionFlag(
  tx: Tx,
  tenantId: string,
  objectId: string,
  flagged: boolean,
): Promise<FlagChange> {
  await lockObject(tx, tenantId, objectId);
  const key = tagKey(tenantId, objectId);
  const [have] = await tx
    .select({ source: objectTags.source, appliedBy: objectTags.appliedBy })
    .from(objectTags)
    .where(key);
  if (!flagged || (await injectionReviewOf(tx, tenantId, objectId)) !== null) {
    if (have?.source !== "rule" || have.appliedBy !== INJECTION_DETECTOR) return "not-flagged";
    await tx.delete(objectTags).where(and(key, eq(objectTags.appliedBy, INJECTION_DETECTOR)));
    return "cleared";
  }
  // A model's guess of the same tag is taken over below (proposeTag() makes it trusted).
  if (have && have.source !== "model") return "already-flagged";
  // The value must be there, approved and metadata-only, or the flag would wait in review or
  // change nothing: the system's own vocabulary, put back if anyone changed it.
  await ensureBuiltInVocabulary(tx, tenantId);
  const outcome = await proposeTag(tx, tenantId, {
    objectId,
    tag: INJECTION_TAG,
    source: "rule",
    appliedBy: INJECTION_DETECTOR,
    confidence: 1,
  });
  // A trusted source on an approved value is applied (tagging.ts); anything else is a bug.
  if (!outcome.applied) throw new Error("the built-in risk:injection value was not applied");
  return "flagged";
}

/** Whether the object carries `risk:injection`, from anyone. */
export async function hasInjectionFlag(tx: Tx, tenantId: string, objectId: string) {
  const rows = await tx
    .select({ value: objectTags.value })
    .from(objectTags)
    .where(tagKey(tenantId, objectId));
  return rows.length > 0;
}

/** A person's "not an injection" decision on an object, or null. */
export async function injectionReviewOf(
  tx: Tx,
  tenantId: string,
  objectId: string,
): Promise<{ reviewedBy: string; reviewedAt: Date } | null> {
  if (typeof objectId !== "string" || !isId("object", objectId)) return null;
  const [row] = await tx
    .select({ reviewedBy: injectionReviews.reviewedBy, reviewedAt: injectionReviews.reviewedAt })
    .from(injectionReviews)
    .where(and(eq(injectionReviews.tenantId, tenantId), eq(injectionReviews.objectId, objectId)));
  return row ?? null;
}

const USER = /^user:usr_[0-9a-hjkmnp-tv-z]{26}$/;

/**
 * A person (the owner or an admin: the API authorizes the caller, and appends the audit record
 * in the same transaction) decides the object is not a prompt injection: the detector's own flag
 * comes off now, and the detector won't flag the object again, whatever later versions say.
 * A person's or a pack's own `risk:injection` tag stays. Returns whether a flag came off.
 */
export async function markNotInjection(
  tx: Tx,
  tenantId: string,
  input: { objectId: string; by: string },
): Promise<boolean> {
  if (!isId("object", input.objectId)) throw new TypeError("markNotInjection: not an object id");
  if (!USER.test(input.by)) throw new TypeError("markNotInjection: by must be user:usr_…");
  await lockObject(tx, tenantId, input.objectId);
  await tx
    .insert(injectionReviews)
    .values({ tenantId, objectId: input.objectId, reviewedBy: input.by })
    .onConflictDoUpdate({
      target: [injectionReviews.tenantId, injectionReviews.objectId],
      set: { reviewedBy: input.by, reviewedAt: sql`now()` },
    });
  const removed = await tx
    .delete(objectTags)
    .where(and(tagKey(tenantId, input.objectId), eq(objectTags.appliedBy, INJECTION_DETECTOR)))
    .returning({ facet: objectTags.facet });
  return removed.length > 0;
}

/**
 * Withdraws a "not an injection" decision: the detector judges the object again from its next
 * enrichment (a new version, a rename, or a re-run). Returns whether there was one.
 */
export async function clearInjectionReview(
  tx: Tx,
  tenantId: string,
  objectId: string,
): Promise<boolean> {
  if (typeof objectId !== "string" || !isId("object", objectId)) return false;
  const removed = await tx
    .delete(injectionReviews)
    .where(and(eq(injectionReviews.tenantId, tenantId), eq(injectionReviews.objectId, objectId)))
    .returning({ objectId: injectionReviews.objectId });
  return removed.length > 0;
}
