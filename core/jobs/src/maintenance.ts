import { pruneActivity } from "@openhoard/core-catalog";
import { versions, type Database } from "@openhoard/core-db";
import { pruneSessions } from "@openhoard/core-identity";
import { and, asc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { EnrichPayload } from "./enrich.js";

/*
 * Scheduled maintenance (T-401): per tenant, in bounded batches, each batch its own short
 * transaction, so one tenant with a large backlog neither holds a transaction open for long
 * nor starves the others. What doesn't fit in one run is left for the next.
 *
 * - Sessions (core/identity) that ended more than `sessionRetentionDays` ago go. The audit log
 *   keeps sign-ins and sign-outs; the rows are only needed while a session can still be used.
 * - Activity events (core/catalog) older than `activityRetentionDays` go.
 * - The sweep finds current versions left unprocessed for longer than `sweepAfterMinutes` and
 *   enqueues them again. Enqueueing happens after ingest commits, so a crash in between loses the
 *   job, and the file would stay hidden for good; the sweep brings it back. Versions whose job
 *   ran out of retries wait in the dead-letter queue instead: the sweep leaves them alone until
 *   an operator redrives them or pg-boss's retention drops them (14 days by default), and then
 *   tries once more.
 */

export interface MaintenanceOptions {
  /** How long ended sessions are kept, in days. Default 30. */
  sessionRetentionDays?: number;
  /** How long activity events are kept, in days. Default 400 (a year and a margin). */
  activityRetentionDays?: number;
  /** Rows one transaction deletes. Default 1,000. */
  batchSize?: number;
  /** Batches one run takes per kind of row and tenant. Default 10. */
  maxBatches?: number;
  /** How long a current version may stay unprocessed before the sweep enqueues it. Default 60. */
  sweepAfterMinutes?: number;
  /** Versions one run of the sweep enqueues per tenant. Default 100. */
  sweepLimit?: number;
}

export const MAINTENANCE_DEFAULTS: Readonly<Required<MaintenanceOptions>> = {
  sessionRetentionDays: 30,
  activityRetentionDays: 400,
  batchSize: 1_000,
  maxBatches: 10,
  sweepAfterMinutes: 60,
  sweepLimit: 100,
};

const LIMITS: Record<keyof MaintenanceOptions, [number, number]> = {
  sessionRetentionDays: [1, 3650],
  activityRetentionDays: [1, 3650],
  batchSize: [1, 100_000],
  maxBatches: [1, 1_000],
  sweepAfterMinutes: [1, 7 * 24 * 60],
  sweepLimit: [0, 10_000],
};

/** The settings for `options`: the defaults, overridden by what it sets, each checked. */
export function maintenanceSettings(
  options: MaintenanceOptions = {},
): Required<MaintenanceOptions> {
  const set = Object.entries(options).filter(([, v]) => v !== undefined);
  const o = { ...MAINTENANCE_DEFAULTS, ...Object.fromEntries(set) } as Required<MaintenanceOptions>;
  for (const [key, [min, max]] of Object.entries(LIMITS) as [
    keyof MaintenanceOptions,
    [number, number],
  ][]) {
    const value = o[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new RangeError(`maintenance.${key} must be a whole number from ${min} to ${max}`);
    }
  }
  return o;
}

/** What one tenant's maintenance run did. */
export interface TenantMaintenance {
  sessions: number;
  activity: number;
  /** Versions the sweep enqueued again (or found queued already). */
  swept: number;
}

/**
 * Runs one tenant's maintenance. `requeue` enqueues a version for enrichment, and `waiting`
 * says whether one already waits (queued, running, or dead-lettered), so the sweep skips it.
 */
export async function maintainTenant(
  db: Database,
  tenantId: string,
  options: Required<MaintenanceOptions>,
  queue: {
    requeue: (payload: EnrichPayload) => Promise<unknown>;
    waiting: (payload: EnrichPayload) => Promise<boolean>;
  },
): Promise<TenantMaintenance> {
  const day = 24 * 60 * 60 * 1000;
  const sessionsBefore = new Date(Date.now() - options.sessionRetentionDays * day);
  const activityBefore = new Date(Date.now() - options.activityRetentionDays * day);
  const sessions = await inBatches(options, () =>
    db.withTenant(tenantId, (tx) => pruneSessions(tx, tenantId, sessionsBefore, options.batchSize)),
  );
  const activity = await inBatches(options, () =>
    db.withTenant(tenantId, (tx) => pruneActivity(tx, tenantId, activityBefore, options.batchSize)),
  );
  let swept = 0;
  for (const versionId of await unprocessedVersions(db, tenantId, options)) {
    const payload = { tenantId, versionId };
    if (await queue.waiting(payload)) continue;
    await queue.requeue(payload);
    swept++;
  }
  return { sessions, activity, swept };
}

/** Runs `batch` until it removes less than a batch, or `maxBatches` times; returns the total. */
async function inBatches(
  options: Required<MaintenanceOptions>,
  batch: () => Promise<number>,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < options.maxBatches; i++) {
    const n = await batch();
    total += n;
    if (n < options.batchSize) break;
  }
  return total;
}

/**
 * Current versions (no later version of their object) still unprocessed, created more than
 * `sweepAfterMinutes` ago, oldest first; at most `sweepLimit`. A renamed version counts from its
 * creation, so it may be enqueued while its job waits: the queue collapses that.
 */
export async function unprocessedVersions(
  db: Database,
  tenantId: string,
  options: Pick<Required<MaintenanceOptions>, "sweepAfterMinutes" | "sweepLimit">,
): Promise<string[]> {
  if (options.sweepLimit === 0) return [];
  const later = alias(versions, "later");
  const rows = await db.withTenant(
    tenantId,
    (tx) =>
      tx
        .select({ id: versions.id })
        .from(versions)
        .where(
          and(
            eq(versions.tenantId, tenantId),
            isNull(versions.processedAt),
            lt(
              versions.createdAt,
              sql`now() - make_interval(mins => ${options.sweepAfterMinutes})`,
            ),
            sql`not exists (${tx
              .select({ one: sql`1` })
              .from(later)
              .where(
                and(
                  eq(later.tenantId, versions.tenantId),
                  eq(later.objectId, versions.objectId),
                  gt(later.seq, versions.seq),
                ),
              )})`,
          ),
        )
        .orderBy(asc(versions.createdAt), asc(versions.id))
        .limit(options.sweepLimit),
    { accessMode: "read only" },
  );
  return rows.map((r) => r.id);
}
