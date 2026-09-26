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
import {
  openTestDatabase,
  seedTenant,
  TEST_POSTGRES_ENV,
  type SeededTenant,
} from "@openhoard/core-db/testing";
import { Authorizer, createCedarEngine, type AuthzPrincipal } from "@openhoard/core-policy";
import { and, asc, eq, sql } from "drizzle-orm";
import type { JobWithMetadata } from "pg-boss";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ruleTagStep, type EnrichStep, type ModelProvider } from "./enrich.js";
import {
  deadLetteredVersions,
  DEFAULT_MAINTENANCE_CRON,
  enrichKey,
  QUEUES,
  startJobs,
  type Jobs,
  type JobsOptions,
} from "./jobs.js";
import { maintainTenant, maintenanceSettings, type MaintenanceOptions } from "./maintenance.js";

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

async function supersededAt(versionId: string, tenantId = t.tenantId) {
  const [row] = await db.withTenant(tenantId, (tx) =>
    tx
      .select({ supersededAt: versions.supersededAt })
      .from(versions)
      .where(eq(versions.id, versionId)),
  );
  return row?.supersededAt ?? null;
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
    // Work a transaction started that runs after its commit is outside it again.
    let later: Promise<string | null> | undefined;
    await db.withTenant(t.tenantId, () => {
      later = new Promise<void>((r) => setTimeout(r, 20)).then(() =>
        jobs.enqueueVersion(t.tenantId, item.versionId),
      );
      return Promise.resolve();
    });
    expect(await later).toEqual(expect.any(String));
  });

  it("checks its options before starting anything", async () => {
    const named = (name: string): EnrichStep => ({ name, run: () => Promise.resolve() });
    await expect(startJobs(db, { steps: [named("Bad Name")] })).rejects.toThrow(TypeError);
    await expect(startJobs(db, { steps: [named("a"), named("a")] })).rejects.toThrow(TypeError);
    const cloud = { ...named("a"), provider: { id: "x", kind: "cloud" as never } };
    await expect(startJobs(db, { steps: [cloud] })).rejects.toThrow(
      /local, commercial or consumer/,
    );
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

  // T-604: "the pipeline must refuse to send content to a model provider not allowed for the
  // exposure".
  it("sends content only to providers the file's exposure allows, and says what it withheld", async () => {
    const ran: string[] = [];
    const answers: boolean[] = [];
    const provider = (kind: ModelProvider["kind"]): ModelProvider => ({
      id: `${kind}-model`,
      kind,
    });
    const modelStep = (kind: ModelProvider["kind"]): EnrichStep => ({
      name: `summarize-${kind}`,
      provider: provider(kind),
      async run(context) {
        ran.push(`${kind}:${context.target.title}`);
        // A step asks again right before it sends; another provider gets its own answer.
        answers.push(await context.mayProcess(provider("commercial")));
      },
    });
    const steps = [ruleTagStep, modelStep("consumer"), modelStep("commercial"), modelStep("local")];
    const setDefault = (exposure: string) =>
      db.withTenant(t.tenantId, (tx) =>
        tx.execute(sql`update tenants set default_exposure = ${exposure} where id = ${t.tenantId}`),
      );
    const jobs = await start({ steps });
    const run = async (title: string) => {
      const item = await ingestItem(title);
      await jobs.enqueueAfterIngest(t.tenantId, item);
      const [queued] = await enrichJobs(jobs, item.versionId);
      const job = await settled(jobs, QUEUES.enrich, queued?.id ?? null);
      expect(job.state).toBe("completed");
      return job.output as { outcome: string; withheld?: unknown[] };
    };

    // A permissive default doesn't reach a consumer provider while nothing trusted classified
    // the file: it is capped at commercial-only.
    await setDefault("full");
    expect(await run("Memo.docx")).toEqual({
      outcome: "processed",
      withheld: [
        { step: "summarize-consumer", provider: "consumer-model", exposure: "commercial-only" },
      ],
    });
    expect(ran).toEqual(["commercial:Memo.docx", "local:Memo.docx"]);
    ran.length = 0;
    answers.length = 0;

    // The tenant default decides for what no tag sets: commercial-only.
    await setDefault("commercial-only");
    expect(await run("Notes.docx")).toEqual({
      outcome: "processed",
      withheld: [
        { step: "summarize-consumer", provider: "consumer-model", exposure: "commercial-only" },
      ],
    });
    expect(ran).toEqual(["commercial:Notes.docx", "local:Notes.docx"]);
    expect(answers).toEqual([true, true]);

    // A rule tag the rule tagger (first) applied sets local-only: only the local model sees it.
    await db.withTenant(t.tenantId, (tx) =>
      tx.execute(
        sql`update facet_values set exposure = 'local-only' where facet = 'topic' and value = 'budget'`,
      ),
    );
    ran.length = 0;
    answers.length = 0;
    expect(await run("Budget 2026.xlsx")).toMatchObject({
      outcome: "processed",
      withheld: [
        { step: "summarize-consumer", exposure: "local-only" },
        { step: "summarize-commercial", exposure: "local-only" },
      ],
    });
    expect(ran).toEqual(["local:Budget 2026.xlsx"]);
    expect(answers).toEqual([false]);

    // Metadata-only: no model at all, and the version is still processed.
    await setDefault("metadata-only");
    ran.length = 0;
    const out = await run("Plan.docx");
    expect(out.outcome).toBe("processed");
    expect(out.withheld).toHaveLength(3);
    expect(ran).toEqual([]);
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

  it("brings a job waiting out its retry delay forward instead of queueing a second", async () => {
    const item = await ingestItem("Budget 2026.xlsx");
    // Fails once, then waits an hour for its retry.
    const flaky = flakyStep(1);
    const jobs = await start({
      steps: [flaky.step, ruleTagStep],
      enrich: { retryDelaySeconds: 3_600, retryLimit: 3 },
    });
    await jobs.enqueueAfterIngest(t.tenantId, item);
    const [queued] = await enrichJobs(jobs, item.versionId);
    await waitFor(async () => {
      const job = await jobs.boss.getJobById<unknown>(QUEUES.enrich, queued?.id ?? "");
      return job?.state === "retry" ? job : null;
    }, "the retry");
    // A rename, the sweep or a connector enqueues it meanwhile: no second job beside the retry
    // (pg-boss would dead-letter that one on its first failure, its retries unused).
    expect(await jobs.enqueueVersion(t.tenantId, item.versionId)).toBeNull();
    const job = await settled(jobs, QUEUES.enrich, queued?.id ?? null);
    expect(job).toMatchObject({ state: "completed", retryCount: 1 });
    expect(await enrichJobs(jobs, item.versionId)).toHaveLength(1);
    expect(flaky.calls).toEqual([1, 2]);
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
      read: (work) => db.withTenant(t.tenantId, work),
      write: (work) => db.withTenant(t.tenantId, work),
      mayProcess: () => Promise.resolve(false),
      signal: new AbortController().signal,
    });
    // Another worker's supervisor finds the expired lease and puts the job back for a retry.
    const jobs = await start({ enrich, superviseIntervalSeconds: 1 });
    const job = await settled(jobs, QUEUES.enrich, claimed?.id ?? null);
    expect(job).toMatchObject({ state: "completed", retryCount: 1 });
    expect(await tagState(item.objectId)).toEqual(SPREADSHEET_TAGS);
  });

  it("writes nothing for a title a rename changed, enqueues again, processes the new one", async () => {
    const item = await ingestItem("Budget 2026.xlsx");
    let renamed: IngestResult | undefined;
    const jobs = await start({
      steps: [
        {
          name: "rename-once",
          async run() {
            if (renamed) return;
            // The source renames the file after the job read it; its connector enqueues as
            // usual. The rule tagger after this step would tag the old title: it must not.
            renamed = await ingestItem("Forecast 2026.xlsx", {
              externalId: item.externalId,
              blob: item.blob,
            });
            await jobs.enqueueAfterIngest(t.tenantId, renamed);
          },
        },
        ruleTagStep,
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
    // The replaced version is given up on, not processed: it leaves the sweep for good.
    expect(await processedAt(v1.versionId)).toBeNull();
    expect(await supersededAt(v1.versionId)).toBeInstanceOf(Date);
    expect(await processedAt(v2.versionId)).toBeInstanceOf(Date);
    expect(await supersededAt(v2.versionId)).toBeNull();
    expect(await enrichJobs(jobs, v1.versionId)).toHaveLength(1);
  });

  it("never lets a slow job for a replaced version overwrite the newer one's tags", async () => {
    const v1 = await ingestItem("Budget 2026.xlsx");
    // v1's job reads its target, then waits in a step until v2 is in and enriched.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const jobs = await start({
      enrich: { concurrency: 2 },
      steps: [
        {
          name: "pause-v1",
          async run({ target }) {
            if (target.versionId !== v1.versionId) return;
            entered();
            await gate;
          },
        },
        ruleTagStep,
      ],
    });
    await jobs.enqueueAfterIngest(t.tenantId, v1);
    await paused;
    // The source saves new content under a new name and type; its job runs and finishes.
    const v2 = await ingestItem("Budget 2026.docx", { externalId: v1.externalId });
    expect(v2).toMatchObject({ renamed: true, created: { version: true } });
    await jobs.enqueueAfterIngest(t.tenantId, v2);
    const two = await settled(
      jobs,
      QUEUES.enrich,
      (await enrichJobs(jobs, v2.versionId))[0]?.id ?? null,
    );
    expect(output(two)).toEqual({ outcome: "processed" });
    const newer = await tagState(v1.objectId);
    expect(newer.tags).toEqual([
      { facet: "kind", value: "document", source: "rule" },
      { facet: "topic", value: "budget", source: "rule" },
    ]);
    const [shown] = await nonReaderView(v1.objectId);
    expect(shown).toMatchObject({ title: "Budget 2026.docx", tags: ["kind:document"] });
    // v1's job goes on: its rule tagger finds v1 replaced and writes nothing.
    release();
    const one = await settled(
      jobs,
      QUEUES.enrich,
      (await enrichJobs(jobs, v1.versionId))[0]?.id ?? null,
    );
    expect(output(one)).toEqual({ outcome: "superseded" });
    expect(await tagState(v1.objectId)).toEqual(newer);
    expect(await nonReaderView(v1.objectId)).toEqual([shown]);
    // Superseded, so never enqueued again (not "renamed", though the title changed too).
    expect(await enrichJobs(jobs, v1.versionId)).toHaveLength(1);
    expect(await processedAt(v1.versionId)).toBeNull();
    expect(await supersededAt(v1.versionId)).toBeInstanceOf(Date);
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

  it("waits for a handler that outlives the stop timeout before it returns", async () => {
    const item = await ingestItem("Budget 2026.xlsx");
    let entered: () => void = () => {};
    const inStep = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finished = false;
    const jobs = await startJobs(db, {
      pollingIntervalSeconds: 0.5,
      maintenance: false,
      steps: [
        {
          name: "too-slow",
          async run() {
            entered();
            await new Promise((r) => setTimeout(r, 1_500));
            finished = true;
          },
        },
      ],
    });
    await jobs.enqueueAfterIngest(t.tenantId, item);
    await inStep;
    // pg-boss gives up after a second and fails the job (it runs again later); stop() still
    // waits for the handler, so nothing of it runs once the database is closed.
    await jobs.stop({ timeoutMs: 1_000, graceMs: 5_000 });
    expect(finished).toBe(true);
    // Told to stop (its signal), the job didn't go on to mark the version.
    expect(await processedAt(item.versionId)).toBeNull();
  });

  it.runIf(process.env[TEST_POSTGRES_ENV])(
    "gives pg-boss's own connections the application pool's session settings",
    async () => {
      const jobs = await start({ worker: false });
      const { rows } = await jobs.boss
        .getDb()
        .executeSql(
          "select current_setting('TimeZone') as tz, current_setting('statement_timeout') as st, " +
            "current_setting('idle_in_transaction_session_timeout') as idle",
        );
      expect(rows).toEqual([{ tz: "UTC", st: "1min", idle: "1min" }]);
    },
  );
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
      expect(done.output).toEqual({ sessions: 2, activity: 1, swept: 1, deadLettered: 0 });
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

  it("joins a job waiting out its retry delay without moving it, run after run", async () => {
    const item = await ingestItem("Budget 2026.xlsx");
    await backdate(t.tenantId, item.versionId, 2);
    const flaky = flakyStep(Infinity);
    const jobs = await start({
      steps: [flaky.step],
      enrich: { retryDelaySeconds: 3_600, retryLimit: 5 },
      maintenance: {},
    });
    await jobs.enqueueAfterIngest(t.tenantId, item);
    const [queued] = await enrichJobs(jobs, item.versionId);
    const waiting = await waitFor(async () => {
      const job = await jobs.boss.getJobById<unknown>(QUEUES.enrich, queued?.id ?? "");
      return job?.state === "retry" ? job : null;
    }, "the retry");
    // Three sweeps: the version is unprocessed and old enough each time.
    for (let run = 1; run <= 3; run++) {
      await settled(jobs, QUEUES.maintenance, await jobs.runMaintenance());
      await waitFor(async () => {
        const done = await jobs.boss.findJobs<unknown>(QUEUES.maintenanceTenant, {
          key: t.tenantId,
        });
        return done.filter((j) => j.state === "completed").length === run ? true : null;
      }, `sweep ${run}`);
    }
    const after = await jobs.boss.getJobById<unknown>(QUEUES.enrich, queued?.id ?? "");
    // Still the one job, still in its first retry delay, which no sweep cut short: no retry
    // spent (pg-boss counts one when a retry starts).
    expect(after).toMatchObject({ state: "retry", retryCount: 0 });
    expect(after?.startAfter).toEqual(waiting.startAfter);
    expect(await enrichJobs(jobs, item.versionId)).toHaveLength(1);
    expect(flaky.calls).toEqual([1]);
  });

  it("pages past dead letters to the lost versions behind them, up to its scan cap", async () => {
    const jobs = await start({ worker: false });
    // Oldest first: three versions whose job ran out of retries, then two lost ones.
    const failed = [];
    for (const [i, title] of ["Failed 1.xlsx", "Failed 2.xlsx", "Failed 3.xlsx"].entries()) {
      const v = await ingestItem(title);
      await backdate(t.tenantId, v.versionId, 10 - i);
      await jobs.boss.send(QUEUES.enrichFailed, { tenantId: t.tenantId, versionId: v.versionId });
      failed.push(v);
    }
    const lost = await ingestItem("Lost.xlsx");
    await backdate(t.tenantId, lost.versionId, 5);
    const waiting = await ingestItem("Waiting.xlsx");
    await backdate(t.tenantId, waiting.versionId, 4);
    await jobs.enqueueAfterIngest(t.tenantId, waiting);
    // Another tenant's dead letters don't count here.
    await jobs.boss.send(QUEUES.enrichFailed, {
      tenantId: newId("tenant"),
      versionId: lost.versionId,
    });
    expect(await deadLetteredVersions(jobs.boss, t.tenantId)).toEqual(
      new Set(failed.map((v) => v.versionId)),
    );
    const sweep = (more: MaintenanceOptions) =>
      maintainTenant(db, t.tenantId, maintenanceSettings(more), {
        requeue: (p) => jobs.enqueueVersion(p.tenantId, p.versionId),
        deadLettered: (tenantId) => deadLetteredVersions(jobs.boss, tenantId),
      });
    // A scan cap of three sees only dead letters: nothing enqueued, and nothing wrong.
    expect(await sweep({ sweepLimit: 1, sweepScanLimit: 3 })).toMatchObject({
      swept: 0,
      deadLettered: 3,
    });
    expect(await enrichJobs(jobs, lost.versionId)).toEqual([]);
    // With the default cap it reaches the lost one; the limit of one stops it there.
    expect(await sweep({ sweepLimit: 1 })).toMatchObject({ swept: 1, deadLettered: 3 });
    expect(await enrichJobs(jobs, lost.versionId)).toHaveLength(1);
    // The one whose job waits is enqueued too, into that same job: still one each.
    expect(await sweep({})).toMatchObject({ swept: 2, deadLettered: 3 });
    expect(await enrichJobs(jobs, lost.versionId)).toHaveLength(1);
    expect(await enrichJobs(jobs, waiting.versionId)).toHaveLength(1);
    for (const v of failed) expect(await enrichJobs(jobs, v.versionId)).toEqual([]);
  });

  it("leaves the cluster's schedule alone where maintenance is off", async () => {
    const jobs = await start({ maintenance: {} });
    expect(await jobs.boss.getSchedules(QUEUES.maintenance)).toHaveLength(1);
    await jobs.stop({ timeoutMs: 1_000 });
    const off = await start({ maintenance: false });
    expect((await off.boss.getSchedules(QUEUES.maintenance)).map((s) => s.cron)).toEqual([
      DEFAULT_MAINTENANCE_CRON,
    ]);
  });
});
