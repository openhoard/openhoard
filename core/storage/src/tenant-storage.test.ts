import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blobs, tenantStorage, type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant } from "@openhoard/core-db/testing";
import { eq } from "drizzle-orm";
import { startFakeS3 } from "./testing.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyStorageError, probeStorage } from "./probe.js";
import { openSecret, SealedSecretError, sealSecret } from "./secrets.js";
import { checkChoice, StorageChoiceError, type StorageChoice } from "./settings.js";
import { BlobStore, blobPath, type StorageConfig } from "./store.js";
import {
  changeTenantStorage,
  cleanTenantBlobs,
  moveTenantBlobs,
  restartMove,
  startCleaning,
  StorageBusyError,
  TenantBlobStores,
  tenantStorageOf,
  testConfig,
} from "./tenant-storage.js";

/* A tenant's own bucket: choosing it, sealing its key, putting and reading, moving, cleaning. */

const SEAL = randomBytes(32);
const KEY = randomBytes(32);
const S3: StorageChoice = {
  kind: "s3",
  bucket: "acme-hoard",
  region: "us-east-1",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "s3cr3t/Key+Value",
};

describe("sealed keys", () => {
  it("open only with the server's key, for the tenant and kind they were sealed for", () => {
    const sealed = sealSecret(SEAL, "openhoard-storage:ten_a:s3", "the-secret");
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain("the-secret");
    expect(openSecret(SEAL, "openhoard-storage:ten_a:s3", sealed)).toBe("the-secret");
    expect(() => openSecret(SEAL, "openhoard-storage:ten_b:s3", sealed)).toThrow(SealedSecretError);
    expect(() => openSecret(randomBytes(32), "openhoard-storage:ten_a:s3", sealed)).toThrow(
      SealedSecretError,
    );
    expect(() =>
      openSecret(SEAL, "openhoard-storage:ten_a:s3", `${sealed.slice(0, -2)}AA`),
    ).toThrow(SealedSecretError);
  });
});

describe("a storage choice", () => {
  const field = (input: unknown, rules = {}) => {
    try {
      checkChoice(input, rules);
      return null;
    } catch (e) {
      return e instanceof StorageChoiceError ? e.field : "other";
    }
  };

  it("takes a bucket as S3 and Azure name them, and a folder inside", () => {
    expect(checkChoice({ ...S3, prefix: "openhoard/blobs" })).toEqual({
      ...S3,
      prefix: "openhoard/blobs",
    });
    expect(
      checkChoice({
        kind: "azblob",
        accountName: "acmestore",
        container: "hoard-blobs",
        accountKey: Buffer.from("k".repeat(64)).toString("base64"),
      }),
    ).toMatchObject({ kind: "azblob", accountName: "acmestore", container: "hoard-blobs" });
    expect(checkChoice({ kind: "local" })).toEqual({ kind: "local" });
  });

  it("names the field it won't take", () => {
    expect(field({ ...S3, bucket: "Acme_Hoard" })).toBe("bucket");
    expect(field({ ...S3, bucket: "192.168.1.1" })).toBe("bucket");
    expect(field({ ...S3, region: "US East" })).toBe("region");
    expect(field({ ...S3, accessKeyId: "" })).toBe("accessKeyId");
    expect(field({ ...S3, secretAccessKey: "short" })).toBe("secretAccessKey");
    expect(field({ ...S3, prefix: "a/../b" })).toBe("prefix");
    expect(field({ ...S3, prefix: "/a/" })).toBe("prefix");
    expect(field({ kind: "azblob", accountName: "Acme", container: "c1c" })).toBe("accountName");
    expect(field({ kind: "azblob", accountName: "acme", container: "a--b" })).toBe("container");
    expect(field({ kind: "gcs" })).toBe("kind");
  });

  it("names a server to connect to only where whoever runs the server allows it", () => {
    expect(field({ ...S3, endpoint: "https://minio.internal:9000" })).toBe("endpoint");
    const allow = { allowEndpoints: true };
    expect(checkChoice({ ...S3, endpoint: "https://minio.internal:9000/" }, allow)).toMatchObject({
      endpoint: "https://minio.internal:9000",
    });
    expect(field({ ...S3, endpoint: "https://u:p@minio.internal" }, allow)).toBe("endpoint");
    expect(field({ ...S3, endpoint: "https://minio.internal/x?y" }, allow)).toBe("endpoint");
    expect(field({ ...S3, endpoint: "file:///etc" }, allow)).toBe("endpoint");
    // Azurite names the account in its path; nothing else may have one.
    const azurite = {
      kind: "azblob",
      accountName: "devstoreaccount1",
      container: "hoard",
      endpoint: "http://127.0.0.1:10000/devstoreaccount1/",
    };
    expect(checkChoice(azurite, allow)).toMatchObject({
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
    });
    expect(field({ ...azurite, endpoint: "http://127.0.0.1:10000/other" }, allow)).toBe("endpoint");
  });
});

