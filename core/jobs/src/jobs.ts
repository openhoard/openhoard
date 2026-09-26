import type { ContentSource, IngestResult } from "@openhoard/core-catalog";
import { insideWithTenant, isId, NestedWorkError, type Database } from "@openhoard/core-db";
import { queueConnectionOf } from "@openhoard/core-db/queue";
import { PgBoss, type ConstructorOptions, type Job, type Queue } from "pg-boss";
import {
  defaultEnrichSteps,
  enrichVersion,
  needsEnrichment,
  stepProviders,
  type EnrichPayload,
  type EnrichStep,
} from "./enrich.js";
import type { ExtractStepOptions } from "./extract.js";
import type { SummarizeStepOptions } from "./summarize.js";
import {
  maintainTenant,
  maintenanceSettings,
  type MaintenanceOptions,
  type TenantMaintenance,
} from "./maintenance.js";

/*
 * Background jobs on pg-boss (ADR-0008, T-401). pg-boss keeps its queues in the `pgboss` schema
 * of the application's own database, created on first start by the application's role (the
 * database's owner, never a superuser: core/db refuses those). That schema is outside row-level
 * security, so every job names its tenant, and every handler does its catalog work inside
 * db.withTenant(tenantId, …).
 *
 * Queues:
 *
 *   enrich              one job per (tenant, version); `stately`, keyed by tenant and version:
 *                       at most one job per key in each of the states created, retry and active.
 *                       Enqueueing goes through upsert(): a job that waits for the key, created
 *                       or waiting out a retry delay, is reused instead of getting a second one
 *                       beside it (and brought forward to run now, except by the sweep). (pg-boss 12.33 fails a job whose retry
 *                       collides with another retry of its key on job_i3, straight to failed and
 *                       the dead letter queue, retries unused: failJobsBody's ON CONFLICT DO
 *                       NOTHING.) With none waiting, a new one is queued, also while one runs (a
 *                       rename needs the run after it). Retries with exponential backoff, then
 *                       dead-letters.
 *   enrich-failed       the dead letter queue (its own partition): jobs that ran out of retries,
 *                       for an operator to look at and redrive. Nothing works it. The version
 *                       stays unprocessed, hidden from non-readers: fail-closed.
 *   maintenance         the cron job (hourly by default): fans out one job per tenant.
 *   maintenance-tenant  one tenant's maintenance (maintenance.ts); `stately`, keyed by tenant.
 *
 * Every process that ingests enqueues; `worker: true` processes also work the queues and keep
 * the schedule (pg-boss coordinates several such processes through the database).
 *
 * One narrow race remains. upsert() finds no waiting job and inserts one, as two statements; a
 * running job failing into its retry between the two leaves a retry and a new job side by side.
 * If the new one then fails too, it is dead-lettered with its retries unused, while the retry
 * still runs: the version is enriched all the same, and the sweep skips it only until it is.
 */

export const QUEUES = {
  enrich: "enrich",
  enrichFailed: "enrich-failed",
  maintenance: "maintenance",
  maintenanceTenant: "maintenance-tenant",
} as const;

/** A pino-shaped logger (the server passes its own); every method is optional. */
export interface JobsLogger {
  debug?(fields: object, message: string): void;
  info?(fields: object, message: string): void;
  warn?(fields: object, message: string): void;
  error?(fields: object, message: string): void;
}

export interface EnrichQueueOptions {
  /** Jobs one process runs at once. Default 2 on PostgreSQL, 1 on PGlite (one connection). */
  concurrency?: number;
  /** Runs after the first before a job is dead-lettered. Default 5. */
  retryLimit?: number;
  /** Delay before the first retry, in seconds; doubles each time (with jitter). Default 30. */
  retryDelaySeconds?: number;
  /** Longest delay between retries, in seconds. Default 3,600. */
  retryDelayMaxSeconds?: number;
  /** Double the delay on each retry. Default true. */
  retryBackoff?: boolean;
  /**
   * How long a job may run before it counts as crashed and is retried, in seconds. Default
   * 1,500 (25 minutes): the extract step's 13 minutes, the summarize step's 8, and room for the
   * rest (see the README's time budget).
   */
  expireInSeconds?: number;
}

