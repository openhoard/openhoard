import { blobs, isId, objects, sourceRefs, versions, type Tx } from "@openhoard/core-db";
import type { Authorizer } from "@openhoard/core-policy";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { INGEST_LIMITS } from "./ingest.js";
import type { ActivityType } from "./activity.js";
import {
  requireSnapshot,
  viewObjects,
  type CardView,
  type ObjectView,
  type RecordedRequest,
} from "./visibility.js";

/*
 * The catalog read API (T-206): what a caller may know about objects, by id, by where they came
 * from, and their versions. Every function here decides through viewObjects(), the one gate:
 * it authorizes `read` for the caller and applies the object's levels, so a file the caller
 * may not know about is left out exactly as an unknown id is. None of them returns content:
 * openContent() says which blob to read, and the caller reads it from core/storage.
 *
 * Each one records the caller's activity (T-205) in the request's recorder, which it must
 * have: a `view` when a reader looked at the file (not a non-reader's card or title), an `open`
 * for openContent(). See activity.ts.
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
  request: RecordedRequest,
  objectId: string,
): Promise<ObjectView | null> {
  await requireSnapshot(tx, "viewObject");
  requireRecorder(request);
  if (typeof objectId !== "string" || !isId("object", objectId)) return null;
  const [view] = await viewObjects(tx, tenantId, authz, request, [objectId]);
  if (!view) return null;
  noteView(request, view);
  return view;
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
  request: RecordedRequest,
  item: SourceItem,
): Promise<ObjectView | null> {
  await requireSnapshot(tx, "viewBySource");
  requireRecorder(request);
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
  const [view] = await viewObjects(tx, tenantId, authz, request, [ref.objectId]);
  if (!view) return null;
  noteView(request, view);
  return view;
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
  request: RecordedRequest,
  objectId: string,
): Promise<VersionView[] | null> {
  await requireSnapshot(tx, "listVersions");
  requireRecorder(request);
  if (typeof objectId !== "string" || !isId("object", objectId)) return null;
  const [view] = await viewObjects(tx, tenantId, authz, request, [objectId]);
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
  noteView(request, view);
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

/** What openContent() hands the caller: which bytes to serve, never the bytes. */
export interface OpenedContent {
  view: CardView;
  version: VersionView;
  /** The content's blob: read it from core/storage (`BlobStore.read(tenantId, blobId)`). */
  blobId: string;
  /**
   * Where OpenHoard holds the bytes (a managed zone), or null when the source holds them (an
   * indexed zone): the source's connector fetches them.
   */
  location: string | null;
}

/**
 * Opening a file (T-205): which content the caller may have, the current version's or, with
 * `versionId`, an earlier one's. It takes a reader, `open` authorized for them, and levels that
 * let their client have the content (an AI client's trust against the file's exposure); an
 * earlier version, only through a first-party client, since the levels are the current
 * content's. Null when any of that fails, or there is no such file or version,
 * indistinguishably; viewObject() tells a reader whether they can read the file at all.
 * Records an `open` of that version.
 */
export async function openContent(
  tx: Tx,
  tenantId: string,
  authz: Authorizer,
  request: RecordedRequest,
  objectId: string,
  options: { versionId?: string } = {},
): Promise<OpenedContent | null> {
  await requireSnapshot(tx, "openContent");
  requireRecorder(request);
  if (typeof objectId !== "string" || !isId("object", objectId)) return null;
  const wanted = options.versionId;
  if (wanted !== undefined && (typeof wanted !== "string" || !isId("version", wanted))) {
    return null;
  }
  const [view] = await viewObjects(tx, tenantId, authz, request, [objectId], { content: true });
  if (view?.shape !== "card" || !view.readable) return null;
  // The newest version, and the one asked for when that is another.
  const rows = await tx
    .select({
      id: versions.id,
      seq: versions.seq,
      mime: versions.mime,
      size: blobs.size,
      authorId: versions.authorId,
      createdAt: versions.createdAt,
      processedAt: versions.processedAt,
      blobId: blobs.id,
      location: blobs.location,
    })
    .from(versions)
    .innerJoin(blobs, and(eq(blobs.tenantId, versions.tenantId), eq(blobs.id, versions.blobId)))
    .where(
      and(
        eq(versions.tenantId, tenantId),
        eq(versions.objectId, objectId),
        wanted === undefined
          ? undefined
          : or(eq(versions.id, wanted), eq(versions.seq, newestSeq(tenantId, objectId))),
      ),
    )
    .orderBy(desc(versions.seq))
    .limit(2);
  const i = wanted === undefined ? 0 : rows.findIndex((r) => r.id === wanted);
  const row = rows[i];
  if (!row) return null;
  // Levels and rules describe the current content: an earlier version may have been tagged
  // stricter, or never processed. Until levels are kept per version, only a person, through
  // OpenHoard, opens one.
  if (i !== 0 && request.client.trust !== "first-party") return null;
  noteActivity(request, "open", view.id, row.id);
  return {
    view,
    version: {
      id: row.id,
      seq: row.seq,
      mime: row.mime,
      size: row.size,
      authorId: row.authorId,
      createdAt: row.createdAt,
      processed: row.processedAt !== null,
      current: i === 0,
    },
    blobId: row.blobId,
    location: row.location,
  };
}

/** The newest version's seq of an object, as a subquery. */
function newestSeq(tenantId: string, objectId: string) {
  return sql`(select max(v.seq) from versions v where v.tenant_id = ${tenantId} and v.object_id = ${objectId})`;
}

/** A recording read refuses a request without a recorder, before it reads anything. */
function requireRecorder(request: RecordedRequest): void {
  if (typeof request.activity?.record !== "function") {
    throw new TypeError("a read of one file needs request.activity (an ActivityRecorder)");
  }
}

/** A reader's look at the file is a view; a non-reader's card or title isn't. */
function noteView(request: RecordedRequest, view: ObjectView): void {
  if (view.shape === "card" && view.readable) noteActivity(request, "view", view.id, null);
}

/** Records the caller's activity. */
function noteActivity(
  request: RecordedRequest,
  type: ActivityType,
  objectId: string,
  versionId: string | null,
): void {
  request.activity.record({
    type,
    actor: `user:${request.principal.userId}`,
    objectId,
    versionId,
    client: request.client,
  });
}
