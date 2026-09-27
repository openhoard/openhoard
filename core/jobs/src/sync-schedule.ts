import { appendAudit } from "@openhoard/core-audit";
import type { IngestResult } from "@openhoard/core-catalog";
import { isId, isRetryable, type Database } from "@openhoard/core-db";
import type { Connector } from "@openhoard/sdk";
import type { JobsLogger } from "./jobs.js";
import { recordSyncRun, sourceStopped } from "./sync-admin.js";
import { runSync, type SyncOptions, type SyncReport } from "./sync.js";

/*
 * Scheduled connector syncs (T-303): the `sync` queue's jobs, one source each.
 *
 * - The queue is `stately`, keyed by tenant and source: at most one job per source waits and
 *   one runs, which runSync() relies on (two runs at once could save each other's tokens out of
 *   order). Its lease (`expireInSeconds`) is above the `budgetMs` a run gets, so a run stops at
 *   a checkpoint before its lease ends and never runs twice.
 * - Each configured source has a schedule of its own (pg-boss `schedule`, keyed by tenant and
 *   source, in UTC), which sends its job; `requestSync()` sends one now (an admin's `run-now`,
 *   connectorContentSource's `onStale`, the server's start). A job already waiting for the
 *   source is reused and brought forward, never doubled.
 * - A run ends as runSync() reports, and the job then:
 *
 *   | status      | the job                                                           |
 *   | ----------- | ----------------------------------------------------------------- |
 *   | `done`      | waits for the next schedule                                       |
 *   | `partial`   | sends the next run now (a waiting one is brought forward)         |
 *   | `retry`     | sends the next run after `retryAfterMs` (a waiting one waits too) |
 *   | `failed`    | stops the source (audited): runs skip it until an admin acts      |
 *   | `cancelled` | resumes from its checkpoint on the next run                       |
 *
 * - Every run records how it ended in `source_syncs` (codes and counts only), for admins. A
 *   failed run stops the source (`stopped_at`) and writes `source.sync-stopped` to the audit log,
 *   in the same transaction; runs skip a stopped source without touching it, until an admin
 *   resumes it (`admin source resume`) or acts on what failed (`confirm-reconcile`,
 *   `discard-reconcile`, `accept-identity`). A run that fails again stops it again.
 * - A source whose owner isn't known yet (nobody signed in as them) is waited for: the run is
 *   recorded as `retry` / `unknown-owner`, and the schedule tries again.
 * - A run that fails before the source was ever bound (no row to stop: an unknown zone) is
 *   audited and its schedule dropped, until the next start schedules it again.
 * - runSync() throws only for its own failures (the database unreachable, a bug): the job then
 *   fails, and pg-boss retries it a little later.
 */

/** A source the server syncs on a schedule. */
export interface ScheduledSource {
  tenantId: string;
  /** The connection's name, a lower-case slug: the `source` of its items. */
  source: string;
  zoneId: string;
  /** Standard cron (five fields), in UTC. */
  cron: string;
  /** The connector serving the source (one instance, reused by every run). */
  connector: Connector;
  /**
   * The owner of new objects, `user:usr_…`, or null while they aren't known (the server
   * resolves a configured email to the person once they exist).
   */
  owner: () => Promise<string | null>;
  reconcileGuard?: SyncOptions["reconcileGuard"];
}

export interface SyncQueueOptions {
  sources: readonly ScheduledSource[];
  /** The tenant's 32-byte blob key (core/catalog blobIdOf()). */
  tenantKey: (tenantId: string) => Uint8Array | Promise<Uint8Array>;
  /** How long one run may go on before it stops at a checkpoint, in ms. Default 10 minutes. */
  budgetMs?: number;
  /**
   * How long a run may hold the job before it counts as crashed, in seconds. Default 15
   * minutes; at least `budgetMs` and a minute more (a run stops only at a checkpoint).
   */
  expireInSeconds?: number;
  /** Runs one process does at once. Default 1. */
  concurrency?: number;
}

/** The payload of a sync job. */
export interface SyncPayload {
  tenantId: string;
  source: string;
}

export const SYNC_SOURCE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const SYNC_BUDGET_MS = 10 * 60_000;
export const SYNC_EXPIRE_SECONDS = 15 * 60;
/** Who stops a source in the audit log. */
export const SYNC_ACTOR = "system:sync";

/** The key that makes one job per source: tenant and source. Also the schedule's key. */
export function syncKey(payload: SyncPayload): string {
  return `${payload.tenantId}/${payload.source}`;
}

export function isSyncPayload(data: unknown): data is SyncPayload {
  if (typeof data !== "object" || data === null) return false;
  const { tenantId, source } = data as Record<string, unknown>;
  return (
    typeof tenantId === "string" &&
    isId("tenant", tenantId) &&
    typeof source === "string" &&
    SYNC_SOURCE.test(source)
  );
}

/** Checks the queue's settings; returns them with their defaults. */
export function syncSettings(options: SyncQueueOptions) {
  const budgetMs = options.budgetMs ?? SYNC_BUDGET_MS;
  const expireInSeconds = options.expireInSeconds ?? SYNC_EXPIRE_SECONDS;
  const concurrency = options.concurrency ?? 1;
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1_000 || budgetMs > 6 * 3_600_000) {
    throw new RangeError("sync.budgetMs must be a whole number from 1,000 to 21,600,000");
  }
  if (
    !Number.isSafeInteger(expireInSeconds) ||
    expireInSeconds > 86_400 ||
    expireInSeconds < Math.ceil(budgetMs / 1000) + 60
  ) {
    throw new RangeError("sync.expireInSeconds must be at least budgetMs and a minute more");
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new RangeError("sync.concurrency must be a whole number from 1 to 16");
  }
  const sources = new Map<string, ScheduledSource>();
  for (const s of options.sources) {
    if (!isSyncPayload(s) || !isId("zone", s.zoneId)) {
      throw new TypeError(`sync source ${String(s.source)}: a tenant id, a source slug, a zone id`);
    }
    const key = syncKey(s);
    if (sources.has(key)) throw new TypeError(`sync source ${s.source} is configured twice`);
    sources.set(key, s);
  }
  return { budgetMs, expireInSeconds, concurrency, sources };
}

