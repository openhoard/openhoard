import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/*
 * PERFORMANCE NOTE (security review #10): @noble/hashes is audited, pure JavaScript. It is fine
 * for documents but may be too slow for multi-GB uploads. Spike S1 / T-020 benchmarks it; if it
 * can't keep up with disk/network speed, swap in a native BLAKE3 binding behind these functions.
 */

/**
 * Content identity (ADR-0013): identical bytes → identical hash. Used for integrity checks and
 * for de-duplication *within* one tenant. Never expose this across tenants; see {@link scopedBlobId}.
 */
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

/**
 * Tenant-scoped blob id (security review #7). Storage keys use this, not the raw content hash,
 * so tenant A can never confirm "tenant B also has this exact file" through de-duplication,
 * timing or storage paths. It is a keyed BLAKE3 of the content hash with a per-tenant secret key.
 */
export function scopedBlobId(tenantKey: Uint8Array, hash: string): string {
  if (tenantKey.byteLength !== 32) throw new RangeError("tenant key must be 32 bytes");
  if (!/^b3:[0-9a-f]{64}$/.test(hash)) throw new TypeError("expected a b3: content hash");
  return `b3t:${bytesToHex(blake3(utf8ToBytes(hash), { key: tenantKey }))}`;
}
