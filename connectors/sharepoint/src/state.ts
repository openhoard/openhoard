import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/*
 * What the connector keeps between runs to follow changes (T-304): each library's folders, by
 * id, with the folder each is in and its name. Graph's delta says a folder was renamed or moved
 * and says nothing of what is inside it, whose paths changed all the same: knowing what the
 * folder was called before is how the connector knows to say so.
 *
 * Two kinds of file, in the source's own state directory:
 *
 * - `folders.<gen>.json`: the folders as they were when a cursor (or a delta's checkpoint) was
 *   made, and what the crawl left for the first delta to do. The cursor names its generation.
 *   A new generation is written before the token naming it is yielded, and the one a token
 *   names is never changed, so whichever token the runner saved last, its folders are the ones
 *   that were written for it. Generations nothing names any more are removed by a later delta.
 * - `crawl.<id>.jsonl`: the folders a crawl has met, and the ids it was told are deleted,
 *   appended a page at a time. A checkpoint names the log and how long it was; resuming cuts
 *   it back to that length, so a page yielded after the checkpoint and met again isn't counted
 *   twice or lost.
 *
 * Neither holds a file's name, content or anything of who may read it: ids, and folders'
 * names. A missing or damaged file is never guessed around: the caller crawls again. The
 * directory is this source's alone, and one sync's at a time: nothing here locks it.
 */

/** A folder: the folder it is in (null at a library's top) and its name. */
export interface FolderEntry {
  parent: string | null;
  name: string;
}
/** A library's folders by id. */
export type Folders = Map<string, FolderEntry>;
/** Every library's folders, by drive id. */
export type SiteFolders = Map<string, Folders>;

/**
 * What goes with a cursor: every library's folders, and what the crawl that made it left for
 * the first delta: folders it met under two names or in two places (what it yielded under the
 * first is somewhere else now: `relist`), and ids it was told are deleted (`deleted`: said by
 * the delta, where the runner counts deletions before it makes them).
 */
export interface Kept {
  folders: SiteFolders;
  relist: Map<string, Set<string>>;
  deleted: Map<string, Set<string>>;
}

/** One line of a crawl log: a folder met in a library, or an id the feed said is deleted. */
export type LogLine =
  | readonly [drive: string, id: string, parent: string | null, name: string]
  | readonly [drive: string, id: string];

/**
 * Deleted ids kept for the deltas after a crawl, at most, for a library. A crawl told of more
 * is being given the site's recycle bin: none are kept, and one of them that the crawl had
 * yielded before stays in the catalog until the next crawl.
 */
const MAX_DELETED = 5000;

const ID = /^[a-z0-9]{8,40}$/;
const GEN_FILE = /^folders\.([a-z0-9]{8,40})\.json$/;
const LOG_FILE = /^crawl\.([a-z0-9]{8,40})\.jsonl$/;

/** A new name for a generation or a log: unguessable is not needed, unique is. */
export const newStateId = (): string => randomBytes(10).toString("hex");

export interface FolderState {
  /** Writes a generation, whole, before its name is given to anyone. */
  writeGeneration(gen: string, kept: Kept): void;
  /** A generation, or undefined when it isn't there or can't be read. */
  readGeneration(gen: string): Kept | undefined;
  /** Removes every generation but this one, and every crawl log. */
  keepOnly(gen: string): void;
  /** Removes every crawl log but this one (a crawl starting, or resuming). */
  keepOnlyLog(log: string | null): void;
  /** Appends folders to a crawl log and returns its length in bytes, safely on disk. */
  appendLog(log: string, lines: readonly LogLine[]): number;
  /** A crawl log's length in bytes, or undefined when it isn't there. */
  logLength(log: string): number | undefined;
  /** Cuts a crawl log back to a length a checkpoint named. False when it is shorter. */
  truncateLog(log: string, length: number): boolean;
  /** What a crawl log comes to, the last word on each id, or undefined when it can't be read. */
  readLog(log: string): Kept | undefined;
}

