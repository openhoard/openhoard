import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { contentHash, scopedBlobId } from "@openhoard/core-catalog";
import { CapabilityOverrideLayer, Operator } from "opendal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BlobNotFoundError,
  blobPath,
  BlobStore,
  BlobTooLargeError,
  operatorFor,
  type StorageConfig,
  type TenantBlobKey,
} from "./store.js";

/*
 * One suite, run on every backend available: local disk and memory always, S3 and Azure Blob
 * when their credentials are in the environment (OPENHOARD_TEST_S3_BUCKET etc., for the
 * nightly job). Memory has neither rename nor copy, so it covers the streaming-move fallback.
 */

const fsRoot = mkdtempSync(join(tmpdir(), "openhoard-blobs-"));
afterAll(() => rmSync(fsRoot, { recursive: true, force: true }));

const env = process.env;
const backends: [string, StorageConfig][] = [
  ["fs", { kind: "fs", root: fsRoot }],
  ["memory", { kind: "memory" }],
];
if (env.OPENHOARD_TEST_S3_BUCKET) {
  backends.push([
    "s3",
    {
      kind: "s3",
      bucket: env.OPENHOARD_TEST_S3_BUCKET,
      ...(env.OPENHOARD_TEST_S3_REGION ? { region: env.OPENHOARD_TEST_S3_REGION } : {}),
      root: `/ci-${Date.now()}`,
    },
  ]);
}
if (env.OPENHOARD_TEST_AZBLOB_CONTAINER) {
  backends.push([
    "azblob",
    {
      kind: "azblob",
      container: env.OPENHOARD_TEST_AZBLOB_CONTAINER,
      ...(env.OPENHOARD_TEST_AZBLOB_ACCOUNT
        ? { accountName: env.OPENHOARD_TEST_AZBLOB_ACCOUNT }
        : {}),
      ...(env.OPENHOARD_TEST_AZBLOB_KEY ? { accountKey: env.OPENHOARD_TEST_AZBLOB_KEY } : {}),
      root: `/ci-${Date.now()}`,
    },
  ]);
}

const tenant = (id: string): TenantBlobKey => ({ id, key: randomBytes(32) });
const text = (s: string) => new TextEncoder().encode(s);
async function* chunked(bytes: Uint8Array, size: number) {
  for (let i = 0; i < bytes.byteLength; i += size) yield bytes.subarray(i, i + size);
}
async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const p of stream) parts.push(p);
  return new Uint8Array(Buffer.concat(parts));
}

