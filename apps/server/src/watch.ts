import {
  watch as fsWatch,
  readFileSync,
  statSync,
  type BigIntStats,
  type Dirent,
  type FSWatcher,
} from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import type { SourceConfig } from "./config.js";

/*
 * Folder watching (T-1203): a file saved into an fs source's folder syncs that source within
 * seconds, not at its next schedule. The schedule stays the safety net: watch events can be lost
 * (network drives, an overflowing event queue, changes while the server was down), and the fs
 * connector compares the whole folder on every run anyway, so an event only says "sync now",
 * never what changed.
 *
 * - One watcher per fs source with `watch` on. On macOS and Windows, fs.watch(root,
 *   { recursive }) (FSEvents, ReadDirectoryChangesW). Not on Linux: there Node's recursive
 *   fs.watch is emulated, with an inotify watch on every file and a synchronous stat of the whole
 *   tree on the event loop, so a large folder would stall the server and use up the user's
 *   inotify watches (every program's). On Linux each folder gets a plain fs.watch instead (it
 *   reports its files' changes), found by an asynchronous walk that, like the connector's
 *   (connectors/fs walk.ts), never follows links below the root and leaves out other file
 *   systems mounted inside; the watches all sources hold together are capped (a share of the
 *   user's inotify limit), and running out fails the source's watcher before inotify does.
 * - Events are debounced per source: a sync is requested after `debounceMs` of quiet, but no
 *   later than `maxWaitMs` after the first event of a burst, so a folder written to all the time
 *   still syncs. At most one request per source is in flight; one wanted meanwhile follows it.
 *   requestSync() coalesces (a waiting job is brought forward, never doubled), so this only
 *   needs to keep the calls few.
 * - Noise never worth a sync (isWatchNoise()) is ignored.
 * - A watcher that fails (the folder removed, EPERM on the root, ENOSPC at Linux's inotify
 *   limit, EMFILE) never takes the server down: it is logged once (warn), closed, and the source
 *   falls back to its schedule. Watching is tried again every `retryMs` (5 min); once a watcher
 *   covers the whole folder again, a sync is requested for what happened meanwhile. A root
 *   folder replaced (removed and made again) is watched afresh.
 * - File names are logged at debug only: they can be sensitive.
 */

/** What a source's watcher needs from its configuration. */
export type WatchedSource = Pick<SourceConfig, "id" | "tenantId" | "root" | "connector" | "watch">;

