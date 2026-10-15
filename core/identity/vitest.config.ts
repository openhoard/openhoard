import { defineConfig } from "vitest/config";
import { preset } from "@openhoard/config/vitest";

const config = preset({ floor: 70 });
// The directory tests start a PGlite database (see core/db's vitest config).
Object.assign(config.test, { hookTimeout: 60_000, testTimeout: 30_000 });
// Passkeys are the frozen solo track's (CLAUDE.md): their suites run in the slow lane, so the
// fast lane's floor doesn't count them.
config.test.coverage.exclude.push("src/passkeys.ts", "src/webauthn.ts", "src/testing.ts");
export default defineConfig(config);
