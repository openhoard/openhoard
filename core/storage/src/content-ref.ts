import type { ZONE_KINDS } from "@openhoard/core-db";

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