export interface JobsOptions {
  /**
   * Work the queues and keep the schedule in this process. Default true (a single node). A
   * process that only ingests and enqueues sets false.
   */
  worker?: boolean;
  /**
   * The enrichment steps, in order. Default defaultEnrichSteps(): text extraction when
   * `content` is given, injection flagging, the rule tagger, and summaries when `summarize` is.
   */
  steps?: readonly EnrichStep[];
  /**
   * Where the default steps read versions' bytes (core/storage blobContentSource(), a
   * connector's source): with it, they extract text (T-402). Ignored when `steps` is given.
   */
  content?: ContentSource;
  /**
   * Summaries and model tags (T-405) with these providers and budget, for the default steps
   * with `content`. Without it, no model runs. Ignored when `steps` is given.
   */
  summarize?: SummarizeStepOptions;
  /**
   * The extract step's settings (with `content`): limits, and `indexedZones` to extract indexed
   * zones' content too (default off; managed zones always, local-only and code zones never).
   */
  extract?: Omit<ExtractStepOptions, "content">;
  enrich?: EnrichQueueOptions;
  /** Scheduled maintenance, or false for none. */
  maintenance?: (MaintenanceOptions & { cron?: string }) | false;
  /** How often an idle worker looks for jobs, in seconds (at least 0.5). Default 2. */
  pollingIntervalSeconds?: number;
  /**
   * How often a worker process looks for jobs whose run outlived `expireInSeconds` (a crashed
   * worker) and puts them back for a retry, in seconds (at least 1). Default 60.
   */
  superviseIntervalSeconds?: number;
  /** pg-boss's own connections on PostgreSQL. Default 4. */
  poolSize?: number;
  log?: JobsLogger;
}

/** Hourly, off the hour. */
export const DEFAULT_MAINTENANCE_CRON = "17 * * * *";

export interface Jobs {
  /**
   * Enqueues enrichment for one version. Returns the new job's id, or null when a job for it
   * already waited (created, or waiting out a retry delay): that one is brought forward to run
   * now instead. A running job doesn't count: the version may have changed since it started, so
   * a new job queues behind it. Call it after the transaction that created the version commits,
   * never inside withTenant().
   */
  enqueueVersion(tenantId: string, versionId: string): Promise<string | null>;
  /**
   * What connectors (and any other ingest caller) call after the ingest transaction commits:
   * enqueues the version when ingest made one or renamed the object, which both leave it
   * unprocessed. Returns whether it needed enrichment. Never inside withTenant(): an enqueue
   * there would not be part of the transaction, and on PGlite it would wait for it forever.
   */
  enqueueAfterIngest(
    tenantId: string,
    result: Pick<IngestResult, "versionId" | "created" | "renamed">,
  ): Promise<boolean>;
  /** Starts a maintenance run now, as the schedule does. Returns the job's id. */
  runMaintenance(): Promise<string | null>;
  /**
   * Stops working and closes pg-boss's connections. Running jobs get up to `timeoutMs` (default
   * 20 s) to finish; any still running then fail, to run again later, and are told to stop
   * (their signal); stop() then waits up to `graceMs` more (default 2 s) for their handlers to
   * return, so nothing of theirs touches the database after. Call it before closing the
   * database; it resolves within `timeoutMs + graceMs` and a little.
   */
  stop(options?: { timeoutMs?: number; graceMs?: number }): Promise<void>;
  /** The pg-boss instance, for operators' tools and tests (job states, dead letters). */
  readonly boss: PgBoss;
}

/**
 * Starts pg-boss on `db`: creates or migrates its schema and the queues, and with `worker` (the
 * default) starts the workers and the maintenance schedule.
 */
