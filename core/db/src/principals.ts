import { sql } from "drizzle-orm";
import type { Tx } from "./database.js";

/**
 * Takes the tenant's principal epoch lock (its principal_epochs row) until the transaction
 * ends. Every function that changes what a principal holds (grants, memberships, a user's kind
 * or stops) takes it first, before any row it changes: the triggers that bump the epoch take the
 * same row, and taking it first keeps two such transactions from waiting on each other crosswise.
 * Lock order: this, then row locks, then the audit append (core/audit, 7421) last.
 */
export async function lockPrincipals(tx: Tx, tenantId: string): Promise<void> {
  await tx.execute(
    sql`insert into principal_epochs (tenant_id, epoch)
        values (${tenantId}, 1 + floor(random() * 1e12)::bigint)
        on conflict (tenant_id) do update set epoch = principal_epochs.epoch`,
  );
}
