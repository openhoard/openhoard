import { defineConfig } from "vitest/config";
import { preset } from "@openhoard/config/vitest";

const config = preset({ floor: 85 });
// Starting PGlite (WASM) and migrating the snapshot every test file starts from takes seconds,
// and well over the 10 s default on slow CI runners (macOS).
Object.assign(config.test, { hookTimeout: 60_000, testTimeout: 30_000 });
// Without a native server (OPENHOARD_TEST_POSTGRES_URL), the Postgres driver never runs; the
// "postgres" CI job measures it instead.
if (!process.env.OPENHOARD_TEST_POSTGRES_URL) {
  config.test.coverage.exclude.push("src/postgres.ts", "src/testing-postgres.ts");
}
export default defineConfig(config);
