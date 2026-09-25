import {
  blobs,
  idPattern,
  isId,
  newId,
  objects,
  sourceRefs,
  users,
  versions,
  zones,
  type Tx,
} from "@openhoard/core-db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { writeActivity } from "./activity.js";
import { contentHasher, scopedBlobId } from "./hash.js";
import { lockObject, lockSourceItem } from "./locks.js";

/*
 * Ingest (T-204): turns "this item exists in a source, with these bytes" into catalog rows.
 *
 *   one source item (source, external id) → one object → versions 1, 2, 3… → one blob each
 *
 * - Identical bytes in a tenant are one blob, however many objects and versions point at it.
 * - An item seen again with the same content and media type adds no version; only its source
 *   reference (eTag, URL, sync time), the version's source marker and the object's title are
 *   refreshed. An item seen without a media type keeps the one it had.
 * - A new version, or a rename, leaves the object unprocessed until enrichment finishes again
 *   (core/catalog visibility.ts: hidden from non-readers meanwhile).
 * - Re-ingesting an item that removeFromSource() marked deleted restores it.
 * - An item keeps its zone and owner: a crawl can't move an object to another zone or give it
 *   to someone else. Ownership changes go through the API (M2 offboarding).
 *
 * In M1 every zone is index-only: the caller hashes the bytes with blobIdOf() and passes no
 * location. Managed zones (M3) store the bytes first (core/storage BlobStore.put) and pass the
 * location; ingest refuses a managed-zone object without one, and a location for any other zone.
 * A blob keeps the first location recorded for it: storage paths derive from the blob id, so a
 * different one is refused (blob-mismatch).
 *
 * A new object's owner is `user:` and the id of an existing user who isn't retired.
 *
 * Every input is checked before anything is written, and a refused item throws IngestError with
 * a code, so a connector can report it and go on. Callers should:
 *
 * - ingest one item per transaction (or per savepoint), and retry on deadlock or serialization
 *   failure (SQLSTATE 40P01, 40001): items that share blobs lock them in the order they meet;
 * - apply one item's events in the source's order: ingest records what it is told, so a stale
 *   update processed late would become the current version, or bring back a deleted item.
 *
 * Who may ingest into a zone is the caller's question (connectors run as the tenant's service
 * principal). Rule tags are applied separately, by the enrichment pipeline (T-401).
 */

export interface IngestInput {
  /** The configured connection, e.g. `sharepoint-main`: a lower-case slug. */
  source: string;
  /** The item's id in that source; stable across renames and moves. */
  externalId: string;
  zoneId: string;
  title: string;
  /**
   * Who owns a new object: `user:` and the id of an existing user who isn't retired. Checked for
   * form always; ignored otherwise for an existing object, which keeps its owner.
   */
  ownerId: string;
  content: {
    /** From blobIdOf(), or BlobStore.put() for a managed zone. */
    blobId: string;
    size: number;
    /** Storage location when OpenHoard holds the bytes. */
    location?: string;
  };
  /**
   * Media type as the source reports it; normalized, and `application/octet-stream` if
   * unusable. When omitted, an existing object keeps its current type.
   */
  mime?: string;
  /** Principal that saved this content, when the source says. */
  authorId?: string;
  /** The source's marker for this content (e.g. a SharePoint cTag), kept on the version. */
  sourceVersion?: string;
  /** The source's change marker for the item (e.g. an eTag), for delta sync. */
  etag?: string;
  url?: string;
}

export interface IngestResult {
  objectId: string;
  /** The object's current version: the new one, or the existing one when nothing changed. */
  versionId: string;
  seq: number;
  created: { object: boolean; version: boolean; blob: boolean };
  /** True when the item had been removed from its source and has come back. */
  restored: boolean;
  /**
   * True when the title changed. Like a new version, a rename needs enrichment again: the
   * current version is unprocessed until it finishes (T-603).
   */
  renamed: boolean;
}

export type IngestErrorCode =
  /** An input field is malformed; the message names it. */
  | "invalid"
  | "unknown-zone"
  /** The item is known in another zone, e.g. it moved to a folder mapped elsewhere. */
  | "zone-mismatch"
  /** A managed zone needs the bytes stored first. */
  | "needs-location"
  /** The tenant has this blob id with another size, or stored at another location. */
  | "blob-mismatch";

export class IngestError extends Error {
  constructor(
    readonly code: IngestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IngestError";
  }
}

