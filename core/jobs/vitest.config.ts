import { defineConfig } from "vitest/config";
import { preset } from "@openhoard/config/vitest";

const config = preset({ floor: 85 });
// The tests start a PGlite database and pg-boss on it (see core/db's vitest config). The sync
// tests crawl dozens of files through a whole source, which the Windows runner takes minutes for.
const windows = process.platform === "win32";
Object.assign(config.test, { hookTimeout: 60_000, testTimeout: windows ? 180_000 : 30_000 });
export default defineConfig(config);
