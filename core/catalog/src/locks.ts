import type { Tx } from "@openhoard/core-db";
import { sql } from "drizzle-orm";

/*
 * Transaction-scoped advisory locks for the catalog. Each namespace is the first key; the second
 * is a hash of what is locked. Always take them in this order: source item, then object.
 * (core/db migrations use 7420, core/audit appends 7421.)
 */

const OBJECT_LOCK = 7422;
const SOURCE_ITEM_LOCK = 7423;

/** Serializes everything that tags or versions one object. Held until the transaction ends. */
export async function lockObject(tx: Tx, tenantId: string, objectId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${OBJECT_LOCK}, hashtext(${tenantId} || '/' || ${objectId}))`,
  );
}

/** Serializes ingests of one item of one source, so a new item becomes exactly one object. */
export async function lockSourceItem(
  tx: Tx,
  tenantId: string,
  source: string,
  externalId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${SOURCE_ITEM_LOCK}, hashtext(${tenantId} || '/' || ${source} || '/' || ${externalId}))`,
  );
}
