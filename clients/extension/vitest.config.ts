import { defineConfig } from "vitest/config";
import { preset } from "@openhoard/config/vitest";

const base = preset({ floor: 85 });
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    coverage: {
      ...base.test.coverage,
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
