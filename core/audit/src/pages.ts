import { auditEvents, type Database, type Tx } from "@openhoard/core-db";
import { eq, max } from "drizzle-orm";

/*
 * Walking a chain in pages, for verifyAudit() and exportAudit(). Each page is read in its own
 * short read-only transaction, and the caller handles it outside any transaction, so a slow
 * consumer (a network sink, a long chain) never holds a pooled connection, or on PGlite, the
 * one connection every tenant shares.
 *
 * The walk stops at the chain's last seq when it started. The chain is append-only, so the rows
 * up to there never change while it reads them: page by page gives the same answer as one
 * snapshot would.
 */

/** The highest seq in `tenantId`'s chain now; 0 when it is empty. */
export async function chainEnd(db: Database, tenantId: string): Promise<number> {
  const [row] = await db.withTenant(
    tenantId,
    (tx) =>
      tx
        .select({ end: max(auditEvents.seq) })
        .from(auditEvents)
        .where(eq(auditEvents.tenantId, tenantId)),
    { accessMode: "read only" },
  );
  return Number(row?.end ?? 0);
}

/**
 * Pages of rows from `read`, which returns up to `pageSize` rows with seq in (after, end], in
 * seq order. Stops at `end`, or at a short page.
 */
export async function* chainPages<T extends { seq: number }>(
  db: Database,
  tenantId: string,
  end: number,
  pageSize: number,
  read: (tx: Tx, after: number) => Promise<T[]>,
): AsyncGenerator<T[], void, undefined> {
  let after = 0;
  while (after < end) {
    const from = after;
    const rows = await db.withTenant(tenantId, (tx) => read(tx, from), {
      accessMode: "read only",
    });
    if (rows.length > 0) yield rows;
    const last = rows.at(-1);
    if (rows.length < pageSize || last === undefined) return;
    after = last.seq;
    // PGlite runs queries without yielding; let the rest of the process run between pages.
    await new Promise((resolve) => setImmediate(resolve));
  }
}
