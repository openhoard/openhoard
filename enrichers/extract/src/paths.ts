import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * What the child process may read under Node's permission model: its own code and the code of
 * the libraries it loads, nothing else (no configuration, no data folder, no blob store, no
 * home directory). The folders are found by resolving each library from this package, then
 * their own dependencies from them, as Node will when the child imports them.
 */

/** The parsers the child loads, directly. Their dependencies are found from their package.json. */
const LIBRARIES = ["csv-parse", "pdfjs-dist", "saxes", "yauzl"] as const;

/** Where the child's entry point is: `child.ts` beside this file in tests (src/), `child.js` built. */
export function childEntry(): string {
  const here = fileURLToPath(import.meta.url);
  return join(dirname(here), here.endsWith(".ts") ? "child.ts" : "child.js");
}

let cached: string[] | undefined;

/**
 * The folders the child may read: this package, and each library's `node_modules` folder (so
 * Node can follow a package manager's links to the library's own dependencies), real paths.
 */
export function readableFolders(): string[] {
  if (cached) return [...cached];
  const folders = new Set<string>();
  const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  folders.add(realpathSync(packageRoot));
  const seen = new Set<string>();
  const visit = (name: string, from: string) => {
    const dir = packageDir(name, from);
    if (dir === null || seen.has(dir)) return;
    seen.add(dir);
    folders.add(nodeModulesOf(dir));
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency, dir);
  };
  for (const library of LIBRARIES) visit(library, packageRoot);
  cached = [...folders].sort();
  return [...cached];
}

/** The folder holding this package's package.json. */
function findPackageRoot(from: string): string {
  let dir = from;
  while (!existsSync(join(dir, "package.json"))) {
    const up = dirname(dir);
    if (up === dir) throw new Error("the extractor's package.json was not found");
    dir = up;
  }
  return dir;
}

/** A package's folder (real path) as Node resolves it from `from`, or null if it isn't installed. */
function packageDir(name: string, from: string): string | null {
  const require = createRequire(join(from, "package.json"));
  let entry: string;
  try {
    entry = require.resolve(`${name}/package.json`);
  } catch {
    try {
      entry = require.resolve(name);
    } catch {
      return null;
    }
  }
  // Walk up from the entry to the folder whose package.json names the package.
  let dir = dirname(realpathSync(entry));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const { name: found } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
      if (found === name) return dir;
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The `node_modules` folder a package sits in (for a scoped package, above its scope). */
function nodeModulesOf(dir: string): string {
  let at = dirname(dir);
  while (basename(at) !== "node_modules") {
    const up = dirname(at);
    if (up === at) return dir;
    at = up;
  }
  return at;
}
