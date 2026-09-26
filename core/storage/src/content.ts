import type { Readable } from "node:stream";
import {
  contentHasher,
  scopedBlobId,
  type ContentRef,
  type ContentSource,
} from "@openhoard/core-catalog";
import type { BlobStore } from "./store.js";

export interface BlobContentOptions {
  /**
   * The tenant's 32-byte blob key, if OpenHoard keeps one (blob ids are keyed by it, core/catalog
   * scopedBlobId()). With it, every byte read is hashed, and a stream whose bytes don't give the
   * version's blob id fails at its end. Without it (no key store yet), only the size is checked.
   */
  tenantKey?: (tenantId: string) => Uint8Array | null | Promise<Uint8Array | null>;
}

/** The bytes a source returned aren't the version's: a different size, or a different hash. */
export class ContentMismatchError extends Error {
  constructor(what: "size" | "hash") {
    super(`the stored bytes don't match the version's blob (${what})`);
    this.name = "ContentMismatchError";
  }
}

/**
 * The bytes OpenHoard holds itself, as enrichment reads them (core/catalog ContentSource):
 * only a managed zone's version, whose blob has a storage location, streams from the store by
 * its content-addressed id. Anything else (an indexed zone, where the source keeps the bytes; a
 * local-only zone, whose content never reaches the server) is not this source's: null.
 *
 * The stream is checked as it is read: its size against the version's, and with `tenantKey`
 * its BLAKE3 hash against the blob id; a mismatch throws at the end, so the extractor never
 * answers for bytes that aren't the version's. When `signal` aborts (the extraction ended, or
 * the job is stopping) the store's stream is destroyed, even one stalled mid-read.
 *
 * A blob the catalog says is stored but the store doesn't have throws (BlobNotFoundError):
 * that is damage for an operator to see, so enrichment retries and then dead-letters the job,
 * leaving the file unprocessed (hidden), rather than treating the content as absent.
 */
export function blobContentSource(
  store: BlobStore,
  options: BlobContentOptions = {},
): ContentSource {
  return {
    async open(ref: ContentRef, signal: AbortSignal) {
      signal.throwIfAborted();
      if (ref.zoneKind !== "managed" || ref.location === null) return null;
      const key = (await options.tenantKey?.(ref.tenantId)) ?? null;
      const stream = await store.open(ref.tenantId, ref.blobId);
      const stop = () => stream.destroy();
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
      return checked(stream, ref, key, () => signal.removeEventListener("abort", stop));
    },
  };
}

async function* checked(
  stream: Readable,
  ref: ContentRef,
  key: Uint8Array | null,
  done: () => void,
): AsyncGenerator<Uint8Array> {
  const hasher = key ? contentHasher() : null;
  let size = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > ref.size) throw new ContentMismatchError("size");
      hasher?.update(chunk);
      yield chunk;
    }
    if (size !== ref.size) throw new ContentMismatchError("size");
    if (hasher && key && scopedBlobId(key, hasher.digest()) !== ref.blobId) {
      throw new ContentMismatchError("hash");
    }
  } finally {
    done();
    stream.destroy();
  }
}
