// Shared Vitest preset. `floor` is the package's coverage minimum (core 85, plugins 70).
export function preset({ floor = 85 } = {}) {
  return {
    test: {
      include: ["src/**/*.test.ts", "test/**/*.test.ts"],
      coverage: {
        provider: "v8",
        include: ["src/**/*.ts"],
        exclude: ["src/**/*.test.ts", "src/**/index.ts", "src/**/types.ts"],
        thresholds: { lines: floor, functions: floor, branches: floor - 5, statements: floor },
      },
    },
  };
}
