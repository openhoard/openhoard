import { INSPECTED_CHARS } from "@openhoard/core-catalog";
import { MAX_SCAN_CHARS } from "@openhoard/core-summarize";
import { describe, expect, it } from "vitest";

describe("the injection-flag step", () => {
  it("reads as much text as the catalog lets an AI client be served", () => {
    // core/catalog can't import the detector; `open` serves no text past INSPECTED_CHARS
    // because the detector scored none past MAX_SCAN_CHARS. One changing alone is a hole.
    expect(INSPECTED_CHARS).toBe(MAX_SCAN_CHARS);
  });
});
