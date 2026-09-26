import { describe, expect, it } from "vitest";
import { resolveLimits } from "./limits.ts";
import { runExtraction } from "./run.ts";
import { chunked, pdfDocument } from "./test.fixtures.ts";

/*
 * The PDF signals come from a small model of PDF's graphics and text state: these pages move
 * text with every operator that can, so a wrong model shows up as a missing or false signal.
 */

const extract = async (bytes: Uint8Array) =>
  (await runExtraction(chunked(bytes), { mime: "application/pdf" }, resolveLimits())).extraction;

describe("PDF signals", () => {
  it("follows the transform, text matrices, leading, save and restore", async () => {
    const content = [
      // Moved by the CTM, inside the page; restored afterwards.
      "q 1 0 0 1 100 100 cm BT /F1 12 Tf 0 0 Td (moved by ctm) Tj ET Q",
      // Leading, next line, TD (sets leading), all on the page.
      "BT /F1 12 Tf 14 TL 72 500 Td (line one) Tj T* (line two) Tj 0 -20 TD (after TD) Tj T* (after TD star) Tj ET",
      // A text matrix, and render mode 3 set and reset.
      "BT 1 0 0 1 72 400 Tm /F1 12 Tf 3 Tr (hidden) Tj 0 Tr (shown) Tj ET",
      // Scaled down by the CTM: 12 pt at 0.05 is 0.6 pt.
      "q 0.05 0 0 0.05 0 0 cm BT /F1 12 Tf 2000 2000 Td (scaled tiny) Tj ET Q",
      // White, by a gray fill.
      "BT /F1 12 Tf 1 g 72 300 Td (gray white) Tj 0 g ET",
      // Off the page to the left, and far right by a restored CTM.
      "BT /F1 12 Tf -500 200 Td (off to the left) Tj ET",
      "q 1 0 0 1 10000 0 cm BT /F1 12 Tf 72 72 Td (off by ctm) Tj ET Q",
      "BT /F1 12 Tf 72 100 Td (back on the page) Tj ET",
      "/Fm0 Do",
    ].join("\n");
    const forms = [
      { matrix: [1, 0, 0, 1, 0, 5000], content: "BT /F1 12 Tf 72 72 Td (inside a form) Tj ET" },
    ];
    const extraction = await extract(pdfDocument(content, forms));
    const signals = Object.fromEntries(extraction.signals.map((s) => [s.kind, s]));
    expect(signals["invisible-text"]).toEqual({
      kind: "invisible-text",
      count: 1,
      sample: "hidden",
    });
    expect(signals["tiny-text"]).toEqual({ kind: "tiny-text", count: 1, sample: "scaled tiny" });
    expect(signals["white-text"]).toEqual({ kind: "white-text", count: 1, sample: "gray white" });
    expect(signals["off-page-text"]).toMatchObject({ count: 3, sample: "off to the left" });
    expect(extraction.text).toContain("line one");
    expect(extraction.text).toContain("back on the page");
  });

  it("reads a page with no text as empty", async () => {
    const extraction = await extract(pdfDocument("q 1 0 0 1 0 0 cm Q"));
    expect(extraction).toMatchObject({
      kind: "pdf",
      text: "",
      metadata: { pages: 1 },
      signals: [],
    });
  });
});
