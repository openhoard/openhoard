import { describe, expect, it } from "vitest";
import { contentHash, contentHasher, reciprocalRankFusion, scopedBlobId } from "./index.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("contentHash", () => {
  it("is stable, prefixed and content-sensitive", () => {
    expect(contentHash(enc("hoard"))).toMatch(/^b3:[0-9a-f]{64}$/);
    expect(contentHash(enc("hoard"))).toBe(contentHash(enc("hoard")));
    expect(contentHash(enc("hoard"))).not.toBe(contentHash(enc("Hoard")));
  });

  it("streaming matches one-shot", () => {
    const h = contentHasher();
    h.update(enc("ho"));
    h.update(enc("ard"));
    expect(h.digest()).toBe(contentHash(enc("hoard")));
  });
});

describe("scopedBlobId", () => {
  const keyA = new Uint8Array(32).fill(1);
  const keyB = new Uint8Array(32).fill(2);
  const h = contentHash(enc("same file"));

  it("differs per tenant for the same content, and is stable per tenant", () => {
    expect(scopedBlobId(keyA, h)).toMatch(/^b3t:[0-9a-f]{64}$/);
    expect(scopedBlobId(keyA, h)).toBe(scopedBlobId(keyA, h));
    expect(scopedBlobId(keyA, h)).not.toBe(scopedBlobId(keyB, h));
  });

  it("rejects bad keys and hashes", () => {
    expect(() => scopedBlobId(new Uint8Array(16), h)).toThrow(RangeError);
    expect(() => scopedBlobId(keyA, "sha256:abc")).toThrow(TypeError);
  });
});

describe("reciprocalRankFusion", () => {
  it("rewards items ranked well in several lists", () => {
    const fused = reciprocalRankFusion([
      ["a", "b", "c"],
      ["b", "c", "a"],
      ["b", "d"],
    ]);
    expect(fused[0]?.id).toBe("b");
    expect(fused.map((r) => r.id)).toEqual(["b", "a", "c", "d"]);
  });

  it("breaks ties deterministically by id", () => {
    expect(reciprocalRankFusion([["y"], ["x"]]).map((r) => r.id)).toEqual(["x", "y"]);
  });

  it("handles no input", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
  });
});
