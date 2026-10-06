import { withheldFromAi } from "@openhoard/core-catalog";
import { sourceRefs, type Tx } from "@openhoard/core-db";
import { canonicalUrl, checkUrl } from "@openhoard/sdk";
import { and, asc, eq, isNotNull } from "drizzle-orm";

/** Why a file has no link for an AI client, in words for the assistant. */
const NO_LINK = {
  flagged:
    "No link: this file is flagged as possibly carrying instructions for AI. The person can find it in OpenHoard.",
  unprocessed:
    "No link yet: this file hasn't been checked since it last changed. The person can find it in OpenHoard.",
  none: "No web link is recorded for this file.",
} as const;

/**
 * The web address the file's source recorded for it, as an AI client may have it, or why there
 * is none. One answer for `open` and `describe`:
 *
 * - none for a file flagged as possibly carrying instructions for AI, or not looked at yet
 *   (core/catalog withheldFromAi()): an assistant that browses could fetch them from there;
 * - https only, never javascript:, data:, file: or a credentialed URL, and canonical
 *   (@openhoard/sdk checkUrl/canonicalUrl), no longer than `max`.
 *
 * For a file the caller may read: the caller checks that.
 */
export async function webLink(
  tx: Tx,
  tenantId: string,
  objectId: string,
  max = Infinity,
): Promise<{ link: string } | { link: null; reason: string }> {
  const withheld = await withheldFromAi(tx, tenantId, objectId);
  if (withheld) return { link: null, reason: NO_LINK[withheld] };
  const refs = await tx
    .select({ url: sourceRefs.url })
    .from(sourceRefs)
    .where(
      and(
        eq(sourceRefs.tenantId, tenantId),
        eq(sourceRefs.objectId, objectId),
        isNotNull(sourceRefs.url),
      ),
    )
    .orderBy(asc(sourceRefs.source), asc(sourceRefs.externalId));
  for (const { url } of refs) {
    if (url === null || checkUrl(url) !== null) continue;
    const link = canonicalUrl(url);
    if (link.length <= max) return { link };
  }
  return { link: null, reason: NO_LINK.none };
}
