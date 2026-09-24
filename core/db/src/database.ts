import { join } from "node:path";
import { sql, type ExtractTablesWithRelations, type SQL } from "drizzle-orm";
import type {
  PgDatabase,
  PgQueryResultHKT,
  PgTransaction,
  PgTransactionConfig,
} from "drizzle-orm/pg-core";
import { checkServer, DatabaseCheckError, type QueryRows } from "./checks.js";
import { isId } from "./ids.js";
import * as schema from "./schema.js";

export type Schema = typeof schema;

/** A transaction scoped to one tenant; see {@link Database.withTenant}. */
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

export interface Database {
  /** "pglite" (embedded, for development, tests and single-node trials) or "postgres". */
  readonly kind: "pglite" | "postgres";

  /**
   * Runs `work` in one transaction that can only see and write `tenantId`'s rows.
   *
   * This is the only way the application touches tenant data. The transaction sets
   * `app.tenant_id` transaction-locally, so the forced row-level security policies filter every
   * statement, and nothing carries over to the next transaction on a pooled connection. The
   * transaction commits when `work` resolves and rolls back when it throws.
   *
   * Isolation holds against queries that forget a tenant filter or name another tenant's ids.
   * It does not hold against arbitrary SQL: `work` runs as the tables' owner, so raw SQL can
   * change the setting or the policies. Build queries with Drizzle and parameters, never
   * `sql.raw()` with input.
   */
  withTenant<T>(
    tenantId: string,
    work: (tx: Tx) => Promise<T>,
    config?: PgTransactionConfig,
  ): Promise<T>;

  /** Closes the connection or pool. */
  close(): Promise<void>;
}

/**
 * What a driver provides: a Drizzle handle bound to the connection, plus migrations.
 * Internal: application code gets a {@link Database}, whose only door is withTenant().
 */
export interface Driver {
  readonly kind: Database["kind"];
  readonly db: PgDatabase<PgQueryResultHKT, Schema>;
  /** Raw query as the owner (checks, tests). */
  readonly query: QueryRows;
  /** Applies pending migrations; safe to call from several processes at once. */
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export interface OpenOptions {
  /**
   * `pglite` (stored under `dataDir`), `pglite:memory` (nothing persisted), or a
   * `postgres://` / `postgresql://` URL.
   */
  url: string;
  /** Data directory for `pglite`; the database lives in `<dataDir>/pgdata`. */
  dataDir?: string;
  /** Apply pending migrations on open. Default true. */
  migrate?: boolean;
}

/**
 * Opens the database, checks the server against the requirements in checks.ts, and applies
 * pending migrations. Throws {@link DatabaseCheckError} when the server does not qualify.
 */
export async function openDatabase(options: OpenOptions): Promise<Database> {
  const driver = await openDriver(options);
  await prepareDriver(driver, { migrate: options.migrate !== false });
  return fromDriver(driver);
}

/** Checks the server and applies migrations; closes the driver and rethrows on failure. */
export async function prepareDriver(driver: Driver, options: { migrate: boolean }): Promise<void> {
  try {
    const problems = await checkServer(driver.query);
    if (problems.length > 0) throw new DatabaseCheckError(problems);
    if (options.migrate) await driver.migrate();
  } catch (e) {
    await driver.close();
    throw e;
  }
}

export async function openDriver(options: OpenOptions): Promise<Driver> {
  const { url } = options;
  if (url === "pglite" || url === "pglite:memory") {
    const { openPglite } = await import("./pglite.js");
    if (url === "pglite") {
      if (!options.dataDir) throw new TypeError('database url "pglite" needs a dataDir');
      return openPglite({ dataDir: join(options.dataDir, "pgdata") });
    }
    return openPglite({});
  }
  if (/^postgres(ql)?:\/\//.test(url)) {
    const { openPostgres } = await import("./postgres.js");
    return openPostgres(url);
  }
  // Never echo the URL: it may hold a password.
  throw new TypeError(
    'unsupported database url: expected "pglite", "pglite:memory" or postgres://…',
  );
}

export function fromDriver(driver: Driver): Database {
  return {
    kind: driver.kind,
    withTenant(tenantId, work, config) {
      if (!isId("tenant", tenantId)) {
        return Promise.reject(new TypeError("withTenant: not a tenant id"));
      }
      return driver.db.transaction(async (tx) => {
        // Transaction-local (the `true`), and parameterized, unlike SET LOCAL.
        await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
        return work(tx as Tx);
      }, config);
    },
    close: () => driver.close(),
  };
}

/**
 * Runs raw SQL in a transaction and returns its rows, the same shape on both drivers. Prefer the
 * query builder; when raw SQL is needed, cast int8 results (`count(*)::int`) or expect strings.
 */
export async function queryRows<T = Record<string, unknown>>(tx: Tx, query: SQL): Promise<T[]> {
  const result = (await tx.execute(query)) as unknown as { rows: T[] };
  return result.rows;
}
