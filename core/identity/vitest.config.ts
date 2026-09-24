import { defineConfig } from "vitest/config";
import { preset } from "@openhoard/config/vitest";

const config = preset({ floor: 85 });
// The directory tests start a PGlite database (see core/db's vitest config).
Object.assign(config.test, { hookTimeout: 60_000, testTimeout: 30_000 });
export default defineConfig(config);