export interface WatchLogger {
  debug(fields: object, message: string): void;
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

/** A running watcher, as a WatchFactory returns it. */
export interface WatchHandle {
  close(): void;
  /**
   * Settles once the watcher covers the whole folder (Linux: after its first walk). A failure
   * meanwhile goes to `onError`; `ready` still resolves.
   */
  ready?: Promise<void>;
  /** The watched root's identity (folderIdentity()): a folder replaced since has another. */
  rootId?: string;
}

/**
 * Starts watching `root`: `onEvent` gets each change's path relative to root (null when the
 * platform didn't say), `onError` a failure, after which nothing more is reported; `onDebug`
 * what it left out (no file names). Throws when it can't start.
 */
export type WatchFactory = (
  root: string,
  onEvent: (path: string | null) => void,
  onError: (err: unknown) => void,
  onDebug?: (fields: object, message: string) => void,
) => WatchHandle;

export interface WatchOptions {
  /** Asks for a sync of the source now (Jobs.requestSync()). */
  request: (tenantId: string, source: string) => Promise<unknown>;
  log: WatchLogger;
  /** Quiet time before a sync is requested, in ms. Default 2,000. */
  debounceMs?: number;
  /** Longest a burst of events waits for its sync, from its first event, in ms. Default 10,000. */
  maxWaitMs?: number;
  /** How often a failed watcher is tried again, in ms. Default 5 minutes. */
  retryMs?: number;
  /** How long close() waits for sync requests in flight, in ms. Default 2,000. */
  closeWaitMs?: number;
  /** How folders are watched (tests pass their own). Default: this platform's (see above). */
  watcher?: WatchFactory;
}

export const WATCH_DEBOUNCE_MS = 2_000;
export const WATCH_MAX_WAIT_MS = 10_000;
export const WATCH_RETRY_MS = 5 * 60_000;
const CLOSE_WAIT_MS = 2_000;

/** Endings of files that are never worth a sync (temporary, swap, partial downloads). */
const NOISE_ENDINGS = [".tmp", ".swp", ".swx", ".crdownload", ".part"];

/**
 * Whether a change to this path (relative to the folder) is noise that shouldn't trigger a
 * sync: Office lock and temporary files (`~$…`, `*.tmp`, LibreOffice's `.~lock.…#`), editors'
 * swap and backup files (vim's `*.swp`, `*.swx` and `4913` probe; `*~`), partial downloads
 * (`*.crdownload`, `*.part`), and the folder metadata macOS and Windows write (`.DS_Store`,
 * `Thumbs.db`, `desktop.ini`). Only the name counts: the fs connector indexes dot-folders like
 * any other, so their changes do too.
 */
export function isWatchNoise(path: string): boolean {
  const name = basename(path.replaceAll("\\", "/"));
  const lower = name.toLowerCase();
  return (
    name.startsWith("~$") ||
    (name.startsWith(".~lock.") && name.endsWith("#")) ||
    name.endsWith("~") ||
    name === "4913" ||
    NOISE_ENDINGS.some((ending) => lower.endsWith(ending)) ||
    name === ".DS_Store" ||
    lower === "thumbs.db" ||
    lower === "desktop.ini"
  );
}

/**
 * Calls `fire` after `debounceMs` without a poke(), or `maxWaitMs` after the first poke of a
 * burst, whichever comes first; never twice at once (a burst due while `fire` runs fires once it
 * settles). `fire` should not reject; a rejection is ignored. idle() settles when no `fire` runs.
 * Its timers don't keep the process alive.
 */
export function createDebouncer(options: {
  fire: () => Promise<void>;
  debounceMs: number;
  maxWaitMs: number;
}): { poke(): void; close(): void; idle(): Promise<void> } {
  const { fire, debounceMs, maxWaitMs } = options;
  let quiet: NodeJS.Timeout | undefined;
  let max: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let again = false;
  let closed = false;
  const clear = () => {
    clearTimeout(quiet);
    clearTimeout(max);
    quiet = max = undefined;
  };
  const due = () => {
    clear();
    if (closed) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = fire()
      .catch(() => {})
      .finally(() => {
        inFlight = undefined;
        if (again) {
          again = false;
          due();
        }
      });
  };
  return {
    poke() {
      if (closed) return;
      clearTimeout(quiet);
      quiet = setTimeout(due, debounceMs);
      quiet.unref();
      if (max === undefined) {
        max = setTimeout(due, maxWaitMs);
        max.unref();
      }
    },
    close() {
      closed = true;
      again = false;
      clear();
    },
    idle: () => inFlight ?? Promise.resolve(),
  };
}

const codeOf = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "unknown";
};

const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

/**
 * A folder's identity: device, inode and birth time. The inode alone isn't enough: a folder
 * removed and made again often gets the same one back (ext4 does).
 */
export function folderIdentity(st: BigIntStats): string {
  return `${st.dev}:${st.ino}:${st.birthtimeNs}`;
}

/**
 * Watches the fs sources with `watch` on, requesting a sync of each soon after its folder
 * changes. close() stops every watcher and timer, and waits (up to `closeWaitMs`) for requests
 * in flight.
 */
