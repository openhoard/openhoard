import { defineConfig } from "vitest/config";
import { preset } from "@openhoard/config/vitest";

const config = preset({ floor: 85 });
// check.ts is the command's argument and environment handling; its work is in the tested modules.
config.test.coverage.exclude = [...(config.test.coverage.exclude ?? []), "src/check.ts"];
export default defineConfig(config);
