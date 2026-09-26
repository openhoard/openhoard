import {
  contentHasher,
  scopedBlobId,
  type ContentRef,
  type ContentSource,
} from "@openhoard/core-catalog";
import { objects, sourceRefs, versions, type Database } from "@openhoard/core-db";
import { changedError, isConnectorError, type Connector } from "@openhoard/sdk";
import { and, asc, eq } from "drizzle-orm";

/*
 * Where enrichment reads an indexed zone's bytes (T-402's ContentSource, T-301): from the
 * connector that crawled them, asked for exactly the version the catalog recorded.
 *
 * - The version's source item (source, external id, url) and its source marker (the item's
 *   contentVersion when the version was recorded) come from the catalog; the connector's read()
 *   refuses the item when it is another version by now (`changed`), or gone (`not-found`).
 *   Those throw, so the job is retried: by then the source's next sync has recorded what
 *   happened (a new version, whose own job reads it; a rename or a move, which updates the
 *   url; a touch, which updates the marker; a delete). `onStale` hears of it, for the job
 *   layer to sync that source soon rather than wait for its schedule (T-303).
 * - The bytes are checked as they are read: exactly `ref.size` of them, and with `tenantKey`,
 *   the BLAKE3 blob id; a mismatch throws at the end, as core/storage's blobContentSource()
 *   does.
 * - Anything it can't read this way answers null ("no source reaches the bytes", which the
 *   extract step records as unavailable): a version OpenHoard holds (a location: that is
 *   blobContentSource()'s), a deleted object, a source no connector serves here, a version
 *   recorded without a marker (it can't be asked for exactly).
 *
 * Compose it with blobContentSource() for managed zones: `firstOf(blobs, connectors)`.
 */

export interface ConnectorContentOptions {
  db: Database;
  /** The connector serving this tenant's source, or undefined when none does here. */
  connectorFor: (tenantId: string, source: string) => Connector | undefined;
  /** The tenant's blob key: with it, every byte read is hashed against the version's blob id. */
  tenantKey?: (tenantId: string) => Uint8Array | null | Promise<Uint8Array | null>;
  /** Told when a version's item changed or went at its source since it was recorded. */
  onStale?: (tenantId: string, source: string) => void;
}

/** A ContentSource over connectors: see above. */
export function connectorContentSource(options: ConnectorContentOptions): ContentSource {
  return {
    async open(ref: ContentRef, signal: AbortSignal) {
      signal.throwIfAborted();
      if (ref.location !== null) return null;
      const row = await options.db.withTenant(
        ref.tenantId,
        async (tx) => {
          const [r] = await tx
            .select({
              source: sourceRefs.source,
              externalId: sourceRefs.externalId,
              url: sourceRefs.url,
              marker: versions.sourceVersion,
              deletedAt: objects.deletedAt,
            })
            .from(versions)
            .innerJoin(
              objects,
              and(eq(objects.tenantId, versions.tenantId), eq(objects.id, versions.objectId)),
            )
            .innerJoin(
              sourceRefs,
              and(
                eq(sourceRefs.tenantId, versions.tenantId),
                eq(sourceRefs.objectId, versions.objectId),
              ),
            )
            .where(and(eq(versions.tenantId, ref.tenantId), eq(versions.id, ref.versionId)))
            .orderBy(asc(sourceRefs.source), asc(sourceRefs.externalId))
            .limit(1);
          return r;
        },
        { accessMode: "read only" },
      );
      if (!row || row.deletedAt !== null || row.marker === null) return null;
      const connector = options.connectorFor(ref.tenantId, row.source);
      if (!connector) return null;
      const key = (await options.tenantKey?.(ref.tenantId)) ?? null;
      const stale = (e: unknown) => {
        if (isConnectorError(e) && (e.code === "changed" || e.code === "not-found")) {
          options.onStale?.(ref.tenantId, row.source);
        }
        return e;
      };
      try {
        const result = await connector.read(
          {
            externalId: row.externalId,
            contentVersion: row.marker,
            size: ref.size,
            ...(row.url === null ? {} : { url: row.url }),
          },
          signal,
        );
        if (result.contentVersion !== row.marker || result.size !== ref.size) {
          throw changedError();
        }
        return checked(result.body, ref, key, stale);
      } catch (e) {
        throw stale(e);
      }
    },
  };
}

/** The first answer of several sources, in order: e.g. managed blobs, then connectors. */
export function firstOf(...sources: ContentSource[]): ContentSource {
  return {
    async open(ref, signal) {
      for (const source of sources) {
        const stream = await source.open(ref, signal);
        if (stream !== null) return stream;
      }
      return null;
    },
  };
}

/** Exactly `ref.size` bytes, and the version's blob when the key is known. */
async function* checked(
  body: AsyncIterable<Uint8Array>,
  ref: ContentRef,
  key: Uint8Array | null,
  stale: (e: unknown) => unknown,
): AsyncGenerator<Uint8Array> {
  const hasher = key ? contentHasher() : null;
  let size = 0;
  try {
    for await (const chunk of body) {
      size += chunk.byteLength;
      if (size > ref.size) throw new Error("the source sent more bytes than the version has");
      hasher?.update(chunk);
      yield chunk;
    }
  } catch (e) {
    throw stale(e);
  }
  if (size !== ref.size) throw new Error("the source sent fewer bytes than the version has");
  if (hasher && key && scopedBlobId(key, hasher.digest()) !== ref.blobId) {
    throw new Error("the source's bytes are not the version's");
  }
}
