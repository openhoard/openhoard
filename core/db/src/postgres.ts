import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import type { Driver, PostgresOptions } from "./database.js";
import { migrationsFolder } from "./migrations.js";
import * as schema from "./schema.js";

/** Advisory lock key held while migrating, so concurrent starts apply each migration once. */
const MIGRATION_LOCK = [7420, 1] as const;

/** The defaults {@link PostgresOptions} documents. */
export const POSTGRES_DEFAULTS: Readonly<Required<PostgresOptions>> = {
  max: 10,
  connectionTimeoutMillis: 10_000,
  statementTimeoutMillis: 60_000,
  idleInTransactionTimeoutMillis: 60_000,
};

/** The pool settings for `options`: the defaults, overridden by what `options` sets. */
export function poolSettings(options: PostgresOptions = {}): Required<PostgresOptions> {
  const set = Object.entries(options).filter(([, v]) => v !== undefined);
  const o = { ...POSTGRES_DEFAULTS, ...Object.fromEntries(set) } as Required<PostgresOptions>;
  for (const [key, value] of Object.entries(o) as [string, unknown][]) {
    const min = key === "max" ? 1 : 0;
    if (!Number.isSafeInteger(value) || (value as number) < min) {
      throw new RangeError(`postgres.${key} must be a whole number of at least ${min}`);
    }
  }
  return o;
}

/** Native PostgreSQL through a node-postgres pool. */
export function openPostgres(url: string, options: PostgresOptions = {}): Driver {
  const o = poolSettings(options);
  const pool = new pg.Pool({
    connectionString: url,
    max: o.max,
    connectionTimeoutMillis: o.connectionTimeoutMillis,
    // Set at connection start, before any query can run: UTC (spike S2), and limits so a stuck
    // statement or an abandoned transaction can't pin a connection and the locks it holds.
    options: [
      "-c TimeZone=UTC",
      `-c statement_timeout=${o.statementTimeoutMillis}`,
      `-c idle_in_transaction_session_timeout=${o.idleInTransactionTimeoutMillis}`,
    ].join(" "),
  });
  // A client's error event with no listener would crash the process. The pool's listener covers
  // idle clients (a server restart, the network); a checked-out client (an idle-in-transaction
  // timeout, 25P03) needs its own. Either way the query in flight fails, the pool drops that
  // client, and the next query gets a fresh one.
  pool.on("error", () => {});
  pool.on("connect", (client) => client.on("error", () => {}));
  const db = drizzle(pool, { schema });
  return {
    kind: "postgres",
    db,
    query: async (text) => (await pool.query<Record<string, unknown>>(text)).rows,
    async migrate() {
      const client = await pool.connect();
      let failure: Error | undefined;
      try {
        // Waiting for another process's migrations, or building an index, may take longer than
        // any application statement should.
        await client.query("set statement_timeout = 0");
        await client.query("select pg_advisory_lock($1, $2)", [...MIGRATION_LOCK]);
        await migrate(drizzle(client, { schema }), { migrationsFolder });
        await client.query("select pg_advisory_unlock($1, $2)", [...MIGRATION_LOCK]);
        // Back to the connection's own setting (the -c option above).
        await client.query("reset statement_timeout");
      } catch (e) {
        failure = e instanceof Error ? e : new Error(String(e));
        throw e;
      } finally {
        // After a failure the lock may still be held: destroy the connection, which releases
        // it, rather than return it to the pool.
        client.release(failure);
      }
    },
    // pg-boss opens its own pool on the same URL, so the same role (checked by openDatabase).
    queue: () => ({ kind: "postgres", connectionString: url }),
    close: () => pool.end(),
  };
}
