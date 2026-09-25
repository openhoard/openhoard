import type { IngestResult } from "@openhoard/core-catalog";
import { insideWithTenant, isId, NestedWorkError, type Database } from "@openhoard/core-db";
import { PgBoss, type ConstructorOptions, type Job, type Queue } from "pg-boss";
import {
  defaultEnrichSteps,
  enrichVersion,
  needsEnrichment,
  type EnrichPayload,
  type EnrichStep,
} from "./enrich.js";
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
 *   enrich              one job per (tenant, version); `stately`, keyed by tenant and version, so
 *                       at most one waits and one runs per version: enqueueing it again while one
 *                       waits changes nothing, and while one runs queues exactly one more (a
 *                       rename needs it). Retries with exponential backoff, then dead-letters.
 *   enrich-failed       the dead letter queue: jobs that ran out of retries, for an operator to
 *                       look at and redrive. Nothing works it. The version stays unprocessed,
 *                       hidden from non-readers: fail-closed.
 *   maintenance         the cron job (hourly by default): fans out one job per tenant.
 *   maintenance-tenant  one tenant's maintenance (maintenance.ts); `stately`, keyed by tenant.
 *
 * Every process that ingests enqueues; `worker: true` processes also work the queues and keep
 * the schedule (pg-boss coordinates several such processes through the database).
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
  /** How long a job may run before it counts as crashed and is retried, in seconds. Default 900. */
  expireInSeconds?: number;
}

export interface JobsOptions {
  /**
   * Work the queues and keep the schedule in this process. Default true (a single node). A
   * process that only ingests and enqueues sets false.
   */
  worker?: boolean;
  /** The enrichment steps, in order. Default defaultEnrichSteps(): the rule tagger. */
  steps?: readonly EnrichStep[];
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
   * Enqueues enrichment for one version. Returns the job's id, or null when a job for it already
   * waits (a running one doesn't count: the version may have changed since it started). Call it
   * after the transaction that created the version commits, never inside withTenant().
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
   * Stops working (waiting up to `timeoutMs`, default 20 s, for running jobs; any still running
   * then fail and run again later) and closes pg-boss's connections. Call it before closing the
   * database.
   */
  stop(options?: { timeoutMs?: number }): Promise<void>;
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
  const steps = [...(options.steps ?? defaultEnrichSteps())];
  const names = new Set<string>();
  for (const step of steps) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(step.name) || names.has(step.name)) {
      throw new TypeError(`enrichment step names must be distinct slugs: ${step.name}`);
    }
    names.add(step.name);
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

  const connection = db.queueConnection();
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
          max: options.poolSize ?? 4,
          application_name: "openhoard-jobs",
        },
  );
  // Without a listener an 'error' event would crash the process.
  boss.on("error", (err) => log.error?.({ err }, "job queue error"));
  boss.on("warning", (warning) => log.warn?.({ warning }, "job queue warning"));

  await boss.start();
  try {
    await ensureQueue(boss, QUEUES.enrichFailed, { policy: "standard" });
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

    const enqueueVersion = async (tenantId: string, versionId: string) => {
      const payload = { tenantId, versionId };
      if (!isId("tenant", tenantId) || !isId("version", versionId)) {
        throw new TypeError("enqueueVersion: expects a tenant id and a version id");
      }
      if (insideWithTenant()) throw new NestedWorkError("enqueueVersion()");
      return boss.send(QUEUES.enrich, payload, { singletonKey: enrichKey(payload) });
    };

    if (worker) {
      await boss.work<unknown>(
        QUEUES.enrich,
        { localConcurrency: enrich.concurrency, pollingIntervalSeconds: polling },
        async ([job]) => runEnrichJob(db, steps, job as Job<unknown>, enqueueVersion, log),
      );
      if (maintenance) {
        await boss.work<unknown>(
          QUEUES.maintenance,
          { pollingIntervalSeconds: polling },
          async () => {
            const tenants = await fanOut(db, (tenantId) =>
              boss.send(QUEUES.maintenanceTenant, { tenantId }, { singletonKey: tenantId }),
            );
            log.info?.({ tenants }, "maintenance scheduled for every tenant");
            return { tenants };
          },
        );
        await boss.work<unknown>(
          QUEUES.maintenanceTenant,
          { pollingIntervalSeconds: polling },
          async ([job]) => {
            const tenantId = (job?.data as { tenantId?: unknown } | undefined)?.tenantId;
            if (typeof tenantId !== "string" || !isId("tenant", tenantId)) {
              log.warn?.({ job: job?.id }, "maintenance job without a tenant: skipped");
              return { skipped: true };
            }
            const done: TenantMaintenance = await maintainTenant(db, tenantId, maintenance, {
              requeue: (p) => enqueueVersion(p.tenantId, p.versionId),
              waiting: (p) => enrichmentWaiting(boss, p),
            });
            log.info?.({ tenantId, ...done }, "tenant maintenance done");
            return done;
          },
        );
        await boss.schedule(QUEUES.maintenance, cron ?? DEFAULT_MAINTENANCE_CRON, null, {
          tz: "UTC",
        });
      } else {
        await boss.unschedule(QUEUES.maintenance);
      }
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
      stop: ({ timeoutMs = 20_000 } = {}) =>
        boss.stop({ graceful: true, timeout: timeoutMs, close: true }),
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
  const outcome = await enrichVersion(db, steps, job.data, {
    signal: job.signal,
    requeue: (p) => enqueueVersion(p.tenantId, p.versionId),
  });
  if (outcome === "invalid") {
    log.warn?.({ job: job.id, outcome }, "enrichment job without a tenant and version");
  } else {
    const { tenantId, versionId } = job.data as EnrichPayload;
    log.debug?.({ job: job.id, tenantId, versionId, outcome }, "enrichment job done");
  }
  return { outcome };
}

/**
 * Whether a job for this version waits in the enrichment queue (queued, running or retrying),
 * or ran out of retries and waits in the dead letter queue.
 */
async function enrichmentWaiting(boss: PgBoss, payload: EnrichPayload): Promise<boolean> {
  const live = await boss.findJobs(QUEUES.enrich, { key: enrichKey(payload) });
  if (live.some((j) => j.state === "created" || j.state === "retry" || j.state === "active")) {
    return true;
  }
  const dead = await boss.findJobs(QUEUES.enrichFailed, { data: payload, queued: true });
  return dead.length > 0;
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
    expireInSeconds: options.expireInSeconds ?? 900,
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
