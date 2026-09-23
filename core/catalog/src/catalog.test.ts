import { describe, expect, it } from "vitest";
import { contentHash, contentHasher, reciprocalRankFusion } from "./index.js";

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
