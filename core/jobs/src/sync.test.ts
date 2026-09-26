import { mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  contentRef,
  readExtract,
  type ContentSource,
  type IngestResult,
} from "@openhoard/core-catalog";
import { fsConnector } from "@openhoard/connector-fs";
import {
  activityEvents,
  newId,
  objects,
  sourceRefs,
  sourceSyncs,
  versions,
  zones,
  type Database,
} from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import {
  permanentError,
  throttledError,
  type Connector,
  type ConnectorDescription,
  type SourceItem,
  type SyncEvent,
} from "@openhoard/sdk";
import { memorySource, type MemorySource } from "@openhoard/sdk/testing";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectorContentSource, firstOf } from "./connector-content.js";
import { needsEnrichment } from "./enrich.js";
import { QUEUES, startJobs, type Jobs } from "./jobs.js";
import { acceptSourceIdentity, confirmReconcile, listSourceSyncs } from "./sync-admin.js";
import { runSync, type SyncOptions } from "./sync.js";

/*
 * T-301's sync runner, end to end on the database (PGlite, and PostgreSQL with
 * OPENHOARD_TEST_POSTGRES_URL): the fs connector over a temporary folder into the seeded
 * tenant's indexed zone, and the SDK's in-memory source for the faults a folder can't produce.
 */

const KEY = new Uint8Array(32).fill(7);
const SOURCE = "fs-test";
const enc = new TextEncoder();

let db: Database;
let t: SeededTenant;
let base: string;
let root: string;
let stateDir: string;
/** What the runner asked to enqueue, in order. */
let enqueued: Pick<IngestResult, "versionId" | "created" | "renamed">[];
const started: Jobs[] = [];

beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  base = await mkdtemp(join(tmpdir(), "openhoard-sync-"));
  root = join(base, "root");
  stateDir = join(base, "state");
  await mkdir(root);
  enqueued = [];
  clock = Math.floor(Date.now() / 1000) - 86_400;
});
afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop({ timeoutMs: 1_000 });
  await db?.close();
  await rm(base, { recursive: true, force: true, maxRetries: 5 });
});

