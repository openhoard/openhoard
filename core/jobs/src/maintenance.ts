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
 *   job, and the file would stay hidden for good; the sweep brings it back. Enqueueing a version
 *   whose job still waits changes nothing (jobs.ts), and one whose job runs costs an idempotent
 *   re-run. Versions whose job ran out of retries wait in the dead letter queue instead: the
 *   sweep skips them until an operator redrives them or pg-boss's retention drops them (14 days
 *   by default), and then tries once more. It pages past the ones it skips, oldest first, until
 *   it has enqueued `sweepLimit` or looked at `sweepScanLimit`, so a pile of dead letters can't
 *   hide the lost versions behind them.
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
  /** Versions one run of the sweep looks at per tenant, skipped ones included. Default 1,000. */
  sweepScanLimit?: number;
}

export const MAINTENANCE_DEFAULTS: Readonly<Required<MaintenanceOptions>> = {
  sessionRetentionDays: 30,
  activityRetentionDays: 400,
  batchSize: 1_000,
  maxBatches: 10,
  sweepAfterMinutes: 60,
  sweepLimit: 100,
  sweepScanLimit: 1_000,
};

const LIMITS: Record<keyof MaintenanceOptions, [number, number]> = {
  sessionRetentionDays: [1, 3650],
  activityRetentionDays: [1, 3650],
  batchSize: [1, 100_000],
  maxBatches: [1, 1_000],
  sweepAfterMinutes: [1, 7 * 24 * 60],
  sweepLimit: [0, 10_000],
  sweepScanLimit: [0, 100_000],
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
  /** Versions the sweep enqueued (a new job, or one already waiting). */
  swept: number;
  /** Versions the sweep skipped because their job is in the dead letter queue. */
  deadLettered: number;
}

/**
 * Runs one tenant's maintenance. `requeue` enqueues a version for enrichment, and
 * `deadLettered` returns the tenant's versions whose job waits in the dead letter queue (read
 * once per run), which the sweep skips.
 */
export async function maintainTenant(
  db: Database,
  tenantId: string,
  options: Required<MaintenanceOptions>,
  queue: {
    requeue: (payload: EnrichPayload) => Promise<unknown>;
    deadLettered: (tenantId: string) => Promise<ReadonlySet<string>>;
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
  const { swept, deadLettered } = await sweep(db, tenantId, options, queue);
  return { sessions, activity, swept, deadLettered };
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

/** Enqueues lost versions, paging past dead-lettered ones; see the header. */
async function sweep(
  db: Database,
  tenantId: string,
  options: Required<MaintenanceOptions>,
  queue: Parameters<typeof maintainTenant>[3],
) {
  let swept = 0;
  let deadLettered = 0;
  if (options.sweepLimit === 0 || options.sweepScanLimit === 0) return { swept, deadLettered };
  const dead = await queue.deadLettered(tenantId);
  const page = Math.min(Math.max(options.sweepLimit, 100), options.sweepScanLimit);
  let scanned = 0;
  let after: VersionCursor | undefined;
  while (swept < options.sweepLimit && scanned < options.sweepScanLimit) {
    const limit = Math.min(page, options.sweepScanLimit - scanned);
    const rows = await unprocessedVersions(db, tenantId, { ...options, limit, after });
    for (const row of rows) {
      scanned++;
      if (dead.has(row.id)) {
        deadLettered++;
        continue;
      }
      await queue.requeue({ tenantId, versionId: row.id });
      if (++swept === options.sweepLimit) break;
    }
    if (rows.length < limit) break;
    after = rows[rows.length - 1];
  }
  return { swept, deadLettered };
}

/**
 * Where a page of {@link unprocessedVersions} ended: the last version's creation time, as the
 * database's own text (a JavaScript Date would drop PostgreSQL's microseconds, and the next page
 * would start inside the last one), and its id.
 */
export interface VersionCursor {
  id: string;
  createdAt: string;
}

/**
 * Current versions (no later version of their object) still unprocessed, created more than
 * `sweepAfterMinutes` ago, oldest first, after `after`; at most `limit`. A renamed version
 * counts from its creation, so it may be enqueued while its job waits: the queue collapses that.
 */
export async function unprocessedVersions(
  db: Database,
  tenantId: string,
  options: { sweepAfterMinutes: number; limit: number; after?: VersionCursor | undefined },
): Promise<VersionCursor[]> {
  if (options.limit === 0) return [];
  const later = alias(versions, "later");
  const { after } = options;
  return db.withTenant(
    tenantId,
    (tx) =>
      tx
        .select({ id: versions.id, createdAt: sql<string>`${versions.createdAt}::text` })
        .from(versions)
        .where(
          and(
            eq(versions.tenantId, tenantId),
            isNull(versions.processedAt),
            lt(
              versions.createdAt,
              sql`now() - make_interval(mins => ${options.sweepAfterMinutes})`,
            ),
            after === undefined
              ? undefined
              : sql`(${versions.createdAt}, ${versions.id}) > (${after.createdAt}::timestamptz, ${after.id})`,
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
        .limit(options.limit),
    { accessMode: "read only" },
  );
}