export function watchSources(
  sources: readonly WatchedSource[],
  options: WatchOptions,
): { close(): Promise<void> } {
  const {
    request,
    log,
    debounceMs = WATCH_DEBOUNCE_MS,
    maxWaitMs = WATCH_MAX_WAIT_MS,
    retryMs = WATCH_RETRY_MS,
    closeWaitMs = CLOSE_WAIT_MS,
    watcher: factory = defaultWatchFactory,
  } = options;
  const closers = sources.filter((s) => s.connector === "fs" && s.watch).map(watchOne);
  return {
    async close() {
      const idle = Promise.all(closers.splice(0).map((close) => close()));
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, closeWaitMs);
        timer.unref();
      });
      await Promise.race([idle, late]);
      clearTimeout(timer);
    },
  };

  function watchOne(s: WatchedSource): () => Promise<void> {
    const fields = { source: s.id, tenantId: s.tenantId };
    let closed = false;
    let watcher: WatchHandle | undefined;
    let retry: NodeJS.Timeout | undefined;
    let warned = false;
    const debouncer = createDebouncer({
      debounceMs,
      maxWaitMs,
      fire: async () => {
        const w = watcher;
        if (closed || w === undefined) return;
        // Some platforms say no more than an event when the folder itself goes or is replaced.
        // One that is gone isn't watched any more (a sync of it is the schedule's to fail,
        // audited); one replaced is watched afresh, and synced once that watcher is ready.
        const found = await stat(s.root, { bigint: true }).then(
          (st) => ({ st }),
          (err: unknown) => ({ err }),
        );
        if (closed || watcher !== w) return;
        if ("err" in found) return failed(found.err);
        if (!found.st.isDirectory()) return failed(coded("not a folder", "ENOTDIR"));
        if (w.rootId !== undefined && w.rootId !== folderIdentity(found.st)) {
          log.info(fields, "the folder was replaced: watching the new one");
          w.close();
          watcher = undefined;
          arm(true);
          return;
        }
        log.debug(fields, "folder changed: sync requested");
        await request(s.tenantId, s.id).catch((err: unknown) =>
          log.warn({ ...fields, err }, "could not request a sync after a change"),
        );
      },
    });
    const onEvent = (path: string | null) => {
      if (closed || watcher === undefined) return;
      if (path !== null && isWatchNoise(path)) return;
      log.debug({ ...fields, path }, "folder change");
      debouncer.poke();
    };
    function failed(err: unknown) {
      if (closed) return;
      watcher?.close();
      watcher = undefined;
      if (warned) {
        log.debug({ ...fields, code: codeOf(err) }, "still cannot watch the folder");
      } else {
        warned = true;
        log.warn(
          { ...fields, code: codeOf(err), retryInMs: retryMs },
          "cannot watch the folder: it syncs on its schedule only, until watching works again",
        );
      }
      clearTimeout(retry);
      retry = setTimeout(() => arm(true), retryMs);
      retry.unref();
    }
    function arm(again: boolean) {
      if (closed) return;
      let w: WatchHandle | undefined;
      try {
        w = factory(
          s.root,
          onEvent,
          (err) => {
            if (w !== undefined && watcher === w) failed(err);
          },
          (more, message) => log.debug({ ...fields, ...more }, message),
        );
      } catch (err) {
        failed(err);
        return;
      }
      const armed = w;
      watcher = armed;
      // Only a watcher that covers the whole folder counts: one that fails during its first
      // walk neither says it works again nor asks for a sync.
      void (armed.ready ?? Promise.resolve()).then(() => {
        if (closed || watcher !== armed) return;
        if (!again) {
          log.info(fields, "watching the folder");
          return;
        }
        if (warned) log.info(fields, "watching the folder again");
        warned = false;
        // What changed while it wasn't watched.
        debouncer.poke();
      });
    }
    arm(false);
    return () => {
      closed = true;
      clearTimeout(retry);
      debouncer.close();
      watcher?.close();
      watcher = undefined;
      return debouncer.idle();
    };
  }
}

/** fs.watch(root, { recursive }): one native watcher for the whole tree (macOS, Windows). */
export const recursiveWatch: WatchFactory = (root, onEvent, onError) => {
  const st = statSync(root, { bigint: true });
  if (!st.isDirectory()) throw coded("not a folder", "ENOTDIR");
  const w = fsWatch(root, { recursive: true, persistent: false }, (_type, name) =>
    onEvent(typeof name === "string" ? name : null),
  );
  w.on("error", onError);
  return { close: () => w.close(), ready: Promise.resolve(), rootId: folderIdentity(st) };
};

/** Deepest folder level watched: as deep as the fs connector walks. */
const MAX_DEPTH = 256;
/** A folder that went, or that may not be read: left out, the rest still watched. */
const SKIPPED = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM"]);
/** Watches this process's folder-tree watchers hold together, at most. */
const WATCH_BUDGET_CAP = 100_000;

/**
 * The watches this process's folder-tree watchers may hold together: a quarter of the user's
 * inotify limit (shared with every other program of theirs) when it can be read, at most
 * WATCH_BUDGET_CAP.
 */
export function defaultWatchBudget(): number {
  try {
    const max = Number(readFileSync("/proc/sys/fs/inotify/max_user_watches", "utf8").trim());
    if (Number.isInteger(max) && max > 0) return Math.min(WATCH_BUDGET_CAP, Math.floor(max / 4));
  } catch {
    // Not Linux, or not readable: the cap alone.
  }
  return WATCH_BUDGET_CAP;
}

/**
 * A folder-tree watcher factory whose watchers together hold at most `budget` watches (default
 * defaultWatchBudget(), read on first use). One plain fs.watch per folder (on Linux, one
 * inotify watch per folder, not per file), found by an asynchronous walk; folders made, moved in
 * or replaced later are (re)watched as their events arrive, removed ones dropped. The root may be
 * a link (the connector follows it too); below it links are never followed, and other file
 * systems mounted inside are left out. A folder that went or may not be read (ENOENT, ENOTDIR,
 * EACCES, EPERM) is left out (debug). Running out (the budget, ENOSPC, EMFILE, ENFILE, ENOMEM)
 * or any other failure fails the whole watcher, so the source falls back to its schedule rather
 * than being watched in part.
 */
