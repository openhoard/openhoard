import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { resyncError } from "@openhoard/sdk";
import type { Entry } from "./walk.js";

/*
 * What the connector keeps in its state folder, so its tokens stay small (the runner stores
 * them) however large the folder is:
 *
 * - a crawl journal per crawl (`crawl-<run>.jsonl`): a header, then every entry the crawl has
 *   yielded, as it saw it. A checkpoint names the run and the journal's length at that point, so
 *   a resumed crawl cuts off what came after and knows what it yielded before;
 * - snapshots (`snap-<sha-256>.json.gz`): every entry at the end of a crawl or a delta, named
 *   by the hash of their content. A cursor names one; delta() compares the folder with it.
 *
 * A token whose file is gone or doesn't check out is refused with `resync`: the runner crawls
 * again. Old files are removed as newer tokens are used (see fs-connector.ts).
 */

/** One entry as stored: bigints as decimal strings. */
export interface Rec {
  id: string;
  k: "f" | "d";
  p: string[];
  i: string;
  b: string;
  s: string;
  m: string;
  c: string;
}

export interface Snapshot {
  v: 1;
  /** The root folder's device and inode: a delta refuses another folder at the same path. */
  root: string;
  entries: Rec[];
}

export const recOf = (id: string, e: Entry): Rec => ({
  id,
  k: e.kind === "file" ? "f" : "d",
  p: e.path,
  i: e.ino.toString(),
  b: e.birthNs.toString(),
  s: e.size.toString(),
  m: e.mtimeNs.toString(),
  c: e.ctimeNs.toString(),
});

export const entryOf = (r: Rec): Entry => ({
  path: r.p,
  kind: r.k === "f" ? "file" : "folder",
  ino: BigInt(r.i),
  birthNs: BigInt(r.b),
  size: BigInt(r.s),
  mtimeNs: BigInt(r.m),
  ctimeNs: BigInt(r.c),
  links: 1n,
});

const DIGITS = /^-?\d{1,30}$/;
const ID = /^[a-z0-9-]{1,80}$/;

/** Whether a parsed line is a Rec, checked field by field (state files can be damaged). */
function isRec(v: unknown): v is Rec {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    ID.test(r.id) &&
    (r.k === "f" || r.k === "d") &&
    Array.isArray(r.p) &&
    r.p.length > 0 &&
    r.p.every((n) => typeof n === "string" && n.length > 0) &&
    [r.i, r.b, r.s, r.m, r.c].every((x) => typeof x === "string" && DIGITS.test(x))
  );
}

export const pathKey = (path: readonly string[]) => JSON.stringify(path);

/** An id from the path: for entries whose inode says nothing (0) or is taken. */
export function pathId(path: readonly string[]): string {
  return `p${createHash("sha256").update(pathKey(path)).digest("hex").slice(0, 32)}`;
}

/**
 * The id of an entry seen for the first time: its inode number, and its birth time when the file
 * system keeps one (Windows, macOS, and Linux file systems with statx), so a file created later
 * on a reused inode number gets another id. Editing a file in place keeps both, so a fresh crawl
 * gives an edited file the id a chain of deltas kept for it. Hard links (one inode at two paths)
 * and inodes of 0 get an id from the path. Never one in `used`, which it joins.
 */
export function firstSightId(e: Entry, used: Set<string>): string {
  const birth = e.birthNs > 0n ? `-${e.birthNs.toString(36)}` : "";
  let id =
    e.ino > 0n ? `${e.kind === "file" ? "f" : "d"}${e.ino.toString(36)}${birth}` : pathId(e.path);
  if (used.has(id)) id = pathId(e.path);
  for (let n = 2; used.has(id); n++) id = `${pathId(e.path)}-${n}`;
  used.add(id);
  return id;
}

