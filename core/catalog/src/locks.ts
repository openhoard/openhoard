import type { Tx } from "@openhoard/core-db";
import { sql } from "drizzle-orm";

/*
 * Transaction-scoped advisory locks for the catalog. Each namespace is the first key; the second
 * is a hash of what is locked. (core/db migrations use 7420, core/audit appends 7421.)
 *
 * Lock order. Every catalog function takes what it needs in this order, and never the other way
 * round, so two of them can wait on each other only in a line, never in a cycle:
 *
 *   0. the tenant's principal epoch (core/db lockPrincipals()): anything that changes grants,
 *      memberships or a user's kind or stops takes it first (none of these functions do);
 *   1. source item (7423): ingest, removeFromSource;
 *   2. tag value (7425): deciding review items (approve, reject, merge);
 *   3. object (7422): anything that versions, tags, titles or marks one object;
 *   4. row locks (SELECT … FOR UPDATE/SHARE, UPDATE) on that object's rows, after its advisory
 *      lock, never before;
 *   5. audit appends (7421), last.
 *
 * A function that locks several items of one kind (rejecting a new value closes other objects'
 * items) locks them in id order.
 */

const OBJECT_LOCK = 7422;
const SOURCE_ITEM_LOCK = 7423;
const TAG_VALUE_LOCK = 7425;

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

/**
 * Serializes review decisions about one value of one facet, so two reviewers closing items for
 * the same value (a rejected new value closes them all) never lock each other's items crosswise.
 */
export async function lockTagValue(
  tx: Tx,
  tenantId: string,
  facet: string,
  value: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${TAG_VALUE_LOCK}, hashtext(${tenantId} || '/' || ${facet} || ':' || ${value}))`,
  );
}
