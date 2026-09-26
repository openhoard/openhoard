import {
  appendFile,
  link,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isConnectorError,
  refOf,
  type Connector,
  type SourceItem,
  type SyncEvent,
} from "@openhoard/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fsError } from "./errors.js";
import { fsConnector } from "./fs-connector.js";
import { mediaTypeOf } from "./media.js";
import { assignIds, firstSightId, pathId } from "./state.js";
import { fsSource } from "./testing/fixture.js";
import { compareWalk, type Entry } from "./walk.js";

/* What the contract kit can't know about a local folder: links, the root, state, inodes. */

const signal = () => new AbortController().signal;

/** A connector's optional method, which these tests know it has. */
function need<T>(method: T | undefined): T {
  if (method === undefined) throw new Error("the connector lacks this method");
  return method;
}
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
const byPath = (items: SourceItem[], ...path: string[]) =>
  items.find((i) => JSON.stringify(i.path) === JSON.stringify(path));

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (e) {
    if (isConnectorError(e)) return e.code;
    throw e;
  }
  throw new Error("expected a ConnectorError");
}
const drain = async (body: AsyncIterable<Uint8Array>) => {
  const chunks: Uint8Array[] = [];
  for await (const c of body) chunks.push(c);
  return Buffer.concat(chunks);
};

let src: Awaited<ReturnType<typeof fsSource>>;
let connector: Connector;
let outside: string;
beforeEach(async () => {
  src = await fsSource({ checkpointEvery: 2, chunkSize: 1024 });
  connector = src.connector;
  outside = await mkdtemp(join(tmpdir(), "openhoard-outside-"));
  await writeFile(join(outside, "secret.txt"), "not yours\n");
});
afterEach(async () => {
  await src.close();
  await rm(outside, { recursive: true, force: true, maxRetries: 5 });
});

describe("fs connector: options and the root", () => {
  it("validates its options", () => {
    expect(() => fsConnector({ root: "relative", stateDir: src.stateDir })).toThrow(TypeError);
    expect(() => fsConnector({ root: src.root, stateDir: "relative" })).toThrow(TypeError);
    expect(() =>
      fsConnector({ root: src.root, stateDir: src.stateDir, checkpointEvery: 0 }),
    ).toThrow(RangeError);
    expect(() => fsConnector({ root: src.root, stateDir: src.stateDir, chunkSize: 1.5 })).toThrow(
      RangeError,
    );
    expect(() =>
      fsConnector({
        root: src.root,
        stateDir: src.stateDir,
        defaultAcl: [{ principal: { kind: "robot" }, role: "read", inherited: false } as never],
      }),
    ).toThrow(TypeError);
  });

  it("refuses a state folder inside the root", async () => {
    const c = fsConnector({ root: src.root, stateDir: join(src.root, ".openhoard") });
    expect(await codeOf(events(c.crawl(null, signal())))).toBe("permanent");
  });

  it("waits for a root that isn't there rather than reporting it empty, and refuses a file", async () => {
    const missing = fsConnector({ root: join(outside, "not-mounted"), stateDir: src.stateDir });
    expect(await codeOf(events(missing.crawl(null, signal())))).toBe("retryable");
    const file = fsConnector({ root: join(outside, "secret.txt"), stateDir: src.stateDir });
    expect(await codeOf(events(file.crawl(null, signal())))).toBe("permanent");
  });

  it("refuses a delta when another folder has taken the root's path", async () => {
    await src.write(["a.txt"], enc.encode("a"));
    const cursor = cursorOf(await events(connector.crawl(null, signal())));
    await rename(src.root, `${src.root}-unmounted`);
    await mkdir(src.root);
    expect(await codeOf(events(need(connector.delta)(cursor, signal())))).toBe("permanent");
    await rm(`${src.root}-unmounted`, { recursive: true });
  });
});