/**
 * Ids for the folder as it is now (`entries`, in walk order), carried over from the snapshot
 * before (`old`):
 *
 * 1. by inode: an entry of the same kind on the same inode keeps its id when its birth time is
 *    the same (and known), or, without one, when it is a folder, or a file whose size and
 *    modification time are unchanged (a rename or a move changes neither). So a renamed or moved
 *    file or folder keeps its id, and a file created on a reused inode number doesn't take the
 *    old file's;
 * 2. by path: an entry at the same path, of the same kind, keeps the id that isn't taken yet.
 *    Editors that save by writing a new file and renaming it over the old one make a new inode
 *    each time; the file keeps its id all the same;
 * 3. anything else is new ({@link firstSightId}), never reusing an id the snapshot had.
 *
 * Without birth times, a file renamed and edited between two deltas matches neither way: it is
 * reported deleted and created, as a path-keyed source would.
 */
export function assignIds(entries: readonly Entry[], old: readonly Rec[]): string[] {
  const ids: (string | undefined)[] = new Array<string | undefined>(entries.length);
  const claimed = new Set<string>();
  const byIno = new Map<string, Rec[]>();
  for (const r of old) {
    if (r.i === "0") continue;
    const key = `${r.k}:${r.i}`;
    const list = byIno.get(key);
    if (list) list.push(r);
    else byIno.set(key, [r]);
  }
  entries.forEach((e, n) => {
    if (e.ino === 0n) return;
    const k = e.kind === "file" ? "f" : "d";
    const birth = e.birthNs.toString();
    const same = (r: Rec) =>
      e.birthNs > 0n && r.b === birth
        ? true
        : k === "d" || (r.s === e.size.toString() && r.m === e.mtimeNs.toString());
    const match = byIno.get(`${k}:${e.ino}`)?.find((r) => !claimed.has(r.id) && same(r));
    if (match) {
      ids[n] = match.id;
      claimed.add(match.id);
    }
  });
  const byPath = new Map(old.map((r) => [`${r.k}:${pathKey(r.p)}`, r]));
  entries.forEach((e, n) => {
    if (ids[n] !== undefined) return;
    const r = byPath.get(`${e.kind === "file" ? "f" : "d"}:${pathKey(e.path)}`);
    if (r && !claimed.has(r.id)) {
      ids[n] = r.id;
      claimed.add(r.id);
    }
  });
  const used = new Set([...claimed, ...old.map((r) => r.id)]);
  return entries.map((e, n) => ids[n] ?? firstSightId(e, used));
}

const RUN = /^[0-9a-f]{16}$/;
const DIGEST = /^[0-9a-f]{64}$/;

/** The state folder. */
export class StateDir {
  constructor(readonly dir: string) {}

  async ensure(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  newRun(): string {
    return randomBytes(8).toString("hex");
  }

  journal(run: string): string {
    if (!RUN.test(run)) throw resyncError();
    return join(this.dir, `crawl-${run}.jsonl`);
  }

  /** The journal's header line: which run, over which root folder. */
  header(run: string, root: string): string {
    return `${JSON.stringify({ v: 1, run, root })}\n`;
  }

  /**
   * The entries a crawl had yielded by a checkpoint: its journal's first `bytes`, after the
   * header. Refused (`resync`) when the journal is gone, shorter, damaged, or of another root.
   */
  async readJournal(run: string, bytes: number): Promise<{ root: string; recs: Rec[] }> {
    let buf: Buffer;
    try {
      buf = await readFile(this.journal(run));
    } catch {
      throw resyncError();
    }
    if (buf.byteLength < bytes) throw resyncError();
    const lines = buf.subarray(0, bytes).toString("utf8").split("\n");
    // Everything up to `bytes` ends with a newline: the last piece is empty.
    if (lines.pop() !== "") throw resyncError();
    const [head, ...rest] = lines;
    const header = parse(head);
    if (
      typeof header !== "object" ||
      header === null ||
      (header as { run?: unknown }).run !== run ||
      typeof (header as { root?: unknown }).root !== "string"
    ) {
      throw resyncError();
    }
    const recs = rest.map((line) => {
      const rec = parse(line);
      if (!isRec(rec)) throw resyncError();
      return rec;
    });
    return { root: (header as { root: string }).root, recs };
  }

  /** Writes a snapshot (atomically: a temporary file renamed into place); returns its digest. */
  async writeSnapshot(snapshot: Snapshot): Promise<string> {
    const json = JSON.stringify(snapshot);
    const digest = createHash("sha256").update(json).digest("hex");
    const file = join(this.dir, `snap-${digest}.json.gz`);
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, gzipSync(json));
    await rename(tmp, file);
    return digest;
  }

