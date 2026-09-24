import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import type { Driver } from "./database.js";
import { migrationsFolder } from "./migrations.js";
import * as schema from "./schema.js";

/** Advisory lock key held while migrating, so concurrent starts apply each migration once. */
const MIGRATION_LOCK = [7420, 1] as const;

/** Native PostgreSQL through a node-postgres pool. */
export function openPostgres(url: string): Driver {
  const pool = new pg.Pool({
    connectionString: url,
    // Every connection starts in UTC (spike S2), before any query can run on it.
    options: "-c TimeZone=UTC",
  });
  // An idle client's error (server restart, network) would otherwise crash the process; the
  // pool drops that client and the next query gets a fresh one.
  pool.on("error", () => {});
  const db = drizzle(pool, { schema });
  return {
    kind: "postgres",
    db,
    query: async (text) => (await pool.query<Record<string, unknown>>(text)).rows,
    async migrate() {
      const client = await pool.connect();
      let failure: Error | undefined;
      try {
        await client.query("select pg_advisory_lock($1, $2)", [...MIGRATION_LOCK]);
        await migrate(drizzle(client, { schema }), { migrationsFolder });
        await client.query("select pg_advisory_unlock($1, $2)", [...MIGRATION_LOCK]);
      } catch (e) {
        failure = e instanceof Error ? e : new Error(String(e));
        throw e;
      } finally {
        // After a failure the lock may still be held: destroy the connection, which releases
        // it, rather than return it to the pool.
        client.release(failure);
      }
    },
    close: () => pool.end(),
  };
}
