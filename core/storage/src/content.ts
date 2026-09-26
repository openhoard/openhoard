import type { ContentRef, ContentSource } from "@openhoard/core-catalog";
import type { BlobStore } from "./store.js";

/**
 * The bytes OpenHoard holds itself, as enrichment reads them (core/catalog ContentSource): a
 * version whose blob has a storage location (a managed zone) streams from the store by its
 * content-addressed id, so the bytes are the version's by construction. A version without a
 * location (an indexed zone: the source keeps the bytes) is not this source's: null, for a
 * connector's source to answer (T-301).
 *
 * A blob the catalog says is stored but the store doesn't have throws (BlobNotFoundError):
 * that is damage for an operator to see, so enrichment retries and then dead-letters the job,
 * leaving the file unprocessed (hidden), rather than treating the content as absent.
 */
export function blobContentSource(store: BlobStore): ContentSource {
  return {
    async open(ref: ContentRef, signal: AbortSignal) {
      signal.throwIfAborted();
      if (ref.location === null) return null;
      return store.open(ref.tenantId, ref.blobId);
    },
  };
}
