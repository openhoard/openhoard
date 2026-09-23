import { describe, expect, it } from "vitest";
import { buildCard, clampWords, MAX_SUMMARY_WORDS } from "./index.js";

describe("clampWords", () => {
  it("keeps short text and collapses whitespace", () => {
    expect(clampWords("  a   b\n c ")).toBe("a b c");
  });

  it("cuts long text with an ellipsis", () => {
    const long = Array.from({ length: 150 }, (_, i) => `w${i}`).join(" ");
    const out = clampWords(long);
    expect(out.split(" ")).toHaveLength(MAX_SUMMARY_WORDS);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("buildCard", () => {
  it("sanitizes untrusted fields", () => {
    const card = buildCard({
      id: "o1",
      title: "Q3\u0000 Forecast\n\n",
      tags: ["client:acme", "client:acme", "Bad Tag", "type:deck", "nocolon"],
      summary: "Revenue   forecast\u0007 for Q3.",
      owner: "steve",
      lastTouched: "2026-09-23T12:00:00Z",
      link: "https://example.test/o1",
    });
    expect(card.title).toBe("Q3 Forecast");
    expect(card.tags).toEqual(["client:acme", "type:deck"]);
    expect(card.summary).toBe("Revenue forecast for Q3.");
  });
});