let clock = 0;
/** Writes a file under the root, each write a later modification time than the last. */
async function put(path: string[], text: string) {
  const file = join(root, ...path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  clock += 2;
  await utimes(file, clock, clock);
}

const folder = (more: { checkpointEvery?: number } = {}) =>
  fsConnector({ root, stateDir, checkpointEvery: more.checkpointEvery ?? 3 });

function sync(connector: Connector, more: Partial<SyncOptions> = {}) {
  return runSync(db, {
    tenantId: t.tenantId,
    source: SOURCE,
    zoneId: t.zoneId,
    connector,
    ownerId: `user:${t.userId}`,
    tenantKey: () => KEY,
    enqueue: async (_tenantId, result) => {
      enqueued.push(result);
    },
    sleep: async () => {},
    ...more,
  });
}

/** The source's objects, by title: whether deleted, how many versions, the url kept. */
async function catalog(source = SOURCE) {
  return db.withTenant(t.tenantId, async (tx) => {
    const rows = await tx
      .select({
        externalId: sourceRefs.externalId,
        objectId: objects.id,
        title: objects.title,
        deleted: objects.deletedAt,
        url: sourceRefs.url,
      })
      .from(sourceRefs)
      .innerJoin(
        objects,
        and(eq(objects.tenantId, sourceRefs.tenantId), eq(objects.id, sourceRefs.objectId)),
      )
      .where(eq(sourceRefs.source, source))
      .orderBy(asc(objects.title));
    const out = [];
    for (const r of rows) {
      const [n] = await tx
        .select({ n: count() })
        .from(versions)
        .where(eq(versions.objectId, r.objectId));
      out.push({ ...r, deleted: r.deleted !== null, versions: Number(n?.n) });
    }
    return out;
  });
}

async function syncState(source = SOURCE) {
  const [row] = await db.withTenant(t.tenantId, (tx) =>
    tx.select().from(sourceSyncs).where(eq(sourceSyncs.source, source)),
  );
  return row;
}

/** A connector whose reads are counted. */
function counting(connector: Connector) {
  const reads: string[] = [];
  const wrapped: Connector = {
    ...connector,
    read: (ref, signal) => {
      reads.push(ref.externalId);
      return connector.read(ref, signal);
    },
  };
  return { connector: wrapped, reads };
}

describe("runSync with the fs connector", () => {
  it("records a folder's files, then follows deltas and skips what didn't change", async () => {
    await put(["Plan.md"], "# plan\n");
    await put(["Finance", "Budget.csv"], "a,b\n1,2\n");
    await put(["Finance", "Old", "2025.csv"], "x\n");
    const first = await sync(folder());
    expect(first).toMatchObject({
      status: "done",
      phase: "crawl",
      counts: { files: 3, folders: 2, ingested: 3, unchanged: 0, skipped: 0, reconciled: 0 },
    });
    expect((await catalog()).map((r) => [r.title, r.deleted, r.versions])).toEqual([
      ["2025.csv", false, 1],
      ["Budget.csv", false, 1],
      ["Plan.md", false, 1],
    ]);
    expect(enqueued.filter(needsEnrichment)).toHaveLength(3);
    expect(await syncState()).toMatchObject({
      phase: "delta",
      reconcileFrom: null,
      connector: "connector-fs",
    });
    // The seeded tenant's other source is untouched.
    expect(await catalog("sharepoint")).toHaveLength(1);

    const again = await sync(folder());
    expect(again).toMatchObject({
      status: "done",
      phase: "delta",
      counts: { files: 0, ingested: 0 },
    });
    expect(enqueued).toHaveLength(3);
  });

  it("records edits as versions, renames and moves without reading again, deletes softly", async () => {
    await put(["Plan.md"], "# plan\n");
    await put(["Notes.txt"], "notes\n");
    await put(["Gone.txt"], "bye\n");
    await put(["Docs", "Spec.md"], "spec\n");
    await sync(folder());
    const before = await catalog();
    enqueued = [];

    await put(["Plan.md"], "# plan, version 2\n");
    await rename(join(root, "Notes.txt"), join(root, "Notes (final).txt"));
    await rename(join(root, "Docs"), join(root, "Documents"));
    await rm(join(root, "Gone.txt"));
    const { connector, reads } = counting(folder());
    const report = await sync(connector);
    expect(report).toMatchObject({
      status: "done",
      phase: "delta",
      counts: { deleted: 1, skipped: 0 },
    });

    const after = await catalog();
    const at = (title: string) => after.find((r) => r.title === title);
    expect(at("Plan.md")).toMatchObject({ versions: 2, deleted: false });
    expect(at("Gone.txt")).toMatchObject({ deleted: true });
    // Same objects: renamed and moved, never deleted and made again.
    expect(at("Notes (final).txt")?.objectId).toBe(
      before.find((r) => r.title === "Notes.txt")?.objectId,
    );
    expect(at("Spec.md")?.objectId).toBe(before.find((r) => r.title === "Spec.md")?.objectId);
    expect(at("Spec.md")?.url).toMatch(/Documents\/Spec\.md$/);
    expect(after.filter((r) => !r.deleted)).toHaveLength(3);
    // The edited file's bytes are read; a file whose folder moved isn't. (A renamed file may
    // be: a rename changes its change time, part of its content version, on most systems.)
    expect(reads).toContain(at("Plan.md")?.externalId);
    expect(reads).not.toContain(at("Spec.md")?.externalId);
    // The new version and the rename go to enrichment; the move changes neither.
    expect(enqueued.filter(needsEnrichment)).toHaveLength(2);
  });

  it("resumes a killed crawl from its last checkpoint without duplicates", async () => {
    for (let i = 0; i < 10; i++) await put([`file-${i}.txt`], `file ${i}\n`);
    const controller = new AbortController();
    const crawls: (string | null)[] = [];
    const watched = (): Connector => {
      const c = folder();
      return {
        ...c,
        crawl: (checkpoint, signal) => {
          crawls.push(checkpoint);
          return c.crawl(checkpoint, signal);
        },
      };
    };
    const killed = await sync(watched(), {
      signal: controller.signal,
      enqueue: async (_t, r) => {
        enqueued.push(r);
        if (enqueued.length === 5) controller.abort();
      },
    });
    expect(killed.status).toBe("cancelled");
    const saved = await syncState();
    expect(saved?.phase).toBe("crawl");
    expect(saved?.token).toMatch(/^fs1c\./);

    const resumed = await sync(watched());
    expect(resumed).toMatchObject({ status: "done", phase: "crawl" });
    expect(crawls).toEqual([null, saved?.token]);
    const rows = await catalog();
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.versions === 1 && !r.deleted)).toBe(true);
    expect(await sync(folder())).toMatchObject({
      status: "done",
      phase: "delta",
      counts: { files: 0 },
    });
  });

  it("retries a transaction that deadlocked, and ingests each item once", async () => {
    for (let i = 0; i < 6; i++) await put([`file-${i}.txt`], `file ${i}\n`);
    let calls = 0;
    let deadlocks = 0;
    // Every third transaction does its work, then fails as a deadlock would: rolled back.
    const flaky: Database = {
      kind: db.kind,
      tenantIds: (o) => db.tenantIds(o),
      close: () => db.close(),
      withTenant: (tenantId, work, config) =>
        db.withTenant(
          tenantId,
          async (tx) => {
            const result = await work(tx);
            if (++calls % 3 === 0) {
              deadlocks++;
              throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
            }
            return result;
          },
          config,
        ),
    };
    const report = await runSync(flaky, {
      tenantId: t.tenantId,
      source: SOURCE,
      zoneId: t.zoneId,
      connector: folder(),
      ownerId: `user:${t.userId}`,
      tenantKey: () => KEY,
      enqueue: async (_t, r) => {
        enqueued.push(r);
      },
      sleep: async () => {},
    });
    expect(deadlocks).toBeGreaterThan(3);
    expect(report).toMatchObject({ status: "done", counts: { ingested: 6, skipped: 0 } });
    const rows = await catalog();
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.versions === 1)).toBe(true);
    // Enqueued once per item, after the commit that stood.
    expect(new Set(enqueued.map((r) => r.versionId)).size).toBe(6);
    expect(enqueued).toHaveLength(6);
  });

  it("crawls again when its state is lost, and removes what that crawl didn't find", async () => {
    await put(["Keep.txt"], "keep\n");
    await put(["Drop.txt"], "drop\n");
    await sync(folder());
    const kept = (await catalog()).find((r) => r.title === "Keep.txt");
    await rm(join(root, "Drop.txt"));
    await rm(stateDir, { recursive: true });

    const report = await sync(folder());
    expect(report).toMatchObject({
      status: "done",
      phase: "crawl",
      counts: { reconciled: 1, deleted: 0 },
    });
    const rows = await catalog();
    expect(rows.find((r) => r.title === "Drop.txt")?.deleted).toBe(true);
    // Inode ids survive the lost state: the same object, not a new one.
    expect(rows.find((r) => r.title === "Keep.txt")).toMatchObject({
      objectId: kept?.objectId,
      deleted: false,
    });
    expect(await syncState()).toMatchObject({ phase: "delta", reconcileFrom: null });
  });

  it("finishes a reconcile a run stopped before", async () => {
    await put(["Keep.txt"], "keep\n");
    await put(["Drop.txt"], "drop\n");
    await sync(folder());
    const drop = (await catalog()).find((r) => r.title === "Drop.txt");
    await rm(join(root, "Drop.txt"));
    // As if a crawl from the beginning reached `done` (its cursor saved) and the run died: it
    // began 30 s ago, and saw everything but Drop.txt.
    await db.withTenant(t.tenantId, async (tx) => {
      await tx
        .update(sourceRefs)
        .set({ syncedAt: sql`now() - interval '60 seconds'` })
        .where(eq(sourceRefs.externalId, drop?.externalId as string));
      await tx.update(sourceSyncs).set({ reconcileFrom: sql`now() - interval '30 seconds'` });
    });
    await put(["Keep.txt"], "keep, touched\n");
    const report = await sync(folder());
    expect(report).toMatchObject({ status: "done", phase: "delta", counts: { reconciled: 1 } });
    expect((await catalog()).find((r) => r.title === "Keep.txt")?.deleted).toBe(false);
  });

  it("refuses a source bound to another zone or connector, or a zone the connector can't serve", async () => {
    await put(["a.txt"], "a\n");
    await sync(folder());
    const managed = newId("zone");
    const laptop = newId("zone");
    const other = newId("zone");
    await db.withTenant(t.tenantId, (tx) =>
      tx.insert(zones).values([
        { tenantId: t.tenantId, id: managed, kind: "managed", name: "Managed" },
        { tenantId: t.tenantId, id: laptop, kind: "local-only", name: "Laptop" },
        { tenantId: t.tenantId, id: other, kind: "indexed", name: "Other" },
      ]),
    );
    expect(await sync(folder(), { zoneId: other })).toMatchObject({
      status: "failed",
      error: "zone-mismatch",
    });
    expect(await sync(folder(), { zoneId: managed })).toMatchObject({
      status: "failed",
      error: "zone-kind",
    });
    // The memory connector declares managed zones; this runner still won't sync one, nor a
    // local-only zone, whose content must not reach the server.
    for (const zoneId of [managed, laptop]) {
      expect(await sync(memorySource().connector, { source: "mem-z", zoneId })).toMatchObject({
        status: "failed",
        error: "zone-kind",
      });
    }
    expect(await sync(folder(), { zoneId: newId("zone") })).toMatchObject({
      status: "failed",
      error: "unknown-zone",
    });
    const mem = memorySource();
    expect(await sync(mem.connector)).toMatchObject({
      status: "failed",
      error: "connector-mismatch",
    });
    const broken = {
      ...folder(),
      describe: () => ({ apiVersion: 2 }) as unknown as ConnectorDescription,
    };
    expect(await sync(broken, { source: "broken" })).toMatchObject({
      status: "failed",
      error: "invalid-connector",
    });
    await expect(sync(folder(), { source: "Not A Slug" })).rejects.toThrow(TypeError);
    await expect(sync(folder(), { tenantId: "nope" })).rejects.toThrow(TypeError);
  });

  it("records an edit by the author the source names, when mapped to a user", async () => {
    const mem = memorySource();
    await mem.write(["a.txt"], enc.encode("a"));
    const author: Connector = {
      ...mem.connector,
      crawl: async function* (checkpoint, signal) {
        for await (const e of mem.connector.crawl(checkpoint, signal)) {
          yield e.type === "item"
            ? {
                ...e,
                item: { ...e.item, modifiedAt: "2026-09-01T10:00:00Z", modifiedBy: { id: "ann" } },
              }
            : e;
        }
      },
    };
    await sync(author, {
      source: "mem",
      authorOf: (u) => (u.id === "ann" ? `user:${t.userId}` : undefined),
    });
    const edits = await db.withTenant(t.tenantId, (tx) => tx.select().from(activityEvents));
    expect(edits).toMatchObject([{ type: "edit", actor: `user:${t.userId}`, origin: "mem" }]);
  });
});

