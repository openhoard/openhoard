import { describe, expect, it } from "vitest";
import { contentHash, contentHasher, reciprocalRankFusion, scopedBlobId } from "./index.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("contentHash", () => {
  it("is stable, prefixed and content-sensitive", () => {
    expect(contentHash(enc("hoard"))).toMatch(/^b3:[0-9a-f]{64}$/);
    expect(contentHash(enc("hoard"))).toBe(contentHash(enc("hoard")));
    expect(contentHash(enc("hoard"))).not.toBe(contentHash(enc("Hoard")));
  });

  // Known-answer tests pin the algorithm, so a dependency upgrade can never silently change ids.
  // Vectors: the official BLAKE3 test vectors (empty input) and the reference `blake3` crate.
  it("matches BLAKE3 known answers", () => {
    expect(contentHash(new Uint8Array())).toBe(
      "b3:af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
    );
    expect(contentHash(enc("hoard"))).toBe(
      "b3:bb478f91fd0990943550c1fba510fd01831d2972a5e2ff62672b598deee337d0",
    );
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

  it("matches a keyed BLAKE3 known answer", () => {
    expect(h).toBe("b3:a30f2773a9b063f9309d9483388b1684df0b22827b318ee16d8bbcd7d6fadbd3");
    expect(scopedBlobId(keyA, h)).toBe(
      "b3t:e412b18897e7efc272235ebe5cf72edc343b0852000e52af3f0d70d7652672e4",
    );
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
