import { defineConfig } from "vitest/config";
import { preset } from "@openhoard/config/vitest";

const config = preset({ floor: 85 });
// Each leak-harness run probes every user against every canary; under coverage on a slow CI
// runner (macOS) one run can take several seconds.
Object.assign(config.test, { testTimeout: 30_000 });
export default defineConfig(config);
