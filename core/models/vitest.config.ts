import { defineConfig } from "vitest/config";
import { preset } from "@openhoard/config/vitest";

const config = preset({ floor: 85 });
// The budget tests open a database (PGlite, or PostgreSQL in CI); the Windows runner is slow.
Object.assign(config.test, {
  hookTimeout: 60_000,
  testTimeout: process.platform === "win32" ? 120_000 : 30_000,
});
export default defineConfig(config);
