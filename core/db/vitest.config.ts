import { defineConfig } from "vitest/config";
import { preset } from "@openhoard/config/vitest";

const config = preset({ floor: 85 });
// Without a native server (OPENHOARD_TEST_POSTGRES_URL), the Postgres driver never runs; the
// "postgres" CI job measures it instead.
if (!process.env.OPENHOARD_TEST_POSTGRES_URL) {
  config.test.coverage.exclude.push("src/postgres.ts", "src/testing-postgres.ts");
}
export default defineConfig(config);
