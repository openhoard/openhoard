import { sourceSyncs, SYNC_STATUSES, type Tx } from "@openhoard/core-db";
import { and, asc, eq, isNotNull, or, sql } from "drizzle-orm";

/*
 * What an admin does about a source's sync (T-301, T-303): see where each source stands and how
 * its last scheduled run ended, confirm a reconcile the guard held, accept that a source is now
 * another one, resume a source whose schedule a failure stopped. They trust the caller: the
 * admin CLI (`openhoard admin source …`) and the admin API authorize and audit.
 *
 * confirm-reconcile, discard-reconcile and accept-identity also lift a stop (the admin acted on
 * what failed); a run that still fails stops the source again.
 */

/** How a scheduled run ended (core/db SYNC_STATUSES). */
export type SyncRunStatus = (typeof SYNC_STATUSES)[number];

/** A source's sync, as an admin sees it. */
export interface SourceSyncState {
  source: string;
  zoneId: string;
  connector: string;
  phase: "crawl" | "delta";
  /** A crawl from the beginning is running, or its reconcile is still to do. */
  reconciling: boolean;
  /** How many removals the reconcile guard holds for an admin, if any. */
  reconcileHeld: number | null;
  /** How many removals an admin confirmed, if any. */
  reconcileConfirmed: number | null;
  /** A crawl met a place it couldn't read: the next crawl from the beginning reconciles. */
  reconcileDeferred: boolean;
  /** What the connector said the source is, when it says. */
  sourceIdentity: string | null;
  /** The last scheduled run (T-303): when, how it ended, why (a code), what it counted. */
  lastRunAt: Date | null;
  lastStatus: SyncRunStatus | null;
  lastError: string | null;
  lastCounts: Record<string, number> | null;
  /**
   * When a failure stopped the source's schedule, and its code: scheduled runs skip it until an
   * admin resumes it. Null while it is scheduled.
   */
  stoppedAt: Date | null;
  stoppedError: string | null;
  updatedAt: Date;
}

/** Every source's sync in the tenant, by source. */
export async function listSourceSyncs(tx: Tx, tenantId: string): Promise<SourceSyncState[]> {
  const rows = await tx
    .select()
    .from(sourceSyncs)
    .where(eq(sourceSyncs.tenantId, tenantId))
    .orderBy(asc(sourceSyncs.source));
  return rows.map((r) => ({
    source: r.source,
    zoneId: r.zoneId,
    connector: r.connector,
    phase: r.phase,
    reconciling: r.reconcileFrom !== null,
    reconcileHeld: r.reconcileHeld,
    reconcileConfirmed: r.reconcileConfirmed,
    reconcileDeferred: r.reconcileDeferred,
    sourceIdentity: r.sourceIdentity,
    lastRunAt: r.lastRunAt,
    lastStatus: r.lastStatus,
    lastError: r.lastError,
    lastCounts: r.lastCounts,
    stoppedAt: r.stoppedAt,
    stoppedError: r.stoppedError,
    updatedAt: r.updatedAt,
  }));
}

/** What every admin action on a source clears: a stop. */
const UNSTOP = { stoppedAt: null, stoppedError: null } as const;
const CODE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Binds a source to its zone and connector before its first run (the server does it for every
 * configured source at start), as the sync runner would: a new row starts with a crawl that
 * reconciles. Returns `ok`, or what an existing row is bound to instead (`zone-mismatch`,
 * `connector-mismatch`), which the runner refuses too.
 */
export async function ensureSourceSync(
  tx: Tx,
  tenantId: string,
  source: { source: string; zoneId: string; connector: string },
): Promise<"ok" | "zone-mismatch" | "connector-mismatch"> {
  await tx
    .insert(sourceSyncs)
    .values({
      tenantId,
      source: source.source,
      zoneId: source.zoneId,
      connector: source.connector,
      phase: "crawl",
      token: null,
      reconcileFrom: sql`now()`,
    })
    .onConflictDoNothing();
  const [row] = await tx
    .select({ zoneId: sourceSyncs.zoneId, connector: sourceSyncs.connector })
    .from(sourceSyncs)
    .where(and(eq(sourceSyncs.tenantId, tenantId), eq(sourceSyncs.source, source.source)));
  if (!row) throw new Error("source_syncs row vanished");
  if (row.zoneId !== source.zoneId) return "zone-mismatch";
  if (row.connector !== source.connector) return "connector-mismatch";
  return "ok";
}

/** Whether a failure stopped the source's schedule; null for a source never bound. */
export async function sourceStopped(
  tx: Tx,
  tenantId: string,
  source: string,
): Promise<boolean | null> {
  const [row] = await tx
    .select({ stoppedAt: sourceSyncs.stoppedAt })
    .from(sourceSyncs)
    .where(and(eq(sourceSyncs.tenantId, tenantId), eq(sourceSyncs.source, source)));
  return row ? row.stoppedAt !== null : null;
}

/** What a scheduled run records about itself: codes and numbers only. */
export interface SyncRunRecord {
  status: SyncRunStatus;
  /** A code (`auth`, `reconcile-guard`…), never a message; anything else is dropped. */
  error?: string;
  counts?: Record<string, number>;
}