describe.each(backends)("BlobStore on %s", (name, config) => {
  let store: BlobStore;
  let acme: TenantBlobKey;
  let globex: TenantBlobKey;
  beforeAll(() => {
    store = BlobStore.open(config);
    acme = tenant(`acme-${name}`);
    globex = tenant(`globex-${name}`);
  });

  it("stores bytes under their tenant-scoped BLAKE3 id", async () => {
    const bytes = text("quarterly report, final");
    const result = await store.put(acme, bytes);
    expect(result).toEqual({
      blobId: scopedBlobId(acme.key, contentHash(bytes)),
      size: bytes.byteLength,
      created: true,
    });
    expect(await store.read(acme.id, result.blobId)).toEqual(bytes);
    expect(await store.has(acme.id, result.blobId)).toBe(true);
    expect(await store.size(acme.id, result.blobId)).toBe(bytes.byteLength);
  });

  it("gives a stream the same id as the same bytes, and stores them once", async () => {
    const bytes = randomBytes(300_000);
    const first = await store.put(acme, chunked(bytes, 64 * 1024));
    const again = await store.put(acme, bytes);
    const streamedAgain = await store.put(acme, chunked(bytes, 7_777));
    expect(first).toMatchObject({ created: true, size: bytes.byteLength });
    expect(again).toEqual({ ...first, created: false });
    expect(streamedAgain).toEqual({ ...first, created: false });
    expect(await collect(await store.open(acme.id, first.blobId))).toEqual(new Uint8Array(bytes));
  });

  it("keeps tenants apart: same bytes, unrelated ids, no reading across", async () => {
    const bytes = text("the same contract in two tenants");
    const a = await store.put(acme, bytes);
    const g = await store.put(globex, bytes);
    expect(g.created).toBe(true);
    expect(g.blobId).not.toBe(a.blobId);
    await expect(store.read(globex.id, a.blobId)).rejects.toThrow(BlobNotFoundError);
    expect(await store.has(globex.id, a.blobId)).toBe(false);
  });

  it("stores empty content", async () => {
    const empty = await store.put(acme, new Uint8Array());
    expect(empty.size).toBe(0);
    expect(await store.read(acme.id, empty.blobId)).toEqual(new Uint8Array());
    const streamed = await store.put(acme, chunked(new Uint8Array(), 1));
    expect(streamed).toEqual({ ...empty, created: false });
  });

  it("reads ranges, clamped to the blob", async () => {
    const bytes = text("0123456789");
    const { blobId } = await store.put(acme, bytes);
    const range = (offset: number, length?: number) =>
      store.read(acme.id, blobId, length === undefined ? { offset } : { offset, length });
    expect(new TextDecoder().decode(await range(2, 3))).toBe("234");
    expect(new TextDecoder().decode(await range(7))).toBe("789");
    expect(new TextDecoder().decode(await range(8, 100))).toBe("89");
    expect(await range(4, 0)).toEqual(new Uint8Array());
    expect(await range(10)).toEqual(new Uint8Array());
    expect(await range(50, 5)).toEqual(new Uint8Array());
    await expect(range(-1, 2)).rejects.toThrow(RangeError);
    await expect(range(1, 1.5)).rejects.toThrow(RangeError);
    expect(await collect(await store.open(acme.id, blobId, { offset: 3, length: 4 }))).toEqual(
      text("3456"),
    );
    expect(await collect(await store.open(acme.id, blobId, { offset: 11 }))).toEqual(
      new Uint8Array(),
    );
  });

  it("streams a range that spans several read chunks", async () => {
    const bytes = randomBytes(9 * 1024 * 1024);
    const { blobId } = await store.put(acme, chunked(bytes, 1024 * 1024));
    const offset = 3 * 1024 * 1024 + 17;
    const length = 5 * 1024 * 1024 + 3;
    const got = await collect(await store.open(acme.id, blobId, { offset, length }));
    expect(Buffer.compare(got, bytes.subarray(offset, offset + length))).toBe(0);
    expect(await store.verify(acme, blobId)).toBe(true);
  });

  it("refuses content over the limit and leaves nothing behind", async () => {
    const bytes = randomBytes(10_000);
    await expect(store.put(acme, chunked(bytes, 1000), { maxBytes: 9_999 })).rejects.toThrow(
      BlobTooLargeError,
    );
    await expect(store.put(acme, bytes, { maxBytes: 9_999 })).rejects.toThrow(BlobTooLargeError);
    expect(await store.has(acme.id, scopedBlobId(acme.key, contentHash(bytes)))).toBe(false);
    const ok = await store.put(acme, chunked(bytes, 1000), { maxBytes: 10_000 });
    expect(ok.created).toBe(true);
  });

  it("cleans up when the source fails part-way", async () => {
    async function* failing() {
      yield text("half a file");
      throw new Error("connection reset");
    }
    await expect(store.put(acme, failing())).rejects.toThrow("connection reset");
    async function* notBytes() {
      yield "a string" as unknown as Uint8Array;
    }
    await expect(store.put(acme, notBytes())).rejects.toThrow("content chunks must be bytes");
  });

  it("stores concurrent uploads of the same bytes once", async () => {
    const bytes = randomBytes(200_000);
    const results = await Promise.all(
      [1, 2, 3].map((n) => store.put(globex, chunked(bytes, 10_000 * n))),
    );
    expect(new Set(results.map((r) => r.blobId)).size).toBe(1);
    expect(await store.read(globex.id, results[0]?.blobId ?? "")).toEqual(new Uint8Array(bytes));
  });

  it("deletes, and treats deleting a missing blob as done", async () => {
    const { blobId } = await store.put(acme, text("to be removed"));
    await store.delete(acme.id, blobId);
    expect(await store.has(acme.id, blobId)).toBe(false);
    expect(await store.size(acme.id, blobId)).toBeUndefined();
    await store.delete(acme.id, blobId);
    await expect(store.open(acme.id, blobId)).rejects.toThrow(BlobNotFoundError);
    await expect(store.verify(acme, blobId)).rejects.toThrow(BlobNotFoundError);
  });

  it("refuses a tenant key of the wrong size", async () => {
    await expect(store.put({ id: acme.id, key: new Uint8Array(16) }, text("x"))).rejects.toThrow(
      "tenant key must be 32 bytes",
    );
  });
});

