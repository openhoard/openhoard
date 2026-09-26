import {
  blobs,
  EXTRACT_STATUSES,
  isId,
  MAX_EXTRACT_TEXT_BYTES,
  objects,
  versionExtracts,
  versions,
  ZONE_KINDS,
  zones,
  type Tx,
} from "@openhoard/core-db";
import { and, eq, sql } from "drizzle-orm";

/*
 * Extracted text (T-402): one row per version in `version_extracts`, written by enrichment's
 * extract step and read by search (T-501) and summaries (T-405).
 *
 * The text is content. Nothing here checks who may see it: the readers are trusted pipeline
 * steps, and whatever shows it to someone later must gate it as it gates the file's content
 * (levels, exposure for AI clients), never as metadata.
 */

/** Where a version's bytes are: what a {@link ContentSource} needs to read them. */
export interface ContentRef {
  tenantId: string;
  objectId: string;
  versionId: string;
  /** The content's tenant-scoped id (`b3t:…`): the bytes a source returns must be these. */
  blobId: string;
  /** Where OpenHoard holds the bytes (a managed zone), or null when only the source does. */
  location: string | null;
  /** The content's exact size in bytes: a source returning more or fewer bytes is wrong. */
  size: number;
  mime: string;
  /** The object's zone kind: which content may be read for extraction at all depends on it. */
  zoneKind: ZoneKind;
}

export type ZoneKind = (typeof ZONE_KINDS)[number];

/**
 * Reads a version's bytes for enrichment. core/storage's `blobContentSource()` reads what
 * OpenHoard holds (managed zones); connectors (T-301) add sources for indexed zones, whose
 * bytes stay in the source.
 *
 * A source must return exactly the version's bytes, the blob `ref.blobId` names, or null when
 * it can't reach them (not its zone, no connector). The extractor enforces the size (a stream
 * that ends early or runs long is refused, and retried); a source that can hash the bytes
 * against the blob id (blobContentSource() with the tenant's blob key) enforces the rest, by
 * throwing at the end of a stream that doesn't match. An indexed zone's source must refuse when
 * the item changed since the crawl that made this version (its eTag or version marker differs)
 * rather than return newer bytes: they belong to the next version, which has its own job. It
 * throws when reading fails for now (the store is unreachable): the job tries again later.
 */
export interface ContentSource {
  open(ref: ContentRef, signal: AbortSignal): Promise<AsyncIterable<Uint8Array> | null>;
}

/** The version's content reference, or null when there is no such version. */
export async function contentRef(
  tx: Tx,
  tenantId: string,
  versionId: string,
): Promise<ContentRef | null> {
  if (typeof versionId !== "string" || !isId("version", versionId)) return null;
  const [row] = await tx
    .select({
      objectId: versions.objectId,
      blobId: versions.blobId,
      mime: versions.mime,
      location: blobs.location,
      size: blobs.size,
      zoneKind: zones.kind,
    })
    .from(versions)
    .innerJoin(blobs, and(eq(blobs.tenantId, versions.tenantId), eq(blobs.id, versions.blobId)))
    .innerJoin(
      objects,
      and(eq(objects.tenantId, versions.tenantId), eq(objects.id, versions.objectId)),
    )
    .innerJoin(zones, and(eq(zones.tenantId, objects.tenantId), eq(zones.id, objects.zoneId)))
    .where(and(eq(versions.tenantId, tenantId), eq(versions.id, versionId)));
  return row ? { tenantId, versionId, ...row } : null;
}

export type ExtractStatus = (typeof EXTRACT_STATUSES)[number];

