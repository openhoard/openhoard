import { defineConfig } from "vitest/config";
import { preset } from "@openhoard/config/vitest";

const config = preset({ floor: 85 });
// check.ts is the command's argument and environment handling; its work is in the tested modules.
config.test.coverage.exclude = [...(config.test.coverage.exclude ?? []), "src/check.ts"];
// e2e.test.ts opens a database per test and syncs into it: slower on Windows and macOS runners.
Object.assign(config.test, { testTimeout: 60_000, hookTimeout: 60_000 });
export default defineConfig(config);