describe("on local disk", () => {
  const root = mkdtempSync(join(tmpdir(), "openhoard-blobs-fs-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const store = BlobStore.open({ kind: "fs", root });
  const t = tenant("tenant-fs");

  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)).map((f) => `${e.name}/${f}`) : [e.name],
    );

  it("lays blobs out by tenant and id, with no uploads left in .incoming", async () => {
    const bytes = randomBytes(50_000);
    const { blobId } = await store.put(t, chunked(bytes, 4096));
    await store.put(t, chunked(bytes, 1000));
    async function* failing() {
      yield text("partial");
      throw new Error("boom");
    }
    await store.put(t, failing()).catch(() => {});
    const hex = blobId.slice(4);
    expect(files(join(root, t.id)).filter((f) => !f.startsWith(".incoming/"))).toEqual([
      `${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}`,
    ]);
    expect(files(join(root, t.id)).filter((f) => f.startsWith(".incoming/"))).toEqual([]);
  });

  it("leaves nothing in .incoming after refused or failed uploads", async () => {
    await store.put(t, chunked(randomBytes(5000), 100), { maxBytes: 1000 }).catch(() => {});
    await store.put(t, randomBytes(5000), { maxBytes: 1000 }).catch(() => {});
    async function* failing() {
      yield text("partial");
      throw new Error("boom");
    }
    await store.put(t, failing()).catch(() => {});
    const incoming = join(root, t.id, ".incoming");
    expect(existsSync(incoming) ? readdirSync(incoming) : []).toEqual([]);
  });

  it("replaces a damaged blob instead of trusting it", async () => {
    const bytes = text("a blob that gets truncated on disk");
    const { blobId } = await store.put(t, bytes);
    writeFileSync(join(root, blobPath(t.id, blobId)), bytes.subarray(0, 5));
    expect(await store.put(t, bytes)).toMatchObject({ blobId, created: true });
    expect(await store.verify(t, blobId)).toBe(true);
  });

  it("sweeps uploads a crashed process left in .incoming", async () => {
    const incoming = join(root, t.id, ".incoming");
    mkdirSync(incoming, { recursive: true });
    writeFileSync(join(incoming, "old"), "left by a crash");
    writeFileSync(join(incoming, "live"), "still uploading");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(join(incoming, "old"), twoDaysAgo, twoDaysAgo);
    expect(await store.sweepIncoming(t.id)).toBe(1);
    expect(readdirSync(incoming)).toEqual(["live"]);
    expect(await store.sweepIncoming(t.id, 0)).toBe(1);
    expect(await store.sweepIncoming("tenant-with-nothing")).toBe(0);
  });

  it("detects a blob changed on disk", async () => {
    const { blobId } = await store.put(t, text("original contents"));
    expect(await store.verify(t, blobId)).toBe(true);
    writeFileSync(join(root, blobPath(t.id, blobId)), "tampered contents");
    expect(await store.verify(t, blobId)).toBe(false);
  });
});

describe("services without rename", () => {
  const root = mkdtempSync(join(tmpdir(), "openhoard-blobs-copy-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("finish uploads with copy and delete, as S3 and Azure Blob do", async () => {
    const op = new Operator("fs", { root }).layer(
      new CapabilityOverrideLayer("rename=false").build(),
    );
    expect([op.capability().rename, op.capability().copy]).toEqual([false, true]);
    const store = new BlobStore(op);
    const t = tenant("tenant-copy");
    const bytes = randomBytes(20_000);
    const { blobId, created } = await store.put(t, chunked(bytes, 3000));
    expect(created).toBe(true);
    expect(await store.read(t.id, blobId)).toEqual(new Uint8Array(bytes));
    expect(readdirSync(join(root, t.id, ".incoming"))).toEqual([]);
  });
});

