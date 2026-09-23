import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { reciprocalRankFusion } from "./rank.js";

/** Ranked lists as retrievers return them: distinct ids per list. */
const rankedList = fc.uniqueArray(fc.string({ minLength: 1, maxLength: 4 }), { maxLength: 20 });
const lists = fc.array(rankedList, { maxLength: 5 });

describe("reciprocalRankFusion (properties)", () => {
  it("returns every input id exactly once", () => {
    fc.assert(
      fc.property(lists, (ls) => {
        const ids = reciprocalRankFusion(ls).map((r) => r.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(ids)).toEqual(new Set(ls.flat()));
      }),
    );
  });

  it("is sorted by descending score, with ties broken by id", () => {
    fc.assert(
      fc.property(lists, (ls) => {
        const out = reciprocalRankFusion(ls);
        out.slice(1).forEach((b, i) => {
          const a = out[i];
          expect(a && (a.score > b.score || (a.score === b.score && a.id < b.id))).toBe(true);
        });
      }),
    );
  });

  it("gives each id the same score whatever the order of the input lists", () => {
    // Scores are compared with a tolerance: floating-point sums depend on addition order.
    fc.assert(
      fc.property(lists, (ls) => {
        const forward = new Map(reciprocalRankFusion(ls).map((r) => [r.id, r.score]));
        for (const r of reciprocalRankFusion([...ls].reverse())) {
          expect(r.score).toBeCloseTo(forward.get(r.id) ?? Number.NaN, 12);
        }
      }),
    );
  });

  it("an id first in every list it appears in, and present in all lists, ranks first", () => {
    fc.assert(
      fc.property(
        lists.filter((ls) => ls.length > 0),
        fc.string({ minLength: 5 }),
        (ls, top) => {
          const boosted = ls.map((l) => [top, ...l]);
          expect(reciprocalRankFusion(boosted)[0]?.id).toBe(top);
        },
      ),
    );
  });
});
