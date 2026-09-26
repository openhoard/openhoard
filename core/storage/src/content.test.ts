import { randomBytes } from "node:crypto";
import type { ContentRef } from "@openhoard/core-catalog";
import { describe, expect, it } from "vitest";
import { blobContentSource, ContentMismatchError } from "./content.js";
import { BlobNotFoundError, BlobStore } from "./store.js";

/* T-402: enrichment reads a managed version's bytes from the store, checked, and nothing else. */

describe("blobContentSource", () => {
  const store = BlobStore.open({ kind: "memory" });
  const tenant = { id: "ten_content", key: randomBytes(32) };
  const other = randomBytes(32);
  const ref = (blobId: string, more: Partial<ContentRef> = {}): ContentRef => ({
    tenantId: tenant.id,
    objectId: "obj_1",
    versionId: "ver_1",
    blobId,
    location: "stored",
    size: 5,
    mime: "text/plain",
    zoneKind: "managed",
    ...more,
  });
  const signal = new AbortController().signal;
  const read = async (stream: AsyncIterable<Uint8Array> | null) => {
    const parts: Uint8Array[] = [];
    for await (const chunk of stream ?? []) parts.push(chunk);
    return Buffer.concat(parts).toString();
  };
  const hello = () => store.put(tenant, new TextEncoder().encode("hello"));

  it("streams a stored version's bytes, checking size and, with the tenant's key, the hash", async () => {
    const { blobId } = await hello();
    expect(await read(await blobContentSource(store).open(ref(blobId), signal))).toBe("hello");
    const keyed = blobContentSource(store, { tenantKey: () => tenant.key });
    expect(await read(await keyed.open(ref(blobId), signal))).toBe("hello");
  });

  it("refuses bytes that aren't the version's: another size, or another hash", async () => {
    const { blobId } = await hello();
    const plain = blobContentSource(store);
    await expect(read(await plain.open(ref(blobId, { size: 9 }), signal))).rejects.toThrow(
      ContentMismatchError,
    );
    await expect(read(await plain.open(ref(blobId, { size: 3 }), signal))).rejects.toThrow(
      ContentMismatchError,
    );
    const wrongKey = blobContentSource(store, { tenantKey: async () => other });
    await expect(read(await wrongKey.open(ref(blobId), signal))).rejects.toThrow("(hash)");
  });

  it("reads only managed zones' content", async () => {
    const { blobId } = await hello();
    const source = blobContentSource(store);
    expect(await source.open(ref(blobId, { location: null, zoneKind: "indexed" }), signal)).toBe(
      null,
    );
    // Even with a location recorded, a local-only or indexed zone's content isn't read here.
    expect(await source.open(ref(blobId, { zoneKind: "local-only" }), signal)).toBe(null);
    expect(await source.open(ref(blobId, { zoneKind: "indexed" }), signal)).toBe(null);
  });

  it("destroys the store's stream when the signal aborts", async () => {
    const big = await store.put(tenant, randomBytes(3 * 1024 * 1024));
    const controller = new AbortController();
    const stream = await blobContentSource(store).open(
      ref(big.blobId, { size: big.size }),
      controller.signal,
    );
    const iterator = (stream as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await expect(
      (async () => {
        for (;;) if ((await iterator.next()).done) return;
      })(),
    ).rejects.toThrow();
  });

  it("throws for a stored blob the store has lost, and when aborted", async () => {
    const source = blobContentSource(store);
    await expect(source.open(ref(`b3t:${"b".repeat(64)}`), signal)).rejects.toThrow(
      BlobNotFoundError,
    );
    const controller = new AbortController();
    controller.abort(new Error("stopping"));
    await expect(source.open(ref(`b3t:${"b".repeat(64)}`), controller.signal)).rejects.toThrow(
      "stopping",
    );
  });
});
