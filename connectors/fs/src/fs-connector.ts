import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { constants } from "node:fs";
import { lstat, open, realpath, rm, stat, truncate, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CONNECTOR_API_VERSION,
  changedError,
  LIMITS,
  normalizeAcl,
  notFoundError,
  permanentError,
  resyncError,
  retryableError,
  type AclEntry,
  type Connector,
  type ConnectorDescription,
  type ItemAcl,
  type ItemRef,
  type ReadResult,
  type SourceItem,
  type SyncEvent,
} from "@openhoard/sdk";
import { fsError } from "./errors.js";
import { mediaTypeOf } from "./media.js";
import { assignIds, entryOf, firstSightId, pathKey, recOf, StateDir, type Rec } from "./state.js";
import { entry, walk, type Entry } from "./walk.js";

/*
 * The local folder connector (T-301): a folder indexed in place, on Windows, macOS and Linux.
 *
 * - crawl(): the folder's files and folders, parents first, names in code-unit order
 *   (walk.ts). Every item it yields goes to a journal in the state folder; a checkpoint names
 *   the journal's length, so a killed crawl resumes right after it, and its cursor still covers
 *   what was yielded before (state.ts).
 * - delta(): walks the folder again and compares it with the snapshot the cursor names: new,
 *   changed, renamed or moved (same id, see state.ts assignIds()) and deleted items, deletes
 *   first, deepest first. No file system watcher: comparing is simple, the same everywhere, and
 *   can't miss what happened while nothing was watching.
 * - read(): the bytes, only while the file is the version crawled. A file's contentVersion is
 *   its size, modification time, change time and inode number: the change time catches a
 *   rewrite that put the old modification time back (tools that preserve times do), and the
 *   inode an editor's save-by-rename. The file is checked again when it is opened and after the
 *   last byte, and a file that changed meanwhile fails with `changed`.
 * - aclImport(): a file system has no permissions a connector can read the same way on every OS
 *   (POSIX modes, ACLs and Windows DACLs name local accounts, not the organization's people).
 *   So every item gets the connection's configured default (`defaultAcl`, basis `configured`),
 *   or, without one, nothing (`owner-only`): only its owner in OpenHoard sees it.
 * - redirect(): the item's `file:` URL, for the local agent to open natively (FR-20).
 *
 * Safety: nothing outside the folder is ever read. Symbolic links and junctions are never
 * followed, other file systems mounted inside are left out (walk.ts), read() and the others
 * accept only a location inside the folder with no link on the way, and open the file without
 * following a link (O_NOFOLLOW where the OS has it; then the opened file's inode must be the
 * crawled one). A delta refuses to run when another folder has taken the root's path (a drive
 * not mounted): it would report every file deleted.
 */

export const FS_CONNECTOR_VERSION = "0.1.0";

export interface FsConnectorOptions {
  /** The folder to serve: an absolute path. */
  root: string;
  /**
   * An absolute path for the connector's own state (crawl journals, snapshots), outside `root`.
   * Keep it with the connection: without it, the next sync crawls everything again.
   */
  stateDir: string;
  /** Permissions to report for every item (see above). Default: none, owner-only. */
  defaultAcl?: readonly AclEntry[];
  /** A checkpoint after every this many items. Default 500. */
  checkpointEvery?: number;
  /** Bytes per chunk read() returns. Default 64 KiB. */
  chunkSize?: number;
}

interface Context {
  root: string;
  dev: bigint;
  /** The root folder's device and inode. */
  identity: string;
}

