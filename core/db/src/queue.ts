import { driverOf, type Database, type QueueConnection } from "./database.js";

/*
 * The internal entry point for core/jobs: `@openhoard/core-db/queue`. pg-boss keeps its queue in
 * its own `pgboss` schema, outside row-level security, and needs raw SQL (PGlite) or the
 * credentialed URL (PostgreSQL) to reach it. Neither belongs on the Database every caller holds,
 * so only this entry point hands it out, and only core/jobs imports it (a lint-free convention,
 * reviewed like the rest of the trusted core).
 */

export type { QueueConnection } from "./database.js";

/** How pg-boss reaches `db`'s database. Throws for a Database openDatabase() didn't make. */
export function queueConnectionOf(db: Database): QueueConnection {
  const driver = driverOf(db);
  if (!driver) throw new TypeError("queueConnectionOf: not a database from openDatabase()");
  return driver.queue();
}
