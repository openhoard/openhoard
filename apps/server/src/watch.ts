import { watch as fsWatch, lstatSync, type FSWatcher } from "node:fs";
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
 *   (connectors/fs walk.ts), never follows links and leaves out other file systems mounted
 *   inside.
 * - Events are debounced per source: a sync is requested after `debounceMs` of quiet, but no
 *   later than `maxWaitMs` after the first event of a burst, so a folder written to all the time
 *   still syncs. At most one request per source is in flight; one wanted meanwhile follows it.
 *   requestSync() coalesces (a waiting job is brought forward, never doubled), so this only
 *   needs to keep the calls few.
 * - Noise never worth a sync (isWatchNoise()) is ignored.
 * - A watcher that fails (the folder removed, EPERM, ENOSPC at Linux's inotify limit, EMFILE)
 *   never takes the server down: it is logged once (warn), closed, and the source falls back to
 *   its schedule. Watching is tried again every `retryMs` (5 min); once it works, a sync is
 *   requested for what happened meanwhile.
 * - File names are logged at debug only: they can be sensitive.
 */

/** What a source's watcher needs from its configuration. */
export type WatchedSource = Pick<SourceConfig, "id" | "tenantId" | "root" | "connector" | "watch">;

export interface WatchLogger {
  debug(fields: object, message: string): void;
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

/**
 * Starts watching `root`: `onEvent` gets each change's path relative to root (null when the
 * platform didn't say), `onError` a failure, after which nothing more is reported. Throws when
 * it can't start.
 */
export type WatchFactory = (
  root: string,
  onEvent: (path: string | null) => void,
  onError: (err: unknown) => void,
) => { close(): void };

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
  /** How folders are watched (tests pass their own). Default: this platform's (see above). */
  watcher?: WatchFactory;
}

export const WATCH_DEBOUNCE_MS = 2_000;
export const WATCH_MAX_WAIT_MS = 10_000;
export const WATCH_RETRY_MS = 5 * 60_000;

/**
 * Whether a change to this path (relative to the folder) is noise that shouldn't trigger a
 * sync: Office lock and temporary files (`~$…`, `*.tmp`, LibreOffice's `.~lock.…#`) and the
 * folder metadata macOS and Windows write (`.DS_Store`, `Thumbs.db`, `desktop.ini`). Only the
 * name counts: the fs connector indexes dot-folders like any other, so their changes do too.
 */
export function isWatchNoise(path: string): boolean {
  const name = basename(path.replaceAll("\\", "/"));
  const lower = name.toLowerCase();
  return (
    name.startsWith("~$") ||
    lower.endsWith(".tmp") ||
    (name.startsWith(".~lock.") && name.endsWith("#")) ||
    name === ".DS_Store" ||
    lower === "thumbs.db" ||
    lower === "desktop.ini"
  );
}

/**
 * Calls `fire` after `debounceMs` without a poke(), or `maxWaitMs` after the first poke of a
 * burst, whichever comes first; never twice at once (a burst due while `fire` runs fires once it
 * settles). `fire` should not reject; a rejection is ignored.
 */
export function createDebouncer(options: {
  fire: () => Promise<void>;
  debounceMs: number;
  maxWaitMs: number;
}): { poke(): void; close(): void } {
  const { fire, debounceMs, maxWaitMs } = options;
  let quiet: NodeJS.Timeout | undefined;
  let max: NodeJS.Timeout | undefined;
  let inFlight = false;
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
    inFlight = true;
    void fire()
      .catch(() => {})
      .finally(() => {
        inFlight = false;
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
      max ??= setTimeout(due, maxWaitMs);
    },
    close() {
      closed = true;
      again = false;
      clear();
    },
  };
}

const codeOf = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "unknown";
};