export function createFolderTreeWatch(options: { budget?: number } = {}): WatchFactory {
  let budget = options.budget;
  let used = 0;
  return (root, onEvent, onError, onDebug) => {
    budget ??= defaultWatchBudget();
    const limit = budget;
    const rootStat = statSync(root, { bigint: true });
    if (!rootStat.isDirectory()) throw coded("not a folder", "ENOTDIR");
    const dev = rootStat.dev;
    const rootId = folderIdentity(rootStat);
    const watchers = new Map<string, { w: FSWatcher; id: string }>();
    let closed = false;
    const unwatch = (dir: string) => {
      const found = watchers.get(dir);
      if (found === undefined) return;
      found.w.close();
      watchers.delete(dir);
      used--;
    };
    const close = () => {
      closed = true;
      for (const dir of [...watchers.keys()]) unwatch(dir);
    };
    const fail = (err: unknown) => {
      if (closed) return;
      close();
      onError(err);
    };
    const leftOut = (err: unknown) =>
      onDebug?.({ code: codeOf(err) }, "a folder is left out of watching");
    /** Stops watching `dir` and everything under it (never the root). */
    const dropTree = (dir: string) => {
      for (const d of [...watchers.keys()]) {
        if (d !== root && (d === dir || d.startsWith(dir + sep))) unwatch(d);
      }
    };
    /** Watches `dir`; false when it isn't (closed, gone, unreadable, out of watches). */
    const add = (dir: string, depth: number, id: string): boolean => {
      if (closed) return false;
      if (used >= limit) {
        fail(coded(`more than ${limit} folders to watch`, "EWATCHLIMIT"));
        return false;
      }
      let w: FSWatcher;
      try {
        w = fsWatch(dir, { persistent: false }, (_type, name) => {
          if (closed) return;
          if (typeof name !== "string") return onEvent(null);
          const path = join(dir, name);
          onEvent(relative(root, path));
          consider(path, depth + 1).catch(fail);
        });
      } catch (err) {
        if (dir === root) throw err;
        if (SKIPPED.has(codeOf(err))) leftOut(err);
        else fail(err);
        return false;
      }
      w.on("error", (err) => (dir === root ? fail(err) : dropTree(dir)));
      watchers.set(dir, { w, id });
      used++;
      return true;
    };
    /**
     * A path that changed, or that a walk found. A folder to watch (not a link, on the root's
     * file system, not too deep) is watched and walked when it isn't yet, or was replaced since
     * (`rm -rf a && mkdir a`, `mv b a`: the old watch sees nothing more); a watched one that is
     * gone or no longer a folder is dropped.
     */
    const consider = async (path: string, depth: number): Promise<void> => {
      if (closed || depth >= MAX_DEPTH) return;
      let st: BigIntStats | null;
      try {
        st = await lstat(path, { bigint: true });
      } catch (err) {
        if (!SKIPPED.has(codeOf(err))) throw err;
        st = null;
      }
      if (closed) return;
      const known = watchers.get(path);
      if (st === null || !st.isDirectory() || st.dev !== dev) {
        if (known !== undefined) dropTree(path);
        return;
      }
      const id = folderIdentity(st);
      if (known !== undefined) {
        if (known.id === id) return;
        dropTree(path);
      }
      if (add(path, depth, id)) await scan(path, depth);
    };
    const scan = async (dir: string, depth: number): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (!SKIPPED.has(codeOf(err))) throw err;
        leftOut(err);
        return;
      }
      for (const e of entries) {
        if (closed) return;
        // Dirent.isDirectory() is false for a link to a folder: links aren't followed.
        if (e.isDirectory()) await consider(join(dir, e.name), depth + 1);
      }
    };
    add(root, 0, rootId);
    const ready = scan(root, 0).catch(fail);
    return { close, ready, rootId };
  };
}

/** The folder-tree watcher, with this process's budget. */
export const folderTreeWatch: WatchFactory = createFolderTreeWatch();

/** This platform's watcher: native recursive on macOS and Windows, a folder tree elsewhere. */
export const defaultWatchFactory: WatchFactory = (root, onEvent, onError, onDebug) =>
  process.platform === "darwin" || process.platform === "win32"
    ? recursiveWatch(root, onEvent, onError, onDebug)
    : folderTreeWatch(root, onEvent, onError, onDebug);
