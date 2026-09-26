import { randomBytes } from "node:crypto";
import type { ContentRef } from "@openhoard/core-catalog";
import { describe, expect, it } from "vitest";
import { blobContentSource } from "./content.js";
import { BlobNotFoundError, BlobStore } from "./store.js";

/* T-402: enrichment reads a managed version's bytes from the store, and nothing else. */

describe("blobContentSource", () => {
  const store = BlobStore.open({ kind: "memory" });
  const tenant = { id: "ten_content", key: randomBytes(32) };
  const source = blobContentSource(store);
  const ref = (blobId: string, location: string | null): ContentRef => ({
    tenantId: tenant.id,
    objectId: "obj_1",
    versionId: "ver_1",
    blobId,
    location,
    size: 5,
    mime: "text/plain",
  });
  const signal = new AbortController().signal;

  it("streams a stored version's bytes", async () => {
    const { blobId } = await store.put(tenant, new TextEncoder().encode("hello"));
    const stream = await source.open(ref(blobId, "stored"), signal);
    const parts: Uint8Array[] = [];
    for await (const chunk of stream ?? []) parts.push(chunk);
    expect(Buffer.concat(parts).toString()).toBe("hello");
  });

  it("leaves a version whose bytes stay in the source to another source", async () => {
    expect(await source.open(ref(`b3t:${"a".repeat(64)}`, null), signal)).toBe(null);
  });

  it("throws for a stored blob the store has lost, and when aborted", async () => {
    await expect(source.open(ref(`b3t:${"b".repeat(64)}`, "stored"), signal)).rejects.toThrow(
      BlobNotFoundError,
    );
    const controller = new AbortController();
    controller.abort(new Error("stopping"));
    await expect(
      source.open(ref(`b3t:${"b".repeat(64)}`, "stored"), controller.signal),
    ).rejects.toThrow("stopping");
  });
});