/**
 * Watches the fs sources with `watch` on, requesting a sync of each soon after its folder
 * changes. close() stops every watcher and timer; a request in flight isn't waited for.
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
    watcher: factory = defaultWatchFactory,
  } = options;
  const closers = sources.filter((s) => s.connector === "fs" && s.watch).map(watchOne);
  return {
    close() {
      for (const close of closers.splice(0)) close();
      return Promise.resolve();
    },
  };

  function watchOne(s: WatchedSource): () => void {
    const fields = { source: s.id, tenantId: s.tenantId };
    let closed = false;
    let watcher: { close(): void } | undefined;
    let retry: NodeJS.Timeout | undefined;
    let warned = false;
    const debouncer = createDebouncer({
      debounceMs,
      maxWaitMs,
      fire: async () => {
        if (closed || watcher === undefined) return;
        // Some platforms say nothing but an event when the folder itself goes: a folder that
        // is gone isn't watched any more (a sync of it is the schedule's to fail, audited).
        const there = await stat(s.root).then(
          (st) => st.isDirectory(),
          (err: unknown) => err,
        );
        if (closed || watcher === undefined) return;
        if (there !== true) {
          failed(
            there === false ? Object.assign(new Error("not a folder"), { code: "ENOTDIR" }) : there,
          );
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
      let w: { close(): void } | undefined;
      try {
        w = factory(s.root, onEvent, (err) => {
          if (w !== undefined && watcher === w) failed(err);
        });
      } catch (err) {
        failed(err);
        return;
      }
      watcher = w;
      if (!again) {
        log.info(fields, "watching the folder");
        return;
      }
      warned = false;
      log.info(fields, "watching the folder again");
      // What changed while it wasn't watched.
      debouncer.poke();
    }
    arm(false);
    return () => {
      closed = true;
      clearTimeout(retry);
      debouncer.close();
      watcher?.close();
      watcher = undefined;
    };
  }
}

/** This platform's watcher: native recursive on macOS and Windows, a folder tree elsewhere. */
export const defaultWatchFactory: WatchFactory = (root, onEvent, onError) =>
  process.platform === "darwin" || process.platform === "win32"
    ? recursiveWatch(root, onEvent, onError)
    : folderTreeWatch(root, onEvent, onError);

/** fs.watch(root, { recursive }): one native watcher for the whole tree. */
export const recursiveWatch: WatchFactory = (root, onEvent, onError) => {
  const w = fsWatch(root, { recursive: true, persistent: false }, (_type, name) =>
    onEvent(typeof name === "string" ? name : null),
  );
  w.on("error", onError);
  return { close: () => w.close() };
};

/** Deepest folder level watched: as deep as the fs connector walks. */
const MAX_DEPTH = 256;

/**
 * One plain fs.watch per folder (on Linux, one inotify watch per folder, not per file), found
 * by an asynchronous walk; folders made or moved in later are added as their events arrive,
 * removed ones dropped. Links are never followed; other file systems mounted inside are left
 * out. Throws when the root can't be watched; a subfolder that can't be (ENOSPC at the inotify
 * limit, EMFILE) fails the whole watcher, so the source falls back to its schedule rather than
 * being watched in part.
 */
export const folderTreeWatch: WatchFactory = (root, onEvent, onError) => {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory()) {
    throw Object.assign(new Error("not a folder"), { code: "ENOTDIR" });
  }
  const dev = rootStat.dev;
  const watchers = new Map<string, FSWatcher>();
  let closed = false;
  const close = () => {
    closed = true;
    for (const w of watchers.values()) w.close();
    watchers.clear();
  };
  const fail = (err: unknown) => {
    if (closed) return;
    close();
    onError(err);
  };
  /** Watches `dir`; false when it was already watched or is gone. */
  const add = (dir: string, depth: number): boolean => {
    if (closed || watchers.has(dir)) return false;
    let w: FSWatcher;
    try {
      w = fsWatch(dir, { persistent: false }, (_type, name) => {
        if (closed) return;
        if (typeof name !== "string") return onEvent(null);
        const path = join(dir, name);
        onEvent(relative(root, path));
        void changed(path, depth + 1);
      });
    } catch (err) {
      if (dir === root) throw err;
      // A subfolder that went before it was watched is simply gone.
      if (codeOf(err) !== "ENOENT" && codeOf(err) !== "ENOTDIR") fail(err);
      return false;
    }
    w.on("error", (err) => (dir === root ? fail(err) : drop(dir)));
    watchers.set(dir, w);
    return true;
  };
  /** Stops watching `dir` and everything under it. */
  const drop = (dir: string) => {
    for (const [d, w] of watchers) {
      if (d !== root && (d === dir || d.startsWith(dir + sep))) {
        w.close();
        watchers.delete(d);
      }
    }
  };
  /** A folder to watch: not a link, on the root's file system, not too deep. */
  const watchable = async (path: string, depth: number) => {
    if (depth >= MAX_DEPTH) return false;
    const st = await lstat(path).catch(() => null);
    return st !== null && st.isDirectory() && st.dev === dev;
  };
  const changed = async (path: string, depth: number) => {
    if (await watchable(path, depth)) {
      if (add(path, depth)) await scan(path, depth);
    } else if (watchers.has(path)) {
      drop(path);
    }
  };
  const scan = async (dir: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (closed) return;
      // Dirent.isDirectory() is false for a link to a folder: links aren't followed.
      if (!e.isDirectory()) continue;
      const path = join(dir, e.name);
      if ((await watchable(path, depth + 1)) && add(path, depth + 1)) await scan(path, depth + 1);
    }
  };
  add(root, 0);
  void scan(root, 0);
  return { close };
};
