import { defineConfig } from "vitest/config";
import { preset } from "@openhoard/config/vitest";

const config = preset({ floor: 70 });
// check.ts is the command's argument and environment handling; its work is in the tested modules.
config.test.coverage.exclude = [...(config.test.coverage.exclude ?? []), "src/check.ts"];
// e2e.slow.test.ts opens a database per test and syncs into it.
Object.assign(config.test, { testTimeout: 60_000, hookTimeout: 60_000 });
export default defineConfig(config);
