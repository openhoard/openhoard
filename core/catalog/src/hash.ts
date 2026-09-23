import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";

/** Content identity for blobs (ADR-013). Identical bytes anywhere → identical id → one stored blob. */
export function contentHash(bytes: Uint8Array): string {
  return `b3:${bytesToHex(blake3(bytes))}`;
}

/** Streaming variant for large files: feed chunks, get the same id as {@link contentHash}. */
export function contentHasher(): { update(chunk: Uint8Array): void; digest(): string } {
  const h = blake3.create({});
  return {
    update: (chunk) => void h.update(chunk),
    digest: () => `b3:${bytesToHex(h.digest())}`,
  };
}
