import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * `@openhoard/core-db/queue` hands out raw SQL outside row-level security (PGlite) and the
 * credentialed database URL (PostgreSQL), for pg-boss. Only core/jobs may import it: this test
 * reads every source file in the repository and fails on any other importer, the way
 * core/catalog's read-surface.test.ts fails on an unclassified export.
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SOURCE_DIRS = ["apps", "clients", "connectors", "core", "enrichers", "packages", "spikes"];
const SKIP = new Set(["node_modules", "dist", "coverage", ".turbo", "target"]);
const CODE = /\.(?:[cm]?[jt]sx?)$/;
/** The specifier, however it is quoted, and a relative reach into core/db's queue module. */
const IMPORTS_QUEUE =
  /["'`]@openhoard\/core-db\/queue["'`]|\bdb\/(?:src|dist)\/queue(?:\.[cm]?[jt]s)?["'`]/;
/** Where it may appear: core/jobs, and core/db itself (the module, its tests, this test). */
const ALLOWED = [`core${sep}jobs${sep}`, `core${sep}db${sep}`];

function sources(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (CODE.test(entry.name)) out.push(path);
  }
  return out;
}

describe("the queue entry point", () => {
  const files = SOURCE_DIRS.flatMap((d) => sources(join(ROOT, d)));

  it("finds the repository's sources", () => {
    const rel = files.map((f) => relative(ROOT, f));
    expect(rel).toContain(join("core", "jobs", "src", "jobs.ts"));
    expect(rel).toContain(join("apps", "server", "src", "main.ts"));
  });

  it("is imported by core/jobs and nothing else", () => {
    const importers = files
      .filter((f) => IMPORTS_QUEUE.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f));
    expect(importers).toContain(join("core", "jobs", "src", "jobs.ts"));
    expect(importers.filter((f) => !ALLOWED.some((prefix) => f.startsWith(prefix)))).toEqual([]);
  });

  it("would catch an importer anywhere else", () => {
    for (const line of [
      `import { queueConnectionOf } from "@openhoard/core-db/queue";`,
      `const q = await import('@openhoard/core-db/queue');`,
      `import { queueConnectionOf } from "../../../core/db/src/queue.js";`,
      `import { queueConnectionOf } from "../../db/dist/queue";`,
    ]) {
      expect(IMPORTS_QUEUE.test(line), line).toBe(true);
    }
    expect(IMPORTS_QUEUE.test(`import { openDatabase } from "@openhoard/core-db";`)).toBe(false);
  });
});