export async function startJobs(db: Database, options: JobsOptions = {}): Promise<Jobs> {
  if (insideWithTenant()) throw new NestedWorkError("startJobs()");
  const worker = options.worker !== false;
  const steps = [
    ...(options.steps ??
      defaultEnrichSteps({
        ...(options.content === undefined ? {} : { content: options.content }),
        ...(options.extract === undefined ? {} : { extract: options.extract }),
        ...(options.summarize === undefined ? {} : { summarize: options.summarize }),
      })),
  ];
  const names = new Set<string>();
  for (const step of steps) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(step.name) || names.has(step.name)) {
      throw new TypeError(`enrichment step names must be distinct slugs: ${step.name}`);
    }
    names.add(step.name);
    // A provider of a kind nobody knows would be skipped every time (mayProcess() refuses it):
    // said at start, not found missing in every job's output.
    if (step.provider !== undefined && step.providers !== undefined) {
      throw new TypeError(`enrichment step ${step.name}: provider or providers, not both`);
    }
    if (
      stepProviders(step).some(
        (p) => !["local", "commercial", "consumer"].includes(p.kind as string),
      )
    ) {
      throw new TypeError(
        `enrichment step ${step.name}: a provider is local, commercial or consumer`,
      );
    }
  }
  const maintenance =
    options.maintenance === false ? false : maintenanceSettings(options.maintenance ?? {});
  const cron =
    options.maintenance === false
      ? undefined
      : (options.maintenance?.cron ?? DEFAULT_MAINTENANCE_CRON);
  const enrich = enrichQueue(options.enrich, db.kind);
  const polling = options.pollingIntervalSeconds ?? 2;
  if (!(polling >= 0.5)) throw new RangeError("pollingIntervalSeconds must be at least 0.5");
  const supervise = options.superviseIntervalSeconds ?? 60;
  if (!Number.isSafeInteger(supervise) || supervise < 1 || supervise > 3_600) {
    throw new RangeError("superviseIntervalSeconds must be a whole number from 1 to 3600");
  }
  const log = options.log ?? {};

  const connection = queueConnectionOf(db);
  const common: ConstructorOptions = {
    schema: "pgboss",
    // Workers and the schedule only where asked; any process may send.
    supervise: worker,
    schedule: worker,
    superviseIntervalSeconds: supervise,
    monitorIntervalSeconds: supervise,
    // Rebuilding indexes CONCURRENTLY is for a busy server's operator, not for the embedded one.
    ...(connection.kind === "pglite" ? { reindex: false } : {}),
  };
  const boss = new PgBoss(
    connection.kind === "pglite"
      ? { ...common, backend: "pglite", db: { executeSql: connection.executeSql } }
      : {
          ...common,
          connectionString: connection.connectionString,
          // The application pool's session settings: UTC (spike S2) and its timeouts.
          options: connection.options,
          connectionTimeoutMillis: connection.connectionTimeoutMillis,
          max: options.poolSize ?? 4,
          application_name: "openhoard-jobs",
        },
  );
  // Without a listener an 'error' event would crash the process.
  boss.on("error", (err) => log.error?.({ err }, "job queue error"));
  boss.on("warning", (warning) => log.warn?.({ warning }, "job queue warning"));

  await boss.start();
  // Handlers running now, so stop() can wait for them after pg-boss gave up on them.
  const running = new Set<Promise<unknown>>();
  const tracked =
    <A extends unknown[], R>(handler: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      const run = handler(...args);
      const settled = run.then(
        () => {},
        () => {},
      );
      running.add(settled);
      void settled.then(() => running.delete(settled));
      return run;
    };
  try {
    // Its own partition: the sweep's per-tenant lookup reads dead letters only.
    await ensureQueue(boss, QUEUES.enrichFailed, { policy: "standard", partition: true });
    await ensureQueue(boss, QUEUES.enrich, {
      policy: "stately",
      deadLetter: QUEUES.enrichFailed,
      ...enrich.queue,
    });
    await ensureQueue(boss, QUEUES.maintenance, { policy: "stately", retryLimit: 1 });
    await ensureQueue(boss, QUEUES.maintenanceTenant, {
      policy: "stately",
      retryLimit: 2,
      retryDelay: 60,
      expireInSeconds: 3600,
    });

    /**
     * A job waiting for the key (created, or in its retry delay) is reused rather than joined
     * by a second one; see the header. `pullForward` also moves its start to now: right for a
     * new version or a rename, which may have changed what failed, and wrong for the sweep,
     * which would otherwise cut every backoff short and spend a retry each run.
     */
    const enqueue = async (tenantId: string, versionId: string, pullForward: boolean) => {
      const payload = { tenantId, versionId };
      if (!isId("tenant", tenantId) || !isId("version", versionId)) {
        throw new TypeError("enqueueVersion: expects a tenant id and a version id");
      }
      if (insideWithTenant()) throw new NestedWorkError("enqueueVersion()");
      const done = await boss.upsert(QUEUES.enrich, payload, {
        singletonKey: enrichKey(payload),
        // Without startAfter, pg-boss's update keeps the waiting job's start_after.
        ...(pullForward ? { startAfter: 0 } : {}),
      });
      return done.inserted > 0 ? (done.jobs[0] ?? null) : null;
    };
    const enqueueVersion = (tenantId: string, versionId: string) =>
      enqueue(tenantId, versionId, true);

    if (worker) {
      await boss.work<unknown>(
        QUEUES.enrich,
        { localConcurrency: enrich.concurrency, pollingIntervalSeconds: polling },
        tracked(async ([job]) => runEnrichJob(db, steps, job as Job<unknown>, enqueueVersion, log)),
      );
      if (maintenance) {
        await boss.work<unknown>(
          QUEUES.maintenance,
          { pollingIntervalSeconds: polling },
          tracked(async () => {
            const tenants = await fanOut(db, (tenantId) =>
              boss.send(QUEUES.maintenanceTenant, { tenantId }, { singletonKey: tenantId }),
            );
            log.info?.({ tenants }, "maintenance scheduled for every tenant");
            return { tenants };
          }),
        );
        await boss.work<unknown>(
          QUEUES.maintenanceTenant,
          { pollingIntervalSeconds: polling },
          tracked(async ([job]) => {
            const tenantId = (job?.data as { tenantId?: unknown } | undefined)?.tenantId;
            if (typeof tenantId !== "string" || !isId("tenant", tenantId)) {
              log.warn?.({ job: job?.id }, "maintenance job without a tenant: skipped");
              return { skipped: true };
            }
            const done: TenantMaintenance = await maintainTenant(db, tenantId, maintenance, {
              // Joins a waiting job without moving it: its backoff stands.
              requeue: (p) => enqueue(p.tenantId, p.versionId, false),
              deadLettered: (t) => deadLetteredVersions(boss, t),
            });
            log.info?.({ tenantId, ...done }, "tenant maintenance done");
            return done;
          }),
        );
        await boss.schedule(QUEUES.maintenance, cron ?? DEFAULT_MAINTENANCE_CRON, null, {
          tz: "UTC",
        });
      }
      // With maintenance off here, the schedule is left as it is: it is the cluster's, and
      // another node may keep it.
    }

    return {
      boss,
      enqueueVersion,
      async enqueueAfterIngest(tenantId, result) {
        if (!needsEnrichment(result)) return false;
        await enqueueVersion(tenantId, result.versionId);
        return true;
      },
      runMaintenance() {
        if (insideWithTenant()) throw new NestedWorkError("runMaintenance()");
        return boss.send(QUEUES.maintenance, {});
      },
      async stop({ timeoutMs = 20_000, graceMs = 2_000 } = {}) {
        await boss.stop({ graceful: true, timeout: timeoutMs, close: true });
        // pg-boss has failed and aborted what outlived the timeout, but not waited for it.
        if (running.size > 0) {
          let timer: NodeJS.Timeout | undefined;
          const grace = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, graceMs);
          });
          await Promise.race([Promise.all(running), grace]);
          clearTimeout(timer);
          if (running.size > 0) {
            log.warn?.({ handlers: running.size }, "job handlers still running after stop");
          }
        }
      },
    };
  } catch (e) {
    await boss.stop({ graceful: false }).catch(() => {});
    throw e;
  }
}