  /** The snapshot a cursor names: `resync` when it is gone or doesn't hash to its name. */
  async readSnapshot(digest: string): Promise<Snapshot> {
    if (!DIGEST.test(digest)) throw resyncError();
    let json: string;
    try {
      json = gunzipSync(await readFile(join(this.dir, `snap-${digest}.json.gz`))).toString("utf8");
    } catch {
      throw resyncError();
    }
    if (createHash("sha256").update(json).digest("hex") !== digest) throw resyncError();
    const snapshot = parse(json) as Snapshot | undefined;
    if (
      snapshot?.v !== 1 ||
      typeof snapshot.root !== "string" ||
      !Array.isArray(snapshot.entries) ||
      !snapshot.entries.every(isRec)
    ) {
      throw resyncError();
    }
    return snapshot;
  }

  /**
   * The warnings a delta gave when it wrote snapshot `digest`, kept beside it so a delta resumed
   * from its checkpoint gives them again (nothing is walked then).
   */
  async writeWarnings(digest: string, warnings: readonly unknown[]): Promise<void> {
    if (!DIGEST.test(digest) || warnings.length === 0) return;
    const file = join(this.dir, `warn-${digest}.json`);
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(warnings));
    await rename(tmp, file);
  }

  /** What writeWarnings() kept for `digest`; none when there is no file, or a damaged one. */
  async readWarnings(digest: string): Promise<{ code: string; externalId?: string }[]> {
    if (!DIGEST.test(digest)) return [];
    try {
      const list = JSON.parse(
        await readFile(join(this.dir, `warn-${digest}.json`), "utf8"),
      ) as unknown;
      if (!Array.isArray(list)) return [];
      return list.filter(
        (w): w is { code: string; externalId?: string } =>
          typeof w === "object" &&
          w !== null &&
          typeof (w as { code?: unknown }).code === "string" &&
          ["undefined", "string"].includes(typeof (w as { externalId?: unknown }).externalId),
      );
    } catch {
      return [];
    }
  }

  /**
   * The newest snapshot there is (the cursor the runner holds, as far as the connector can tell),
   * or null: what identity() compares the folder with.
   */
  async latestSnapshot(): Promise<Snapshot | null> {
    let newest: { digest: string; at: number } | undefined;
    try {
      for (const name of await readdir(this.dir)) {
        const m = /^snap-([0-9a-f]{64})\.json\.gz$/.exec(name);
        if (!m) continue;
        const at = (await stat(join(this.dir, name))).mtimeMs;
        if (!newest || at > newest.at) newest = { digest: m[1] as string, at };
      }
      return newest ? await this.readSnapshot(newest.digest) : null;
    } catch {
      return null;
    }
  }

  /**
   * Removes what no token in use can name: with `snapshots`, every snapshot but those (and any
   * half-written one); with `journals`, every crawl journal but that run's.
   */
  async prune(options: { snapshots?: { keep: readonly string[] }; journals?: { keep: string } }) {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const snap =
        /^snap-([0-9a-f]{64})\.json\.gz(\.[0-9a-f]{12}\.tmp)?$/.exec(name) ??
        /^warn-([0-9a-f]{64})\.json(\.[0-9a-f]{12}\.tmp)?$/.exec(name);
      const crawl = /^crawl-([0-9a-f]{16})\.jsonl$/.exec(name);
      const drop = snap
        ? options.snapshots !== undefined &&
          (snap[2] !== undefined || !options.snapshots.keep.includes(snap[1] as string))
        : crawl
          ? options.journals !== undefined && crawl[1] !== options.journals.keep
          : false;
      if (drop) await rm(join(this.dir, name), { force: true });
    }
  }
}

function parse(s: string | undefined): unknown {
  if (s === undefined) return undefined;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return undefined;
  }
}