describe("a store's errors, for an admin", () => {
  it("says what went wrong, with the service's own code", () => {
    expect(
      classifyStorageError(
        new Error(
          'NotFound (permanent) at write, context: { response: Parts { status: 404, headers: {"x-ms-error-code": "ContainerNotFound"} } }',
        ),
      ),
    ).toEqual({ problem: "not-found", code: "ContainerNotFound" });
    expect(
      classifyStorageError(
        new Error(
          "ConfigInvalid (permanent) at write, context: { response: Parts { status: 404 } } <Code>NoSuchBucket</Code>",
        ),
      ),
    ).toEqual({ problem: "not-found", code: "NoSuchBucket" });
    expect(
      classifyStorageError(
        new Error("PermissionDenied (permanent) at write, status: 403 <Code>AccessDenied</Code>"),
      ),
    ).toEqual({ problem: "denied", code: "AccessDenied" });
    expect(
      classifyStorageError(
        new Error(
          "Unexpected (temporary) at write => send http request, source: error sending request",
        ),
      ),
    ).toEqual({ problem: "unreachable" });
    expect(
      classifyStorageError(
        new Error("Unexpected (permanent) status: 301 <Code>PermanentRedirect</Code>"),
      ),
    ).toEqual({ problem: "wrong-region", code: "PermanentRedirect" });
  });

  it("writes, reads back and removes a probe in a place that works", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oh-probe-"));
    expect(await probeStorage({ kind: "fs", root: dir }, "ten_x")).toEqual({
      ok: true,
      steps: [
        { step: "check", ok: true },
        { step: "write", ok: true },
        { step: "read", ok: true },
        { step: "delete", ok: true },
      ],
    });
  });

  it("says a key Azure refuses is refused, not that it can't list", async () => {
    const azure = createServer((req, res) => {
      req.resume();
      res.writeHead(403, { "x-ms-error-code": "AuthenticationFailed" });
      res.end();
    });
    await new Promise<void>((done) => azure.listen(0, "127.0.0.1", done));
    try {
      const { port } = azure.address() as AddressInfo;
      const probe = await probeStorage(
        {
          kind: "azblob",
          container: "hoard",
          accountName: "acct",
          accountKey: Buffer.from("x".repeat(64)).toString("base64"),
          endpoint: `http://127.0.0.1:${port}/acct`,
        },
        "ten_x",
      );
      expect(probe).toMatchObject({ ok: false, steps: [{ step: "check", problem: "denied" }] });
    } finally {
      await new Promise((done) => azure.close(done));
    }
  });
});

