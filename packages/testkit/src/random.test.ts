import { describe, expect, it } from "vitest";
import { Random } from "./random.js";

describe("Random", () => {
  it("produces a pinned sequence for a seed, on every platform", () => {
    const r = new Random("openhoard");
    expect([r.next(), r.next(), r.next()]).toEqual([
      0.16495177312754095, 0.9178366630803794, 0.33275821013376117,
    ]);
  });

  it("differs across seeds and stays in [0, 1)", () => {
    const a = new Random("a");
    const b = new Random("b");
    const xs = Array.from({ length: 1000 }, () => a.next());
    expect(xs).not.toEqual(Array.from({ length: 1000 }, () => b.next()));
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
  });

  it("int covers both ends of the range and rejects bad ranges", () => {
    const r = new Random("int");
    const seen = new Set(Array.from({ length: 500 }, () => r.int(1, 3)));
    expect([...seen].sort()).toEqual([1, 2, 3]);
    expect(() => r.int(3, 1)).toThrow(RangeError);
    expect(() => r.int(0.5, 2)).toThrow(RangeError);
  });

  it("weighted respects zero weights and rejects empty totals", () => {
    const r = new Random("w");
    const picks = new Set(
      Array.from({ length: 300 }, () =>
        r.weighted([
          ["a", 1],
          ["b", 0],
          ["c", 2],
        ] as const),
      ),
    );
    expect(picks.has("b")).toBe(false);
    expect(picks.size).toBe(2);
    expect(() => r.weighted([["a", 0]])).toThrow(RangeError);
  });

  it("sample returns distinct items and caps at the input size", () => {
    const r = new Random("s");
    const s = r.sample([1, 2, 3, 4, 5], 3);
    expect(new Set(s).size).toBe(3);
    expect(r.sample([1, 2], 5).sort()).toEqual([1, 2]);
  });

  it("pick rejects an empty list", () => {
    expect(() => new Random("p").pick([])).toThrow(RangeError);
  });

  it("forks are deterministic and independent of later parent use", () => {
    const f1 = new Random("x").fork("child");
    const f2 = new Random("x").fork("child");
    expect(f1.next()).toBe(f2.next());
    expect(new Random("x").fork("other").next()).not.toBe(new Random("x").fork("child").next());
  });
});