describe("fs connector: state", () => {
  it("asks for a resync when its state is gone or damaged", async () => {
    for (let i = 0; i < 5; i++) await src.write([`f${i}.txt`], enc.encode(`${i}`));
    const crawl = await events(connector.crawl(null, signal()));
    const cursor = cursorOf(crawl);
    const checkpoint = crawl.find((e) => e.type === "checkpoint");
    expect(checkpoint).toBeDefined();
    // The crawl finished: its journal is gone, so its checkpoints are too.
    const token = (checkpoint as { token: string }).token;
    expect(await codeOf(events(connector.crawl(token, signal())))).toBe("resync");
    expect(await codeOf(events(connector.crawl("fs1c.0123456789abcdef.99", signal())))).toBe(
      "resync",
    );
    expect(await codeOf(events(need(connector.delta)(`fs1.${"0".repeat(64)}`, signal())))).toBe(
      "resync",
    );

    // A snapshot whose content no longer hashes to its name.
    const [snap] = (await readdir(src.stateDir)).filter((n) => n.startsWith("snap-"));
    await writeFile(join(src.stateDir, snap as string), "damaged");
    expect(await codeOf(events(need(connector.delta)(cursor, signal())))).toBe("resync");

    // A journal cut short, or of another crawl.
    const partial: SyncEvent[] = [];
    for await (const e of connector.crawl(null, signal())) {
      partial.push(e);
      if (e.type === "checkpoint") break;
    }
    const live = (partial.find((e) => e.type === "checkpoint") as { token: string }).token;
    const [journal] = (await readdir(src.stateDir)).filter((n) => n.startsWith("crawl-"));
    await writeFile(join(src.stateDir, journal as string), "{}\n");
    expect(await codeOf(events(connector.crawl(live, signal())))).toBe("resync");

    await rm(src.stateDir, { recursive: true });
    expect(await codeOf(events(need(connector.delta)(cursor, signal())))).toBe("resync");
    // And it starts over from nothing.
    expect(itemsOf(await events(connector.crawl(null, signal())))).toHaveLength(5);
  });

  it("keeps only the snapshot the last cursor names", async () => {
    await src.write(["a.txt"], enc.encode("a"));
    const c1 = cursorOf(await events(connector.crawl(null, signal())));
    await src.write(["b.txt"], enc.encode("b"));
    const c2 = cursorOf(await events(need(connector.delta)(c1, signal())));
    await src.write(["c.txt"], enc.encode("c"));
    const c3 = cursorOf(await events(need(connector.delta)(c2, signal())));
    const snaps = (await readdir(src.stateDir)).filter((n) => n.startsWith("snap-"));
    expect(snaps.sort()).toEqual([c2, c3].map((c) => `snap-${c.slice(4)}.json.gz`).sort());
    expect(await codeOf(events(need(connector.delta)(c1, signal())))).toBe("resync");
  });
});