/** Records one item and its current content. Run inside the tenant's transaction. */
export async function ingest(tx: Tx, tenantId: string, input: IngestInput): Promise<IngestResult> {
  validate(input);
  const { source, externalId, content } = input;
  await lockSourceItem(tx, tenantId, source, externalId);

  const [zone] = await tx
    .select({ kind: zones.kind })
    .from(zones)
    .where(and(eq(zones.tenantId, tenantId), eq(zones.id, input.zoneId)));
  if (!zone) throw new IngestError("unknown-zone", `no zone ${input.zoneId}`);
  if (zone.kind === "managed" && content.location === undefined) {
    throw new IngestError(
      "needs-location",
      "managed zones hold the bytes: store them first and pass the location",
    );
  }
  if (zone.kind !== "managed" && content.location !== undefined) {
    throw new IngestError(
      "invalid",
      `content.location is for managed zones; zone ${input.zoneId} is ${zone.kind}`,
    );
  }

  const [ref] = await tx
    .select({ objectId: sourceRefs.objectId })
    .from(sourceRefs)
    .where(
      and(
        eq(sourceRefs.tenantId, tenantId),
        eq(sourceRefs.source, source),
        eq(sourceRefs.externalId, externalId),
      ),
    );
  const refFields = { url: input.url ?? null, etag: input.etag ?? null, syncedAt: sql`now()` };

  if (!ref) {
    // A new object needs an owner who can own it. An existing one keeps its owner, even one
    // retired since: offboarding hands files over through the API, not through a crawl.
    const userId = input.ownerId.slice(USER_PREFIX.length);
    if (!input.ownerId.startsWith(USER_PREFIX) || !isId("user", userId)) {
      throw new IngestError("invalid", "ownerId must be user: and a user id");
    }
    // FOR KEY SHARE, as addMember does: a retirement running now finishes first, and is seen.
    const [owner] = await tx
      .select({ retiredAt: users.retiredAt })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
      .for("key share");
    if (!owner) throw new IngestError("invalid", `ownerId ${input.ownerId} is not a user`);
    if (owner.retiredAt !== null) {
      throw new IngestError("invalid", `ownerId ${input.ownerId} is a retired user`);
    }
    const blobCreated = await ensureBlob(tx, tenantId, content);
    const objectId = newId("object");
    await tx.insert(objects).values({
      tenantId,
      id: objectId,
      zoneId: input.zoneId,
      title: input.title,
      ownerId: input.ownerId,
    });
    const version = await addVersion(tx, tenantId, objectId, 1, input, normalizeMime(input.mime));
    await tx.insert(sourceRefs).values({ tenantId, source, externalId, objectId, ...refFields });
    await noteEdit(tx, tenantId, input, objectId, version.versionId);
    return {
      objectId,
      ...version,
      created: { object: true, version: true, blob: blobCreated },
      restored: false,
      renamed: false,
    };
  }

  const { objectId } = ref;
  await lockObject(tx, tenantId, objectId);
  const [object] = await tx
    .select({ zoneId: objects.zoneId, title: objects.title, deletedAt: objects.deletedAt })
    .from(objects)
    .where(and(eq(objects.tenantId, tenantId), eq(objects.id, objectId)))
    .for("update");
  // The source reference cascades from its object, so this can't happen short of corruption.
  if (!object) throw new Error(`source reference points at a missing object ${objectId}`);
  if (object.zoneId !== input.zoneId) {
    throw new IngestError(
      "zone-mismatch",
      `${source}/${externalId} belongs to zone ${object.zoneId}`,
    );
  }

  const [latest] = await tx
    .select({
      id: versions.id,
      seq: versions.seq,
      blobId: versions.blobId,
      mime: versions.mime,
      sourceVersion: versions.sourceVersion,
    })
    .from(versions)
    .where(and(eq(versions.tenantId, tenantId), eq(versions.objectId, objectId)))
    .orderBy(desc(versions.seq))
    .limit(1);
  const mime =
    input.mime === undefined && latest !== undefined ? latest.mime : normalizeMime(input.mime);
  const blobCreated = await ensureBlob(tx, tenantId, content);
  const unchanged = latest?.blobId === content.blobId && latest.mime === mime;
  let version;
  const renamed = object.title !== input.title;
  if (unchanged) {
    version = { versionId: latest.id, seq: latest.seq };
    const marker =
      input.sourceVersion !== undefined && input.sourceVersion !== latest.sourceVersion;
    // Title rules and the display title depend on the title: a rename starts enrichment over,
    // and until it finishes the object is unprocessed (hidden from non-readers).
    if (marker || renamed) {
      await tx
        .update(versions)
        .set({
          ...(marker ? { sourceVersion: input.sourceVersion } : {}),
          ...(renamed ? { processedAt: null } : {}),
        })
        .where(and(eq(versions.tenantId, tenantId), eq(versions.id, latest.id)));
    }
  } else {
    version = await addVersion(tx, tenantId, objectId, (latest?.seq ?? 0) + 1, input, mime);
    await noteEdit(tx, tenantId, input, objectId, version.versionId);
  }

  const restored = object.deletedAt !== null;
  if (!unchanged || restored || renamed) {
    await tx
      .update(objects)
      .set({ title: input.title, deletedAt: null, updatedAt: sql`now()` })
      .where(and(eq(objects.tenantId, tenantId), eq(objects.id, objectId)));
  }
  await tx
    .update(sourceRefs)
    .set(refFields)
    .where(
      and(
        eq(sourceRefs.tenantId, tenantId),
        eq(sourceRefs.source, source),
        eq(sourceRefs.externalId, externalId),
      ),
    );
  return {
    objectId,
    ...version,
    created: { object: false, version: !unchanged, blob: blobCreated },
    restored,
    renamed,
  };
}

