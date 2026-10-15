import { configDefaults } from "vitest/config";

/**
 * The slow lane (CLAUDE.md, "Input handling and tests"): a suite named `*.slow.test.ts` (over a
 * minute, large inputs, the frozen solo track) runs only when `OPENHOARD_TEST_SLOW=1`, which
 * `pnpm test:slow` sets, and then only those suites run. CI runs the lane once, on Linux
 * against native Postgres; the matrix jobs run the fast suites.
 */
export const SLOW_LANE = process.env.OPENHOARD_TEST_SLOW === "1";

// Shared Vitest preset. `floor` is the package's coverage minimum: a tripwire against a package
// whose tests stopped running, not a target (CLAUDE.md, "Input handling and tests"). Core 70,
// plugins 60; branches ten under, so refusal branches needn't each have a test.
export function preset({ floor = 70 } = {}) {
  return {
    test: {
      include: SLOW_LANE ? ["src/**/*.slow.test.ts"] : ["src/**/*.test.ts", "test/**/*.test.ts"],
      exclude: SLOW_LANE
        ? [...configDefaults.exclude]
        : [...configDefaults.exclude, "**/*.slow.test.ts"],
      // The slow lane runs what the fast suites don't: it is not held to the coverage floor.
      passWithNoTests: true,
      coverage: {
        provider: "v8",
        include: ["src/**/*.ts"],
        exclude: ["src/**/*.test.ts", "src/**/index.ts", "src/**/types.ts"],
        thresholds: SLOW_LANE
          ? {}
          : { lines: floor, functions: floor, branches: floor - 10, statements: floor },
      },
    },
  };
}