export function folderState(dir: string): FolderState {
  const genPath = (gen: string) => join(dir, `folders.${gen}.json`);
  const logPath = (log: string) => join(dir, `crawl.${log}.jsonl`);
  const safe = (id: string) => {
    if (!ID.test(id)) throw new RangeError("not a state id");
    return id;
  };
  /** The directory, the server user's alone. (An existing one is made so, where that means anything.) */
  const ensureDir = () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Not ours to change: the files in it are 0600 all the same.
    }
  };
  const list = () => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  const entryOk = (v: unknown): v is [string, string | null, string] =>
    Array.isArray(v) &&
    v.length === 3 &&
    typeof v[0] === "string" &&
    (v[1] === null || typeof v[1] === "string") &&
    typeof v[2] === "string";
  /** Ids by library, as they are written: a plain object without a prototype to fall into. */
  const idsOut = (ids: Map<string, Set<string>>) => {
    const out = Object.create(null) as Record<string, string[]>;
    for (const [drive, set] of ids) if (set.size > 0) out[drive] = [...set];
    return out;
  };
  const idsIn = (v: unknown): Map<string, Set<string>> | undefined => {
    const out = new Map<string, Set<string>>();
    if (v === undefined) return out;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
    for (const [drive, ids] of Object.entries(v)) {
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) return undefined;
      out.set(drive, new Set(ids as string[]));
    }
    return out;
  };
  const setIn = (map: Map<string, Set<string>>, drive: string) => {
    let set = map.get(drive);
    if (!set) map.set(drive, (set = new Set()));
    return set;
  };

  return {
    writeGeneration(gen, kept) {
      ensureDir();
      const drives = Object.create(null) as Record<string, [string, string | null, string][]>;
      for (const [drive, folders] of kept.folders) {
        drives[drive] = [...folders].map(([id, f]) => [id, f.parent, f.name]);
      }
      const text = JSON.stringify({
        v: 1,
        drives,
        relist: idsOut(kept.relist),
        deleted: idsOut(kept.deleted),
      });
      const tmp = join(dir, `.folders.${safe(gen)}.${newStateId()}.tmp`);
      try {
        const fd = openSync(tmp, "wx", 0o600);
        try {
          writeFileSync(fd, text);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmp, genPath(gen));
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
    },

    readGeneration(gen) {
      if (!ID.test(gen)) return undefined;
      try {
        const parsed = JSON.parse(readFileSync(genPath(gen), "utf8")) as {
          v?: unknown;
          drives?: unknown;
          relist?: unknown;
          deleted?: unknown;
        } | null;
        const drives = parsed?.drives;
        const relist = idsIn(parsed?.relist);
        const deleted = idsIn(parsed?.deleted);
        const isMap = typeof drives === "object" && drives !== null && !Array.isArray(drives);
        if (parsed?.v !== 1 || !isMap || !relist || !deleted) {
          return undefined;
        }
        const site: SiteFolders = new Map();
        for (const [drive, entries] of Object.entries(drives)) {
          if (!Array.isArray(entries)) return undefined;
          const folders: Folders = new Map();
          for (const entry of entries as unknown[]) {
            if (!entryOk(entry)) return undefined;
            folders.set(entry[0], { parent: entry[1], name: entry[2] });
          }
          site.set(drive, folders);
        }
        return { folders: site, relist, deleted };
      } catch {
        return undefined;
      }
    },

    keepOnly(gen) {
      for (const name of list()) {
        const g = GEN_FILE.exec(name)?.[1];
        if ((g !== undefined && g !== gen) || LOG_FILE.test(name) || name.endsWith(".tmp")) {
          rmSync(join(dir, name), { force: true });
        }
      }
    },

    keepOnlyLog(log) {
      for (const name of list()) {
        const l = LOG_FILE.exec(name)?.[1];
        if (l !== undefined && l !== log) rmSync(join(dir, name), { force: true });
      }
    },

    appendLog(log, lines) {
      ensureDir();
      const fd = openSync(logPath(safe(log)), "a", 0o600);
      try {
        if (lines.length > 0) {
          writeFileSync(fd, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return statSync(logPath(log)).size;
    },

    logLength(log) {
      if (!ID.test(log)) return undefined;
      try {
        return statSync(logPath(log)).size;
      } catch {
        return undefined;
      }
    },

    truncateLog(log, length) {
      const size = this.logLength(log);
      if (size === undefined || !Number.isSafeInteger(length) || length < 0 || size < length) {
        return false;
      }
      if (size > length) truncateSync(logPath(log), length);
      return true;
    },

    readLog(log) {
      if (!ID.test(log)) return undefined;
      try {
        const kept: Kept = { folders: new Map(), relist: new Map(), deleted: new Map() };
        for (const text of readFileSync(logPath(log), "utf8").split("\n")) {
          if (text === "") continue;
          const line: unknown = JSON.parse(text);
          if (!Array.isArray(line) || typeof line[0] !== "string" || typeof line[1] !== "string") {
            return undefined;
          }
          const [drive, id] = line as [string, string];
          let folders = kept.folders.get(drive);
          if (!folders) kept.folders.set(drive, (folders = new Map()));
          if (line.length === 2) {
            // Said deleted: no folder any more, and nothing under it to look for.
            folders.delete(id);
            kept.relist.get(drive)?.delete(id);
            setIn(kept.deleted, drive).add(id);
            continue;
          }
          const entry = line.slice(1);
          if (line.length !== 4 || !entryOk(entry)) return undefined;
          const before = folders.get(id);
          // Met before under another name or in another place: what was yielded under it then
          // was placed by that, and is somewhere else now.
          if (before && (before.parent !== entry[1] || before.name !== entry[2])) {
            setIn(kept.relist, drive).add(id);
          }
          folders.set(id, { parent: entry[1], name: entry[2] });
          kept.deleted.get(drive)?.delete(id);
        }
        // A crawl told of that many deletions is given the recycle bin: not carried.
        for (const [drive, ids] of kept.deleted) {
          if (ids.size > MAX_DELETED) kept.deleted.delete(drive);
        }
        return kept;
      } catch {
        return undefined;
      }
    },
  };
}
