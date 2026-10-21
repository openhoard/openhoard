import { defineConfig } from "vitest/config";
import { preset } from "@openhoard/config/vitest";

const config = preset({ floor: 70 });
// The tests start a PGlite database and pg-boss on it (see core/db's vitest config), and the
// extract tests a child process per file: the Windows runner is slow at both.
const windows = process.platform === "win32";
Object.assign(config.test, { hookTimeout: 60_000, testTimeout: windows ? 180_000 : 30_000 });
export default defineConfig(config);
