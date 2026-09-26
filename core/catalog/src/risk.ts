import { appendAudit } from "@openhoard/core-audit";
import {
  ensureBuiltInVocabulary,
  injectionReviews,
  isId,
  objectTags,
  versions,
  type Tx,
} from "@openhoard/core-db";
import { isAdmin } from "@openhoard/core-identity";
import { and, desc, eq, sql } from "drizzle-orm";
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
 *   approved and metadata-only (createTenant(), migration 0046, and before every flag), and the
 *   database refuses any change to its levels or its removal (migration 0050). So a flag never
 *   depends on an admin, and a missing vocabulary can't leave files hidden.
 * - The tag is trusted: source `rule`, applied by `rule:builtin/injection-detector`, a name no
 *   pack rule can take (rule ids have no `/`), and applyRuleTags() leaves it alone.
 * - It is the detector's: when a later version (or a rename) no longer looks like an injection,
 *   the detector takes its own tag off again. A tag a person or a pack put on stays.
 * - A tenant admin can decide a file is fine (markNotInjection(); never the owner, who is who an
 *   insider attack would come from): for the content they reviewed, the detector then neither
 *   flags it nor keeps its own flag on it. A new version with other content is judged again.
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
 * trusted) or takes the detector's own tag off. A file an admin reviewed (markNotInjection()),
 * while its current version has the content they reviewed, is never flagged: `flagged` is taken
 * as false. Call it through enrichment's guarded write.
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
  if (!flagged || (await reviewedNotInjection(tx, tenantId, objectId))) {
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

/** An admin's "not an injection" decision on an object, for the content they reviewed. */
export interface InjectionReview {
  versionId: string;
  blobId: string;
  reviewedBy: string;
  reviewedAt: Date;
}

/** The object's review, whatever version it was for, or null. */
export async function injectionReviewOf(
  tx: Tx,
  tenantId: string,
  objectId: string,
): Promise<InjectionReview | null> {
  if (typeof objectId !== "string" || !isId("object", objectId)) return null;
  const [row] = await tx
    .select({
      versionId: injectionReviews.versionId,
      blobId: injectionReviews.blobId,
      reviewedBy: injectionReviews.reviewedBy,
      reviewedAt: injectionReviews.reviewedAt,
    })
    .from(injectionReviews)
    .where(and(eq(injectionReviews.tenantId, tenantId), eq(injectionReviews.objectId, objectId)));
  return row ?? null;
}

/** The object's current version and its content, or null. */
async function currentVersionOf(tx: Tx, tenantId: string, objectId: string) {
  const [row] = await tx
    .select({ versionId: versions.id, blobId: versions.blobId })
    .from(versions)
    .where(and(eq(versions.tenantId, tenantId), eq(versions.objectId, objectId)))
    .orderBy(desc(versions.seq))
    .limit(1);
  return row ?? null;
}

/**
 * Whether an admin's "not an injection" decision covers the object's current version: it has
 * the content (blob) they reviewed. A new version with other bytes is judged again.
 */
export async function reviewedNotInjection(
  tx: Tx,
  tenantId: string,
  objectId: string,
): Promise<boolean> {
  const review = await injectionReviewOf(tx, tenantId, objectId);
  if (review === null) return false;
  const current = await currentVersionOf(tx, tenantId, objectId);
  return current !== null && current.blobId === review.blobId;
}

/** Why an injection review was refused. */
export class InjectionReviewError extends Error {
  constructor(
    readonly code: "invalid" | "not-admin" | "unknown-object",
    message: string,
  ) {
    super(message);
    this.name = "InjectionReviewError";
  }
}

const USER = /^user:(usr_[0-9a-hjkmnp-tv-z]{26})$/;

/** Checks the input and that `by` is an admin now; returns the user id. */
async function checkReviewer(
  tx: Tx,
  tenantId: string,
  input: { objectId: string; by: string; adminGroupId?: string | undefined },
): Promise<void> {
  if (typeof input.objectId !== "string" || !isId("object", input.objectId)) {
    throw new InjectionReviewError("invalid", "not an object id");
  }
  const user = typeof input.by === "string" ? USER.exec(input.by)?.[1] : undefined;
  if (user === undefined) throw new InjectionReviewError("invalid", "by must be user:usr_…");
  // Admins only, never the owner as such: an owner could otherwise clear their own flag.
  const admin = await isAdmin(tx, tenantId, user, {
    ...(input.adminGroupId === undefined ? {} : { adminGroupId: input.adminGroupId }),
  });
  if (!admin) throw new InjectionReviewError("not-admin", "only a tenant admin reviews a flag");
}

/**
 * A tenant admin decides the object's current version is not a prompt injection: the detector's
 * own flag comes off now, and the detector won't flag the object again while its current version
 * has this content. A person's or a pack's own `risk:injection` tag stays. The audit record
 * (`injection.review`) is appended in the same transaction, last; run it in a read-write
 * transaction (READ COMMITTED). Throws InjectionReviewError (`not-admin`, `unknown-object`,
 * `invalid`), writing nothing. Returns whether a flag came off.
 */
export async function markNotInjection(
  tx: Tx,
  tenantId: string,
  input: { objectId: string; by: string; adminGroupId?: string },
): Promise<boolean> {
  await checkReviewer(tx, tenantId, input);
  await lockObject(tx, tenantId, input.objectId);
  const current = await currentVersionOf(tx, tenantId, input.objectId);
  if (current === null) throw new InjectionReviewError("unknown-object", "no such object");
  await tx
    .insert(injectionReviews)
    .values({ tenantId, objectId: input.objectId, ...current, reviewedBy: input.by })
    .onConflictDoUpdate({
      target: [injectionReviews.tenantId, injectionReviews.objectId],
      set: { ...current, reviewedBy: input.by, reviewedAt: sql`now()` },
    });
  const removed = await tx
    .delete(objectTags)
    .where(and(tagKey(tenantId, input.objectId), eq(objectTags.appliedBy, INJECTION_DETECTOR)))
    .returning({ facet: objectTags.facet });
  await appendAudit(tx, tenantId, {
    actor: input.by,
    action: "injection.review",
    decision: "allow",
    object: input.objectId,
    version: current.versionId,
    detail: { flagCleared: removed.length > 0 },
  });
  return removed.length > 0;
}

/**
 * A tenant admin withdraws a "not an injection" decision: the detector judges the object again
 * from its next enrichment (a new version, a rename, or a re-run). Audited
 * (`injection.review-withdrawn`) in the same transaction. Returns whether there was one.
 */
export async function clearInjectionReview(
  tx: Tx,
  tenantId: string,
  input: { objectId: string; by: string; adminGroupId?: string },
): Promise<boolean> {
  await checkReviewer(tx, tenantId, input);
  const removed = await tx
    .delete(injectionReviews)
    .where(
      and(eq(injectionReviews.tenantId, tenantId), eq(injectionReviews.objectId, input.objectId)),
    )
    .returning({ objectId: injectionReviews.objectId });
  if (removed.length === 0) return false;
  await appendAudit(tx, tenantId, {
    actor: input.by,
    action: "injection.review-withdrawn",
    decision: "allow",
    object: input.objectId,
  });
  return true;
}
