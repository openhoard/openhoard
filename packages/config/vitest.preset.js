// Shared Vitest preset. `floor` is the package's coverage minimum: a tripwire against a package
// whose tests stopped running, not a target (CLAUDE.md, "Input handling and tests"). Core 70,
// plugins 60; branches ten under, so refusal branches needn't each have a test.
export function preset({ floor = 70 } = {}) {
  return {
    test: {
      include: ["src/**/*.test.ts", "test/**/*.test.ts"],
      coverage: {
        provider: "v8",
        include: ["src/**/*.ts"],
        exclude: ["src/**/*.test.ts", "src/**/index.ts", "src/**/types.ts"],
        thresholds: { lines: floor, functions: floor, branches: floor - 10, statements: floor },
      },
    },
  };
}
