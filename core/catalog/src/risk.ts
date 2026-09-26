import { facetValues, objectTags, type Tx } from "@openhoard/core-db";
import { and, eq } from "drizzle-orm";
import { lockObject } from "./locks.js";
import { BUILTIN_RULE_PREFIX } from "./rules.js";
import { proposeTag } from "./tagging.js";

/*
 * Risk flags from built-in detectors (T-408). The injection detector (core/summarize
 * detectInjection(), run by core/jobs' injection-flag step) flags a version whose content or
 * name looks like it carries instructions for an AI. The flag is a tag, `risk:injection`, so it
 * works like any other level-bearing tag: the starter pack gives the value `exposure:
 * metadata-only`, which makes the file metadata-only for every AI client (no summary, no
 * content, core/policy decideRead()) and keeps its content from every model (core/policy
 * mayProcess() refuses metadata-only), while people in OpenHoard's own apps still read it.
 *
 * - The tag is trusted: source `rule`, applied by `rule:builtin/injection-detector`, a name no
 *   pack rule can take (rule ids have no `/`), and applyRuleTags() leaves it alone.
 * - It is the detector's: when a later version (or a rename) no longer looks like an injection,
 *   the detector takes its own tag off again. A tag a person or a pack put on stays.
 * - Nothing creates vocabulary, detectors included. If the tenant has no approved
 *   `risk:injection` that sets `exposure: metadata-only` (the starter pack's `risk` facet),
 *   flagging throws RiskVocabularyError: the job fails and retries, and the version stays
 *   unprocessed, which is hidden and metadata-only, until an admin applies the pack. Fail closed.
 */

/** The flag a detector puts on a file that looks like a prompt injection. */
export const INJECTION_TAG = "risk:injection";
/** Who applies it. */
export const INJECTION_DETECTOR = `${BUILTIN_RULE_PREFIX}injection-detector`;

/** The tenant lacks the vocabulary a flag needs to have its effect. */
export class RiskVocabularyError extends Error {
  constructor(readonly tag: string) {
    super(
      `${tag} is not approved vocabulary with exposure metadata-only in this tenant: apply the starter pack (its risk facet)`,
    );
    this.name = "RiskVocabularyError";
  }
}

/** What applyInjectionFlag() did. */
export type FlagChange = "flagged" | "already-flagged" | "cleared" | "not-flagged";

/**
 * Makes the object's detector flag match `flagged`: adds `risk:injection` (as the detector's,
 * trusted) or takes the detector's own tag off. Call it through enrichment's guarded write.
 */
export async function applyInjectionFlag(
  tx: Tx,
  tenantId: string,
  objectId: string,
  flagged: boolean,
): Promise<FlagChange> {
  const [facet, value] = INJECTION_TAG.split(":") as [string, string];
  await lockObject(tx, tenantId, objectId);
  const key = and(
    eq(objectTags.tenantId, tenantId),
    eq(objectTags.objectId, objectId),
    eq(objectTags.facet, facet),
    eq(objectTags.value, value),
  );
  const [have] = await tx
    .select({ source: objectTags.source, appliedBy: objectTags.appliedBy })
    .from(objectTags)
    .where(key);
  if (!flagged) {
    if (have?.source !== "rule" || have.appliedBy !== INJECTION_DETECTOR) return "not-flagged";
    await tx.delete(objectTags).where(and(key, eq(objectTags.appliedBy, INJECTION_DETECTOR)));
    return "cleared";
  }
  // A model's guess of the same tag is taken over below (proposeTag() makes it trusted).
  if (have && have.source !== "model") return "already-flagged";
  // The value must exist, be approved, and make the file metadata-only; else the flag would
  // wait in review or change nothing.
  const [v] = await tx
    .select({ approved: facetValues.approved, exposure: facetValues.exposure })
    .from(facetValues)
    .where(
      and(
        eq(facetValues.tenantId, tenantId),
        eq(facetValues.facet, facet),
        eq(facetValues.value, value),
      ),
    );
  if (!v?.approved || v.exposure !== "metadata-only") throw new RiskVocabularyError(INJECTION_TAG);
  const outcome = await proposeTag(tx, tenantId, {
    objectId,
    tag: INJECTION_TAG,
    source: "rule",
    appliedBy: INJECTION_DETECTOR,
    confidence: 1,
  });
  // A trusted source on an approved value is applied (tagging.ts); anything else is a bug.
  if (!outcome.applied) throw new RiskVocabularyError(INJECTION_TAG);
  return "flagged";
}

/** Whether the object carries `risk:injection`, from anyone. */
export async function hasInjectionFlag(tx: Tx, tenantId: string, objectId: string) {
  const [facet, value] = INJECTION_TAG.split(":") as [string, string];
  const rows = await tx
    .select({ value: objectTags.value })
    .from(objectTags)
    .where(
      and(
        eq(objectTags.tenantId, tenantId),
        eq(objectTags.objectId, objectId),
        eq(objectTags.facet, facet),
        eq(objectTags.value, value),
      ),
    );
  return rows.length > 0;
}