describe("fs connector: never outside the root", () => {
  it("never follows links, to files or folders, inside or outside the root", async () => {
    await src.write(["real.txt"], enc.encode("real"));
    let linked = true;
    try {
      await symlink(
        outside,
        join(src.root, "link-dir"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await symlink(join(outside, "secret.txt"), join(src.root, "link.txt"), "file");
    } catch (e) {
      // Windows without the symlink privilege: the junction may exist, the file link not.
      if ((e as { code?: string }).code !== "EPERM") throw e;
      linked = false;
    }
    const items = itemsOf(await events(connector.crawl(null, signal())));
    expect(items.map((i) => i.path.join("/"))).toEqual(["real.txt"]);
    const secret = { externalId: "x", contentVersion: "v1.10.0.0.1" };
    expect(
      await codeOf(connector.read({ ...secret, path: ["link-dir", "secret.txt"] }, signal())),
    ).toBe("not-found");
    if (linked) {
      expect(await codeOf(connector.read({ ...secret, path: ["link.txt"] }, signal()))).toBe(
        "not-found",
      );
      expect(
        await codeOf(need(connector.redirect)({ externalId: "x", path: ["link.txt"] }, signal())),
      ).toBe("not-found");
    }
  });

  it("refuses locations outside the root, or that aren't file URLs or names", async () => {
    await src.write(["a.txt"], enc.encode("a"));
    const refs = [
      { url: pathToFileURL(join(outside, "secret.txt")).href },
      { url: pathToFileURL(src.root).href },
      { url: "https://example.com/a.txt" },
      { path: ["..", "secret.txt"] },
      { path: ["a/b"] },
      { path: [] },
      {},
    ];
    for (const ref of refs) {
      const r = { externalId: "x", contentVersion: "v1", ...ref };
      expect(await codeOf(connector.read(r, signal())), JSON.stringify(ref)).toBe("not-found");
      expect(await codeOf(need(connector.aclImport)(r, signal()))).toBe("not-found");
      expect(await codeOf(need(connector.redirect)(r, signal()))).toBe("not-found");
    }
  });
});

describe("fs connector: identity", () => {
  it("keeps a file's id across an editor's save-by-rename", async () => {
    await src.write(["Docs", "report.txt"], enc.encode("draft"));
    const crawl = await events(connector.crawl(null, signal()));
    const before = byPath(itemsOf(crawl), "Docs", "report.txt") as SourceItem;
    await writeFile(join(src.root, "Docs", ".report.txt.swp"), "final version");
    await rename(join(src.root, "Docs", ".report.txt.swp"), join(src.root, "Docs", "report.txt"));
    const changes = await events(need(connector.delta)(cursorOf(crawl), signal()));
    expect(changes.filter((e) => e.type === "deleted")).toEqual([]);
    const after = byPath(itemsOf(changes), "Docs", "report.txt") as SourceItem;
    expect(after.externalId).toBe(before.externalId);
    expect(after.contentVersion).not.toBe(before.contentVersion);
    const bytes = await drain((await connector.read(refOf(after), signal())).body);
    expect(bytes.toString()).toBe("final version");
  });

  it("keeps ids across a rename that only changes case", async () => {
    await src.write(["Report.txt"], enc.encode("x"));
    const crawl = await events(connector.crawl(null, signal()));
    const before = byPath(itemsOf(crawl), "Report.txt") as SourceItem;
    await rename(join(src.root, "Report.txt"), join(src.root, "report.txt"));
    const changes = await events(need(connector.delta)(cursorOf(crawl), signal()));
    expect(changes.filter((e) => e.type === "deleted")).toEqual([]);
    expect(byPath(itemsOf(changes), "report.txt")?.externalId).toBe(before.externalId);
  });

  it("gives each path of a hard-linked file its own id", async () => {
    await src.write(["a.txt"], enc.encode("shared"));
    await link(join(src.root, "a.txt"), join(src.root, "b.txt"));
    const items = itemsOf(await events(connector.crawl(null, signal())));
    expect(items).toHaveLength(2);
    expect(new Set(items.map((i) => i.externalId)).size).toBe(2);
    expect((byPath(items, "b.txt") as SourceItem).externalId).toBe(pathId(["b.txt"]));
  });

  it("assigns ids by inode, then by path, and never hands out an old one", () => {
    const e = (path: string[], ino: bigint, birthNs: bigint, mtimeNs = 1n, size = 1n): Entry => ({
      path,
      kind: "file",
      ino,
      birthNs,
      size,
      mtimeNs,
      ctimeNs: 1n,
    });
    const rec = (id: string, x: Entry) => ({
      id,
      k: "f" as const,
      p: x.path,
      i: `${x.ino}`,
      b: `${x.birthNs}`,
      s: `${x.size}`,
      m: `${x.mtimeNs}`,
      c: "1",
    });
    const old = [
      rec("A", e(["a"], 5n, 0n, 10n)),
      rec("B", e(["b"], 6n, 99n)),
      rec("C", e(["c"], 7n, 0n)),
    ];
    const ids = assignIds(
      [
        e(["moved-a"], 5n, 0n, 10n), // same inode, size and time: A, moved
        e(["b-edited"], 6n, 99n, 50n, 9n), // same inode and birth: B, renamed and edited
        e(["c"], 8n, 0n), // new inode at C's path: C, saved by rename
        e(["new"], 5n, 0n, 77n), // A's inode reused, another time: new, and not A
      ],
      old,
    );
    expect(ids.slice(0, 3)).toEqual(["A", "B", "C"]);
    expect(ids[3]).not.toMatch(/^[ABC]$/);
    const used = new Set(["f5"]);
    expect(firstSightId(e(["x"], 5n, 0n), used)).toBe(pathId(["x"]));
    expect(firstSightId(e(["x"], 5n, 0n), used)).toBe(`${pathId(["x"])}-2`);
    expect(firstSightId(e(["y"], 0n, 0n), new Set())).toBe(pathId(["y"]));
    expect(firstSightId(e(["z"], 35n, 36n), new Set())).toBe("fz-10");
  });

  it("orders paths as the walk does: a folder before what is in it, names by code unit", () => {
    expect(compareWalk(["a"], ["a", "b"])).toBeLessThan(0);
    expect(compareWalk(["B"], ["a"])).toBeLessThan(0);
    expect(compareWalk(["a", "z"], ["b"])).toBeLessThan(0);
    expect(compareWalk(["a"], ["a"])).toBe(0);
  });
});

describe("fs connector: reading", () => {
  it("fails a read when the file changes while it is read", async () => {
    await src.write(["big.bin"], new Uint8Array(10_000).fill(7));
    const item = byPath(
      itemsOf(await events(connector.crawl(null, signal()))),
      "big.bin",
    ) as SourceItem;
    const result = await connector.read(refOf(item), signal());
    let chunks = 0;
    expect(
      await codeOf(
        (async () => {
          for await (const chunk of result.body) {
            void chunk;
            if (++chunks === 1) await appendFile(join(src.root, "big.bin"), "more");
          }
        })(),
      ),
    ).toBe("changed");
  });

  it("refuses bytes rewritten with the old modification time put back", async () => {
    await src.write(["a.txt"], enc.encode("original"));
    const item = byPath(
      itemsOf(await events(connector.crawl(null, signal()))),
      "a.txt",
    ) as SourceItem;
    const { mtime } = await stat(join(src.root, "a.txt"));
    await new Promise((r) => setTimeout(r, 50));
    await writeFile(join(src.root, "a.txt"), "tampered");
    await utimes(join(src.root, "a.txt"), mtime, mtime);
    expect(await codeOf(connector.read(refOf(item), signal()))).toBe("changed");
  });

  it("holds nothing open for a body that is never read, or left early", async () => {
    await src.write(["a.txt"], new Uint8Array(5_000));
    const item = byPath(
      itemsOf(await events(connector.crawl(null, signal()))),
      "a.txt",
    ) as SourceItem;
    await connector.read(refOf(item), signal());
    for await (const chunk of (await connector.read(refOf(item), signal())).body) {
      void chunk;
      break;
    }
    // Windows refuses to delete a file that is still open.
    await rm(join(src.root, "a.txt"));
  });

  it("crawls and reads paths longer than Windows' old 260-character limit", async () => {
    const deep = Array.from({ length: 6 }, (_, i) => `${"folder".repeat(6)}-${i}`);
    await src.write([...deep, "deep file.txt"], enc.encode("deep"));
    const items = itemsOf(await events(connector.crawl(null, signal())));
    const item = byPath(items, ...deep, "deep file.txt") as SourceItem;
    expect(join(src.root, ...item.path).length).toBeGreaterThan(260);
    expect((await drain((await connector.read(refOf(item), signal())).body)).toString()).toBe(
      "deep",
    );
  });

  it("imports the owner-only ACL and redirects to the file's URL", async () => {
    await src.write(["a b.txt"], enc.encode("x"));
    const item = byPath(
      itemsOf(await events(connector.crawl(null, signal()))),
      "a b.txt",
    ) as SourceItem;
    expect(await need(connector.aclImport)(refOf(item), signal())).toEqual({
      basis: "owner-only",
      entries: [],
    });
    const url = await need(connector.redirect)(refOf(item), signal());
    expect(url).toBe(item.url);
    expect(url).toMatch(/^file:\/\/.*a%20b\.txt$/);
  });
});

describe("fs connector: errors and media types", () => {
  it("maps OS errors to the contract's codes without the path", () => {
    const err = (code: string) =>
      fsError(
        Object.assign(new Error(`${code}: /secret/path`), { code, syscall: "open" }),
      ) as Error & {
        code: string;
      };
    expect(err("ENOENT").code).toBe("not-found");
    expect(err("EACCES").code).toBe("permanent");
    expect(err("EBUSY").code).toBe("retryable");
    expect(err("EMFILE").code).toBe("retryable");
    expect(err("constructor").code).toBe("retryable");
    expect(err("ENOENT").message).toBe("file system error ENOENT (open)");
    expect(err("ENOENT").message).not.toContain("secret");
    expect((fsError(new Error("odd")) as Error).message).toBe("file system error unknown");
    const abort = new DOMException("stop", "AbortError");
    expect(fsError(abort)).toBe(abort);
  });

  it("names media types by extension, and nothing else", () => {
    expect(mediaTypeOf("Plan.DOCX")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(mediaTypeOf("notes.md")).toBe("text/markdown");
    expect(mediaTypeOf("x.constructor")).toBe("application/octet-stream");
    expect(mediaTypeOf(".bashrc")).toBe("application/octet-stream");
    expect(mediaTypeOf("trailing.")).toBe("application/octet-stream");
    expect(mediaTypeOf("README")).toBe("application/octet-stream");
  });
});
