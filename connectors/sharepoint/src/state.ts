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
 *   made. The cursor names its generation. A new generation is written before the token naming
 *   it is yielded, and the one a token names is never changed, so whichever token the runner
 *   saved last, its folders are the ones that were written for it. Generations nothing names
 *   any more are removed by a later delta.
 * - `crawl.<id>.jsonl`: the folders a crawl has met, appended a page at a time. A page yielded
 *   after a checkpoint the runner didn't save is met again on resume and appended again: the
 *   last line for an id wins, so that is harmless.
 *
 * Neither holds a file's name, content or anything of who may read it: ids, and folders'
 * names. A missing or damaged file is never repaired: the caller crawls again.
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

/** One line of a crawl log: a folder met in a library. */
export type LogLine = readonly [drive: string, id: string, parent: string | null, name: string];

const ID = /^[a-z0-9]{8,40}$/;
const GEN_FILE = /^folders\.([a-z0-9]{8,40})\.json$/;
const LOG_FILE = /^crawl\.([a-z0-9]{8,40})\.jsonl$/;

/** A new name for a generation or a log: unguessable is not needed, unique is. */
export const newStateId = (): string => randomBytes(10).toString("hex");

export interface FolderState {
  /** Writes a generation, whole, before its name is given to anyone. */
  writeGeneration(gen: string, folders: SiteFolders): void;
  /** A generation, or undefined when it isn't there or can't be read. */
  readGeneration(gen: string): SiteFolders | undefined;
  /** Removes every generation but this one, and every crawl log. */
  keepOnly(gen: string): void;
  /** Removes every crawl log but this one (a crawl starting, or resuming). */
  keepOnlyLog(log: string | null): void;
  /** Appends folders to a crawl log, safely on disk. */
  appendLog(log: string, lines: readonly LogLine[]): void;
  /** What a crawl log comes to, the last word on each id, or undefined when it can't be read. */
  readLog(log: string): SiteFolders | undefined;
}

type Entry = [id: string, parent: string | null, name: string];
const isEntry = (v: unknown): v is Entry =>
  Array.isArray(v) &&
  v.length === 3 &&
  typeof v[0] === "string" &&
  (v[1] === null || typeof v[1] === "string") &&
  typeof v[2] === "string";

export function folderState(dir: string): FolderState {
  const safe = (id: string) => {
    if (!ID.test(id)) throw new RangeError("not a state id");
    return id;
  };
  const genPath = (gen: string) => join(dir, `folders.${safe(gen)}.json`);
  const logPath = (log: string) => join(dir, `crawl.${safe(log)}.jsonl`);
  /** The directory, the server user's alone. */
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
  const remove = (keep: (name: string) => boolean) => {
    for (const name of list()) if (!keep(name)) rmSync(join(dir, name), { force: true });
  };

  return {
    writeGeneration(gen, folders) {
      ensureDir();
      const drives = Object.create(null) as Record<string, Entry[]>;
      for (const [drive, entries] of folders) {
        drives[drive] = [...entries].map(([id, f]) => [id, f.parent, f.name]);
      }
      const tmp = join(dir, `.folders.${safe(gen)}.${newStateId()}.tmp`);
      try {
        const fd = openSync(tmp, "wx", 0o600);
        try {
          writeFileSync(fd, JSON.stringify({ v: 1, drives }));
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
      try {
        const parsed = JSON.parse(readFileSync(genPath(gen), "utf8")) as {
          v?: unknown;
          drives?: unknown;
        };
        const drives = parsed.drives;
        if (parsed.v !== 1 || typeof drives !== "object" || drives === null) return undefined;
        const site: SiteFolders = new Map();
        for (const [drive, entries] of Object.entries(drives)) {
          if (!Array.isArray(entries) || !entries.every(isEntry)) return undefined;
          site.set(drive, new Map(entries.map((e) => [e[0], { parent: e[1], name: e[2] }])));
        }
        return site;
      } catch {
        return undefined;
      }
    },

    keepOnly(gen) {
      remove((name) => {
        const g = GEN_FILE.exec(name)?.[1];
        return g === gen || (g === undefined && !LOG_FILE.test(name) && !name.endsWith(".tmp"));
      });
    },

    keepOnlyLog(log) {
      remove((name) => {
        const l = LOG_FILE.exec(name)?.[1];
        return l === undefined || l === log;
      });
    },

    appendLog(log, lines) {
      ensureDir();
      const fd = openSync(logPath(log), "a", 0o600);
      try {
        if (lines.length > 0)
          writeFileSync(fd, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },

    readLog(log) {
      try {
        const site: SiteFolders = new Map();
        for (const text of readFileSync(logPath(log), "utf8").split("\n")) {
          if (text === "") continue;
          const line: unknown = JSON.parse(text);
          if (!Array.isArray(line) || line.length !== 4 || typeof line[0] !== "string") {
            return undefined;
          }
          const entry = line.slice(1);
          if (!isEntry(entry)) return undefined;
          let folders = site.get(line[0] as string);
          if (!folders) site.set(line[0] as string, (folders = new Map()));
          folders.set(entry[0], { parent: entry[1], name: entry[2] });
        }
        return site;
      } catch {
        return undefined;
      }
    },
  };
}