describe("runSync with a source that misbehaves", () => {
  async function seeded(n = 7): Promise<MemorySource> {
    const mem = memorySource({ checkpointEvery: 2 });
    for (let i = 0; i < n; i++) await mem.write([`f${i}.txt`], enc.encode(`file ${i}`));
    return mem;
  }
  const memSync = (connector: Connector, more: Partial<SyncOptions> = {}) =>
    sync(connector, { source: "mem", ...more });

  it("records a rename without reading when the content version stays, and restores an item that comes back", async () => {
    const mem = await seeded(2);
    await memSync(mem.connector);
    const { connector, reads } = counting(mem.connector);
    await mem.move(["f0.txt"], ["renamed.txt"]);
    const renamed = await memSync(connector);
    expect(renamed).toMatchObject({ status: "done", phase: "delta", counts: { ingested: 1 } });
    expect(reads).toEqual([]);
    const row = (await catalog("mem")).find((r) => r.title === "renamed.txt");
    expect(row?.versions).toBe(1);

    // The source deletes it, then brings it back under the same id (a recycle bin's restore).
    const items: SourceItem[] = [];
    for await (const e of mem.connector.crawl(null, new AbortController().signal)) {
      if (e.type === "item") items.push(e.item);
    }
    const item = items.find((i) => i.externalId === row?.externalId) as SourceItem;
    const script: SyncEvent[][] = [
      [
        { type: "deleted", externalId: item.externalId },
        { type: "done", cursor: "delta:1" },
      ],
      [
        { type: "item", item },
        { type: "done", cursor: "delta:1" },
      ],
    ];
    const scripted: Connector = {
      ...mem.connector,
      delta: async function* () {
        yield* script.shift() ?? [];
      },
    };
    expect(await memSync(scripted)).toMatchObject({ counts: { deleted: 1 } });
    expect((await catalog("mem")).find((r) => r.objectId === row?.objectId)?.deleted).toBe(true);
    expect(await memSync(scripted)).toMatchObject({ counts: { ingested: 1 } });
    expect((await catalog("mem")).find((r) => r.objectId === row?.objectId)).toMatchObject({
      deleted: false,
      versions: 1,
    });
  });

  it("stops for a throttle, keeps its checkpoint, and resumes after it", async () => {
    const mem = await seeded();
    mem.fault("throttled", { afterEvents: 5 });
    const throttled = await memSync(mem.connector);
    expect(throttled).toMatchObject({ status: "retry", error: "throttled", retryAfterMs: 1_500 });
    expect((await syncState("mem"))?.token).toMatch(/^crawl:/);
    const resumed = await memSync(mem.connector);
    expect(resumed).toMatchObject({ status: "done" });
    expect(await catalog("mem")).toHaveLength(7);
  });

  it("waits in place for a short throttle on a read, and stops for a long one", async () => {
    const mem = await seeded(2);
    const waits: number[] = [];
    const flaky = (after: number): Connector => {
      let reads = 0;
      return {
        ...mem.connector,
        read: async (ref, signal) => {
          if (++reads <= after) throw throttledError(50);
          return mem.connector.read(ref, signal);
        },
      };
    };
    const report = await memSync(flaky(2), {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(report).toMatchObject({ status: "done", counts: { ingested: 2 } });
    expect(waits.filter((w) => w === 50)).toHaveLength(2);
    const stopped = await memSync(flaky(10), { source: "mem-2" });
    expect(stopped).toMatchObject({ status: "retry", error: "throttled" });
  });

  it("fails on refused credentials, and says so", async () => {
    const mem = await seeded(1);
    mem.fault("auth");
    expect(await memSync(mem.connector)).toMatchObject({ status: "failed", error: "auth" });
  });

  it("crawls again once when the connector refuses its cursor", async () => {
    const mem = await seeded(3);
    await memSync(mem.connector);
    await mem.remove(["f1.txt"]);
    await mem.close(); // forgets its copies: the cursor is refused
    const report = await memSync(mem.connector);
    expect(report).toMatchObject({ status: "done", phase: "crawl", counts: { reconciled: 1 } });
  });

  it("crawls and reconciles every time when the connector has no delta", async () => {
    const mem = await seeded(3);
    const d = mem.connector.describe();
    const noDelta: Connector = {
      describe: () => ({ ...d, capabilities: { ...d.capabilities, delta: false } }),
      crawl: mem.connector.crawl,
      read: mem.connector.read,
    };
    await memSync(noDelta);
    await mem.remove(["f2.txt"]);
    const report = await memSync(noDelta);
    expect(report).toMatchObject({
      status: "done",
      phase: "crawl",
      counts: { reconciled: 1, ingested: 2 },
    });
  });

  it("skips what the connector gets wrong, and reports it", async () => {
    const mem = await seeded(4);
    const items: SourceItem[] = [];
    for await (const e of mem.connector.crawl(null, new AbortController().signal)) {
      if (e.type === "item") items.push(e.item);
    }
    const [a, b, c, d] = items as [SourceItem, SourceItem, SourceItem, SourceItem];
    const wrong: Connector = {
      ...mem.connector,
      crawl: async function* () {
        yield { type: "item", item: { ...a, size: -1 } }; // invalid
        yield { type: "item", item: b }; // its read lies about the size
        yield { type: "item", item: c }; // its read is refused
        yield { type: "item", item: d }; // fine
        yield { type: "deleted", externalId: "never-seen" };
        yield { type: "done", cursor: "delta:1" };
      },
      read: async (ref, signal) => {
        if (ref.externalId === b.externalId) {
          const r = await mem.connector.read(ref, signal);
          return { ...r, size: r.size + 1 };
        }
        if (ref.externalId === c.externalId) throw permanentError("unreadable");
        return mem.connector.read(ref, signal);
      },
    };
    const report = await memSync(wrong);
    expect(report).toMatchObject({
      status: "done",
      counts: { files: 3, ingested: 1, skipped: 3, deleted: 0 },
    });
    expect(report.skipped).toEqual([
      { externalId: a.externalId, reason: "invalid" },
      { externalId: b.externalId, reason: "changed" },
      { externalId: c.externalId, reason: "permanent" },
    ]);
  });

  it("stops on a bad token, a stream without done, or a connector that throws anything", async () => {
    const mem = await seeded(1);
    const stream = (events: unknown[], thrown?: unknown): Connector => ({
      ...mem.connector,
      crawl: async function* () {
        for (const e of events) yield e as SyncEvent;
        if (thrown !== undefined) throw thrown;
      },
    });
    expect(await memSync(stream([{ type: "checkpoint", token: "" }]))).toMatchObject({
      status: "failed",
      error: "invalid-token",
    });
    expect(await memSync(stream([]), { source: "mem-2" })).toMatchObject({
      status: "retry",
      error: "incomplete",
    });
    expect(await memSync(stream([], new Error("bug")), { source: "mem-3" })).toMatchObject({
      status: "retry",
      error: "retryable",
    });
    const noDescription: Connector = {
      ...mem.connector,
      describe: () => {
        throw new Error("bug");
      },
    };
    expect(await memSync(noDescription, { source: "mem-4" })).toMatchObject({
      status: "failed",
      error: "invalid-connector",
    });
    const notAStream: Connector = {
      ...mem.connector,
      crawl: () => {
        throw new Error("bug");
      },
    };
    expect(await memSync(notAStream, { source: "mem-5" })).toMatchObject({
      status: "retry",
      error: "retryable",
    });
  });

  it("stops at a checkpoint when its time is up, and goes on from there", async () => {
    const mem = await seeded(6);
    const partial = await memSync(mem.connector, { budgetMs: 0 });
    expect(partial).toMatchObject({ status: "partial", counts: { ingested: 2 } });
    const rest = await memSync(mem.connector);
    expect(rest).toMatchObject({ status: "done" });
    expect(await catalog("mem")).toHaveLength(6);
  });

  it("refuses to run inside a transaction", async () => {
    const mem = await seeded(1);
    await expect(db.withTenant(t.tenantId, () => memSync(mem.connector))).rejects.toThrow(
      /withTenant/,
    );
  });
});

describe("reading indexed zones through connectors", () => {
  it("reads a version's exact bytes, refuses changed ones, and says which source is stale", async () => {
    await put(["Report.md"], "# Q3\nnumbers\n");
    await sync(folder());
    const [row] = await catalog();
    const [version] = await db.withTenant(t.tenantId, (tx) =>
      tx
        .select({ id: versions.id })
        .from(versions)
        .where(eq(versions.objectId, row?.objectId as string)),
    );
    const ref = await db.withTenant(t.tenantId, (tx) =>
      contentRef(tx, t.tenantId, version?.id as string),
    );
    if (!ref) throw new Error("no content ref");
    const stale: string[] = [];
    const connector = folder();
    const source = connectorContentSource({
      db,
      connectorFor: (_tenant, s) => (s === SOURCE ? connector : undefined),
      tenantKey: () => KEY,
      onStale: (_tenant, s) => stale.push(s),
    });
    const read = async (src: ContentSource) => {
      const stream = await src.open(ref, new AbortController().signal);
      if (!stream) return null;
      const chunks: Uint8Array[] = [];
      for await (const c of stream) chunks.push(c);
      return Buffer.concat(chunks).toString();
    };
    expect(await read(source)).toBe("# Q3\nnumbers\n");
    expect(await read(firstOf({ open: async () => null }, source))).toBe("# Q3\nnumbers\n");

    // Changed at the source since the crawl: refused, and the source is flagged for a sync.
    await put(["Report.md"], "# Q4\nnew numbers\n");
    await expect(read(source)).rejects.toMatchObject({ code: "changed" });
    expect(stale).toEqual([SOURCE]);

    // Not this source's: another connector, OpenHoard's own bytes, or a deleted object.
    const none = connectorContentSource({ db, connectorFor: () => undefined });
    expect(await read(none)).toBeNull();
    expect(
      await source.open({ ...ref, location: "stored" }, new AbortController().signal),
    ).toBeNull();
    await rm(join(root, "Report.md"));
    await sync(folder());
    expect(await read(source)).toBeNull();
  });

  it("refuses bytes that aren't the version's", async () => {
    await put(["a.txt"], "right");
    await sync(folder());
    const [row] = await catalog();
    const [version] = await db.withTenant(t.tenantId, (tx) =>
      tx
        .select({ id: versions.id })
        .from(versions)
        .where(eq(versions.objectId, row?.objectId as string)),
    );
    const ref = await db.withTenant(t.tenantId, (tx) =>
      contentRef(tx, t.tenantId, version?.id as string),
    );
    if (!ref) throw new Error("no content ref");
    const lying = (bytes: string, size = bytes.length): Connector => ({
      ...folder(),
      read: async (r) => ({
        contentVersion: r.contentVersion as string,
        size,
        body: (async function* () {
          yield enc.encode(bytes);
        })(),
      }),
    });
    const open = (c: Connector, key?: Uint8Array) =>
      connectorContentSource({
        db,
        connectorFor: () => c,
        ...(key ? { tenantKey: () => key } : {}),
      }).open(ref, new AbortController().signal);
    const drain = async (s: AsyncIterable<Uint8Array> | null) => {
      for await (const c of s ?? []) void c;
    };
    await expect(drain(await open(lying("wrong"), KEY))).rejects.toThrow(/not the version's/);
    await expect(drain(await open(lying("longer!", 5)))).rejects.toThrow(/more bytes/);
    await expect(drain(await open(lying("shrt", 5)))).rejects.toThrow(/fewer bytes/);
    await expect(open(lying("right", 4))).rejects.toMatchObject({ code: "changed" });
    // Without the key only the size is checked.
    await drain(await open(lying("wrong")));
  });

  it("feeds enrichment: a sync enqueues, and extraction reads the indexed zone's bytes", async () => {
    await put(["Notes.md"], "# Hello\nfrom the folder\n");
    const connector = folder();
    const jobs = await startJobs(db, {
      pollingIntervalSeconds: 0.5,
      maintenance: false,
      content: connectorContentSource({ db, connectorFor: () => connector, tenantKey: () => KEY }),
      extract: { indexedZones: true },
    });
    started.push(jobs);
    const report = await sync(connector, {
      enqueue: (tenantId, r) => jobs.enqueueAfterIngest(tenantId, r),
    });
    expect(report.status).toBe("done");
    const [row] = await catalog();
    const [version] = await db.withTenant(t.tenantId, (tx) =>
      tx
        .select({ id: versions.id })
        .from(versions)
        .where(eq(versions.objectId, row?.objectId as string)),
    );
    const deadline = Date.now() + 25_000;
    let extract = null;
    while (extract?.status !== "extracted" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      extract = await db.withTenant(t.tenantId, (tx) =>
        readExtract(tx, t.tenantId, version?.id as string),
      );
    }
    expect(extract).toMatchObject({ status: "extracted", kind: "markdown" });
    expect(extract?.text).toContain("from the folder");
    const jobsFor = await jobs.boss.findJobs<unknown>(QUEUES.enrich, {
      data: { tenantId: t.tenantId },
    });
    expect(jobsFor.length).toBeGreaterThan(0);
    // The folder itself is untouched.
    expect(await readFile(join(root, "Notes.md"), "utf8")).toBe("# Hello\nfrom the folder\n");
  });
});

describe("runSync's safeguards", () => {
  const admin = <T>(
    work: (tx: Parameters<Parameters<Database["withTenant"]>[1]>[0]) => Promise<T>,
  ) => db.withTenant(t.tenantId, work);
  const live = async (source = SOURCE) => (await catalog(source)).filter((r) => !r.deleted);

  it("holds a reconcile that would empty the source until an admin confirms it", async () => {
    for (let i = 0; i < 60; i++) await put([`file-${i}.txt`], `file ${i}\n`);
    await sync(folder({ checkpointEvery: 20 }));
    expect(await live()).toHaveLength(60);
    // The folder looks empty and the connector's state is gone: a crawl from the beginning
    // reaches `done` having seen nothing.
    for (let i = 0; i < 60; i++) await rm(join(root, `file-${i}.txt`));
    await rm(stateDir, { recursive: true });

    const held = await sync(folder());
    expect(held).toMatchObject({
      status: "failed",
      error: "reconcile-guard",
      reconcileHeld: 60,
      counts: { reconciled: 0 },
    });
    expect(await live()).toHaveLength(60);
    expect(await syncState()).toMatchObject({ reconcileHeld: 60, reconcileConfirmed: null });
    // Every run holds it again, and says so.
    expect(await sync(folder())).toMatchObject({ status: "failed", error: "reconcile-guard" });

    expect((await admin((tx) => listSourceSyncs(tx, t.tenantId)))[0]).toMatchObject({
      source: SOURCE,
      reconciling: true,
      reconcileHeld: 60,
    });
    expect(await admin((tx) => confirmReconcile(tx, t.tenantId, SOURCE))).toBe(60);
    expect(await admin((tx) => confirmReconcile(tx, t.tenantId, "nope"))).toBeNull();
    const confirmed = await sync(folder());
    expect(confirmed).toMatchObject({ status: "done", counts: { reconciled: 60 } });
    expect(await live()).toHaveLength(0);
    expect(await syncState()).toMatchObject({
      reconcileFrom: null,
      reconcileHeld: null,
      reconcileConfirmed: null,
    });
  });

  it("holds any removal when the crawl mentioned nothing, however small the source", async () => {
    const mem = memorySource();
    for (let i = 0; i < 3; i++) await mem.write([`f${i}.txt`], enc.encode(`${i}`));
    await sync(mem.connector, { source: "mem" });
    // A connector that says `done` before anything else.
    const early: Connector = {
      ...mem.connector,
      crawl: async function* () {
        yield { type: "done", cursor: "delta:1" };
      },
    };
    await admin((tx) =>
      tx.update(sourceSyncs).set({ phase: "crawl", token: null, reconcileFrom: sql`now()` }),
    );
    expect(await sync(early, { source: "mem" })).toMatchObject({
      status: "failed",
      error: "reconcile-guard",
      reconcileHeld: 3,
    });
    expect(await live("mem")).toHaveLength(3);
  });

  it("lets a reconcile under the threshold through, and a larger one with a lower threshold wait", async () => {
    const mem = memorySource();
    for (let i = 0; i < 10; i++) await mem.write([`f${i}.txt`], enc.encode(`${i}`));
    await sync(mem.connector, { source: "mem" });
    for (let i = 0; i < 4; i++) await mem.remove([`f${i}.txt`]);
    await mem.close(); // its cursor is refused: a crawl from the beginning
    expect(
      await sync(mem.connector, {
        source: "mem",
        reconcileGuard: { minItems: 3, maxFraction: 0.3 },
      }),
    ).toMatchObject({ status: "failed", error: "reconcile-guard", reconcileHeld: 4 });
    expect(await sync(mem.connector, { source: "mem" })).toMatchObject({
      status: "done",
      counts: { reconciled: 4 },
    });
    await expect(
      sync(mem.connector, { source: "mem", reconcileGuard: { maxFraction: 2 } }),
    ).rejects.toThrow(RangeError);
  });

  it("refuses a source that is now another one until an admin accepts it", async () => {
    for (let i = 0; i < 3; i++) await put([`file-${i}.txt`], `file ${i}\n`);
    await sync(folder());
    const recorded = (await syncState())?.sourceIdentity;
    expect(recorded).toMatch(/^\d+:\d+$/);
    // Another folder at the root's path (a drive mounted there, a folder replaced).
    await rename(root, `${root}-old`);
    await mkdir(root);
    await put(["new.txt"], "new\n");
    await rm(stateDir, { recursive: true }); // even with the connector's own check gone

    expect(await sync(folder())).toMatchObject({ status: "failed", error: "source-identity" });
    expect(await live()).toHaveLength(3);

    expect(await admin((tx) => acceptSourceIdentity(tx, t.tenantId, SOURCE))).toBe(true);
    expect(await admin((tx) => acceptSourceIdentity(tx, t.tenantId, "nope"))).toBe(false);
    // A crawl from the beginning of the new folder; a small source, under the guard's threshold.
    expect(await sync(folder())).toMatchObject({ status: "done", counts: { reconciled: 3 } });
    expect((await syncState())?.sourceIdentity).not.toBe(recorded);
    expect((await live()).map((r) => r.title)).toEqual(["new.txt"]);
  });

  it("keeps items a reconciling crawl mentioned but couldn't record", async () => {
    const mem = memorySource();
    for (let i = 0; i < 4; i++) await mem.write([`f${i}.txt`], enc.encode(`${i}`));
    await sync(mem.connector, { source: "mem" });
    const ids = Object.fromEntries((await catalog("mem")).map((r) => [r.title, r.externalId]));
    await mem.write(["f1.txt"], enc.encode("changed, and unreadable now"));
    await mem.close(); // a crawl from the beginning
    const items: SourceItem[] = [];
    const tricky: Connector = {
      ...mem.connector,
      crawl: async function* (checkpoint, signal) {
        for await (const e of mem.connector.crawl(checkpoint, signal)) {
          // f2 arrives malformed; f1 can't be read.
          if (e.type === "item" && e.item.externalId === ids["f2.txt"]) {
            yield { type: "item", item: { ...e.item, size: -1 } };
          } else yield e;
          if (e.type === "item") items.push(e.item);
        }
      },
      read: async (ref, signal) => {
        if (ref.externalId === ids["f1.txt"]) throw permanentError("unreadable");
        return mem.connector.read(ref, signal);
      },
    };
    const report = await sync(tricky, { source: "mem" });
    expect(report).toMatchObject({ status: "done", counts: { skipped: 2, reconciled: 0 } });
    expect(await live("mem")).toHaveLength(4);
    expect(items).toHaveLength(4);
  });

  it("doesn't reconcile a crawl that met a place it couldn't read, and reports the warnings", async () => {
    const mem = memorySource();
    for (let i = 0; i < 3; i++) await mem.write([`f${i}.txt`], enc.encode(`${i}`));
    await sync(mem.connector, { source: "mem" });
    await mem.remove(["f0.txt"]);
    await mem.close();
    const partly: Connector = {
      ...mem.connector,
      crawl: async function* (checkpoint, signal) {
        yield { type: "warning", code: "unreadable" };
        yield { type: "warning", code: "hard-link", externalId: "m9" };
        yield* mem.connector.crawl(checkpoint, signal);
      },
    };
    const report = await sync(partly, { source: "mem" });
    expect(report).toMatchObject({ status: "done", counts: { reconciled: 0 } });
    expect(report.warnings).toEqual([
      { code: "unreadable" },
      { code: "reconcile-skipped" },
      { code: "hard-link", externalId: "m9" },
    ]);
    expect(await live("mem")).toHaveLength(3);
    expect(await syncState("mem")).toMatchObject({ phase: "delta", reconcileFrom: null });
  });

  it("enqueues a committed version again when its enqueue failed, without ingesting it again", async () => {
    await put(["a.txt"], "a\n");
    let failures = 2;
    const report = await sync(folder(), {
      enqueue: async (_t, r) => {
        if (failures-- > 0) throw new Error("queue unavailable");
        enqueued.push(r);
      },
    });
    expect(report).toMatchObject({ status: "done", counts: { ingested: 1 } });
    expect(enqueued).toHaveLength(1);
    expect((await catalog())[0]?.versions).toBe(1);

    await put(["b.txt"], "b\n");
    await expect(
      sync(folder(), {
        enqueue: async () => {
          throw new Error("queue down");
        },
      }),
    ).rejects.toThrow("queue down");
  });

  it("stops at a checkpoint after its item cap, and goes on from there", async () => {
    const mem = memorySource({ checkpointEvery: 2 });
    for (let i = 0; i < 7; i++) await mem.write([`f${i}.txt`], enc.encode(`${i}`));
    const first = await sync(mem.connector, { source: "mem", maxItems: 3 });
    expect(first).toMatchObject({ status: "partial", counts: { ingested: 4 } });
    // The rest: two items to the next checkpoint (under the cap), then the end.
    expect(await sync(mem.connector, { source: "mem", maxItems: 3 })).toMatchObject({
      status: "done",
      counts: { ingested: 3 },
    });
    expect(await live("mem")).toHaveLength(7);
    await expect(sync(mem.connector, { source: "mem", maxItems: 0 })).rejects.toThrow(RangeError);
  });

  it("refuses item URLs that could run code or leak credentials", async () => {
    const mem = memorySource();
    await mem.write(["a.txt"], enc.encode("a"));
    await mem.write(["b.txt"], enc.encode("b"));
    const bad: Connector = {
      ...mem.connector,
      crawl: async function* (checkpoint, signal) {
        for await (const e of mem.connector.crawl(checkpoint, signal)) {
          if (e.type === "item" && e.item.path[0] === "a.txt") {
            yield { type: "item", item: { ...e.item, url: "javascript:alert(1)" } };
          } else if (e.type === "item") {
            yield { type: "item", item: { ...e.item, url: "https://memory.example/b" } };
          } else yield e;
        }
      },
    };
    const report = await sync(bad, { source: "mem" });
    expect(report).toMatchObject({ counts: { ingested: 1, skipped: 1 } });
    expect((await catalog("mem")).map((r) => r.url)).toEqual(["https://memory.example/b"]);
  });
});
