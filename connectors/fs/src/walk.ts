import type { BigIntStats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fsError } from "./errors.js";

/*
 * Walking the folder: depth first, parents before their children, names in UTF-16 code-unit
 * order (the same on every OS, whatever order the file system lists them in), so a crawl is
 * deterministic and can resume after any position.
 *
 * What is left out, on purpose:
 * - symbolic links and junctions (Windows reports junctions as links too), whether to a file or a
 *   folder, inside the folder or outside it: following them could leave the folder, loop, or
 *   report one file twice. A link's target inside the folder is crawled where it is anyway;
 * - anything on another file system mounted inside the folder (its device differs): a mount can
 *   come and go, and its inode numbers aren't the folder's. By default a mount is reported as
 *   `unreadable` (what was there is kept, and nothing is reconciled): a disk mounted over a
 *   folder, or a subvolume appearing, must not make its files look deleted. With
 *   `otherDevices: "skip"` it is left out as if it weren't there;
 * - anything that isn't a regular file or a folder (sockets, pipes, devices);
 * - with `hardLinks: "skip"`, files with more than one link;
 * - anything deeper than MAX_DEPTH folders.
 *
 * Gone and unreadable are not the same. An entry that vanishes while the walk looks (ENOENT,
 * ENOTDIR) is gone. One the connector may not stat, or a folder it may not list (EACCES, EPERM,
 * EBUSY as Windows answers for pagefile.sys, hiberfil.sys and the like, a path the OS refuses as
 * too long), is `unreadable`: the walk says so, and the caller treats
 * what was there before as still there (a delta keeps it, a crawl doesn't reconcile). Anything
 * else that fails (a busy or unreachable disk) throws: a walk never reports a folder as emptier
 * than it is because reading it failed.
 */

/** Deepest folder level walked. */
export const MAX_DEPTH = 256;

/** One file or folder as the walk found it. Numbers from the file system stay bigints. */
export interface Entry {
  path: string[];
  kind: "file" | "folder";
  ino: bigint;
  /** When the file system says the entry was created (ns), or 0 when it doesn't keep that. */
  birthNs: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  /** How many names the file has (hard links); 1 for folders. */
  links: bigint;
}

/**
 * A place the walk couldn't see into: the entry at `path` (it couldn't stat it), or, with
 * `contents`, what is in the folder at `path` (it couldn't list it).
 */
export interface Unreadable {
  kind: "unreadable";
  path: string[];
  contents: boolean;
}

/** Compares two paths in walk order: a folder before what is in it, names by code unit. */
export function compareWalk(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as string;
    const y = b[i] as string;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

export function isPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((name, i) => path[i] === name);
}

/** Codes that mean the entry is gone. */
const GONE = new Set(["ENOENT", "ENOTDIR"]);
/** Codes that mean the entry is there, but not for the connector to see. */
const UNREADABLE = new Set(["EACCES", "EPERM", "EBUSY", "ENAMETOOLONG", "ELOOP"]);

const codeOf = (e: unknown) => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
};

export interface WalkOptions {
  /** Resume after this path (a crawl's checkpoint). */
  after?: readonly string[];
  /** Leave out files with more than one link. Default false. */
  skipHardLinks?: boolean;
  /** Leave out what is on another device, as if it weren't there. Default false: unreadable. */
  skipOtherDevices?: boolean;
}

/**
 * The entries under `root` (not `root` itself), in walk order, and where it couldn't see.
 * `dev` is the root's device: other file systems are left out.
 */
export async function* walk(
  root: string,
  dev: bigint,
  signal: AbortSignal,
  options: WalkOptions = {},
): AsyncGenerator<Entry | Unreadable> {
  const { after, skipHardLinks = false, skipOtherDevices = false } = options;
  yield* visit(root, [], 0);

  async function* visit(
    dir: string,
    rel: string[],
    depth: number,
  ): AsyncGenerator<Entry | Unreadable> {
    signal.throwIfAborted();
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (e) {
      // The root itself must be readable.
      if (depth > 0 && GONE.has(codeOf(e))) return;
      if (depth > 0 && UNREADABLE.has(codeOf(e))) {
        yield { kind: "unreadable", path: rel, contents: true };
        return;
      }
      throw fsError(e);
    }
    names.sort();
    for (const name of names) {
      const path = [...rel, name];
      // Everything up to `after` was yielded before the checkpoint; only a folder on the way to
      // it still has something after it.
      if (after && compareWalk(path, after) <= 0 && !isPrefix(path, after)) continue;
      signal.throwIfAborted();
      const abs = join(dir, name);
      const fresh = !after || compareWalk(path, after) > 0;
      let st: BigIntStats;
      try {
        st = await lstat(abs, { bigint: true });
      } catch (e) {
        if (GONE.has(codeOf(e))) continue;
        if (UNREADABLE.has(codeOf(e))) {
          if (fresh) yield { kind: "unreadable", path, contents: false };
          continue;
        }
        throw fsError(e);
      }
      if (st.isSymbolicLink()) continue;
      if (st.dev !== dev) {
        if (fresh && !skipOtherDevices) yield { kind: "unreadable", path, contents: false };
        continue;
      }
      if (st.isFile()) {
        if (fresh && !(skipHardLinks && st.nlink > 1n)) yield entry(path, "file", st);
      } else if (st.isDirectory()) {
        if (fresh) yield entry(path, "folder", st);
        if (depth + 1 < MAX_DEPTH) yield* visit(abs, path, depth + 1);
      }
    }
  }
}

export function entry(path: string[], kind: Entry["kind"], st: BigIntStats): Entry {
  return {
    path,
    kind,
    ino: st.ino,
    birthNs: st.birthtimeNs > 0n ? st.birthtimeNs : 0n,
    size: kind === "file" ? st.size : 0n,
    mtimeNs: st.mtimeNs,
    ctimeNs: st.ctimeNs,
    links: kind === "file" ? st.nlink : 1n,
  };
}
