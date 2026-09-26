import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isConnectorError, type SyncEvent } from "@openhoard/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fsSource } from "./testing/fixture.js";

/*
 * What the root folder is, when the numbers a file system gives change under it: Linux and
 * macOS number devices anew on a remount or a reboot, some file systems keep no birth times, and
 * on Windows realpath() turns a mapped drive into its network share. Simulated here, since a test
 * can't remount anything.
 */

const fake = vi.hoisted(() => ({
  root: "",
  /** Added to every device number. */
  devShift: 0n,
  /** Every birth time reads 0. */
  noBirth: false,
  /** Added to the root folder's inode number. */
  rootInoShift: 0n,
  /** The root folder's inode number, whatever folder it is (ext4 roots are all inode 2). */
  rootIno: undefined as bigint | undefined,
  /** What realpath() answers for the root. */
  realRoot: undefined as string | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const adjust = (path: unknown, st: unknown) => {
    const s = st as { dev?: unknown; ino: bigint; birthtimeNs: bigint } | null;
    if (!s || typeof s.dev !== "bigint") return st;
    Object.assign(s, { dev: s.dev + fake.devShift });
    if (fake.noBirth) Object.assign(s, { birthtimeNs: 0n });
    if (String(path) === fake.root) {
      Object.assign(s, { ino: fake.rootIno ?? s.ino + fake.rootInoShift });
    }
    return st;
  };
  const call = (f: unknown, args: unknown[]) =>
    (f as (...a: unknown[]) => Promise<unknown>)(...args);
  return {
    ...real,
    stat: async (...args: unknown[]) => adjust(args[0], await call(real.stat, args)),
    lstat: async (...args: unknown[]) => adjust(args[0], await call(real.lstat, args)),
    realpath: async (...args: unknown[]) =>
      String(args[0]) === fake.root && fake.realRoot !== undefined
        ? fake.realRoot
        : call(real.realpath, args),
  };
});

const signal = () => new AbortController().signal;
const enc = new TextEncoder();
async function events(iterable: AsyncIterable<SyncEvent>): Promise<SyncEvent[]> {
  const out: SyncEvent[] = [];
  for await (const e of iterable) out.push(e);
  return out;
}
const cursorOf = (es: SyncEvent[]) => {
  const last = es[es.length - 1];
  if (last?.type !== "done") throw new Error("no done");
  return last.cursor;
};
async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (e) {
    if (isConnectorError(e)) return e.code;
    throw e;
  }
  return "none";
}

let src: Awaited<ReturnType<typeof fsSource>>;
const identity = (recorded?: string) => {
  if (!src.connector.identity) throw new Error("no identity()");
  return src.connector.identity(signal(), recorded);
};
const delta = (cursor: string) => {
  if (!src.connector.delta) throw new Error("no delta()");
  return events(src.connector.delta(cursor, signal()));
};

beforeEach(async () => {
  Object.assign(fake, {
    devShift: 0n,
    noBirth: false,
    rootInoShift: 0n,
    rootIno: undefined,
    realRoot: undefined,
  });
  src = await fsSource({ checkpointEvery: 100 });
  fake.root = src.root;
  for (let i = 0; i < 8; i++) await src.write([`f${i}.txt`], enc.encode(`file ${i}`));
});
afterEach(async () => {
  Object.assign(fake, { devShift: 0n, noBirth: false, rootInoShift: 0n, realRoot: undefined });
  await src.close();
});

describe("fs connector: the root's identity", () => {
  it("stays the same folder when the device is numbered anew", async () => {
    const recorded = await identity();
    const crawl = await events(src.connector.crawl(null, signal()));
    fake.devShift = 1_000n;
    expect(await identity()).toBe(recorded);
    expect((await delta(cursorOf(crawl))).filter((e) => e.type !== "done")).toEqual([]);
  });

  it("without birth times, knows the folder by its files, and another folder by their absence", async () => {
    fake.noBirth = true;
    const recorded = await identity();
    expect(recorded).toMatch(/^r1:\d+:0:\d+$/);
    const crawl = await events(src.connector.crawl(null, signal()));
    // A remount gave the root another inode number; its files are the same.
    fake.rootInoShift = 7n;
    expect(await identity()).not.toBe(recorded);
    expect(await identity(recorded)).toBe(recorded);
    expect((await delta(cursorOf(crawl))).filter((e) => e.type !== "done")).toEqual([]);

    // Now another folder's files: not the same folder.
    for (let i = 0; i < 8; i++) await rm(join(src.root, `f${i}.txt`));
    for (let i = 0; i < 8; i++) await src.write([`g${i}.txt`], enc.encode(`other ${i}`));
    expect(await identity(recorded)).not.toBe(recorded);
    expect(await codeOf(delta(cursorOf(crawl)))).toBe("permanent");
  });

  it("without birth times, tells another disk from the recorded one even when its numbers read the same", async () => {
    // Every disk of one kind has the same root inode (ext4: 2), and none keeps birth times: the
    // identities of two disks mounted in turn at the path are the same text.
    fake.noBirth = true;
    fake.rootIno = 2n;
    const recorded = await identity();
    const crawl = await events(src.connector.crawl(null, signal()));
    expect(crawl.filter((e) => e.type === "item")).toHaveLength(8);

    await rename(src.root, `${src.root}-first-disk`);
    await mkdir(src.root);
    for (let i = 0; i < 3; i++) await src.write([`other-${i}.txt`], enc.encode(`other ${i}`));
    expect(await identity()).toBe(recorded); // the numbers alone can't tell
    expect(await identity(recorded)).not.toBe(recorded);
    // The delta refuses rather than report the 8 files deleted.
    expect(await codeOf(delta(cursorOf(crawl)))).toBe("permanent");

    // The first disk back at the path: the same folder again.
    await rm(src.root, { recursive: true });
    await rename(`${src.root}-first-disk`, src.root);
    expect(await identity(recorded)).toBe(recorded);
    expect((await delta(cursorOf(crawl))).filter((e) => e.type !== "done")).toEqual([]);
  });

  it("accepts a folder whose last snapshot holds no files, where there is nothing to delete", async () => {
    fake.noBirth = true;
    for (let i = 0; i < 8; i++) await rm(join(src.root, `f${i}.txt`));
    const recorded = await identity();
    await events(src.connector.crawl(null, signal()));
    fake.rootInoShift = 3n;
    expect(await identity(recorded)).toBe(recorded);
  });

  it("with birth times, never takes another folder for the recorded one", async () => {
    const recorded = await identity();
    fake.rootInoShift = 7n;
    expect(await identity(recorded)).not.toBe(recorded);
  });

  it("builds URLs from the root as configured, whatever realpath() says it is", async () => {
    // Windows: a mapped drive's realpath is its share, whose URLs would name a host.
    fake.realRoot = "\\\\files.example\\share";
    const crawl = await events(src.connector.crawl(null, signal()));
    const items = crawl.flatMap((e) => (e.type === "item" ? [e.item] : []));
    expect(items).toHaveLength(8);
    for (const item of items) {
      expect(item.url?.startsWith(pathToFileURL(src.root).href)).toBe(true);
    }
  });
});