/** `op` with some methods replaced, for failures real services produce only occasionally. */
function patched(op: Operator, overrides: Record<string, unknown>): Operator {
  return new Proxy(op, {
    get(target, key) {
      if (typeof key === "string" && key in overrides) return overrides[key];
      const value = Reflect.get(target, key) as unknown;
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

describe("failures while storing", () => {
  it("a failed streamed move leaves no partial blob behind (services without rename or copy)", async () => {
    const memory = new Operator("memory", {});
    let failReads = true;
    const flaky = patched(memory, {
      reader: async (path: string) => {
        if (!failReads) return memory.reader(path);
        return {
          createReadStream: () =>
            Readable.from(
              (async function* () {
                yield Buffer.alloc(64 * 1024);
                throw new Error("read failed");
              })(),
            ),
        };
      },
    });
    const store = new BlobStore(flaky);
    const t = tenant("tenant-flaky");
    const bytes = randomBytes(1_000_000);
    await expect(store.put(t, bytes)).rejects.toThrow("read failed");
    const blobId = scopedBlobId(t.key, contentHash(bytes));
    expect(await store.has(t.id, blobId)).toBe(false);
    expect(await memory.list(`${t.id}/`)).toEqual([]);
    failReads = false;
    expect(await store.put(t, bytes)).toMatchObject({ blobId, created: true });
    expect(await store.verify(t, blobId)).toBe(true);
  });

  it("a copy that did not complete fails the upload and keeps no blob", async () => {
    const root = mkdtempSync(join(tmpdir(), "openhoard-blobs-copyfail-"));
    try {
      const op = new Operator("fs", { root }).layer(
        new CapabilityOverrideLayer("rename=false").build(),
      );
      // The copy reports success but the destination is not (yet) there, as with a pending
      // Azure copy.
      const store = new BlobStore(patched(op, { copy: () => Promise.resolve() }));
      const t = tenant("tenant-copyfail");
      await expect(store.put(t, text("pending copy"))).rejects.toThrow("copy did not complete");
      expect(readdirSync(join(root, t.id, ".incoming"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports the real failure when closing the upload fails too", async () => {
    const memory = new Operator("memory", {});
    const store = new BlobStore(
      patched(memory, {
        writer: async (path: string) => {
          const writer = await memory.writer(path);
          return {
            write: (b: Buffer) => writer.write(b),
            close: () => Promise.reject(new Error("close failed")),
          };
        },
      }),
    );
    await expect(
      store.put(tenant("tenant-close"), chunked(randomBytes(100), 10), { maxBytes: 50 }),
    ).rejects.toThrow(BlobTooLargeError);
  });

  it("refuses to guess a size the service does not report", async () => {
    const memory = new Operator("memory", {});
    const store = new BlobStore(
      patched(memory, { stat: () => Promise.resolve({ contentLength: null }) }),
    );
    await expect(store.size("t", `b3t:${"0".repeat(64)}`)).rejects.toThrow(
      "did not report the blob's size",
    );
  });
});

describe("blobPath", () => {
  const id = `b3t:${"ab".repeat(32)}`;
  it("nests by the first two bytes of the id", () => {
    expect(blobPath("ten_1", id)).toBe(`ten_1/ab/ab/${"ab".repeat(32)}`);
  });

  it.each([
    `b3:${"ab".repeat(32)}`, // a raw content hash must never become a path
    `b3t:${"AB".repeat(32)}`,
    `b3t:${"ab".repeat(31)}`,
    `b3t:../../${"ab".repeat(29)}`,
    `b3t:${"ab".repeat(32)}\n`,
    "",
  ])("refuses the blob id %j", (bad) => {
    expect(() => blobPath("ten_1", bad)).toThrow("expected a b3t: blob id");
  });

  it.each(["", "..", "../x", "a/b", "A", "-x", "x".repeat(65), "t\n"])(
    "refuses the tenant %j",
    (bad) => {
      expect(() => blobPath(bad, id)).toThrow("invalid tenant id for storage");
    },
  );
});

describe("operatorFor", () => {
  it("builds S3 and Azure Blob operators without contacting them", () => {
    const s3 = operatorFor({ kind: "s3", bucket: "b", region: "us-east-1", root: "/x" });
    expect(s3.capability().copy).toBe(true);
    const az = operatorFor({
      kind: "azblob",
      container: "c",
      accountName: "acct",
      accountKey: Buffer.from("k").toString("base64"),
      endpoint: "https://acct.blob.core.windows.net",
    });
    expect(az.capability().copy).toBe(true);
  });
});
