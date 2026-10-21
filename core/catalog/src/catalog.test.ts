import { describe, expect, it } from "vitest";
import { reciprocalRankFusion } from "./index.js";

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
