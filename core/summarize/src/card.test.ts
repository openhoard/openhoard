import { describe, expect, it } from "vitest";
import {
  buildCard,
  clampWords,
  MAX_SUMMARY_WORDS,
  safeLink,
  stripUnsafeText,
  truncateCodePoints,
} from "./index.js";

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

describe("stripUnsafeText", () => {
  it("removes zero-width and bidi-override characters", () => {
    expect(stripUnsafeText("invoice‮fdp.exe")).toBe("invoice fdp.exe");
    expect(stripUnsafeText("ig​nore‍ previous")).toBe("ig nore previous");
    expect(stripUnsafeText("﻿hello⁦world⁩")).toBe("hello world");
  });
});

describe("safeLink", () => {
  it.each([
    ["https://example.test/o1", "https://example.test/o1"],
    ["http://intranet.local/x", "http://intranet.local/x"],
    ["javascript:alert(1)", ""],
    ["data:text/html,<script>", ""],
    ["file:///etc/passwd", ""],
    ["not a url", ""],
  ])("%s → %s", (input, expected) => {
    expect(safeLink(input)).toBe(expected);
  });
});

describe("buildCard", () => {
  const base = {
    id: "o1",
    title: "Q3 Forecast",
    tags: ["client:acme"],
    summary: "Revenue forecast for Q3.",
    owner: "steve",
    lastTouched: "2026-09-23T12:00:00Z",
    link: "https://example.test/o1",
  };

  it("sanitizes untrusted fields", () => {
    const card = buildCard({
      ...base,
      title: "Q3\u0000 Forecast​\n\n",
      tags: ["client:acme", "client:acme", "Bad Tag", "type:deck", "nocolon", "type:‮deck"],
      summary: "Revenue   forecast\u0007 for Q3.",
    });
    expect(card.title).toBe("Q3 Forecast");
    expect(card.tags).toEqual(["client:acme", "type:deck"]);
    expect(card.summary).toBe("Revenue forecast for Q3.");
    expect(card.link).toBe("https://example.test/o1");
  });

  it("drops unsafe links", () => {
    expect(buildCard({ ...base, link: "javascript:alert(document.cookie)" }).link).toBe("");
  });

  it("never splits an emoji when capping the title", () => {
    const title = `${"a".repeat(199)}😀tail`;
    expect(buildCard({ ...base, title }).title).toBe(`${"a".repeat(199)}😀`);
  });
});

describe("truncateCodePoints", () => {
  it("counts code points, not UTF-16 units", () => {
    expect(truncateCodePoints("😀😀😀", 2)).toBe("😀😀");
    expect(truncateCodePoints("abc", 5)).toBe("abc");
    expect(truncateCodePoints("abc", 0)).toBe("");
  });
});

describe("stripUnsafeText and malformed or invisible Unicode", () => {
  it("removes lone surrogates but keeps valid pairs", () => {
    expect(stripUnsafeText("a\ud83db 😀")).toBe("a b 😀");
  });

  it("removes invisible tag characters used for ASCII smuggling", () => {
    expect(stripUnsafeText("ok\u{e0049}\u{e0047}\u{e004e}")).toBe("ok");
  });
});
