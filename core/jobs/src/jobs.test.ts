import {
  APPLY_TRANSACTION,
  applyPack,
  ingest,
  planPack,
  viewObjects,
  VIEW_TRANSACTION,
  writeActivity,
  type IngestResult,
} from "@openhoard/core-catalog";
import {
  activityEvents,
  NestedWorkError,
  newId,
  objectTags,
  sessions,
  tagReviews,
  versions,
  type Database,
  type Tx,
} from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { Authorizer, createCedarEngine, type AuthzPrincipal } from "@openhoard/core-policy";
import { and, asc, eq, sql } from "drizzle-orm";
import type { JobWithMetadata } from "pg-boss";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ruleTagStep, type EnrichStep } from "./enrich.js";
import { enrichKey, QUEUES, startJobs, type Jobs, type JobsOptions } from "./jobs.js";

/* T-401: "re-running a job never duplicates tags or cards". */

const PACK = {
  pack_version: 1,
  name: "test-rules",
  version: "1.0.0",
  defaults: { visibility: "discoverable", exposure: "metadata-only" },
  facets: [
    {
      key: "kind",
      label: "Kind",
      public: true,
      values: [
        { value: "spreadsheet", label: "Spreadsheet" },
        { value: "document", label: "Document" },
      ],
    },
    { key: "topic", label: "Topic", values: [{ value: "budget", label: "Budget" }] },
  ],
  rules: [
    { id: "sheets", tag: "kind:spreadsheet", when: { extension: ["xlsx"] } },
    { id: "docs", tag: "kind:document", when: { extension: ["docx"] } },
    { id: "topics", facet: "topic", dictionary: { budget: ["Budget"] } },
    // Not in the vocabulary: every run proposes it, and it waits in review, once.
    { id: "forecasts", tag: "topic:forecast", when: { extension: ["xlsx"] } },
  ],
};

let db: Database;
let t: SeededTenant;
const started: Jobs[] = [];

beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  await applyTestPack(t.tenantId);
});
afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop({ timeoutMs: 1_000 });
  await db?.close();
});

async function applyTestPack(tenantId: string) {
  const plan = await db.withTenant(tenantId, (tx) => planPack(tx, tenantId, PACK));
  await db.withTenant(
    tenantId,
    (tx) => applyPack(tx, tenantId, PACK, { planHash: plan.planHash, by: "user:admin" }),
    APPLY_TRANSACTION,
  );
}

/** Fast polling, quick retries, no schedule: what most tests want. */
async function start(more: JobsOptions = {}): Promise<Jobs> {
  const jobs = await startJobs(db, {
    pollingIntervalSeconds: 0.5,
    maintenance: false,
    ...more,
    enrich: { retryDelaySeconds: 0, retryBackoff: false, retryLimit: 2, ...more.enrich },
  });
  started.push(jobs);
  return jobs;
}

let items = 0;
/** Ingests an item (a new one unless `externalId` is given) and returns the result. */
function ingestItem(
  title: string,
  options: { externalId?: string; blob?: number; tenant?: SeededTenant } = {},
): Promise<IngestResult & { externalId: string; blob: number }> {
  const s = options.tenant ?? t;
  const k = ++items;
  const externalId = options.externalId ?? `item-${k}`;
  const blob = options.blob ?? k;
  return db.withTenant(s.tenantId, async (tx) => ({
    externalId,
    blob,
    ...(await ingest(tx, s.tenantId, {
      source: "test",
      externalId,
      zoneId: s.zoneId,
      title,
      ownerId: `user:${s.userId}`,
      content: { blobId: `b3t:${blob.toString(16).padStart(64, "a")}`, size: 10 },
    })),
  }));
}

