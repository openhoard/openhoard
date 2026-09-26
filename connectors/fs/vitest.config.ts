import { defineConfig } from "vitest/config";
import { preset } from "@openhoard/config/vitest";

const config = preset({ floor: 85 });
// The contract kit writes and crawls real folders; Windows and macOS runners are slower at it.
Object.assign(config.test, { testTimeout: 60_000, hookTimeout: 60_000 });
export default defineConfig(config);
