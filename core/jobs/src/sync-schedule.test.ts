import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsConnector } from "@openhoard/connector-fs";
import { auditEvents, sourceSyncs, versions, type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import type { Connector, SyncEvent } from "@openhoard/sdk";
import { memorySource } from "@openhoard/sdk/testing";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { JobWithMetadata } from "pg-boss";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ruleTagStep } from "./enrich.js";
import { QUEUES, startJobs, type Jobs, type JobsOptions } from "./jobs.js";
import {
  acceptSourceIdentity,
  confirmReconcile,
  ensureSourceSync,
  listSourceSyncs,
  pinSourceOwner,
  recordSyncRun,
  resumeSource,
} from "./sync-admin.js";
import {
  runSyncJob,
  syncKey,
  syncSettings,
  type ScheduledSource,
  type SyncJobDeps,
  type SyncPayload,
} from "./sync-schedule.js";

/*
 * T-303: connector syncs on a schedule. The queue end to end (PGlite, and PostgreSQL with
 * OPENHOARD_TEST_POSTGRES_URL) over a temporary folder, and one run's decisions (partial,
 * retry, failed, stopped, unknown owner) over the SDK's in-memory source.
 */

const KEY = new Uint8Array(32).fill(7);
const EVERY_15 = "*/15 * * * *";

let db: Database;
let t: SeededTenant;
let base: string;
const started: Jobs[] = [];

beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  base = await mkdtemp(join(tmpdir(), "openhoard-schedule-"));
});
afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop({ timeoutMs: 1_000 });
  await db?.close();
  await rm(base, { recursive: true, force: true, maxRetries: 5 });
});

async function start(more: JobsOptions = {}): Promise<Jobs> {
  const jobs = await startJobs(db, {
    pollingIntervalSeconds: 0.5,
    maintenance: false,
    steps: [ruleTagStep],
    ...more,
  });
  started.push(jobs);
  return jobs;
}

