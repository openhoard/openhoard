import { blobs, isId, objects, sourceRefs, versions, type Tx } from "@openhoard/core-db";
import type { Authorizer } from "@openhoard/core-policy";
import { and, desc, eq, isNull } from "drizzle-orm";
import { INGEST_LIMITS } from "./ingest.js";
import { requireSnapshot, viewObjects, type ObjectView, type ViewRequest } from "./visibility.js";

/*
 * The catalog read API (T-206): what a caller may know about objects, by id, by where they came
 * from, and their versions. Every function here decides through viewObjects(), the one gate:
 * it authorizes `read` for the caller and applies the object's levels, so a file the caller
 * may not know about is left out exactly as an unknown id is. Nothing here returns content.
 *
 * The other catalog exports that read (levelsFor, sourceItemState, primaryTagOf, explainAccess,
 * listOpenReviews…) answer without a caller's policy: they are for enrichment, connectors,
 * admins and the API's own checks, and must not be exposed to a caller without one.
 * read-surface.test.ts lists which export is which, and fails on a new one until someone
 * classifies it; a gated function queries nothing but sourceRefs before the gate.
 *
 * Run these in a snapshot (VIEW_TRANSACTION). Each checks that first, before it reads anything,
 * so a call outside one fails the same way whether or not the object exists. Input that can't
 * name anything (a malformed id, a NUL byte) is an unknown object: null, not an error.
 */

/** One object's view for the caller, or null when they may not know about it (or it is gone). */
export async function viewObject(
  tx: Tx,
  tenantId: string,
  authz: Authorizer,
  request: ViewRequest,
  objectId: string,
): Promise<ObjectView | null> {
  await requireSnapshot(tx, "viewObject");
  if (typeof objectId !== "string" || !isId("object", objectId)) return null;
  const [view] = await viewObjects(tx, tenantId, authz, request, [objectId]);
  return view ?? null;
}

/** Where an item came from: a connector's source and the item's id there. */
export interface SourceItem {
  source: string;
  externalId: string;
}

/**
 * The view of the object behind a source item (a SharePoint item id, say), or null when there is
 * none or the caller may not know about it. For deep links and "open in OpenHoard".
 */
export async function viewBySource(
  tx: Tx,
  tenantId: string,
  authz: Authorizer,
  request: ViewRequest,
  item: SourceItem,
): Promise<ObjectView | null> {
  await requireSnapshot(tx, "viewBySource");
  const named = (s: unknown) => typeof s === "string" && s.length > 0 && !s.includes("\0");
  if (
    !named(item.source) ||
    !named(item.externalId) ||
    [...item.externalId].length > INGEST_LIMITS.externalId
  ) {
    return null;
  }
  const [ref] = await tx
    .select({ objectId: sourceRefs.objectId })
    .from(sourceRefs)
    .where(
      and(
        eq(sourceRefs.tenantId, tenantId),
        eq(sourceRefs.source, item.source),
        eq(sourceRefs.externalId, item.externalId),
      ),
    );
  if (!ref) return null;
  return viewObject(tx, tenantId, authz, request, ref.objectId);
}

/** One version of an object, as its readers see it: metadata, never content or the blob. */
export interface VersionView {
  id: string;
  /** 1, 2, 3… */
  seq: number;
  mime: string;
  /** Bytes. */
  size: number;
  /** Who saved it, when the source says. */
  authorId: string | null;
  createdAt: Date;
  /** Whether enrichment has finished with it. */
  processed: boolean;
  /** The newest version: what opening the file opens. */
  current: boolean;
}

/**
 * An object's versions, newest first, for someone who can read it; null for anyone else (or
 * when there is no such object), indistinguishably. A title-only view or a non-reader's card
 * gets null: which versions exist, when and by whom is a reader's to know. A file deleted and
 * restored (re-ingested) keeps its history: its versions from before are listed too.
 */
export async function listVersions(
  tx: Tx,
  tenantId: string,
  authz: Authorizer,
  request: ViewRequest,
  objectId: string,
): Promise<VersionView[] | null> {
  await requireSnapshot(tx, "listVersions");
  const view = await viewObject(tx, tenantId, authz, request, objectId);
  if (view?.shape !== "card" || !view.readable) return null;
  const rows = await tx
    .select({
      id: versions.id,
      seq: versions.seq,
      mime: versions.mime,
      size: blobs.size,
      authorId: versions.authorId,
      createdAt: versions.createdAt,
      processedAt: versions.processedAt,
    })
    .from(versions)
    .innerJoin(blobs, and(eq(blobs.tenantId, versions.tenantId), eq(blobs.id, versions.blobId)))
    .innerJoin(
      objects,
      and(eq(objects.tenantId, versions.tenantId), eq(objects.id, versions.objectId)),
    )
    .where(
      and(
        eq(versions.tenantId, tenantId),
        eq(versions.objectId, objectId),
        isNull(objects.deletedAt),
      ),
    )
    .orderBy(desc(versions.seq));
  return rows.map((r, i) => ({
    id: r.id,
    seq: r.seq,
    mime: r.mime,
    size: r.size,
    authorId: r.authorId,
    createdAt: r.createdAt,
    processed: r.processedAt !== null,
    current: i === 0,
  }));
}
