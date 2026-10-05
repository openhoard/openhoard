import { defineConfig } from "vitest/config";

const floor = 80;

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      // main.tsx only starts the app on the page.
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/main.tsx"],
      thresholds: { lines: floor, functions: floor, branches: floor - 5, statements: floor },
    },
  },
});