async function waitFor<T>(probe: () => Promise<T | null | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + (process.platform === "win32" ? 120_000 : 25_000);
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A folder with `files` text files, and the fs connector over it. */
async function folder(name: string, files: number) {
  const root = join(base, name);
  await mkdir(root, { recursive: true });
  for (let i = 1; i <= files; i++) await writeFile(join(root, `note-${i}.txt`), `note ${i}`);
  return fsConnector({ root, stateDir: join(base, `${name}-state`) });
}

const source = (name: string, connector: Connector, more: Partial<ScheduledSource> = {}) => ({
  tenantId: t.tenantId,
  source: name,
  zoneId: t.zoneId,
  cron: EVERY_15,
  connector,
  owner: async () => `user:${t.userId}`,
  ...more,
});

const syncs = () => db.withTenant(t.tenantId, (tx) => listSourceSyncs(tx, t.tenantId));
const stateOf = async (name: string) => (await syncs()).find((s) => s.source === name);
const audit = async () =>
  (
    await db.withTenant(t.tenantId, (tx) =>
      tx
        .select({ actor: auditEvents.actor, action: auditEvents.action, event: auditEvents.event })
        .from(auditEvents)
        .where(eq(auditEvents.tenantId, t.tenantId))
        .orderBy(asc(auditEvents.seq)),
    )
  ).map((e) => ({
    actor: e.actor,
    action: e.action,
    detail: (JSON.parse(e.event) as { detail?: unknown }).detail,
  }));

// Up to three waits of 120 s each on the Windows runner (waitFor): room for all of them.
const QUEUE_TIMEOUT = process.platform === "win32" ? 600_000 : 90_000;

describe("the sync queue", { timeout: QUEUE_TIMEOUT }, () => {
  it("keeps a schedule per source, runs each at start, and enriches what it ingested", async () => {
    const docs = await folder("docs", 2);
    // A schedule left from a source taken out of the configuration.
    const before = await start({ worker: false });
    await before.boss.schedule(
      QUEUES.sync,
      EVERY_15,
      { tenantId: t.tenantId, source: "gone" },
      { key: `${t.tenantId}/gone`, tz: "UTC" },
    );
    await before.stop({ timeoutMs: 1_000 });
    started.length = 0;

    const jobs = await start({
      sync: { sources: [source("fs-docs", docs)], tenantKey: () => KEY },
    });
    const schedules = await jobs.boss.getSchedules(QUEUES.sync);
    expect(schedules.map((s) => [s.key, s.cron, s.timezone])).toEqual([
      [syncKey({ tenantId: t.tenantId, source: "fs-docs" }), EVERY_15, "UTC"],
    ]);
    const state = await waitFor(async () => {
      const s = await stateOf("fs-docs");
      return s?.lastStatus === "done" ? s : null;
    }, "the first run");
    expect(state).toMatchObject({ phase: "delta", lastError: null, stoppedAt: null });
    expect(state.lastCounts).toMatchObject({ files: 2, ingested: 2 });
    expect(state.lastRunAt).toBeInstanceOf(Date);
    // Enrichment was enqueued for both, and ran (the owner sees them processed).
    await waitFor(async () => {
      const rows = await db.withTenant(t.tenantId, (tx) =>
        tx
          .select({ id: versions.id })
          .from(versions)
          .where(and(eq(versions.tenantId, t.tenantId), isNotNull(versions.processedAt))),
      );
      // The seeded version isn't the folder's, and nobody enqueued it.
      return rows.length >= 2 ? rows : null;
    }, "enrichment");

    // run-now: one job, reused when asked twice.
    const first = await jobs.requestSync(t.tenantId, "fs-docs");
    const second = await jobs.requestSync(t.tenantId, "fs-docs");
    expect([first, second].filter((id) => id !== null).length).toBeLessThanOrEqual(1);
    await expect(jobs.requestSync(t.tenantId, "Not A Slug")).rejects.toThrow(TypeError);
  });

  it("drops every schedule on a worker once no source is configured", async () => {
    const docs = await folder("docs", 1);
    await start({ sync: { sources: [source("fs-docs", docs)], tenantKey: () => KEY } });
    for (const jobs of started.splice(0)) await jobs.stop({ timeoutMs: 1_000 });
    const none = await start();
    expect(await none.boss.getSchedules(QUEUES.sync)).toEqual([]);
  });

  it("a node that isn't a worker sends but doesn't run, and leaves the schedules alone", async () => {
    const docs = await folder("docs", 1);
    const jobs = await start({
      worker: false,
      sync: { sources: [source("fs-docs", docs)], tenantKey: () => KEY },
    });
    const id = await jobs.requestSync(t.tenantId, "fs-docs");
    expect(id).not.toBeNull();
    await new Promise((r) => setTimeout(r, 1_500));
    expect(await jobs.boss.getJobById(QUEUES.sync, id as string)).toMatchObject({
      state: "created",
    });
    expect(await jobs.boss.getSchedules(QUEUES.sync)).toEqual([]);
    expect(await syncs()).toEqual([]);
  });

  it("stops a failing source through the queue, audited, and runs it again once resumed", async () => {
    const memory = memorySource();
    await memory.write(["a.txt"], new TextEncoder().encode("a"));
    memory.fault("auth");
    const jobs = await start({
      sync: { sources: [source("mem", memory.connector)], tenantKey: () => KEY },
    });
    const stopped = await waitFor(async () => {
      const s = await stateOf("mem");
      return s?.stoppedAt ? s : null;
    }, "the stop");
    expect(stopped).toMatchObject({
      lastStatus: "failed",
      lastError: "auth",
      stoppedError: "auth",
    });
    expect(await audit()).toContainEqual({
      actor: "system:sync",
      action: "source.sync-stopped",
      detail: { source: "mem", reason: "auth" },
    });
    // A run now skips it without touching it.
    const skipped = await jobs.requestSync(t.tenantId, "mem");
    const job = await waitFor(async () => {
      const j = await jobs.boss.getJobById<unknown>(QUEUES.sync, skipped ?? "");
      return j?.state === "completed" ? j : null;
    }, "the skipped run");
    expect((job as JobWithMetadata<unknown>).output).toEqual({ outcome: "stopped" });
    expect(memory.connector.describe().id).toBe("memory");
    // Resumed, the next run goes through.
    expect(await db.withTenant(t.tenantId, (tx) => resumeSource(tx, t.tenantId, "mem"))).toBe(
      "auth",
    );
    await jobs.requestSync(t.tenantId, "mem");
    const done = await waitFor(async () => {
      const s = await stateOf("mem");
      return s?.lastStatus === "done" ? s : null;
    }, "the resumed run");
    expect(done).toMatchObject({ stoppedAt: null, stoppedError: null });
  });
});

describe("one scheduled run", () => {
  const nexts: [SyncPayload, number][] = [];
  const deps = (sources: ScheduledSource[], budgetMs?: number): SyncJobDeps => ({
    db,
    settings: syncSettings({
      sources,
      tenantKey: () => KEY,
      ...(budgetMs === undefined ? {} : { budgetMs }),
    }),
    tenantKey: () => KEY,
    enqueue: async () => {},
    next: async (payload, delay) => {
      nexts.push([payload, delay]);
    },
    log: {},
  });
  const run = (d: SyncJobDeps, name: string) =>
    runSyncJob(d, { tenantId: t.tenantId, source: name }, new AbortController().signal);
  beforeEach(() => {
    nexts.length = 0;
  });

  it("sends the next run now after a partial one, and later after a throttle", async () => {
    const memory = memorySource({ checkpointEvery: 1 });
    for (const n of ["a", "b", "c"]) await memory.write([`${n}.txt`], new TextEncoder().encode(n));
    // A checkpoint only after the time budget: the run stops there.
    const slow: Connector = {
      ...memory.connector,
      async *crawl(checkpoint, signal) {
        let first = true;
        for await (const e of memory.connector.crawl(
          checkpoint,
          signal,
        ) as AsyncIterable<SyncEvent>) {
          if (e.type === "checkpoint" && first) {
            first = false;
            await new Promise((r) => setTimeout(r, 1_100));
          }
          yield e;
        }
      },
    };
    const d = deps([source("mem", slow)], 1_000);
    expect(await run(d, "mem")).toEqual({ outcome: "ran", status: "partial", next: "now" });
    expect(nexts).toEqual([[{ tenantId: t.tenantId, source: "mem" }, 0]]);
    expect(await stateOf("mem")).toMatchObject({ lastStatus: "partial", stoppedAt: null });

    memory.fault("throttled");
    const again = await run(d, "mem");
    expect(again).toMatchObject({ outcome: "ran", status: "retry", error: "throttled" });
    expect(nexts[1]?.[1]).toBeGreaterThanOrEqual(1_000);
    expect(await stateOf("mem")).toMatchObject({ lastStatus: "retry", lastError: "throttled" });
  });

  it("waits for an owner nobody knows yet, without stopping", async () => {
    const memory = memorySource();
    const d = deps([source("mem", memory.connector, { owner: async () => null })]);
    await db.withTenant(t.tenantId, (tx) =>
      ensureSourceSync(tx, t.tenantId, { source: "mem", zoneId: t.zoneId, connector: "memory" }),
    );
    expect(await run(d, "mem")).toEqual({ outcome: "unknown-owner" });
    expect(await stateOf("mem")).toMatchObject({
      lastStatus: "retry",
      lastError: "unknown-owner",
      stoppedAt: null,
    });
    expect(memory.calls.crawl).toBe(0);
  });

  it("skips what it can't run: an unknown payload, a source not configured", async () => {
    const d = deps([]);
    expect(await runSyncJob(d, { tenantId: "x" }, new AbortController().signal)).toEqual({
      outcome: "invalid",
    });
    expect(await run(d, "nowhere")).toEqual({ outcome: "unconfigured" });
  });

  it("audits a failure before the source was bound, and drops its schedule", async () => {
    const memory = memorySource();
    const dropped: SyncPayload[] = [];
    const d = {
      ...deps([source("mem", memory.connector, { zoneId: "zon_00000000000000000000000000" })]),
      unschedule: async (p: SyncPayload) => void dropped.push(p),
    };
    expect(await run(d, "mem")).toMatchObject({ status: "failed", error: "unknown-zone" });
    expect(await syncs()).toEqual([]);
    expect(dropped).toEqual([{ tenantId: t.tenantId, source: "mem" }]);
    expect(await audit()).toContainEqual({
      actor: "system:sync",
      action: "source.sync-stopped",
      detail: { source: "mem", reason: "unknown-zone", unbound: true },
    });
  });

  it("an admin's action on what failed lifts the stop", async () => {
    const memory = memorySource();
    await db.withTenant(t.tenantId, (tx) =>
      ensureSourceSync(tx, t.tenantId, { source: "mem", zoneId: t.zoneId, connector: "memory" }),
    );
    const stop = () =>
      db.withTenant(t.tenantId, (tx) =>
        recordSyncRun(tx, t.tenantId, "mem", { status: "failed", error: "source-identity" }),
      );
    expect(await stop()).toEqual({ recorded: true, stopped: true });
    // Stopped already: recorded, not stopped again.
    expect(await stop()).toEqual({ recorded: true, stopped: false });
    expect(await run(deps([source("mem", memory.connector)]), "mem")).toEqual({
      outcome: "stopped",
    });
    expect(
      await db.withTenant(t.tenantId, (tx) => acceptSourceIdentity(tx, t.tenantId, "mem")),
    ).toBe(true);
    expect(await stateOf("mem")).toMatchObject({ stoppedAt: null });
    // A reconcile held stops it too; confirming lifts it.
    await db.withTenant(t.tenantId, async (tx) => {
      await tx
        .update(sourceSyncs)
        .set({ reconcileHeld: 9 })
        .where(and(eq(sourceSyncs.tenantId, t.tenantId), eq(sourceSyncs.source, "mem")));
      await recordSyncRun(tx, t.tenantId, "mem", { status: "failed", error: "Not a code!" });
    });
    expect(await stateOf("mem")).toMatchObject({ stoppedError: "failed", lastError: null });
    expect(await db.withTenant(t.tenantId, (tx) => confirmReconcile(tx, t.tenantId, "mem"))).toBe(
      9,
    );
    expect(await stateOf("mem")).toMatchObject({ stoppedAt: null });
    expect(await db.withTenant(t.tenantId, (tx) => resumeSource(tx, t.tenantId, "mem"))).toBeNull();
    // Another zone or connector later is refused, as the runner would.
    expect(
      await db.withTenant(t.tenantId, (tx) =>
        ensureSourceSync(tx, t.tenantId, { source: "mem", zoneId: t.zoneId, connector: "other" }),
      ),
    ).toBe("connector-mismatch");
  });

  it("pins the first owner, and never another after", async () => {
    await db.withTenant(t.tenantId, (tx) =>
      ensureSourceSync(tx, t.tenantId, { source: "mem", zoneId: t.zoneId, connector: "memory" }),
    );
    const pin = (who: string | null, name = "mem") =>
      db.withTenant(t.tenantId, (tx) => pinSourceOwner(tx, t.tenantId, name, who));
    const ana = `user:${t.userId}`;
    expect(await pin(null)).toBeNull();
    expect(await pin(ana)).toBe(ana);
    expect(await pin("user:usr_00000000000000000000000000")).toBe(ana);
    expect(await stateOf("mem")).toMatchObject({ ownerId: ana });
    expect(await pin(ana, "nowhere")).toBeNull();
  });

  it("checks its settings", () => {
    const memory = memorySource();
    const ok = { sources: [], tenantKey: () => KEY };
    expect(() => syncSettings({ ...ok, budgetMs: 10 })).toThrow(RangeError);
    expect(() => syncSettings({ ...ok, budgetMs: 600_000, expireInSeconds: 600 })).toThrow(
      RangeError,
    );
    expect(() => syncSettings({ ...ok, concurrency: 0 })).toThrow(RangeError);
    expect(() =>
      syncSettings({
        ...ok,
        sources: [source("mem", memory.connector), source("mem", memory.connector)],
      }),
    ).toThrow(/twice/);
    expect(() => syncSettings({ ...ok, sources: [source("Bad Name", memory.connector)] })).toThrow(
      TypeError,
    );
  });
});
