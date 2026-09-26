import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * What the child process may read under Node's permission model: the folder its code runs from
 * (dist/, or src/ in this package's tests), this package's package.json (Node reads it to know
 * the files are ES modules), and each library it loads, folder by folder: the parsers and their
 * own dependencies, found by resolving them as Node will. Nothing else: no configuration, data
 * folder, blob store, home or temp files, and not the whole node_modules folder (in a hoisted
 * install that would be every package the server has).
 *
 * Node's permission model follows symbolic links, so a link inside a granted folder that points
 * outside would widen the grant. Every granted folder is walked once, and a link that leads out
 * of the granted set stops the sandbox from starting (UnsafeInstallError).
 */

/** The parsers the child loads, directly. Their dependencies are found from their package.json. */
export const LIBRARIES = ["csv-parse", "pdfjs-dist", "saxes", "yauzl"] as const;

/** Where the child's entry point is: `child.ts` beside this file in tests (src/), `child.js` built. */
export function childEntry(): string {
  const here = fileURLToPath(import.meta.url);
  return join(dirname(here), here.endsWith(".ts") ? "child.ts" : "child.js");
}

/** A granted folder holds a symbolic link that leads outside what the child may read. */
export class UnsafeInstallError extends Error {
  constructor(link: string) {
    super(`the extractor's sandbox would be widened by a link: ${link}`);
    this.name = "UnsafeInstallError";
  }
}

let cached: string[] | undefined;

/**
 * The paths the child may read (real paths): its code folder, this package's package.json, and
 * the libraries' package folders. Checked for links that lead out; cached after the first call.
 */
export function readablePaths(): string[] {
  if (!cached) {
    const here = dirname(fileURLToPath(import.meta.url));
    cached = grantsFor(here, findPackageRoot(here), LIBRARIES);
  }
  return [...cached];
}

/**
 * What to grant for code in `codeFolder` of the package at `packageRoot` that loads `libraries`:
 * the code folder and the package's package.json; for each library and each of its
 * dependencies, the paths Node looks at while resolving it (Node's permission model checks the
 * path it reads, a package manager's link included) and the package's real folder. Then a
 * check that no link in any of it leads elsewhere.
 */
export function grantsFor(
  codeFolder: string,
  packageRoot: string,
  libraries: readonly string[],
): string[] {
  const code = realpathSync(codeFolder);
  const folders = new Set<string>([code]);
  const lookups = new Set<string>();
  const visit = (name: string, from: string) => {
    const { looked, found } = lookup(name, from);
    for (const path of looked) lookups.add(path);
    if (found === null) return;
    const real = realpathSync(found);
    if (folders.has(real)) return;
    folders.add(real);
    const manifest = JSON.parse(readFileSync(join(real, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency, real);
  };
  for (const library of libraries) visit(library, code);
  const real = [...folders].sort();
  for (const folder of real) checkLinks(folder, real);
  // A path Node looks at may be a link (pnpm's node_modules): it must lead into the grant.
  for (const path of lookups) {
    if (!existsSync(path)) continue;
    const target = realpathSync(path);
    if (!real.some((g) => inside(target, g))) throw new UnsafeInstallError(path);
  }
  return [
    ...real,
    ...[...lookups].filter((p) => !real.includes(p)).sort(),
    realpathSync(join(packageRoot, "package.json")),
  ];
}

/**
 * The paths Node's resolver tries for package `name` from folder `from` (each ancestor's
 * node_modules, nearest first), up to the one that has it, which is `found` (null if none).
 */
function lookup(name: string, from: string): { looked: string[]; found: string | null } {
  const looked: string[] = [];
  let dir = from;
  for (;;) {
    if (basename(dir) !== "node_modules") {
      const candidate = join(dir, "node_modules", name);
      looked.push(candidate);
      if (existsSync(join(candidate, "package.json"))) return { looked, found: candidate };
    }
    const up = dirname(dir);
    if (up === dir) return { looked, found: null };
    dir = up;
  }
}

/** Whether `path` is `folder` or inside it. */
function inside(path: string, folder: string): boolean {
  const r = relative(folder, path);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/** Throws UnsafeInstallError for a link under `folder` whose target isn't in `granted`. */
function checkLinks(folder: string, granted: readonly string[]): void {
  const stack = [folder];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink() || lstatSync(path).isSymbolicLink()) {
        let target: string;
        try {
          target = realpathSync(path);
        } catch {
          throw new UnsafeInstallError(path);
        }
        if (!granted.some((g) => inside(target, g))) throw new UnsafeInstallError(path);
      } else if (entry.isDirectory()) {
        stack.push(path);
      }
    }
  }
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