describe("a tenant's storage", () => {
  let db: Database;
  let tenantId: string;
  const local = BlobStore.open({ kind: "memory" });
  const buckets = new Map<string, BlobStore>();
  /** Fake clouds: a memory store per bucket or container, and the keys each was opened with. */
  const opened: StorageConfig[] = [];
  const openStore = (config: StorageConfig) => {
    opened.push(config);
    const name =
      config.kind === "s3" ? config.bucket : config.kind === "azblob" ? config.container : "?";
    let store = buckets.get(name);
    if (!store) {
      store = BlobStore.open({ kind: "memory" });
      buckets.set(name, store);
    }
    return store;
  };
  const stores = () =>
    new TenantBlobStores({ db, local, sealKey: () => SEAL, openStore, ttlMs: 0 });
  const change = (choice: StorageChoice) =>
    db.withTenant(tenantId, (tx) =>
      changeTenantStorage(tx, tenantId, choice, { by: "user:usr_1", sealKey: SEAL }),
    );
  const view = () => db.withTenant(tenantId, (tx) => tenantStorageOf(tx, tenantId));
  /** A blob put the way uploads do, and recorded as one OpenHoard holds. */
  const keep = async (s: TenantBlobStores, text: string) => {
    const put = await s.put({ id: tenantId, key: KEY }, Buffer.from(text));
    await db.withTenant(tenantId, (tx) =>
      tx
        .insert(blobs)
        .values({
          tenantId,
          id: put.blobId,
          size: put.size,
          location: blobPath(tenantId, put.blobId),
        })
        .onConflictDoNothing(),
    );
    return put.blobId;
  };
  const text = async (s: TenantBlobStores, id: string) => {
    const chunks: Buffer[] = [];
    for await (const c of await s.open(tenantId, id)) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString();
  };

  // One database for the file, a fresh tenant for each test.
  let seeded = 0;
  beforeAll(async () => {
    db = await openTestDatabase();
  }, 60_000);
  beforeEach(async () => {
    tenantId = (await seedTenant(db, ++seeded)).tenantId;
    buckets.clear();
    opened.length = 0;
  }, 60_000);
  afterAll(() => db?.close());

  it("is the server's disk until its admin chooses a bucket, whose key is sealed", async () => {
    expect(await view()).toMatchObject({ kind: "local", phase: "active", previous: null });
    expect(await change({ kind: "local" })).toEqual({ outcome: "unchanged" });
    expect(await change(S3)).toEqual({ outcome: "moving", version: 1 });
    const [row] = await db.withTenant(tenantId, (tx) =>
      tx.select().from(tenantStorage).where(eq(tenantStorage.tenantId, tenantId)),
    );
    expect(row?.secret).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain("s3cr3t");
    expect(await view()).toMatchObject({
      kind: "s3",
      settings: { bucket: "acme-hoard", region: "us-east-1", accessKeyId: "AKIAEXAMPLE" },
      hasSecret: true,
      phase: "moving",
      previous: { kind: "local", settings: {} },
    });
    // One move at a time.
    await expect(change({ ...S3, bucket: "other-bucket" })).rejects.toBeInstanceOf(
      StorageBusyError,
    );
  });

  it("needs the key for a new place, and keeps the one it has for the same place", async () => {
    const { secretAccessKey: _, ...keyless } = S3 as Extract<StorageChoice, { kind: "s3" }>;
    await expect(change(keyless)).rejects.toMatchObject({ field: "secretAccessKey" });
    await change(S3);
    const s = stores();
    await moveTenantBlobs(db, s, { id: tenantId, key: KEY }, 1);
    expect(await change(keyless)).toEqual({ outcome: "unchanged" });
    expect(await change({ ...S3, secretAccessKey: "n3w-s3cr3t-key" })).toEqual({
      outcome: "rekeyed",
      version: 2,
    });
    // Tested with the key kept, when the admin doesn't type it again.
    const config = await db.withTenant(tenantId, (tx) =>
      testConfig(tx, tenantId, keyless, { sealKey: () => SEAL, local: { kind: "memory" } }),
    );
    expect(config).toMatchObject({
      kind: "s3",
      secretAccessKey: "n3w-s3cr3t-key",
      ambientCredentials: false,
    });
  });

  it("puts new blobs in the bucket at once, reads old ones from the disk, and moves them over", async () => {
    const s = stores();
    const old = await keep(s, "kept on the server's disk");
    await change(S3);
    const fresh = await keep(s, "put after the change");
    const bucket = buckets.get("acme-hoard") as BlobStore;
    expect(await bucket.has(tenantId, fresh)).toBe(true);
    expect(await local.has(tenantId, fresh)).toBe(false);
    // Not moved yet: read from where it was.
    expect(await text(s, old)).toBe("kept on the server's disk");
    // The bucket was reached with the tenant's key, and no other credentials.
    expect(opened.at(-1)).toMatchObject({
      secretAccessKey: "s3cr3t/Key+Value",
      ambientCredentials: false,
    });

    expect(await moveTenantBlobs(db, s, { id: tenantId, key: KEY }, 1)).toBe(true);
    expect(await bucket.has(tenantId, old)).toBe(true);
    expect(await view()).toMatchObject({ phase: "active", total: 2, done: 2, failed: 0 });
    // The old copies are kept until the admin removes them.
    expect(await local.has(tenantId, old)).toBe(true);
    await expect(change({ ...S3, bucket: "third-bucket" })).rejects.toMatchObject({
      reason: "old-copies",
    });

    const { version } = await db.withTenant(tenantId, (tx) =>
      startCleaning(tx, tenantId, "user:usr_1"),
    );
    expect(await cleanTenantBlobs(db, s, { id: tenantId, key: KEY }, version)).toBe(true);
    expect(await local.has(tenantId, old)).toBe(false);
    expect(await text(s, old)).toBe("kept on the server's disk");
    expect(await view()).toMatchObject({ phase: "active", previous: null });
  });

  it("copies over, when removing, a blob put where the move had already been", async () => {
    const s = stores();
    await change(S3);
    await moveTenantBlobs(db, s, { id: tenantId, key: KEY }, 1);
    // A server that hadn't seen the move yet put this on its disk.
    const late = await local.put({ id: tenantId, key: KEY }, Buffer.from("late"));
    await db.withTenant(tenantId, (tx) =>
      tx.insert(blobs).values({
        tenantId,
        id: late.blobId,
        size: late.size,
        location: blobPath(tenantId, late.blobId),
      }),
    );
    const { version } = await db.withTenant(tenantId, (tx) =>
      startCleaning(tx, tenantId, "user:usr_1"),
    );
    await cleanTenantBlobs(db, s, { id: tenantId, key: KEY }, version);
    expect(await buckets.get("acme-hoard")?.has(tenantId, late.blobId)).toBe(true);
    expect(await local.has(tenantId, late.blobId)).toBe(false);
  });

  it("counts a blob it can't copy, keeps the old place, and goes on when moved again", async () => {
    const s = stores();
    const flaky = await keep(s, "can't be read now");
    const fine = await keep(s, "fine");
    await change(S3);
    const open = local.open.bind(local);
    const spy = vi
      .spyOn(local, "open")
      .mockImplementation((tenant, id, range) =>
        id === flaky
          ? Promise.reject(
              new Error(
                "Unexpected (temporary) at read => send http request, source: /srv/data/blobs",
              ),
            )
          : open(tenant, id, range),
      );
    try {
      await moveTenantBlobs(db, s, { id: tenantId, key: KEY }, 1);
    } finally {
      spy.mockRestore();
    }
    const failed = await view();
    expect(failed).toMatchObject({ phase: "active", done: 1, failed: 1, lost: 0 });
    // Said in an admin's terms, never the store's own text (paths, addresses).
    expect(failed.lastError).toBe(`${flaky}: unreachable`);
    expect(await buckets.get("acme-hoard")?.has(tenantId, fine)).toBe(true);
    // Not removed while some didn't make it.
    await expect(
      db.withTenant(tenantId, (tx) => startCleaning(tx, tenantId, "user:usr_1")),
    ).rejects.toThrow(RangeError);
    const { version } = await db.withTenant(tenantId, (tx) =>
      restartMove(tx, tenantId, "user:usr_1"),
    );
    await moveTenantBlobs(db, s, { id: tenantId, key: KEY }, version);
    expect(await view()).toMatchObject({ phase: "active", done: 2, failed: 0 });
  });

  it("counts a blob in neither place as lost, and doesn't let it block the removal", async () => {
    const s = stores();
    const gone = await keep(s, "lost before the move");
    await keep(s, "fine");
    await change(S3);
    await local.delete(tenantId, gone);
    await moveTenantBlobs(db, s, { id: tenantId, key: KEY }, 1);
    expect(await view()).toMatchObject({ phase: "active", done: 1, failed: 0, lost: 1 });
    const { version } = await db.withTenant(tenantId, (tx) =>
      startCleaning(tx, tenantId, "user:usr_1"),
    );
    // Asked again while it runs (its job lost, say): the same removal, queued again.
    expect(
      await db.withTenant(tenantId, (tx) => startCleaning(tx, tenantId, "user:usr_1")),
    ).toEqual({ version });
    await cleanTenantBlobs(db, s, { id: tenantId, key: KEY }, version);
    expect(await view()).toMatchObject({ phase: "active", previous: null, lost: 1 });
  });

  it("removes nothing when the old and new places are the same storage", async () => {
    // The "bucket" is the server's own disk under another name.
    const same = new TenantBlobStores({
      db,
      local,
      sealKey: () => SEAL,
      openStore: () => local,
      ttlMs: 0,
    });
    const kept = await keep(same, "the only copy");
    await change(S3);
    await moveTenantBlobs(db, same, { id: tenantId, key: KEY }, 1);
    expect(await view()).toMatchObject({
      phase: "active",
      previous: null,
      lastError: "the old and new places are the same storage",
    });
    expect(await local.has(tenantId, kept)).toBe(true);
  });

  it("needs the secret again for another access key", async () => {
    const s = stores();
    await change(S3);
    await moveTenantBlobs(db, s, { id: tenantId, key: KEY }, 1);
    const { secretAccessKey: _, ...keyless } = S3 as Extract<StorageChoice, { kind: "s3" }>;
    await expect(change({ ...keyless, accessKeyId: "AKIAOTHERKEY" })).rejects.toMatchObject({
      field: "secretAccessKey",
    });
  });

  it("copies a blob put across a change of place to the new place too", async () => {
    const s = stores();
    async function* slowly() {
      yield Buffer.from("begun on the old place, ");
      // The admin changes the place while this is still being written.
      await change(S3);
      yield Buffer.from("finished after the change");
    }
    const put = await s.put({ id: tenantId, key: KEY }, slowly());
    expect(await local.has(tenantId, put.blobId)).toBe(true);
    expect(await buckets.get("acme-hoard")?.has(tenantId, put.blobId)).toBe(true);
  });

  it("stops a move whose choice changed under it", async () => {
    const s = stores();
    await keep(s, "x");
    await change(S3);
    const { version } = await db.withTenant(tenantId, (tx) =>
      restartMove(tx, tenantId, "user:usr_1"),
    );
    expect(version).toBe(2);
    expect(await moveTenantBlobs(db, s, { id: tenantId, key: KEY }, 1)).toBe(false);
    expect(await moveTenantBlobs(db, s, { id: tenantId, key: KEY }, 2)).toBe(true);
  });

  it("refuses a sealed key another server's key can't open", async () => {
    await change(S3);
    const other = new TenantBlobStores({
      db,
      local,
      sealKey: () => randomBytes(32),
      openStore,
      ttlMs: 0,
    });
    await expect(other.put({ id: tenantId, key: KEY }, Buffer.from("x"))).rejects.toBeInstanceOf(
      SealedSecretError,
    );
  });
});