/** How a sync job ended (its output). */
export type SyncJobOutcome =
  | { outcome: "ran"; status: SyncReport["status"]; error?: string; next?: "now" | number }
  | { outcome: "stopped" | "unconfigured" | "invalid" | "unknown-owner" };

/** What a sync job needs from the queue around it. */
export interface SyncJobDeps {
  db: Database;
  settings: ReturnType<typeof syncSettings>;
  tenantKey: SyncQueueOptions["tenantKey"];
  enqueue: (
    tenantId: string,
    result: Pick<IngestResult, "versionId" | "created" | "renamed">,
  ) => Promise<unknown>;
  /** Sends the source's next run after `delayMs` (0: now), reusing a waiting one. */
  next: (payload: SyncPayload, delayMs: number) => Promise<unknown>;
  /** Drops the source's schedule (a failure before it was ever bound). */
  unschedule?: (payload: SyncPayload) => Promise<unknown>;
  log: JobsLogger;
}

/** One scheduled run of one source (see the header). */
export async function runSyncJob(
  deps: SyncJobDeps,
  data: unknown,
  signal: AbortSignal,
): Promise<SyncJobOutcome> {
  const { db, settings, log } = deps;
  if (!isSyncPayload(data)) {
    log.warn?.({}, "sync job without a tenant and a source: skipped");
    return { outcome: "invalid" };
  }
  const { tenantId, source } = data;
  const configured = settings.sources.get(syncKey(data));
  if (!configured) {
    // Taken out of the configuration since its job was sent.
    log.warn?.({ tenantId, source }, "sync job for a source that isn't configured: skipped");
    return { outcome: "unconfigured" };
  }
  const stopped = await db.withTenant(tenantId, (tx) => sourceStopped(tx, tenantId, source), {
    accessMode: "read only",
  });
  if (stopped === true) {
    log.debug?.({ tenantId, source }, "sync: the source is stopped until an admin acts");
    return { outcome: "stopped" };
  }
  const owner = await configured.owner();
  if (owner === null) {
    await record(deps, data, { status: "retry", error: "unknown-owner" });
    log.warn?.({ tenantId, source }, "sync: the source's owner isn't known yet (not signed in)");
    return { outcome: "unknown-owner" };
  }
  const report = await runSync(db, {
    tenantId,
    source,
    zoneId: configured.zoneId,
    connector: configured.connector,
    ownerId: owner,
    tenantKey: deps.tenantKey,
    enqueue: deps.enqueue,
    signal,
    budgetMs: settings.budgetMs,
    ...(configured.reconcileGuard === undefined
      ? {}
      : { reconcileGuard: configured.reconcileGuard }),
    log,
  });
  const recorded = await record(deps, data, {
    status: report.status,
    ...(report.error === undefined ? {} : { error: report.error }),
    counts: {
      ...report.counts,
      ...(report.reconcileHeld === undefined ? {} : { held: report.reconcileHeld }),
    },
  });
  if (report.status === "failed" && !recorded) {
    // Never bound (an unknown zone, say): nothing to mark stopped, so its schedule goes, until
    // the next start schedules it again (and the server binds, or refuses, it first).
    await deps.unschedule?.(data);
  }
  const out: SyncJobOutcome = {
    outcome: "ran",
    status: report.status,
    ...(report.error === undefined ? {} : { error: report.error }),
  };
  if (report.status === "partial") {
    await deps.next(data, 0);
    return { ...out, next: "now" };
  }
  if (report.status === "retry") {
    const delay = Math.max(1_000, report.retryAfterMs ?? 60_000);
    await deps.next(data, delay);
    return { ...out, next: delay };
  }
  return out;
}

/**
 * Records the run in source_syncs; a failure also stops the source and is audited, in the same
 * transaction. Retried on a deadlock or a serialization failure.
 */
async function record(
  deps: SyncJobDeps,
  payload: SyncPayload,
  run: { status: SyncReport["status"]; error?: string; counts?: Record<string, number> },
): Promise<boolean> {
  const { db, log } = deps;
  const { tenantId, source } = payload;
  for (let attempt = 1; ; attempt++) {
    try {
      const done = await db.withTenant(tenantId, async (tx) => {
        const recorded = await recordSyncRun(tx, tenantId, source, run);
        if (run.status === "failed" && (recorded.stopped || !recorded.recorded)) {
          await appendAudit(tx, tenantId, {
            actor: SYNC_ACTOR,
            action: "source.sync-stopped",
            decision: "deny",
            detail: {
              source,
              reason: run.error ?? "failed",
              ...(recorded.recorded ? {} : { unbound: true }),
            },
          });
        }
        return recorded;
      });
      if (run.status === "failed") {
        log.error?.(
          { tenantId, source, error: run.error },
          done.recorded
            ? "sync failed: the source is stopped until an admin acts"
            : "sync failed before the source was bound (see the audit log)",
        );
      }
      return done.recorded;
    } catch (e) {
      if (!isRetryable(e) || attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 20 * attempt));
    }
  }
}
