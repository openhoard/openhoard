import { sourceSyncs, type Tx } from "@openhoard/core-db";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";

/*
 * What an admin does about a source's sync (T-301): see where each source stands, confirm a
 * reconcile the guard held, accept that a source is now another one. They trust the caller: the
 * admin CLI (`openhoard admin source …`) and, later, the admin API authorize and audit.
 */

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
  /** What the connector said the source is, when it says. */
  sourceIdentity: string | null;
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
    sourceIdentity: r.sourceIdentity,
    updatedAt: r.updatedAt,
  }));
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
    .set({ reconcileConfirmed: sql`${sourceSyncs.reconcileHeld}`, updatedAt: sql`now()` })
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
      updatedAt: sql`now()`,
    })
    .where(and(eq(sourceSyncs.tenantId, tenantId), eq(sourceSyncs.source, source)))
    .returning({ source: sourceSyncs.source });
  return rows.length > 0;
}