describe("a tenant's bucket over S3's own protocol (a fake S3)", () => {
  it("is tried, kept, written to and moved to, with the tenant's key only", async () => {
    const s3 = await startFakeS3({ bucket: "acme-hoard", accessKeyId: "AKIAEXAMPLE" });
    const db = await openTestDatabase();
    try {
      const { tenantId } = await seedTenant(db, 1);
      const choice = checkChoice(
        { ...S3, endpoint: s3.endpoint, prefix: "openhoard" },
        { allowEndpoints: true },
      );
      const config = await db.withTenant(tenantId, (tx) =>
        testConfig(tx, tenantId, choice, { sealKey: () => SEAL, local: { kind: "memory" } }),
      );
      expect(await probeStorage(config as StorageConfig, tenantId)).toMatchObject({ ok: true });
      // A probe leaves nothing behind.
      expect(s3.objects.size).toBe(0);
      expect(
        await probeStorage(
          { ...(config as Extract<StorageConfig, { kind: "s3" }>), bucket: "nope" },
          tenantId,
        ),
      ).toEqual({
        ok: false,
        steps: [
          { step: "check", ok: true },
          { step: "write", ok: false, problem: "not-found", code: "NoSuchBucket" },
        ],
      });
      expect(
        await probeStorage(
          { ...(config as Extract<StorageConfig, { kind: "s3" }>), accessKeyId: "AKIAOTHER" },
          tenantId,
        ),
      ).toEqual({
        ok: false,
        steps: [{ step: "check", ok: false, problem: "cant-list" }],
      });
      // A key that can't list the bucket: every upload would fail on S3, so it doesn't pass.
      const noList = await startFakeS3({
        bucket: "acme-hoard",
        accessKeyId: "AKIAEXAMPLE",
        canList: false,
      });
      try {
        expect(
          await probeStorage(
            { ...(config as Extract<StorageConfig, { kind: "s3" }>), endpoint: noList.endpoint },
            tenantId,
          ),
        ).toEqual({ ok: false, steps: [{ step: "check", ok: false, problem: "cant-list" }] });
      } finally {
        await noList.close();
      }

      const disk = BlobStore.open({ kind: "memory" });
      const stores = new TenantBlobStores({ db, local: disk, sealKey: () => SEAL, ttlMs: 0 });
      const before = await disk.put({ id: tenantId, key: KEY }, Buffer.from("on the disk"));
      await db.withTenant(tenantId, (tx) =>
        tx.insert(blobs).values({
          tenantId,
          id: before.blobId,
          size: before.size,
          location: blobPath(tenantId, before.blobId),
        }),
      );
      await db.withTenant(tenantId, (tx) =>
        changeTenantStorage(tx, tenantId, choice, { by: "user:usr_1", sealKey: SEAL }),
      );
      const after = await stores.put({ id: tenantId, key: KEY }, Buffer.from("in the bucket"));
      expect([...s3.objects.keys()]).toEqual([`openhoard/${blobPath(tenantId, after.blobId)}`]);
      expect(await moveTenantBlobs(db, stores, { id: tenantId, key: KEY }, 1)).toBe(true);
      expect(s3.objects.has(`openhoard/${blobPath(tenantId, before.blobId)}`)).toBe(true);
      const read = await stores.open(tenantId, before.blobId);
      const chunks: Buffer[] = [];
      for await (const c of read) chunks.push(c as Buffer);
      expect(Buffer.concat(chunks).toString()).toBe("on the disk");
    } finally {
      await db.close();
      await s3.close();
    }
  }, 60_000);
});
