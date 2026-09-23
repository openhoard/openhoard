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
    expect(stripUnsafeText("invoice\u202efdp.exe")).toBe("invoice fdp.exe");
    expect(stripUnsafeText("ig\u200bnore\u200d previous")).toBe("ig nore previous");
    expect(stripUnsafeText("\ufeffhello\u2066world\u2069")).toBe("hello world");
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
      title: "Q3\u0000 Forecast\u200b\n\n",
      tags: ["client:acme", "client:acme", "Bad Tag", "type:deck", "nocolon", "type:\u202edeck"],
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

  it("removes invisible fillers and supplementary variation selectors", () => {
    expect(stripUnsafeText("a\u3164b\u115fc\u034fd\u{e0101}\u{e0102}e")).toBe("a b c d e");
  });

  it("keeps one emoji-style selector but cuts selector runs used to smuggle data", () => {
    expect(stripUnsafeText("tag \u{1f3f7}\ufe0f ok")).toBe("tag \u{1f3f7}\ufe0f ok");
    expect(stripUnsafeText("x\ufe0f\ufe01\ufe02\ufe0e")).toBe("x\ufe0f");
    expect(stripUnsafeText("\ufe0fstart and \ufe0f after space")).toBe("start and after space");
  });

  it("removes invisible tag characters used for ASCII smuggling", () => {
    expect(stripUnsafeText("ok\u{e0049}\u{e0047}\u{e004e}")).toBe("ok");
  });
});
