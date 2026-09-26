import { defineConfig } from "vitest/config";
import { preset } from "@openhoard/config/vitest";

const config = preset({ floor: 85 });
// A few tests hash and move several MiB (pure-JS BLAKE3); on a busy CI runner (Windows runs
// every package's suite at once, the extractor's child processes included) that took 30 s.
Object.assign(config.test, { testTimeout: 120_000 });
export default defineConfig(config);