const SOURCE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PRINCIPAL = /^[a-z]+:.+$/s;
const BLOB_ID = /^b3t:[0-9a-f]{64}$/;
const ZONE_ID = new RegExp(idPattern("zone"));
const USER_PREFIX = "user:";

/** Longest accepted values, in characters, of the free-text fields. */
export const INGEST_LIMITS = {
  externalId: 2048,
  title: 1024,
  principal: 1024,
  location: 1024,
  url: 4096,
  etag: 1024,
  sourceVersion: 1024,
  mime: 1024,
} as const;

/** The checks core/db's constraints make, as IngestErrors raised before any write. */
function validate(input: IngestInput) {
  const bad = (field: string, why: string) => {
    throw new IngestError("invalid", `${field} ${why}`);
  };
  const chars = (s: string) => [...s].length;
  // PostgreSQL text can't hold NUL (it would fail with 22021, aborting the transaction).
  const text = (
    field: keyof typeof INGEST_LIMITS,
    name: string,
    value: string | undefined,
    min = 1,
  ) => {
    if (value === undefined) return;
    const max = INGEST_LIMITS[field];
    if (chars(value) < min || chars(value) > max) {
      bad(name, `must be ${min} to ${max} characters`);
    }
    if (value.includes("\0")) bad(name, "must not contain NUL");
  };
  if (!SOURCE.test(input.source)) bad("source", "must be a lower-case slug");
  text("externalId", "externalId", input.externalId);
  if (!ZONE_ID.test(input.zoneId)) bad("zoneId", "is not a zone id");
  text("title", "title", input.title);
  // The owner of a new object must be a user (checked when creating it); an existing object
  // keeps its owner, perhaps one recorded in an older form, so here only its shape.
  if (!PRINCIPAL.test(input.ownerId)) bad("ownerId", "must be a principal such as user:…");
  text("principal", "ownerId", input.ownerId);
  if (input.authorId !== undefined && !PRINCIPAL.test(input.authorId)) {
    bad("authorId", "must be a principal such as user:…");
  }
  text("principal", "authorId", input.authorId);
  const { blobId, size, location } = input.content;
  if (!BLOB_ID.test(blobId)) bad("content.blobId", "must be a b3t: blob id");
  if (!Number.isSafeInteger(size) || size < 0) {
    bad("content.size", "must be a non-negative integer");
  }
  text("location", "content.location", location);
  // Sources send empty markers and media types; those stay allowed.
  text("url", "url", input.url, 0);
  text("etag", "etag", input.etag, 0);
  text("sourceVersion", "sourceVersion", input.sourceVersion, 0);
  text("mime", "mime", input.mime, 0);
}

/**
 * Marks the object behind a source item deleted, keeping its rows for audit and undo. Returns
 * the object id, or null when the item is unknown or already marked.
 */
export async function removeFromSource(
  tx: Tx,
  tenantId: string,
  source: string,
  externalId: string,
): Promise<string | null> {
  await lockSourceItem(tx, tenantId, source, externalId);
  const [ref] = await tx
    .select({ objectId: sourceRefs.objectId })
    .from(sourceRefs)
    .where(
      and(
        eq(sourceRefs.tenantId, tenantId),
        eq(sourceRefs.source, source),
        eq(sourceRefs.externalId, externalId),
      ),
    );
  if (!ref) return null;
  // The object's lock before its row, as locks.ts orders them (markProcessed takes both).
  await lockObject(tx, tenantId, ref.objectId);
  const marked = await tx
    .update(objects)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(eq(objects.tenantId, tenantId), eq(objects.id, ref.objectId), isNull(objects.deletedAt)),
    )
    .returning({ id: objects.id });
  return marked[0]?.id ?? null;
}

/** What a connector needs to skip an unchanged item before downloading it. */
export interface SourceItemState {
  objectId: string;
  etag: string | null;
  deleted: boolean;
  /** The current version's source marker and blob; null for an object with no versions. */
  current: { seq: number; sourceVersion: string | null; blobId: string } | null;
}