async function waitFor<T>(probe: () => Promise<T | null | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 25_000;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Waits until the job has completed or failed for good. */
function settled(jobs: Jobs, queue: string, id: string | null) {
  if (id === null) throw new Error("no job id");
  return waitFor(async () => {
    const job = await jobs.boss.getJobById<unknown>(queue, id);
    return job && (job.state === "completed" || job.state === "failed") ? job : null;
  }, `job ${id} in ${queue}`);
}

/** Every enrichment job for a version, oldest first. */
async function enrichJobs(jobs: Jobs, versionId: string, tenantId = t.tenantId) {
  const found = await jobs.boss.findJobs<unknown>(QUEUES.enrich, {
    key: enrichKey({ tenantId, versionId }),
  });
  return found.sort((a, b) => a.createdOn.getTime() - b.createdOn.getTime());
}

const output = (job: JobWithMetadata<unknown>) => job.output as { outcome?: string };

/** The object's tags and open review items, as rows a duplicate would show up in. */
async function tagState(objectId: string, tenantId = t.tenantId) {
  return db.withTenant(tenantId, async (tx) => ({
    tags: await tx
      .select({ facet: objectTags.facet, value: objectTags.value, source: objectTags.source })
      .from(objectTags)
      .where(eq(objectTags.objectId, objectId))
      .orderBy(asc(objectTags.facet), asc(objectTags.value)),
    reviews: await tx
      .select({
        facet: tagReviews.facet,
        value: tagReviews.value,
        reason: tagReviews.reason,
        decision: tagReviews.decision,
      })
      .from(tagReviews)
      .where(eq(tagReviews.objectId, objectId))
      .orderBy(asc(tagReviews.facet), asc(tagReviews.value)),
  }));
}

const SPREADSHEET_TAGS = {
  tags: [
    { facet: "kind", value: "spreadsheet", source: "rule" },
    { facet: "topic", value: "budget", source: "rule" },
  ],
  reviews: [{ facet: "topic", value: "forecast", reason: "new-value", decision: null }],
};

async function processedAt(versionId: string, tenantId = t.tenantId) {
  const [row] = await db.withTenant(tenantId, (tx) =>
    tx
      .select({ processedAt: versions.processedAt })
      .from(versions)
      .where(eq(versions.id, versionId)),
  );
  return row?.processedAt ?? null;
}

/** A step that runs `effect` and fails the first `failures` times. */
function flakyStep(failures: number, effect?: () => Promise<void>) {
  const calls: number[] = [];
  const step: EnrichStep = {
    name: "flaky",
    async run() {
      calls.push(calls.length + 1);
      await effect?.();
      if (calls.length <= failures) throw new Error(`flaky failure ${calls.length}`);
    },
  };
  return { step, calls };
}

describe("enqueueing", () => {
  it("makes one job per version and collapses duplicates", async () => {
    const jobs = await start({ worker: false });
    const first = await ingestItem("Budget 2026.xlsx");
    expect(await jobs.enqueueAfterIngest(t.tenantId, first)).toBe(true);
    expect(await jobs.enqueueVersion(t.tenantId, first.versionId)).toBeNull();
    expect(await jobs.enqueueAfterIngest(t.tenantId, first)).toBe(true);
    // Seen again unchanged: no version, no rename, nothing to enrich.
    const again = await ingestItem("Budget 2026.xlsx", {
      externalId: first.externalId,
      blob: first.blob,
    });
    expect(again.created.version).toBe(false);
    expect(await jobs.enqueueAfterIngest(t.tenantId, again)).toBe(false);
    expect(await enrichJobs(jobs, first.versionId)).toHaveLength(1);
    // A new version is a job of its own; so is the same version id in another tenant's name.
    const second = await ingestItem("Budget 2026.xlsx", { externalId: first.externalId });
    expect(second.versionId).not.toBe(first.versionId);
    expect(await jobs.enqueueAfterIngest(t.tenantId, second)).toBe(true);
    const [job] = await enrichJobs(jobs, second.versionId);
    expect(job?.data).toEqual({ tenantId: t.tenantId, versionId: second.versionId });
    expect(job?.singletonKey).toBe(`${t.tenantId}/${second.versionId}`);
  });

  it("refuses inside a tenant's transaction, and malformed ids", async () => {
    const jobs = await start({ worker: false });
    const item = await ingestItem("Notes.docx");
    await expect(
      db.withTenant(t.tenantId, () => jobs.enqueueVersion(t.tenantId, item.versionId)),
    ).rejects.toThrow(NestedWorkError);
    await expect(
      db.withTenant(t.tenantId, () => jobs.enqueueAfterIngest(t.tenantId, item)),
    ).rejects.toThrow(NestedWorkError);
    await expect(db.withTenant(t.tenantId, () => jobs.runMaintenance())).rejects.toThrow(
      NestedWorkError,
    );
    await expect(jobs.enqueueVersion("ten_nope", item.versionId)).rejects.toThrow(TypeError);
    await expect(jobs.enqueueVersion(t.tenantId, t.objectId)).rejects.toThrow(TypeError);
    await expect(db.withTenant(t.tenantId, () => startJobs(db))).rejects.toThrow(NestedWorkError);
  });

  it("checks its options before starting anything", async () => {
    const named = (name: string): EnrichStep => ({ name, run: () => Promise.resolve() });
    await expect(startJobs(db, { steps: [named("Bad Name")] })).rejects.toThrow(TypeError);
    await expect(startJobs(db, { steps: [named("a"), named("a")] })).rejects.toThrow(TypeError);
    await expect(startJobs(db, { pollingIntervalSeconds: 0.1 })).rejects.toThrow(RangeError);
    await expect(startJobs(db, { superviseIntervalSeconds: 0 })).rejects.toThrow(RangeError);
    await expect(startJobs(db, { enrich: { retryLimit: -1 } })).rejects.toThrow(RangeError);
    await expect(startJobs(db, { enrich: { concurrency: 1.5 } })).rejects.toThrow(RangeError);
    await expect(startJobs(db, { maintenance: { batchSize: 0 } })).rejects.toThrow(RangeError);
  });
});

describe("the worker", () => {
  const authz = new Authorizer(createCedarEngine());
  /** A member of the tenant with no grant on anything: a non-reader. */
  const outsider: AuthzPrincipal = {
    userId: "bo",
    groupIds: [],
    tagGrants: [],
    tagWriteGrants: [],
    objectGrants: [],
    objectWriteGrants: [],
    guest: false,
    active: true,
  };
  const nonReaderView = (objectId: string) =>
    db.withTenant(
      t.tenantId,
      (tx) =>
        viewObjects(
          tx,
          t.tenantId,
          authz,
          { principal: outsider, client: { id: "openhoard-web", trust: "first-party" } },
          [objectId],
        ),
      VIEW_TRANSACTION,
    );

  it("runs the steps, then marks the version processed: non-readers see it from then on", async () => {
    const item = await ingestItem("Budget 2026.xlsx");
    // Unprocessed: hidden from anyone who can't read it, whatever the defaults say.
    expect(await nonReaderView(item.objectId)).toEqual([]);
    const jobs = await start();
    await jobs.enqueueAfterIngest(t.tenantId, item);
    const [queued] = await enrichJobs(jobs, item.versionId);
    const job = await settled(jobs, QUEUES.enrich, queued?.id ?? null);
    expect(job.state).toBe("completed");
    expect(output(job)).toEqual({ outcome: "processed" });
    expect(await tagState(item.objectId)).toEqual(SPREADSHEET_TAGS);
    expect(await processedAt(item.versionId)).toBeInstanceOf(Date);
    const [view] = await nonReaderView(item.objectId);
    expect(view).toMatchObject({
      id: item.objectId,
      shape: "title-only",
      title: "Budget 2026.xlsx",
      tags: ["kind:spreadsheet"],
    });
  });

  it("retries a job whose step failed half way, and the re-run duplicates nothing", async () => {
    const item = await ingestItem("Budget 2026.xlsx");
    // The rule tags are written, then the next step fails: the job runs again from the start.
    const flaky = flakyStep(1);
    const jobs = await start({ steps: [ruleTagStep, flaky.step] });
    await jobs.enqueueAfterIngest(t.tenantId, item);
    const [queued] = await enrichJobs(jobs, item.versionId);
    const job = await settled(jobs, QUEUES.enrich, queued?.id ?? null);
    expect(job).toMatchObject({ state: "completed", retryCount: 1 });
    expect(flaky.calls).toEqual([1, 2]);
    expect(await tagState(item.objectId)).toEqual(SPREADSHEET_TAGS);
    expect(await processedAt(item.versionId)).toBeInstanceOf(Date);
  });

  it("re-runs a completed job without changing anything", async () => {
    const item = await ingestItem("Budget 2026.xlsx");
    const jobs = await start();
    await jobs.enqueueAfterIngest(t.tenantId, item);
    const first = await settled(
      jobs,
      QUEUES.enrich,
      (await enrichJobs(jobs, item.versionId))[0]?.id ?? null,
    );
    expect(output(first)).toEqual({ outcome: "processed" });
    const before = { ...(await tagState(item.objectId)), at: await processedAt(item.versionId) };
    // Enqueued again (a redrive, an operator, a duplicate delivery): it runs every step again.
    const id = await jobs.enqueueVersion(t.tenantId, item.versionId);
    const second = await settled(jobs, QUEUES.enrich, id);
    expect(output(second)).toEqual({ outcome: "already-processed" });
    const after = { ...(await tagState(item.objectId)), at: await processedAt(item.versionId) };
    expect(after).toEqual(before);
  });

  it("runs a job again when its worker died half way (the lease expired)", async () => {
    const item = await ingestItem("Budget 2026.xlsx");
    const enrich = { expireInSeconds: 1 };
    const dead = await start({ worker: false, enrich });
    await dead.enqueueAfterIngest(t.tenantId, item);
    // A worker takes the job, writes the rule tags, and dies before finishing.
    const [claimed] = await dead.boss.fetch<unknown>(QUEUES.enrich);
    expect(claimed?.data).toEqual({ tenantId: t.tenantId, versionId: item.versionId });
    await ruleTagStep.run({
      target: {
        tenantId: t.tenantId,
        objectId: item.objectId,
        versionId: item.versionId,
        seq: 1,
        title: "Budget 2026.xlsx",
        mime: "application/octet-stream",
        blobId: "unused",
      },
      withTenant: (work, config) => db.withTenant(t.tenantId, work, config),
      signal: new AbortController().signal,
    });
    // Another worker's supervisor finds the expired lease and puts the job back for a retry.
    const jobs = await start({ enrich, superviseIntervalSeconds: 1 });
    const job = await settled(jobs, QUEUES.enrich, claimed?.id ?? null);
    expect(job).toMatchObject({ state: "completed", retryCount: 1 });
    expect(await tagState(item.objectId)).toEqual(SPREADSHEET_TAGS);
  });

  it("enqueues again after a rename during the run, and processes the new title", async () => {
    const item = await ingestItem("Budget 2026.xlsx");
    let renamed: IngestResult | undefined;
    const jobs = await start({
      steps: [
        ruleTagStep,
        {
          name: "rename-once",
          async run() {
            if (renamed) return;
            // The source renames the file while the job runs; its connector enqueues as usual.
            renamed = await ingestItem("Forecast 2026.xlsx", {
              externalId: item.externalId,
              blob: item.blob,
            });
            await jobs.enqueueAfterIngest(t.tenantId, renamed);
          },
        },
      ],
    });
    await jobs.enqueueAfterIngest(t.tenantId, item);
    const [first] = await enrichJobs(jobs, item.versionId);
    expect(output(await settled(jobs, QUEUES.enrich, first?.id ?? null))).toEqual({
      outcome: "renamed",
    });
    expect(renamed).toMatchObject({ renamed: true, versionId: item.versionId });
    const all = await waitFor(async () => {
      const found = await enrichJobs(jobs, item.versionId);
      return found.length === 2 && found.every((j) => j.state === "completed") ? found : null;
    }, "the second run");
    // Exactly one more job: the connector's enqueue and the job's own collapsed into it.
    expect(all.map(output)).toEqual([{ outcome: "renamed" }, { outcome: "processed" }]);
    expect(await processedAt(item.versionId)).toBeInstanceOf(Date);
    // The rules ran on the new title: no budget any more.
    expect((await tagState(item.objectId)).tags).toEqual([
      { facet: "kind", value: "spreadsheet", source: "rule" },
    ]);
    const [view] = await nonReaderView(item.objectId);
    expect(view).toMatchObject({ title: "Forecast 2026.xlsx" });
  });

  it("leaves a replaced version to the newer one's job", async () => {
    const v1 = await ingestItem("Budget 2026.xlsx");
    const v2 = await ingestItem("Budget 2026.xlsx", { externalId: v1.externalId });
    const jobs = await start({ worker: false });
    await jobs.enqueueAfterIngest(t.tenantId, v1);
    await jobs.enqueueAfterIngest(t.tenantId, v2);
    const worker = await start();
    const one = await settled(
      worker,
      QUEUES.enrich,
      (await enrichJobs(jobs, v1.versionId))[0]?.id ?? null,
    );
    const two = await settled(
      worker,
      QUEUES.enrich,
      (await enrichJobs(jobs, v2.versionId))[0]?.id ?? null,
    );
    expect([output(one), output(two)]).toEqual([
      { outcome: "superseded" },
      { outcome: "processed" },
    ]);
    expect(await processedAt(v1.versionId)).toBeNull();
    expect(await processedAt(v2.versionId)).toBeInstanceOf(Date);
  });

  it("completes jobs that name nothing, without doing anything", async () => {
    const jobs = await start();
    const invalid = await jobs.boss.send(QUEUES.enrich, { tenantId: "ten_x", versionId: 1 });
    const gone = await jobs.enqueueVersion(t.tenantId, newId("version"));
    const otherTenant = await jobs.enqueueVersion(newId("tenant"), t.versionId);
    expect(output(await settled(jobs, QUEUES.enrich, invalid))).toEqual({ outcome: "invalid" });
    expect(output(await settled(jobs, QUEUES.enrich, gone))).toEqual({ outcome: "gone" });
    expect(output(await settled(jobs, QUEUES.enrich, otherTenant))).toEqual({ outcome: "gone" });
    expect(await processedAt(t.versionId)).toBeNull();
  });

  it("dead-letters a job that keeps failing; the version stays hidden", async () => {
    const item = await ingestItem("Budget 2026.xlsx");
    const flaky = flakyStep(Infinity);
    const jobs = await start({ steps: [flaky.step], enrich: { retryLimit: 1 } });
    await jobs.enqueueAfterIngest(t.tenantId, item);
    const [queued] = await enrichJobs(jobs, item.versionId);
    const job = await settled(jobs, QUEUES.enrich, queued?.id ?? null);
    expect(job).toMatchObject({ state: "failed", retryCount: 1 });
    expect(JSON.stringify(job.output)).toContain("enrichment step flaky failed: flaky failure 2");
    const dead = await jobs.boss.findJobs<unknown>(QUEUES.enrichFailed, { queued: true });
    expect(dead.map((j) => j.data)).toEqual([{ tenantId: t.tenantId, versionId: item.versionId }]);
    expect(await processedAt(item.versionId)).toBeNull();
    expect(await nonReaderView(item.objectId)).toEqual([]);
  });

  it("stops gracefully: a running job finishes first, then the database can close", async () => {
    const item = await ingestItem("Budget 2026.xlsx");
    let release: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const inStep = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const jobs = await startJobs(db, {
      pollingIntervalSeconds: 0.5,
      maintenance: false,
      steps: [
        ruleTagStep,
        {
          name: "slow",
          async run() {
            entered();
            await running;
          },
        },
      ],
    });
    await jobs.enqueueAfterIngest(t.tenantId, item);
    await inStep;
    const stopping = jobs.stop({ timeoutMs: 10_000 });
    setTimeout(release, 300);
    await stopping;
    expect(await processedAt(item.versionId)).toBeInstanceOf(Date);
    // Stopped for good: nothing polls any more, so closing the database is safe.
    await db.close();
    db = await openTestDatabase();
  });
});

describe("maintenance", () => {
  const DAY = 24 * 60 * 60 * 1000;

  /** Old ended sessions, an old and a new activity event, for one tenant. */
  async function oldRows(s: SeededTenant) {
    await db.withTenant(s.tenantId, async (tx) => {
      for (const days of [40, 50, 1]) {
        await tx.insert(sessions).values({
          tenantId: s.tenantId,
          id: newId("session"),
          userId: s.userId,
          userKind: "member",
          secretHash: "0".repeat(64),
          provider: "test",
          issuer: "https://login.example.com",
          subject: `ana-${days}`,
          idleSeconds: 3600,
          createdAt: sql`now() - make_interval(days => ${days})`,
          lastSeenAt: sql`now() - make_interval(days => ${days})`,
          expiresAt: sql`now() - make_interval(days => ${days}) + interval '1 hour'`,
        });
      }
      await writeActivity(tx, s.tenantId, [
        {
          type: "view",
          actor: `user:${s.userId}`,
          objectId: s.objectId,
          at: new Date(Date.now() - 500 * DAY),
        },
        {
          type: "view",
          actor: `user:${s.userId}`,
          objectId: s.objectId,
          at: new Date(Date.now() - 2 * DAY),
        },
      ]);
    });
  }

  const remaining = (tenantId: string) =>
    db.withTenant(tenantId, async (tx) => ({
      sessions: (await tx.select().from(sessions)).length,
      activity: (await tx.select().from(activityEvents)).length,
    }));

  /** Makes a version look created `hours` ago, as if its job had been lost long since. */
  const backdate = (tenantId: string, versionId: string, hours: number) =>
    db.withTenant(tenantId, (tx: Tx) =>
      tx
        .update(versions)
        .set({ createdAt: sql`now() - make_interval(hours => ${hours})` })
        .where(and(eq(versions.tenantId, tenantId), eq(versions.id, versionId))),
    );

  it("keeps the schedule, and a run prunes and sweeps every tenant in bounded batches", async () => {
    const u = await seedTenant(db, 2);
    await applyTestPack(u.tenantId);
    await oldRows(t);
    await oldRows(u);
    // A version whose enqueue was lost (a crash after ingest committed), in each tenant.
    const lost = await ingestItem("Budget 2026.xlsx");
    const lostToo = await ingestItem("Budget 2026.xlsx", { tenant: u });
    await backdate(t.tenantId, lost.versionId, 2);
    await backdate(u.tenantId, lostToo.versionId, 2);
    // A fresh one: its job may still be on its way, so the sweep leaves it for now.
    const fresh = await ingestItem("Notes.docx");

    const jobs = await start({
      maintenance: { cron: "5 4 * * *", batchSize: 1, maxBatches: 10 },
    });
    expect((await jobs.boss.getSchedules(QUEUES.maintenance)).map((s) => s.cron)).toEqual([
      "5 4 * * *",
    ]);
    const run = await settled(jobs, QUEUES.maintenance, await jobs.runMaintenance());
    expect(run.output).toEqual({ tenants: 2 });
    for (const s of [t, u]) {
      const [perTenant] = await jobs.boss.findJobs<unknown>(QUEUES.maintenanceTenant, {
        key: s.tenantId,
      });
      const done = await settled(jobs, QUEUES.maintenanceTenant, perTenant?.id ?? null);
      // One batch at a time: the two sessions that ended over 30 days ago, the event from
      // 500 days ago; the recent ones stay.
      expect(done.output).toEqual({ sessions: 2, activity: 1, swept: 1 });
      expect(await remaining(s.tenantId)).toEqual({ sessions: 1, activity: 1 });
    }
    // The swept versions are enriched now; the fresh one wasn't enqueued by anyone.
    await waitFor(async () => ((await processedAt(lost.versionId)) ? true : null), "the sweep");
    await waitFor(
      async () => ((await processedAt(lostToo.versionId, u.tenantId)) ? true : null),
      "the sweep in the other tenant",
    );
    expect(await tagState(lostToo.objectId, u.tenantId)).toEqual(SPREADSHEET_TAGS);
    expect(await enrichJobs(jobs, fresh.versionId)).toEqual([]);
  });

  it("sweeps nothing that waits in a queue or ran out of retries", async () => {
    const waiting = await ingestItem("Waiting.xlsx");
    const failed = await ingestItem("Failed.xlsx");
    for (const v of [waiting, failed]) await backdate(t.tenantId, v.versionId, 2);
    const flaky = flakyStep(Infinity);
    const jobs = await start({
      steps: [flaky.step],
      enrich: { retryLimit: 0 },
      maintenance: { sweepAfterMinutes: 60 },
    });
    await jobs.enqueueAfterIngest(t.tenantId, failed);
    const [dead] = await enrichJobs(jobs, failed.versionId);
    expect((await settled(jobs, QUEUES.enrich, dead?.id ?? null)).state).toBe("failed");
    await jobs.stop({ timeoutMs: 1_000 });
    // The other one waits in the queue while no worker runs.
    const sender = await start({ worker: false });
    await sender.enqueueAfterIngest(t.tenantId, waiting);
    const worker = await start({ steps: [flaky.step], maintenance: {} });
    const run = await settled(worker, QUEUES.maintenance, await worker.runMaintenance());
    expect(run.output).toEqual({ tenants: 1 });
    const [perTenant] = await worker.boss.findJobs<unknown>(QUEUES.maintenanceTenant, {
      key: t.tenantId,
    });
    const done = await settled(worker, QUEUES.maintenanceTenant, perTenant?.id ?? null);
    expect(done.output).toMatchObject({ swept: 0 });
    expect(await enrichJobs(worker, failed.versionId)).toHaveLength(1);
  });

  it("unschedules maintenance that is turned off", async () => {
    const jobs = await start({ maintenance: {} });
    expect(await jobs.boss.getSchedules(QUEUES.maintenance)).toHaveLength(1);
    await jobs.stop({ timeoutMs: 1_000 });
    const off = await start({ maintenance: false });
    expect(await off.boss.getSchedules(QUEUES.maintenance)).toEqual([]);
  });
});
