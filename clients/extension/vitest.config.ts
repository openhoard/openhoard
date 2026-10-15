import { defineConfig } from "vitest/config";
import { preset, SLOW_LANE } from "@openhoard/config/vitest";

const base = preset({ floor: 70 });
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    // The extension is on the frozen solo track (CLAUDE.md): all of its suites are slow-lane,
    // and with no fast suite there is no floor to hold (an empty run would fail thresholds).
    include: SLOW_LANE ? ["src/**/*.test.ts"] : [],
    coverage: {
      ...base.test.coverage,
      thresholds: {},
      // The glue that only runs inside a browser (the extension's worker, its popup and its options page) and
      // the browser API's types: what they do is in lib.ts and capture.ts, which are tested.
      exclude: [
        ...base.test.coverage.exclude,
        "src/background.ts",
        "src/popup.ts",
        "src/options.ts",
        "src/env.ts",
        "src/browser.d.ts",
      ],
    },
  },
});
