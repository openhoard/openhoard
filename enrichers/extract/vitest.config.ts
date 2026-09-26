import { defineConfig } from "vitest/config";
import { preset } from "@openhoard/config/vitest";

const config = preset({ floor: 85 });
// Extraction tests start child processes (Node with type stripping in this package's tests);
// Windows runners start them slowly.
Object.assign(config.test, { hookTimeout: 60_000, testTimeout: 60_000 });
// The child process's entry runs only in the child, where coverage can't see it (the sandbox
// tests exercise it); fixtures are test code.
config.test.coverage.exclude.push("src/child.ts", "src/**/*.fixtures.ts");
export default defineConfig(config);
