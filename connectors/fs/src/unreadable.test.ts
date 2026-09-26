import { basename } from "node:path";
import { isConnectorError, type SourceItem, type SyncEvent } from "@openhoard/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fsConnector } from "./fs-connector.js";
import { fsSource } from "./testing/fixture.js";

/*
 * A folder the connector may not list, or a file it may not stat, is unknown, not gone. Tests
 * may run as root (where permissions don't stop anything), so the file system's refusals are
 * injected: readdir or lstat of a name listed here fails with that code.
 */

const refuse = vi.hoisted(() => ({
  readdir: new Map<string, string>(),
  lstat: new Map<string, string>(),
  /** Names lstat() reports on another device (a mount point). */
  mounted: new Set<string>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const failing =
    (which: "readdir" | "lstat", original: (...args: never[]) => Promise<unknown>) =>
    async (...args: unknown[]) => {
      const name = basename(String(args[0]));
      const code = refuse[which].get(name);
      if (code !== undefined) throw Object.assign(new Error(`${code}: refused`), { code });
      const result = await (original as (...a: unknown[]) => Promise<unknown>)(...args);
      const st = result as { dev?: unknown };
      if (which === "lstat" && refuse.mounted.has(name) && typeof st.dev === "bigint") {
        Object.assign(st, { dev: st.dev + 1n });
      }
      return result;
    };
  return {
    ...real,
    readdir: failing("readdir", real.readdir as never),
    lstat: failing("lstat", real.lstat as never),
  };
});

const signal = () => new AbortController().signal;
const enc = new TextEncoder();
async function events(iterable: AsyncIterable<SyncEvent>): Promise<SyncEvent[]> {
  const out: SyncEvent[] = [];
  for await (const e of iterable) out.push(e);
  return out;
}
const itemsOf = (es: SyncEvent[]) => es.flatMap((e) => (e.type === "item" ? [e.item] : []));
const cursorOf = (es: SyncEvent[]) => {
  const last = es[es.length - 1];
  if (last?.type !== "done") throw new Error("no done");
  return last.cursor;
};
const idOf = (items: SourceItem[], ...path: string[]) =>
  items.find((i) => JSON.stringify(i.path) === JSON.stringify(path))?.externalId;

let src: Awaited<ReturnType<typeof fsSource>>;
const deltaOf = (cursor: string) => {
  if (!src.connector.delta) throw new Error("no delta");
  return src.connector.delta(cursor, signal());
};
beforeEach(async () => {
  refuse.readdir.clear();
  refuse.lstat.clear();
  refuse.mounted.clear();
  src = await fsSource({ checkpointEvery: 100 });
  await src.write(["Locked", "a.txt"], enc.encode("a"));
  await src.write(["Locked", "b.txt"], enc.encode("b"));
  await src.write(["Hidden.txt"], enc.encode("h"));
  await src.write(["Other.txt"], enc.encode("o"));
});
afterEach(async () => {
  refuse.readdir.clear();
  refuse.lstat.clear();
  refuse.mounted.clear();
  await src.close();
});

describe("fs connector: places it can't see", () => {
  it("keeps what a delta can't list or stat, warns, and reports it again once it can", async () => {
    const crawl = await events(src.connector.crawl(null, signal()));
    const items = itemsOf(crawl);
    const delta = (cursor: string) => {
      if (!src.connector.delta) throw new Error("no delta");
      return events(src.connector.delta(cursor, signal()));
    };

    refuse.readdir.set("Locked", "EACCES");
    refuse.lstat.set("Hidden.txt", "EPERM");
    const blind = await delta(cursorOf(crawl));
    expect(blind.filter((e) => e.type === "deleted")).toEqual([]);
    expect(blind.filter((e) => e.type === "warning")).toEqual([
      { type: "warning", code: "unreadable", externalId: idOf(items, "Hidden.txt") },
      { type: "warning", code: "unreadable", externalId: idOf(items, "Locked") },
    ]);

    // Seen again: the kept entries were in the snapshot all along, so a real delete shows.
    refuse.readdir.clear();
    refuse.lstat.clear();
    await src.remove(["Locked", "b.txt"]);
    const seen = await delta(cursorOf(blind));
    expect(seen.filter((e) => e.type !== "done")).toEqual([
      { type: "deleted", externalId: idOf(items, "Locked", "b.txt") },
    ]);
  });

  it("warns a crawl that met a folder it can't list, and leaves its contents out", async () => {
    refuse.readdir.set("Locked", "EACCES");
    const crawl = await events(src.connector.crawl(null, signal()));
    const items = itemsOf(crawl);
    expect(items.map((i) => i.path.join("/")).sort()).toEqual([
      "Hidden.txt",
      "Locked",
      "Other.txt",
    ]);
    expect(crawl.filter((e) => e.type === "warning")).toEqual([
      { type: "warning", code: "unreadable", externalId: idOf(items, "Locked") },
    ]);
    refuse.readdir.clear();
    refuse.lstat.set("Other.txt", "EACCES");
    const again = await events(src.connector.crawl(null, signal()));
    expect(again.filter((e) => e.type === "warning")).toEqual([
      { type: "warning", code: "unreadable" },
    ]);
  });

  it("fails, rather than report anything gone, when reading fails another way", async () => {
    const crawl = await events(src.connector.crawl(null, signal()));
    refuse.readdir.set("Locked", "EIO");
    let error: unknown;
    try {
      await events(deltaOf(cursorOf(crawl)));
    } catch (e) {
      error = e;
    }
    expect(isConnectorError(error) && error.code).toBe("retryable");
    // A folder that went while the walk looked is simply gone.
    refuse.readdir.set("Locked", "ENOENT");
    const gone = await events(deltaOf(cursorOf(crawl)));
    expect(gone.filter((e) => e.type === "deleted")).toHaveLength(2);
  });

  it("takes a busy file (Windows' pagefile.sys and the like) as unreadable, not as a failure", async () => {
    const crawl = await events(src.connector.crawl(null, signal()));
    refuse.lstat.set("Hidden.txt", "EBUSY");
    const busy = await events(deltaOf(cursorOf(crawl)));
    expect(busy.filter((e) => e.type === "deleted")).toEqual([]);
    expect(busy.filter((e) => e.type === "warning")).toEqual([
      { type: "warning", code: "unreadable", externalId: idOf(itemsOf(crawl), "Hidden.txt") },
    ]);
  });

  it("keeps what a mount over a folder hides, unless told to skip other devices", async () => {
    const crawl = await events(src.connector.crawl(null, signal()));
    const items = itemsOf(crawl);
    refuse.mounted.add("Locked");
    const hidden = await events(deltaOf(cursorOf(crawl)));
    expect(hidden.filter((e) => e.type === "deleted")).toEqual([]);
    expect(hidden.filter((e) => e.type === "warning")).toEqual([
      { type: "warning", code: "unreadable", externalId: idOf(items, "Locked") },
    ]);

    const skipping = fsConnector({
      root: src.root,
      stateDir: src.stateDir,
      otherDevices: "skip",
    });
    if (!skipping.delta) throw new Error("no delta");
    const gone = await events(skipping.delta(cursorOf(hidden), signal()));
    expect(gone.filter((e) => e.type === "deleted")).toHaveLength(3);
    expect(() =>
      fsConnector({ root: src.root, stateDir: src.stateDir, otherDevices: "x" as never }),
    ).toThrow(RangeError);
  });
});