/** The local folder connector over `options.root`. */
export function fsConnector(options: FsConnectorOptions): Connector {
  if (!isAbsolute(options.root)) throw new TypeError("root must be an absolute path");
  if (!isAbsolute(options.stateDir)) throw new TypeError("stateDir must be an absolute path");
  const every = options.checkpointEvery ?? 500;
  const chunkSize = options.chunkSize ?? 64 * 1024;
  if (!Number.isSafeInteger(every) || every < 1) throw new RangeError("checkpointEvery");
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new RangeError("chunkSize");
  const acl: ItemAcl =
    options.defaultAcl && options.defaultAcl.length > 0
      ? { basis: "configured", entries: normalizeAcl(options.defaultAcl) }
      : { basis: "owner-only", entries: [] };
  const state = new StateDir(options.stateDir);
  const description: ConnectorDescription = {
    apiVersion: CONNECTOR_API_VERSION,
    id: "connector-fs",
    version: FS_CONNECTOR_VERSION,
    zoneKinds: ["indexed"],
    capabilities: { delta: true, aclImport: true, redirect: true },
    stableIds: true,
    redirectSchemes: ["file:"],
  };

  let prepared: Promise<void> | undefined;
  /** The root as it is now; the state folder checked once. */
  async function context(): Promise<Context> {
    let root: string;
    let st: BigIntStats;
    try {
      root = await realpath(options.root);
      st = await stat(root, { bigint: true });
    } catch (e) {
      // A root that isn't there may be a drive not mounted yet: never "empty", try later.
      const err = fsError(e) as { code?: string };
      throw err.code === "not-found" ? retryableError("the folder can't be reached") : err;
    }
    if (!st.isDirectory()) throw permanentError("the root is not a folder");
    // Made again if someone removed it: the tokens it held are then refused (`resync`).
    await state.ensure().catch((e: unknown) => {
      throw fsError(e);
    });
    prepared ??= (async () => {
      const dir = await realpath(options.stateDir);
      if (within(root, dir)) throw permanentError("the state folder must be outside the root");
    })().catch((e: unknown) => {
      prepared = undefined;
      throw fsError(e);
    });
    await prepared;
    return { root, dev: st.dev, identity: `${st.dev}:${st.ino}` };
  }

  function itemOf(ctx: Context, id: string, parentId: string | null, e: Entry): SourceItem {
    const name = e.path[e.path.length - 1] as string;
    const url = pathToFileURL(join(ctx.root, ...e.path)).href;
    const base = {
      externalId: id,
      kind: e.kind,
      parentId,
      path: e.path,
      etag: etagOf(id, e),
      // A URL too long to keep is left out: read() finds the item by its path then.
      ...([...url].length <= LIMITS.url ? { url } : {}),
    };
    if (e.kind === "folder") return base;
    const ms = Number(e.mtimeNs / 1_000_000n);
    return {
      ...base,
      mediaType: mediaTypeOf(name),
      size: Number(e.size),
      contentVersion: versionOf(e),
      // Only times the catalog can record.
      ...(ms >= 0 && ms < Date.UTC(10000, 0, 1) ? { modifiedAt: new Date(ms).toISOString() } : {}),
    };
  }

  async function* crawl(checkpoint: string | null, signal: AbortSignal): AsyncGenerator<SyncEvent> {
    signal.throwIfAborted();
    const ctx = await context();
    let run: string;
    let bytes: number;
    let recs: Rec[] = [];
    if (checkpoint === null) {
      run = state.newRun();
      await state.prune({ journals: { keep: run } });
      const header = state.header(run, ctx.identity);
      await writeNew(state.journal(run), header);
      bytes = Buffer.byteLength(header);
    } else {
      const m = /^fs1c\.([0-9a-f]{16})\.(\d{1,15})$/.exec(checkpoint);
      if (!m) throw resyncError();
      run = m[1] as string;
      bytes = Number(m[2]);
      recs = await state.readJournal(run, bytes, ctx.identity);
      await state.prune({ journals: { keep: run } });
      // What was written after the checkpoint is yielded again.
      await truncate(state.journal(run), bytes).catch((e: unknown) => {
        throw fsError(e);
      });
    }
    const used = new Set(recs.map((r) => r.id));
    const idAt = new Map(recs.map((r) => [pathKey(r.p), r.id]));
    const after = recs[recs.length - 1]?.p;
    let journal: FileHandle | undefined = await open(state.journal(run), "a").catch(
      (e: unknown) => {
        throw fsError(e);
      },
    );
    try {
      let since = 0;
      for await (const e of walk(ctx.root, ctx.dev, signal, after)) {
        const parentId = e.path.length === 1 ? null : idAt.get(pathKey(e.path.slice(0, -1)));
        // Its folder isn't in the journal (a damaged one): the next delta finds it.
        if (parentId === undefined) continue;
        const id = firstSightId(e, used);
        idAt.set(pathKey(e.path), id);
        const line = `${JSON.stringify(recOf(id, e))}\n`;
        await journal.write(line);
        bytes += Buffer.byteLength(line);
        yield { type: "item", item: itemOf(ctx, id, parentId, e) };
        if (++since >= every) {
          since = 0;
          yield { type: "checkpoint", token: `fs1c.${run}.${bytes}` };
        }
      }
      await journal.close();
      journal = undefined;
      const entries = await state.readJournal(run, bytes, ctx.identity);
      const digest = await state.writeSnapshot({ v: 1, root: ctx.identity, entries });
      await rm(state.journal(run), { force: true });
      yield { type: "done", cursor: `fs1.${digest}` };
    } catch (e) {
      throw fsError(e);
    } finally {
      await journal?.close();
    }
  }

  async function* delta(cursor: string, signal: AbortSignal): AsyncGenerator<SyncEvent> {
    signal.throwIfAborted();
    const ctx = await context();
    const m = /^fs1\.([0-9a-f]{64})$/.exec(cursor);
    if (!m) throw resyncError();
    const digest = m[1] as string;
    const before = await state.readSnapshot(digest);
    if (before.root !== ctx.identity) {
      throw permanentError("another folder is at the root's path (a drive not mounted?)");
    }
    // Only this cursor (and what this delta writes) can be asked for from now on.
    await state.prune({ snapshots: { keep: digest } });
    const entries: Entry[] = [];
    try {
      for await (const e of walk(ctx.root, ctx.dev, signal)) entries.push(e);
    } catch (e) {
      throw fsError(e);
    }
    const ids = assignIds(entries, before.entries);
    const recs = entries.map((e, n) => recOf(ids[n] as string, e));
    const idAt = new Map(recs.map((r) => [pathKey(r.p), r.id]));
    const was = new Map(before.entries.map((r) => [r.id, etagOf(r.id, entryOf(r))]));
    const alive = new Set(ids);
    const events: SyncEvent[] = [];
    for (const r of [...before.entries].reverse()) {
      if (!alive.has(r.id)) events.push({ type: "deleted", externalId: r.id });
    }
    entries.forEach((e, n) => {
      const id = ids[n] as string;
      if (was.get(id) === etagOf(id, e)) return;
      const parentId =
        e.path.length === 1 ? null : (idAt.get(pathKey(e.path.slice(0, -1))) ?? null);
      events.push({ type: "item", item: itemOf(ctx, id, parentId, e) });
    });
    const next = await state.writeSnapshot({ v: 1, root: ctx.identity, entries: recs });
    for (const e of events) {
      signal.throwIfAborted();
      yield e;
    }
    yield { type: "done", cursor: `fs1.${next}` };
  }

  /**
   * Where an item is: its `url` (a file: URL inside the root), else its `path` under the root.
   * Nothing outside the root, and no link on the way (each folder above it is a real folder on
   * the root's device). Never trusted beyond that: the caller checks what it finds there.
   */
  async function locate(ctx: Context, ref: ItemRef): Promise<string> {
    let abs: string;
    if (ref.url !== undefined) {
      try {
        abs = fileURLToPath(ref.url);
      } catch {
        throw notFoundError();
      }
    } else if (ref.path !== undefined && ref.path.length > 0 && ref.path.every(isName)) {
      abs = join(ctx.root, ...ref.path);
    } else {
      throw notFoundError();
    }
    if (!within(ctx.root, abs) || abs === ctx.root) throw notFoundError();
    const names = relative(ctx.root, abs).split(sep);
    let dir = ctx.root;
    for (const name of names.slice(0, -1)) {
      dir = join(dir, name);
      const st = await lstat(dir, { bigint: true }).catch((e: unknown) => {
        throw fsError(e);
      });
      if (st.isSymbolicLink() || !st.isDirectory() || st.dev !== ctx.dev) throw notFoundError();
    }
    return abs;
  }

  /** The item's own entry, not following a link: `not-found` for a link or nothing. */
  async function lstatItem(ctx: Context, abs: string): Promise<BigIntStats> {
    const st = await lstat(abs, { bigint: true }).catch((e: unknown) => {
      throw fsError(e);
    });
    if (st.isSymbolicLink() || st.dev !== ctx.dev || !(st.isFile() || st.isDirectory())) {
      throw notFoundError();
    }
    return st;
  }

  async function read(ref: ItemRef, signal: AbortSignal): Promise<ReadResult> {
    signal.throwIfAborted();
    const ctx = await context();
    const version = ref.contentVersion;
    if (version === undefined) throw permanentError("read() needs the contentVersion to read");
    const abs = await locate(ctx, ref);
    const st = await lstatItem(ctx, abs);
    if (!st.isFile()) throw permanentError("not a file");
    if (versionOf(entry([], "file", st)) !== version) throw changedError();
    const size = Number(st.size);
    return { contentVersion: version, size, body: body(ctx, abs, version, size, signal) };
  }

  /**
   * The file's bytes. Opened on the first read, so a body nobody reads holds nothing open; the
   * opened file must still be the version asked for, and still be after the last byte.
   */
  async function* body(
    ctx: Context,
    abs: string,
    version: string,
    size: number,
    signal: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    signal.throwIfAborted();
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    const fh = await open(abs, flags).catch((e: unknown) => {
      throw fsError(e);
    });
    try {
      const check = async () => {
        const st = await fh.stat({ bigint: true });
        if (!st.isFile() || st.dev !== ctx.dev || versionOf(entry([], "file", st)) !== version) {
          throw changedError();
        }
      };
      await check();
      let total = 0;
      for (;;) {
        signal.throwIfAborted();
        // One byte more than is left, to notice a file that grew.
        const buf = Buffer.allocUnsafe(Math.min(chunkSize, size - total + 1));
        const { bytesRead } = await fh.read(buf, 0, buf.byteLength, total);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > size) throw changedError();
        yield buf.subarray(0, bytesRead);
      }
      if (total !== size) throw changedError();
      await check();
    } catch (e) {
      throw fsError(e);
    } finally {
      await fh.close();
    }
  }

  return {
    describe: () => ({
      ...description,
      capabilities: { ...description.capabilities },
      zoneKinds: [...description.zoneKinds],
      redirectSchemes: ["file:"],
    }),
    crawl,
    delta,
    read,
    async aclImport(ref, signal) {
      signal.throwIfAborted();
      const ctx = await context();
      await lstatItem(ctx, await locate(ctx, ref));
      return structuredClone(acl);
    },
    async redirect(ref, signal) {
      signal.throwIfAborted();
      const ctx = await context();
      const abs = await locate(ctx, ref);
      await lstatItem(ctx, abs);
      return pathToFileURL(abs).href;
    },
  };
}

/** An item's eTag: everything the connector reports about it, its path included. */
function etagOf(id: string, e: Entry): string {
  const facts =
    e.kind === "file"
      ? [id, "f", e.path, `${e.size}`, `${e.mtimeNs}`, `${e.ctimeNs}`, `${e.ino}`]
      : [id, "d", e.path, `${e.ino}`];
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 32);
}

/** A file's content version: size, modification and change times (ns), inode. */
function versionOf(e: Entry): string {
  return `v1.${e.size}.${e.mtimeNs}.${e.ctimeNs}.${e.ino}`;
}

/** Whether `child` is `parent` or inside it. */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** A name that is one step down: not empty, `.`, `..`, and no separator of any OS. */
function isName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\0") &&
    !(sep === "\\" && (name.includes("\\") || name.includes(":")))
  );
}

/** Creates a file with `text`, failing if it exists. */
async function writeNew(file: string, text: string): Promise<void> {
  const fh = await open(file, "wx").catch((e: unknown) => {
    throw fsError(e);
  });
  try {
    await fh.write(text);
  } finally {
    await fh.close();
  }
}
