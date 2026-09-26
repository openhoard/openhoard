import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { constants } from "node:fs";
import {
  lstat,
  open,
  realpath,
  rm,
  stat,
  statfs,
  truncate,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CONNECTOR_API_VERSION,
  changedError,
  checkUrl,
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
import { compareWalk, entry, isPrefix, walk, type Entry, type Unreadable } from "./walk.js";

/*
 * The local folder connector (T-301): a folder indexed in place, on Windows, macOS and Linux.
 *
 * - crawl(): the folder's files and folders, parents first, names in code-unit order
 *   (walk.ts). Every item it yields goes to a journal in the state folder; a checkpoint names
 *   the journal's length, so a killed crawl resumes right after it, and its cursor still covers
 *   what was yielded before (state.ts).
 * - delta(): walks the folder again, compares it with the snapshot the cursor names (new,
 *   changed, renamed or moved: same id, see state.ts assignIds(); deleted; deletes first,
 *   deepest first), writes the new snapshot, and yields the difference with checkpoints: a
 *   checkpoint names both snapshots and how far it got, so a stopped delta resumes from the
 *   two snapshots without walking again. No file system watcher: comparing is simple, the same
 *   everywhere, and can't miss what happened while nothing was watching.
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
 * - identity(): the root folder's inode, birth time and file system type. Not its device
 *   number: Linux and macOS number devices anew on a remount or a reboot (network and FUSE file
 *   systems, tmpfs, btrfs, overlays, external disks). Where the file system keeps no birth time,
 *   a changed answer is checked against the folder itself: when the files the last snapshot
 *   recorded are still there (same inode, and same birth time or size), it is the same folder.
 *
 * Safety: nothing outside the folder is ever read. Symbolic links and junctions are never
 * followed, other file systems mounted inside are reported unreadable (walk.ts), read() and the
 * others accept only a location inside the folder with no link on the way, and open the file
 * without following a link (O_NOFOLLOW where the OS has it; then the opened file's inode must be
 * the crawled one). A delta refuses to run when another folder has taken the root's path (a drive
 * not mounted): it would report every file deleted.
 *
 * The root is used as configured (made absolute), never as realpath() writes it: on Windows that
 * turns a mapped network drive (`Z:\`) into its share (`\\server\share`) and a mounted volume
 * into `\\?\Volume{…}\`, whose file: URLs would name a host. A configured root that is itself
 * such a path is refused.
 */

export const FS_CONNECTOR_VERSION = "0.1.0";

export interface FsConnectorOptions {
  /** The folder to serve: an absolute path (a local disk, or a mapped drive on Windows). */
  root: string;
  /**
   * An absolute path for the connector's own state (crawl journals, snapshots), outside `root`.
   * Keep it with the connection: without it, the next sync crawls everything again.
   */
  stateDir: string;
  /** Permissions to report for every item (see above). Default: none, owner-only. */
  defaultAcl?: readonly AclEntry[];
  /** A checkpoint after every this many items (crawl) or changes (delta). Default 500. */
  checkpointEvery?: number;
  /** Bytes per chunk read() returns. Default 64 KiB. */
  chunkSize?: number;
  /**
   * Files with more than one name (hard links). `index` (default): indexed, each name its own
   * item, with a `hard-link` warning: the same bytes can change through another name, perhaps
   * one outside the root. `skip`: left out (reported deleted if they were indexed before).
   */
  hardLinks?: "index" | "skip";
  /**
   * What another file system mounted inside the root is. `keep` (default): unreadable (what was
   * there stays, a warning says so, and a crawl doesn't reconcile). `skip`: not there at all, so
   * what was indexed there is reported deleted.
   */
  otherDevices?: "keep" | "skip";
}

/** Where the root is: what read(), aclImport() and redirect() need. */
interface Place {
  root: string;
  dev: bigint;
}

/** What a crawl, a delta and identity() need besides. */
interface Context extends Place {
  /** What the root folder is: see identityOf(). */
  identity: string;
}

/** How many files identity() looks at when the root's own numbers changed. */
const SAMPLE = 16;

/** The local folder connector over `options.root`. */
export function fsConnector(options: FsConnectorOptions): Connector {
  if (!isAbsolute(options.root)) throw new TypeError("root must be an absolute path");
  if (!isAbsolute(options.stateDir)) throw new TypeError("stateDir must be an absolute path");
  const every = options.checkpointEvery ?? 500;
  const chunkSize = options.chunkSize ?? 64 * 1024;
  if (!Number.isSafeInteger(every) || every < 1) throw new RangeError("checkpointEvery");
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new RangeError("chunkSize");
  const hardLinks = options.hardLinks ?? "index";
  if (hardLinks !== "index" && hardLinks !== "skip") throw new RangeError("hardLinks");
  const otherDevices = options.otherDevices ?? "keep";
  if (otherDevices !== "keep" && otherDevices !== "skip") throw new RangeError("otherDevices");
  const walkOptions = {
    skipHardLinks: hardLinks === "skip",
    skipOtherDevices: otherDevices === "skip",
  };
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
  const configuredRoot = resolve(options.root);

  let prepared: Promise<void> | undefined;
  /**
   * The root as it is now, checked: there, a folder, not a network share, the state folder
   * (checked once) outside it. All a single item's call needs: those run once per item, and on a
   * busy Windows machine every system call counts, so they don't make the state folder again or
   * ask the file system its type, as a crawl or a delta does (context()).
   */
  async function place(): Promise<Place & { st: BigIntStats }> {
    // A network share path (UNC), or a device path (\\?\, \\.\), gives file: URLs with a host,
    // which opening would make Windows authenticate to: refused, as the core refuses such URLs.
    if (pathToFileURL(configuredRoot).host !== "" || /^[\\/]{2}/.test(configuredRoot)) {
      throw permanentError("a root on a network share or device path isn't supported");
    }
    let st: BigIntStats;
    try {
      st = await stat(configuredRoot, { bigint: true });
    } catch (e) {
      // A root that isn't there may be a drive not mounted yet: never "empty", try later.
      const err = fsError(e) as { code?: string };
      throw err.code === "not-found" ? retryableError("the folder can't be reached") : err;
    }
    if (!st.isDirectory()) throw permanentError("the root is not a folder");
    prepared ??= (async () => {
      await state.ensure();
      // Both as realpath() writes them, so a link or a mapped drive can't hide the state folder
      // inside the root.
      const [real, dir] = await Promise.all([realpath(configuredRoot), realpath(options.stateDir)]);
      if (within(real, dir)) throw permanentError("the state folder must be outside the root");
    })().catch((e: unknown) => {
      prepared = undefined;
      throw fsError(e);
    });
    await prepared;
    return { root: configuredRoot, dev: st.dev, st };
  }

  /**
   * The root, its state folder (made again if someone removed it: the tokens it held are then
   * refused, `resync`) and what the root is.
   */
  async function context(): Promise<Context> {
    const { root, dev, st } = await place();
    await state.ensure().catch((e: unknown) => {
      throw fsError(e);
    });
    return { root, dev, identity: await identityOf(root, st) };
  }

  /**
   * Whether the folder at the root is the one `recorded` names, as far as `entries` (what the
   * last snapshot or journal recorded) can tell:
   *
   * - both answers with a birth time: the same inode, birth time and file system type;
   * - either without one: the numbers say nothing (every ext4 root is inode 2, every FAT or FUSE
   *   root inode 1, every XFS root 128), so always the files: at least three in four of a sample
   *   still at their path with the same inode (and birth time, where kept). A folder whose
   *   snapshot has no files passes: there is nothing a mistake could delete.
   *
   * It guards against accidents (a disk not mounted, another one mounted at the path), not an
   * attacker who controls the folder, who could put back files with the same numbers.
   */
  async function sameRoot(ctx: Context, recorded: string, entries: readonly Rec[]) {
    const [a, b] = [parseIdentity(recorded), parseIdentity(ctx.identity)];
    if (!a || !b) return false;
    // A file system type of 0 means statfs() couldn't say: not a difference.
    const sameType = a.type === b.type || a.type === "0" || b.type === "0";
    if (a.birth !== "0" && b.birth !== "0") {
      return a.ino === b.ino && a.birth === b.birth && sameType;
    }
    const files = entries.filter((r) => r.k === "f");
    if (files.length === 0) return true;
    const step = Math.max(1, Math.floor(files.length / SAMPLE));
    const sample = files.filter((_, n) => n % step === 0).slice(0, SAMPLE);
    let same = 0;
    for (const r of sample) {
      const st = await lstat(join(ctx.root, ...r.p), { bigint: true }).catch(() => null);
      if (!st || `${st.ino}` !== r.i) continue;
      const birth = st.birthtimeNs > 0n ? `${st.birthtimeNs}` : "0";
      if (r.b === "0" || birth === "0" || birth === r.b) same++;
    }
    return same * 4 >= sample.length * 3;
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
      // A URL the core would refuse (too long; a name with a backslash, which is allowed on
      // Linux, encodes as %5C) is left out: read() finds the item by its path during a sync.
      ...(checkUrl(url, description) === null ? { url } : {}),
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
      // A crawl from the beginning: no earlier snapshot will be asked for again, and none may
      // stand for the folder in identity() while this one isn't done.
      await state.prune({ journals: { keep: run }, snapshots: { keep: [] } });
      const header = state.header(run, ctx.identity);
      await writeNew(state.journal(run), header);
      bytes = Buffer.byteLength(header);
    } else {
      const m = /^fs1c\.([0-9a-f]{16})\.(\d{1,15})$/.exec(checkpoint);
      if (!m) throw resyncError();
      run = m[1] as string;
      bytes = Number(m[2]);
      const journal = await state.readJournal(run, bytes);
      // Another folder at the root's path since: start again.
      if (!(await sameRoot(ctx, journal.root, journal.recs))) throw resyncError();
      recs = journal.recs;
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
      for await (const e of walk(ctx.root, ctx.dev, signal, {
        ...walkOptions,
        ...(after ? { after } : {}),
      })) {
        if (e.kind === "unreadable") {
          yield unreadableWarning(e.contents ? idAt.get(pathKey(e.path)) : undefined);
          continue;
        }
        const parentId = e.path.length === 1 ? null : idAt.get(pathKey(e.path.slice(0, -1)));
        // Its folder isn't in the journal (a damaged one): the next delta finds it.
        if (parentId === undefined) continue;
        const id = firstSightId(e, used);
        idAt.set(pathKey(e.path), id);
        const line = `${JSON.stringify(recOf(id, e))}\n`;
        await journal.write(line);
        bytes += Buffer.byteLength(line);
        yield { type: "item", item: itemOf(ctx, id, parentId, e) };
        if (e.links > 1n) yield { type: "warning", code: "hard-link", externalId: id };
        if (++since >= every) {
          since = 0;
          yield { type: "checkpoint", token: `fs1c.${run}.${bytes}` };
        }
      }
      await journal.close();
      journal = undefined;
      const { recs: entries } = await state.readJournal(run, bytes);
      const digest = await state.writeSnapshot({ v: 1, root: ctx.identity, entries });
      await rm(state.journal(run), { force: true });
      yield { type: "done", cursor: `fs1.${digest}` };
    } catch (e) {
      throw fsError(e);
    } finally {
      await journal?.close();
    }
  }

  /**
   * A delta: from a cursor (`fs1.<snapshot>`), walks the folder and writes the new snapshot; from
   * one of its own checkpoints (`fs1d.<old>.<new>.<n>`), takes both snapshots as they are. Either
   * way it yields the difference between the two, from the n-th change on.
   */
  async function* delta(cursor: string, signal: AbortSignal): AsyncGenerator<SyncEvent> {
    signal.throwIfAborted();
    const ctx = await context();
    const fresh = /^fs1\.([0-9a-f]{64})$/.exec(cursor);
    const resumed = /^fs1d\.([0-9a-f]{64})\.([0-9a-f]{64})\.(\d{1,12})$/.exec(cursor);
    if (!fresh && !resumed) throw resyncError();
    const oldDigest = ((fresh ?? resumed) as RegExpExecArray)[1] as string;
    const before = await state.readSnapshot(oldDigest);
    if (!(await sameRoot(ctx, before.root, before.entries))) {
      throw permanentError("another folder is at the root's path (a drive not mounted?)");
    }
    let nextDigest: string;
    let next: Rec[];
    let from = 0;
    const warnings: SyncEvent[] = [];
    if (resumed) {
      nextDigest = resumed[2] as string;
      from = Number(resumed[3]);
      next = (await state.readSnapshot(nextDigest)).entries;
      await state.prune({ snapshots: { keep: [oldDigest, nextDigest] } });
      // What the first attempt warned of, given again: the report keeps them.
      for (const w of await state.readWarnings(nextDigest)) {
        warnings.push(
          w.externalId === undefined
            ? { type: "warning", code: w.code }
            : { type: "warning", code: w.code, externalId: w.externalId },
        );
      }
    } else {
      // Only this cursor (and what this delta writes) can be asked for from now on.
      await state.prune({ snapshots: { keep: [oldDigest] } });
      const walked = await walkAgainst(ctx, before.entries, signal);
      next = walked.next;
      warnings.push(...walked.warnings);
      nextDigest = await state.writeSnapshot({ v: 1, root: ctx.identity, entries: next });
      await state.writeWarnings(
        nextDigest,
        warnings.map((w) =>
          w.type === "warning" ? { code: w.code, externalId: w.externalId } : w,
        ),
      );
    }
    const changes = diff(ctx, before.entries, next);
    for (let n = from; n < changes.length; n++) {
      signal.throwIfAborted();
      yield changes[n] as SyncEvent;
      if ((n + 1) % every === 0 && n + 1 < changes.length) {
        yield { type: "checkpoint", token: `fs1d.${oldDigest}.${nextDigest}.${n + 1}` };
      }
    }
    for (const w of warnings) yield w;
    yield { type: "done", cursor: `fs1.${nextDigest}` };
  }

  /**
   * The folder now, as a snapshot's entries (ids carried over from `old`), and its warnings: what
   * the walk couldn't see keeps what `old` had there (unknown is not gone; a file moved out of
   * there is found elsewhere by its inode, and not kept), and hard links are flagged.
   */
  async function walkAgainst(ctx: Context, old: readonly Rec[], signal: AbortSignal) {
    const entries: Entry[] = [];
    const unreadable: Unreadable[] = [];
    try {
      for await (const e of walk(ctx.root, ctx.dev, signal, walkOptions)) {
        if (e.kind === "unreadable") unreadable.push(e);
        else entries.push(e);
      }
    } catch (e) {
      throw fsError(e);
    }
    const ids = assignIds(entries, old);
    const alive = new Set(ids);
    const hidden = (r: Rec) =>
      unreadable.some((u) =>
        u.contents ? r.p.length > u.path.length && isPrefix(u.path, r.p) : isPrefix(u.path, r.p),
      );
    const kept = old.filter((r) => !alive.has(r.id) && hidden(r));
    const recs = entries.map((e, n) => recOf(ids[n] as string, e));
    const idAt = new Map(recs.map((r) => [pathKey(r.p), r.id]));
    const was = new Map(old.map((r) => [r.id, etagOf(r.id, entryOf(r))]));
    const warnings: SyncEvent[] = [];
    entries.forEach((e, n) => {
      const id = ids[n] as string;
      // Flagged when it changed, as the crawl flags it when it yields it.
      if (e.links > 1n && was.get(id) !== etagOf(id, e)) {
        warnings.push({ type: "warning", code: "hard-link", externalId: id });
      }
    });
    for (const u of unreadable) {
      const at = pathKey(u.path);
      warnings.push(
        unreadableWarning(u.contents ? idAt.get(at) : old.find((r) => pathKey(r.p) === at)?.id),
      );
    }
    return { next: [...recs, ...kept].sort((a, b) => compareWalk(a.p, b.p)), warnings };
  }

  /**
   * What changed from one snapshot to the next, in the order a delta yields it: deletes (deepest
   * first), then what is new or changed (parents first). Deterministic, so a resumed delta counts
   * the same list.
   */
  function diff(ctx: Context, old: readonly Rec[], next: readonly Rec[]): SyncEvent[] {
    const alive = new Set(next.map((r) => r.id));
    const idAt = new Map(next.map((r) => [pathKey(r.p), r.id]));
    const was = new Map(old.map((r) => [r.id, etagOf(r.id, entryOf(r))]));
    const events: SyncEvent[] = [];
    for (const r of [...old].reverse()) {
      if (!alive.has(r.id)) events.push({ type: "deleted", externalId: r.id });
    }
    for (const r of next) {
      const e = entryOf(r);
      if (was.get(r.id) === etagOf(r.id, e)) continue;
      const parentId = r.p.length === 1 ? null : (idAt.get(pathKey(r.p.slice(0, -1))) ?? null);
      events.push({ type: "item", item: itemOf(ctx, r.id, parentId, e) });
    }
    return events;
  }

  /**
   * Where an item is: its `url` (a file: URL inside the root), else its `path` under the root.
   * Nothing outside the root, and no link on the way (each folder above it is a real folder on
   * the root's device). Never trusted beyond that: the caller checks what it finds there.
   */
  async function locate(ctx: Place, ref: ItemRef): Promise<string> {
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
  async function lstatItem(ctx: Place, abs: string): Promise<BigIntStats> {
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
    const ctx = await place();
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
    ctx: Place,
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
    async identity(signal, recorded) {
      signal.throwIfAborted();
      const ctx = await context();
      if (recorded === undefined) return ctx.identity;
      // Checked against the files, not only the numbers (see sameRoot()).
      const snapshot = await state.latestSnapshot();
      if (await sameRoot(ctx, recorded, snapshot?.entries ?? [])) return recorded;
      // Another folder, even when its numbers read the same.
      return ctx.identity === recorded ? `${ctx.identity}:other` : ctx.identity;
    },
    async aclImport(ref, signal) {
      signal.throwIfAborted();
      const ctx = await place();
      await lstatItem(ctx, await locate(ctx, ref));
      return structuredClone(acl);
    },
    async redirect(ref, signal) {
      signal.throwIfAborted();
      const ctx = await place();
      const abs = await locate(ctx, ref);
      await lstatItem(ctx, abs);
      return pathToFileURL(abs).href;
    },
  };
}

/**
 * What a root folder is: `r1:<inode>:<birth time, ns, or 0>:<file system type, or 0>`. Never its
 * device number, which Linux and macOS give anew on a remount or a reboot.
 */
async function identityOf(root: string, st: BigIntStats): Promise<string> {
  let type = "0";
  try {
    type = `${(await statfs(root, { bigint: true })).type}`;
  } catch {
    // Not every platform or file system answers; the rest still says which folder it is.
  }
  return `r1:${st.ino}:${st.birthtimeNs > 0n ? st.birthtimeNs : 0n}:${type}`;
}

function parseIdentity(s: string): { ino: string; birth: string; type: string } | null {
  const m = /^r1:(\d{1,40}):(\d{1,40}):(\d{1,40})$/.exec(s);
  return m ? { ino: m[1] as string, birth: m[2] as string, type: m[3] as string } : null;
}

/** Part of the folder couldn't be seen: the runner mustn't take it as gone. */
function unreadableWarning(externalId: string | undefined): SyncEvent {
  return externalId === undefined
    ? { type: "warning", code: "unreadable" }
    : { type: "warning", code: "unreadable", externalId };
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
