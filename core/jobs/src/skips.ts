import { sourceSkips, sourceSyncs, type Tx } from "@openhoard/core-db";
import { and, asc, count, desc, eq, inArray, lt, sql } from "drizzle-orm";

/*
 * What a source's syncs left out, and why, kept across runs (source_skips, migration 0070).
 *
 * A run's report lists what it skipped, but only for that run: a file skipped for being too
 * large is not mentioned again until it changes, so by the next run nobody could say why it
 * isn't in the catalog. The runner (sync.ts) gathers what it skips and what it records between
 * checkpoints and writes both with each checkpoint (keepSkips()), in the checkpoint's own
 * transaction: what comes after the last checkpoint comes again after a crash, so a skip is kept
 * exactly when the run moved past it. A crawl from the beginning that reconciles also forgets
 * what it didn't meet again (sweepSkips()): items gone from the source, or no longer skipped.
 */

/** A skipped item, as kept. */
export interface SourceSkip {
  externalId: string;
  /** A code: `too-large`, `invalid-acl`, `ingest-<code>`, `invalid`, a connector warning's. */
  reason: string;
  /** Where the item is in its source, its own name last, when the run knew it. */
  path: string[] | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/** What a run gathered since its last checkpoint. */
export interface SkipChanges {
  /** Items skipped, by external id: the latest reason and path. */
  skipped: ReadonlyMap<string, { reason: string; path?: readonly string[] }>;
  /** Items recorded or removed: no longer left out. */
  cleared: ReadonlySet<string>;
}

/** Ids per statement. */
const BATCH = 500;
/** A reason as kept: a code, else `other`. */
const REASON = /^[a-z0-9][a-z0-9:-]{0,63}$/;
/** The most items one checkpoint keeps; past it, the run's report still counts them all. */
export const MAX_SKIPS_PER_CHECKPOINT = 5_000;

const pathOf = (path: readonly string[] | undefined): string[] | null =>
  path !== undefined &&
  path.length >= 1 &&
  path.length <= 1024 &&
  path.every((n) => typeof n === "string" && n !== "" && !n.includes("\0") && n.length <= 1024)
    ? [...path]
    : null;

/**
 * Writes what a run gathered: the skipped items (new ones, or a new reason or path for one
 * already kept; `last_seen_at` now either way) and the items no longer left out. Run it in the
 * checkpoint's transaction, after the source's sync row exists.
 */
export async function keepSkips(
  tx: Tx,
  tenantId: string,
  source: string,
  changes: SkipChanges,
): Promise<void> {
  const cleared = [...changes.cleared].filter(
    (id) => id.length >= 1 && id.length <= 1024 && !changes.skipped.has(id),
  );
  for (let at = 0; at < cleared.length; at += BATCH) {
    await tx
      .delete(sourceSkips)
      .where(
        and(
          eq(sourceSkips.tenantId, tenantId),
          eq(sourceSkips.source, source),
          inArray(sourceSkips.externalId, cleared.slice(at, at + BATCH)),
        ),
      );
  }
  const rows = [...changes.skipped]
    .filter(([id]) => id.length >= 1 && id.length <= 1024)
    .slice(0, MAX_SKIPS_PER_CHECKPOINT)
    .map(([externalId, s]) => ({
      tenantId,
      source,
      externalId,
      reason: REASON.test(s.reason) ? s.reason : "other",
      path: pathOf(s.path),
    }));
  for (let at = 0; at < rows.length; at += BATCH) {
    await tx
      .insert(sourceSkips)
      .values(rows.slice(at, at + BATCH))
      .onConflictDoUpdate({
        target: [sourceSkips.tenantId, sourceSkips.source, sourceSkips.externalId],
        set: {
          reason: sql`excluded.reason`,
          // A path the run didn't know leaves the one kept.
          path: sql`coalesce(excluded.path, ${sourceSkips.path})`,
          lastSeenAt: sql`now()`,
        },
      });
  }
}

/**
 * Forgets what the crawl from the beginning now ending didn't meet again (kept before its
 * `reconcile_from`): gone from the source, or recorded since by another way. Run it in the
 * reconcile's last transaction, before `reconcile_from` is cleared.
 */
export async function sweepSkips(tx: Tx, tenantId: string, source: string): Promise<number> {
  const gone = await tx
    .delete(sourceSkips)
    .where(
      and(
        eq(sourceSkips.tenantId, tenantId),
        eq(sourceSkips.source, source),
        lt(
          sourceSkips.lastSeenAt,
          sql`(select ${sourceSyncs.reconcileFrom} from ${sourceSyncs}
                where ${sourceSyncs.tenantId} = ${tenantId} and ${sourceSyncs.source} = ${source})`,
        ),
      ),
    )
    .returning({ externalId: sourceSkips.externalId });
  return gone.length;
}

/** The most skips one listing returns. */
export const MAX_SKIP_PAGE = 1_000;

/**
 * What the source leaves out now: how many per reason, and the items, the most recently seen
 * first, then by id: at most `limit` (default 100, at most {@link MAX_SKIP_PAGE}), of one
 * `reason` when given.
 */
export async function listSourceSkips(
  tx: Tx,
  tenantId: string,
  source: string,
  options: { limit?: number; reason?: string } = {},
): Promise<{ total: number; byReason: Record<string, number>; items: SourceSkip[] }> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), MAX_SKIP_PAGE);
  const mine = and(eq(sourceSkips.tenantId, tenantId), eq(sourceSkips.source, source));
  const counted = await tx
    .select({ reason: sourceSkips.reason, n: count() })
    .from(sourceSkips)
    .where(mine)
    .groupBy(sourceSkips.reason);
  const byReason: Record<string, number> = Object.create(null);
  let total = 0;
  for (const r of counted) {
    byReason[r.reason] = Number(r.n);
    total += Number(r.n);
  }
  const items = await tx
    .select({
      externalId: sourceSkips.externalId,
      reason: sourceSkips.reason,
      path: sourceSkips.path,
      firstSeenAt: sourceSkips.firstSeenAt,
      lastSeenAt: sourceSkips.lastSeenAt,
    })
    .from(sourceSkips)
    .where(options.reason === undefined ? mine : and(mine, eq(sourceSkips.reason, options.reason)))
    .orderBy(desc(sourceSkips.lastSeenAt), asc(sourceSkips.externalId))
    .limit(limit);
  return { total, byReason, items };
}