/** A version's extraction, as stored. */
export interface VersionExtract {
  status: ExtractStatus;
  /** What the content turned out to be (`pdf`, `docx`…), when extracted. */
  kind: string | null;
  text: string;
  truncated: boolean;
  /** Pages, sheets, CSV schema and row count…: plain JSON. */
  metadata: Record<string, unknown>;
  /** Hints of hidden text for injection flagging (T-408): plain JSON. */
  signals: unknown[];
  warnings: string[];
  /** Why a `failed` extraction failed. */
  failure: string | null;
  /** Which extractor, and which version of it, produced this. */
  extractor: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;
const EXTRACTOR = /^[a-z0-9][a-z0-9./-]{0,63}$/;

/**
 * Stores a version's extraction, replacing any earlier one: running enrichment again for the
 * same version rewrites its row, never adds a second. Call it through the enrichment step's
 * `write`, which holds the object's lock and has checked the version is still current.
 * Throws TypeError for a malformed extraction (a bug in the caller), before writing.
 */
export async function saveExtract(
  tx: Tx,
  tenantId: string,
  input: VersionExtract & { objectId: string; versionId: string },
): Promise<void> {
  checkExtract(input);
  const row = {
    status: input.status,
    kind: input.kind,
    text: input.text,
    truncated: input.truncated,
    metadata: input.metadata,
    signals: input.signals,
    warnings: input.warnings,
    failure: input.failure,
    extractor: input.extractor,
  };
  await tx
    .insert(versionExtracts)
    .values({ tenantId, versionId: input.versionId, objectId: input.objectId, ...row })
    .onConflictDoUpdate({
      target: [versionExtracts.tenantId, versionExtracts.versionId],
      set: { ...row, extractedAt: sql`now()` },
    });
}

/** A version's stored extraction, or null when it has none (yet). */
export async function readExtract(
  tx: Tx,
  tenantId: string,
  versionId: string,
): Promise<(VersionExtract & { objectId: string; extractedAt: Date }) | null> {
  if (typeof versionId !== "string" || !isId("version", versionId)) return null;
  const [row] = await tx
    .select()
    .from(versionExtracts)
    .where(and(eq(versionExtracts.tenantId, tenantId), eq(versionExtracts.versionId, versionId)));
  if (!row) return null;
  return {
    objectId: row.objectId,
    status: row.status,
    kind: row.kind,
    text: row.text,
    truncated: row.truncated,
    metadata: row.metadata as Record<string, unknown>,
    signals: row.signals as unknown[],
    warnings: row.warnings as string[],
    failure: row.failure,
    extractor: row.extractor,
    extractedAt: row.extractedAt,
  };
}

function checkExtract(e: VersionExtract & { objectId: string; versionId: string }): void {
  const bad = (what: string) => {
    throw new TypeError(`invalid extraction: ${what}`);
  };
  if (!isId("object", e.objectId) || !isId("version", e.versionId)) bad("ids");
  if (!(EXTRACT_STATUSES as readonly string[]).includes(e.status)) bad("status");
  if (typeof e.extractor !== "string" || !EXTRACTOR.test(e.extractor)) bad("extractor");
  const extracted = e.status === "extracted";
  if (extracted !== (typeof e.kind === "string" && SLUG.test(e.kind))) bad("kind");
  if ((e.status === "failed") !== (typeof e.failure === "string" && SLUG.test(e.failure))) {
    bad("failure");
  }
  if (typeof e.text !== "string" || typeof e.truncated !== "boolean") bad("text");
  if (!extracted && (e.text !== "" || e.truncated)) bad("text without an extraction");
  if (Buffer.byteLength(e.text, "utf8") > MAX_EXTRACT_TEXT_BYTES) bad("text too large");
  // Postgres text holds no NUL, and UTF-8 has no lone surrogates (a driver would write U+FFFD,
  // or fail): the extractor's sanitizer never leaves either.
  if (!storable(e.text)) bad("unstorable text");
  const plain = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!plain(e.metadata) || !Array.isArray(e.signals) || !Array.isArray(e.warnings)) bad("json");
  if (!e.warnings.every((w) => typeof w === "string")) bad("warnings");
  // Nor does jsonb, in values or keys.
  if (!storableJson([e.metadata, e.signals, e.warnings])) bad("unstorable JSON");
}

/** No NUL and no lone surrogate: text PostgreSQL stores as given. */
function storable(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) return false;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Every string in a JSON value, keys included, {@link storable}; bounded depth. */
function storableJson(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (typeof value === "string") return storable(value);
  if (typeof value !== "object" || value === null) return true;
  if (Array.isArray(value)) return value.every((v) => storableJson(v, depth + 1));
  return Object.entries(value).every(([k, v]) => storable(k) && storableJson(v, depth + 1));
}
