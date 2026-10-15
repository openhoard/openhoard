// The slow lane: runs every package's `*.slow.test.ts` suites and nothing else
// (packages/config/vitest.preset.js). `pnpm test:slow [-- <turbo args>]`; it works on Windows
// too, where setting a variable on the command line doesn't.
import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  // (`pnpm test:slow -- --concurrency=1`: pnpm passes the `--` through; turbo would hand what
  // follows it to vitest.)
  ["turbo", "run", "test", "--continue", ...process.argv.slice(2).filter((a) => a !== "--")],
  {
    stdio: "inherit",
    env: { ...process.env, OPENHOARD_TEST_SLOW: "1" },
    shell: process.platform === "win32",
  },
);
process.exit(result.status ?? 1);