/** The key that makes one enrichment job per version and tenant. */
export function enrichKey(payload: EnrichPayload): string {
  return `${payload.tenantId}/${payload.versionId}`;
}

/** One enrichment job, as the worker runs it; its outcome becomes the job's output. */
async function runEnrichJob(
  db: Database,
  steps: readonly EnrichStep[],
  job: Job<unknown>,
  enqueueVersion: (tenantId: string, versionId: string) => Promise<string | null>,
  log: JobsLogger,
) {
  // Steps skipped for the file's exposure: in the job's output and the log, where an operator
  // looking for a missing summary finds why (T-604).
  const withheld: { step: string; provider: string; exposure: string | null }[] = [];
  const outcome = await enrichVersion(db, steps, job.data, {
    signal: job.signal,
    requeue: (p) => enqueueVersion(p.tenantId, p.versionId),
    onWithheld: (w) =>
      withheld.push({ step: w.step, provider: w.provider.id, exposure: w.exposure }),
  });
  if (outcome === "invalid") {
    log.warn?.({ job: job.id, outcome }, "enrichment job without a tenant and version");
  } else {
    const { tenantId, versionId } = job.data as EnrichPayload;
    if (withheld.length > 0) {
      log.info?.({ job: job.id, tenantId, versionId, withheld }, "enrichment: content withheld");
    }
    log.debug?.({ job: job.id, tenantId, versionId, outcome }, "enrichment job done");
  }
  return withheld.length > 0 ? { outcome, withheld } : { outcome };
}

