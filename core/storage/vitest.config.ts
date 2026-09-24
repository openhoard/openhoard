import { defineConfig } from "vitest/config";
import { preset } from "@openhoard/config/vitest";

const config = preset({ floor: 85 });
// A few tests hash and move several MiB (pure-JS BLAKE3); on a busy CI runner that can pass
// the 5 s default.
Object.assign(config.test, { testTimeout: 30_000 });
export default defineConfig(config);
