import { sourceRefs, versions, type Tx } from "@openhoard/core-db";
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";

/*
 * Small reads for callers that have put the files through the gate already (viewObjects): what
 * a card doesn't carry. Trusted: they decide nothing about who may see the file (T-1405, so that
 * no route or tool reads the catalog's tables itself).
 */

/**
 * The web addresses the file's sources recorded for it, as recorded (not checked), in a stable
 * order (by source, then external id).
 */
export async function sourceUrls(tx: Tx, tenantId: string, objectId: string): Promise<string[]> {
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
  return refs.flatMap((r) => (r.url === null ? [] : [r.url]));
}

/** Each object's current version id (its highest seq), for the objects that have one. */
export async function currentVersionIds(
  tx: Tx,
  tenantId: string,
  objectIds: readonly string[],
): Promise<Map<string, string>> {
  if (objectIds.length === 0) return new Map();
  const current = await tx
    .selectDistinctOn([versions.objectId], { objectId: versions.objectId, id: versions.id })
    .from(versions)
    .where(and(eq(versions.tenantId, tenantId), inArray(versions.objectId, [...objectIds])))
    .orderBy(versions.objectId, desc(versions.seq));
  return new Map(current.map((r) => [r.objectId, r.id]));
}
