import { defineConfig } from "vitest/config";
import { preset } from "@openhoard/config/vitest";

const base = preset({ floor: 85 });
// main.ts only wires process signals and the listener; it is exercised by the dev smoke test.
export default defineConfig({
  test: {
    ...base.test,
    // Suites migrate a fresh database in beforeAll; the Windows and macOS runners need longer.
    hookTimeout: 60_000,
    testTimeout: 30_000,
    coverage: { ...base.test.coverage, exclude: [...base.test.coverage.exclude, "src/main.ts"] },
  },
});
