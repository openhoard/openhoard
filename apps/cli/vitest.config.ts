import { defineConfig } from "vitest/config";
import { preset } from "@openhoard/config/vitest";

const base = preset({ floor: 70 });
// bin.ts only wires the process (argv, stdio, exit), like the server's main.ts.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    coverage: { ...base.test.coverage, exclude: [...base.test.coverage.exclude, "src/bin.ts"] },
  },
});
