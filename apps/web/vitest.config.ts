import { configDefaults, defineConfig } from "vitest/config";
import { SLOW_LANE } from "@openhoard/config/vitest";

const floor = 70;

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    // No slow suites here: the slow lane (packages/config/vitest.preset.js) runs nothing.
    include: SLOW_LANE ? ["src/**/*.slow.test.tsx"] : ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: [...configDefaults.exclude],
    passWithNoTests: true,
    // CI's Linux leg runs every package's coverage at once, beside the database suites: a file's
    // first test, which pays for jsdom and the first render, has run past the 5 s default there.
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      // main.tsx only starts the app on the page.
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/main.tsx"],
      thresholds: SLOW_LANE
        ? {}
        : { lines: floor, functions: floor, branches: floor - 10, statements: floor },
    },
  },
});