/**
 * Records how a scheduled run ended. A `failed` run also stops the source, when it wasn't
 * already: scheduled runs skip it until an admin acts. `recorded` is false for a source without
 * a row (one the runner refused before binding it); `stopped` says whether this call stopped it.
 */
export async function recordSyncRun(
  tx: Tx,
  tenantId: string,
  source: string,
  run: SyncRunRecord,
): Promise<{ recorded: boolean; stopped: boolean }> {
  const error = run.error !== undefined && CODE.test(run.error) ? run.error : null;
  const where = and(eq(sourceSyncs.tenantId, tenantId), eq(sourceSyncs.source, source));
  const [before] = await tx
    .select({ stoppedAt: sourceSyncs.stoppedAt })
    .from(sourceSyncs)
    .where(where)
    .for("update");
  if (!before) return { recorded: false, stopped: false };
  const stopping = run.status === "failed" && before.stoppedAt === null;
  await tx
    .update(sourceSyncs)
    .set({
      lastRunAt: sql`now()`,
      lastStatus: run.status,
      lastError: run.status === "done" ? null : error,
      lastCounts: run.counts ?? null,
      ...(stopping ? { stoppedAt: sql`now()`, stoppedError: error ?? "failed" } : {}),
    })
    .where(where);
  return { recorded: true, stopped: stopping };
}

/**
 * Resumes a source a failure stopped: scheduled runs run it again. Returns the code it was
 * stopped for, or null when it wasn't stopped (an unknown source included).
 */
export async function resumeSource(
  tx: Tx,
  tenantId: string,
  source: string,
): Promise<string | null> {
  const where = and(
    eq(sourceSyncs.tenantId, tenantId),
    eq(sourceSyncs.source, source),
    isNotNull(sourceSyncs.stoppedAt),
  );
  const [before] = await tx
    .select({ error: sourceSyncs.stoppedError })
    .from(sourceSyncs)
    .where(where)
    .for("update");
  if (!before) return null;
  await tx
    .update(sourceSyncs)
    .set({ ...UNSTOP, updatedAt: sql`now()` })
    .where(where);
  return before.error ?? "failed";
}

/**
 * Confirms the reconcile the guard held for a source: the next sync removes up to that many
 * items (a larger count is held again). Returns the count confirmed, or null when nothing is
 * held (an unknown source included).
 */
export async function confirmReconcile(
  tx: Tx,
  tenantId: string,
  source: string,
): Promise<number | null> {
  const [row] = await tx
    .update(sourceSyncs)
    .set({
      reconcileConfirmed: sql`${sourceSyncs.reconcileHeld}`,
      ...UNSTOP,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(sourceSyncs.tenantId, tenantId),
        eq(sourceSyncs.source, source),
        isNotNull(sourceSyncs.reconcileHeld),
      ),
    )
    .returning({ confirmed: sourceSyncs.reconcileConfirmed });
  return row?.confirmed ?? null;
}

/**
 * Discards a reconcile or a delta the guard held (or a reconcile deferred for an unreadable
 * place) without removing anything: the source is crawled again from the beginning, from a clean state, and that crawl's
 * reconcile is guarded like any other. For when the source is right after all (a drive mounted
 * again, a folder restored) or its administrator wants a fresh look before confirming. Returns
 * false when nothing is held or deferred (an unknown source included).
 */
export async function discardReconcile(tx: Tx, tenantId: string, source: string): Promise<boolean> {
  const rows = await tx
    .update(sourceSyncs)
    .set({
      phase: "crawl",
      token: null,
      reconcileFrom: sql`now()`,
      reconcileHeld: null,
      reconcileConfirmed: null,
      reconcileDeferred: false,
      deltaDeletes: 0,
      ...UNSTOP,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(sourceSyncs.tenantId, tenantId),
        eq(sourceSyncs.source, source),
        or(isNotNull(sourceSyncs.reconcileHeld), eq(sourceSyncs.reconcileDeferred, true)),
      ),
    )
    .returning({ source: sourceSyncs.source });
  return rows.length > 0;
}

/**
 * Accepts that the source is now what its connector says (another disk at the path, a site
 * recreated): forgets the recorded identity (the next sync records the new one) and starts a
 * crawl from the beginning, whose reconcile the guard watches as any other. Returns false for
 * an unknown source.
 */
export async function acceptSourceIdentity(
  tx: Tx,
  tenantId: string,
  source: string,
): Promise<boolean> {
  const rows = await tx
    .update(sourceSyncs)
    .set({
      sourceIdentity: null,
      phase: "crawl",
      token: null,
      reconcileFrom: sql`now()`,
      reconcileHeld: null,
      reconcileConfirmed: null,
      reconcileDeferred: false,
      deltaDeletes: 0,
      ...UNSTOP,
      updatedAt: sql`now()`,
    })
    .where(and(eq(sourceSyncs.tenantId, tenantId), eq(sourceSyncs.source, source)))
    .returning({ source: sourceSyncs.source });
  return rows.length > 0;
}