/**
 * The tenant's versions whose job waits in the dead letter queue: one read of that queue's own
 * partition per tenant and run, bounded by what pg-boss retains there (14 days by default).
 */
export async function deadLetteredVersions(
  boss: PgBoss,
  tenantId: string,
): Promise<ReadonlySet<string>> {
  const dead = await boss.findJobs<unknown>(QUEUES.enrichFailed, {
    data: { tenantId },
    queued: true,
  });
  const ids = new Set<string>();
  for (const job of dead) {
    const versionId = (job.data as { versionId?: unknown } | null)?.versionId;
    if (typeof versionId === "string") ids.add(versionId);
  }
  return ids;
}

/** Sends one job per tenant, a page of ids at a time; returns how many tenants. */
async function fanOut(db: Database, send: (tenantId: string) => Promise<unknown>) {
  let after: string | undefined;
  let count = 0;
  for (;;) {
    const page = await db.tenantIds(
      after === undefined ? { limit: 1_000 } : { after, limit: 1_000 },
    );
    for (const tenantId of page) await send(tenantId);
    count += page.length;
    if (page.length < 1_000) return count;
    after = page[page.length - 1];
  }
}

/** Creates the queue, or brings an existing one's settings up to date. */
async function ensureQueue(
  boss: PgBoss,
  name: string,
  options: Omit<Queue, "name" | "retryDelayMax"> & { retryDelayMax?: number | null },
) {
  // pg-boss takes null for "no maximum" in both (its types only say so for updateQueue).
  await boss.createQueue(name, options as Omit<Queue, "name">);
  // A queue's policy and partitioning are fixed at creation; the rest follows the options.
  const { policy: _policy, partition: _partition, ...changeable } = options;
  if (Object.keys(changeable).length > 0) await boss.updateQueue(name, changeable);
}

function enrichQueue(options: EnrichQueueOptions = {}, kind: Database["kind"]) {
  const o = {
    concurrency: options.concurrency ?? (kind === "pglite" ? 1 : 2),
    retryLimit: options.retryLimit ?? 5,
    retryDelaySeconds: options.retryDelaySeconds ?? 30,
    retryDelayMaxSeconds: options.retryDelayMaxSeconds ?? 3_600,
    retryBackoff: options.retryBackoff ?? true,
    expireInSeconds: options.expireInSeconds ?? 1_500,
  };
  const whole = (key: keyof typeof o, min: number, max: number) => {
    const value = o[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new RangeError(`enrich.${key} must be a whole number from ${min} to ${max}`);
    }
  };
  whole("concurrency", 1, 64);
  whole("retryLimit", 0, 100);
  whole("retryDelaySeconds", 0, 86_400);
  whole("retryDelayMaxSeconds", 1, 7 * 86_400);
  whole("expireInSeconds", 1, 86_400);
  return {
    concurrency: o.concurrency,
    queue: {
      retryLimit: o.retryLimit,
      retryDelay: o.retryDelaySeconds,
      retryBackoff: o.retryBackoff,
      // Only with backoff; without, the delay is fixed.
      retryDelayMax: o.retryBackoff ? o.retryDelayMaxSeconds : null,
      expireInSeconds: o.expireInSeconds,
    },
  };
}