export async function sourceItemState(
  tx: Tx,
  tenantId: string,
  source: string,
  externalId: string,
): Promise<SourceItemState | null> {
  const [row] = await tx
    .select({
      objectId: sourceRefs.objectId,
      etag: sourceRefs.etag,
      deletedAt: objects.deletedAt,
    })
    .from(sourceRefs)
    .innerJoin(
      objects,
      and(eq(objects.tenantId, sourceRefs.tenantId), eq(objects.id, sourceRefs.objectId)),
    )
    .where(
      and(
        eq(sourceRefs.tenantId, tenantId),
        eq(sourceRefs.source, source),
        eq(sourceRefs.externalId, externalId),
      ),
    );
  if (!row) return null;
  const [current] = await tx
    .select({ seq: versions.seq, sourceVersion: versions.sourceVersion, blobId: versions.blobId })
    .from(versions)
    .where(and(eq(versions.tenantId, tenantId), eq(versions.objectId, row.objectId)))
    .orderBy(desc(versions.seq))
    .limit(1);
  return {
    objectId: row.objectId,
    etag: row.etag,
    deleted: row.deletedAt !== null,
    current: current ?? null,
  };
}

/**
 * The tenant-scoped blob id and size of some bytes, without storing them: what index-only
 * zones record. Streams, so memory stays flat for any size.
 */
export async function blobIdOf(
  tenantKey: Uint8Array,
  content: Uint8Array | AsyncIterable<Uint8Array>,
): Promise<{ blobId: string; size: number }> {
  if (tenantKey.byteLength !== 32) throw new RangeError("tenant key must be 32 bytes");
  const hasher = contentHasher();
  let size = 0;
  for await (const chunk of content instanceof Uint8Array ? [content] : content) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError("content chunks must be bytes");
    hasher.update(chunk);
    size += chunk.byteLength;
  }
  return { blobId: scopedBlobId(tenantKey, hasher.digest()), size };
}

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** `Text/CSV; charset=utf-8` → `text/csv`; anything unusable → `application/octet-stream`. */
export function normalizeMime(mime: string | undefined): string {
  const essence = ((mime ?? "").split(";")[0] ?? "").trim().toLowerCase();
  return MIME.test(essence) && essence.length <= 255 ? essence : "application/octet-stream";
}

/** Inserts the blob unless the tenant has it; returns whether it was new. */
async function ensureBlob(tx: Tx, tenantId: string, content: IngestInput["content"]) {
  const inserted = await tx
    .insert(blobs)
    .values({
      tenantId,
      id: content.blobId,
      size: content.size,
      location: content.location ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: blobs.id });
  if (inserted.length > 0) return true;
  const [existing] = await tx
    .select({ size: blobs.size, location: blobs.location })
    .from(blobs)
    .where(and(eq(blobs.tenantId, tenantId), eq(blobs.id, content.blobId)));
  if (!existing) throw new Error(`blob ${content.blobId} vanished`);
  if (Number(existing.size) !== content.size) {
    throw new IngestError(
      "blob-mismatch",
      `blob ${content.blobId} is ${existing.size} bytes, not ${content.size}`,
    );
  }
  if (
    existing.location !== null &&
    content.location !== undefined &&
    existing.location !== content.location
  ) {
    // Storage paths derive from the blob id, so two locations for one blob mean a bug or a
    // forged location, not a second copy.
    throw new IngestError(
      "blob-mismatch",
      `blob ${content.blobId} is stored at another location than ${content.location}`,
    );
  }
  if (existing.location === null && content.location !== undefined) {
    await tx
      .update(blobs)
      .set({ location: content.location })
      .where(
        and(eq(blobs.tenantId, tenantId), eq(blobs.id, content.blobId), isNull(blobs.location)),
      );
  }
  return false;
}

/**
 * A new version is an edit by its author (T-205), when the source names one, as observed by
 * this source's crawl: `at` is when ingest saw it, not when it was saved.
 */
async function noteEdit(
  tx: Tx,
  tenantId: string,
  input: IngestInput,
  objectId: string,
  versionId: string,
) {
  if (input.authorId === undefined) return;
  await writeActivity(tx, tenantId, [
    { type: "edit", actor: input.authorId, objectId, versionId, origin: input.source },
  ]);
}

async function addVersion(
  tx: Tx,
  tenantId: string,
  objectId: string,
  seq: number,
  input: IngestInput,
  mime: string,
) {
  const versionId = newId("version");
  await tx.insert(versions).values({
    tenantId,
    id: versionId,
    objectId,
    seq,
    blobId: input.content.blobId,
    mime,
    authorId: input.authorId ?? null,
    sourceVersion: input.sourceVersion ?? null,
  });
  return { versionId, seq };
}
