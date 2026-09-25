import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { asc, gt, sql, type ExtractTablesWithRelations, type SQL } from "drizzle-orm";
import type {
  PgDatabase,
  PgQueryResultHKT,
  PgTransaction,
  PgTransactionConfig,
} from "drizzle-orm/pg-core";
import { checkServer, DatabaseCheckError, type QueryRows } from "./checks.js";
import { isId } from "./ids.js";
import * as schema from "./schema.js";
import { tenants } from "./schema.js";

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
   * `tx` works only while `work` runs: once `work` settles, every use of it throws. On a pool
   * the connection goes back for another tenant's transaction, so a handle that escaped (kept
   * in a variable, or used by a promise nobody awaited) must not reach it. Query builders
   * already built from `tx` are not covered: build and await queries inside `work`.
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

  /**
   * Every tenant's id, in order, at most `limit` (1 to 10,000, default 1,000) after `after`:
   * page with the last id returned until a page comes back short.
   *
   * The only read across tenants, for scheduled maintenance (core/jobs) that must visit each
   * one. It names tenants and nothing else: it runs in a read-only transaction of its own, in
   * which the `tenant_directory` policy (migration 0031) lets `tenants` rows be selected, and
   * every other table stays closed because no tenant is set. Work on what it returns goes
   * through withTenant(), one tenant at a time.
   */
  tenantIds(options?: { after?: string; limit?: number }): Promise<string[]>;

  /**
   * The connection for pg-boss (core/jobs, ADR-0008), which keeps its queue in its own `pgboss`
   * schema, outside row-level security. It is a second door past withTenant(), for pg-boss's
   * own SQL only: nothing else may use it.
   *
   * - On PostgreSQL it is the URL the database was opened with, so pg-boss connects with its
   *   own small pool as the same ordinary role, which openDatabase() checked (not a superuser,
   *   no BYPASSRLS). As the database's owner, that role may create the `pgboss` schema.
   * - On PGlite it runs statements on the same embedded instance, one at a time, between the
   *   application's transactions. A pg-boss call made while a withTenant() callback runs would
   *   wait for that transaction to end, which can't happen while the callback awaits the call,
   *   so it throws {@link NestedWorkError} instead: enqueue after the transaction commits.
   */
  queueConnection(): QueueConnection;

  /** Closes the connection or pool. */
  close(): Promise<void>;
}

/** How pg-boss reaches the database; see {@link Database.queueConnection}. */
export type QueueConnection =
  | { readonly kind: "postgres"; readonly connectionString: string }
  | {
      readonly kind: "pglite";
      /** pg-boss's `db` adapter (its IDatabase): one statement, or a block without parameters. */
      executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
    };

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
  /** See {@link Database.queueConnection}. */
  queue(): QueueConnection;
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
  /** Pool and session limits for a `postgres://` URL; see {@link PostgresOptions}. */
  postgres?: PostgresOptions;
}

/**
 * Limits for the native PostgreSQL pool. Each has a default, so a stuck client, statement or
 * transaction can't hold a connection (and the locks it took) indefinitely; 0 turns a timeout
 * off.
 */
export interface PostgresOptions {
  /** Connections in the pool. Default 10. */
  max?: number;
  /** How long to wait for a free connection, or a new one, before failing. Default 10 s. */
  connectionTimeoutMillis?: number;
  /** Longest a single statement may run (`statement_timeout`). Default 60 s. */
  statementTimeoutMillis?: number;
  /**
   * Longest a transaction may sit idle between statements before the server ends the session
   * (`idle_in_transaction_session_timeout`). Default 60 s.
   */
  idleInTransactionTimeoutMillis?: number;
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
    return openPostgres(url, options.postgres);
  }
  // Never echo the URL: it may hold a password.
  throw new TypeError(
    'unsupported database url: expected "pglite", "pglite:memory" or postgres://…',
  );
}

/** The most tenant ids one {@link Database.tenantIds} call returns. */
export const MAX_TENANT_PAGE = 10_000;

export function fromDriver(driver: Driver): Database {
  return {
    kind: driver.kind,
    async tenantIds(options = {}) {
      const { after, limit = 1_000 } = options;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TENANT_PAGE) {
        throw new RangeError(`tenantIds: limit is 1 to ${MAX_TENANT_PAGE}`);
      }
      if (after !== undefined && !isId("tenant", after)) {
        throw new TypeError("tenantIds: after is not a tenant id");
      }
      // A transaction of its own: called from a tenant's on PGlite, it would wait for it forever.
      if (insideWithTenant()) throw new NestedWorkError("tenantIds()");
      return driver.db.transaction(
        async (tx) => {
          // Transaction-local, like app.tenant_id: the policy opens `tenants` to SELECT here and
          // nowhere else, and no tenant is set, so every other table shows nothing.
          await tx.execute(sql`select set_config('app.tenant_directory', 'on', true)`);
          const rows = await tx
            .select({ id: tenants.id })
            .from(tenants)
            .where(after === undefined ? undefined : gt(tenants.id, after))
            .orderBy(asc(tenants.id))
            .limit(limit);
          return rows.map((r) => r.id);
        },
        { accessMode: "read only" },
      );
    },
    queueConnection: () => driver.queue(),
    withTenant(tenantId, work, config) {
      if (!isId("tenant", tenantId)) {
        return Promise.reject(new TypeError("withTenant: not a tenant id"));
      }
      let session: unknown;
      const settled = driver.db.transaction(async (tx) => {
        session = (tx as unknown as { session?: unknown }).session;
        // Transaction-local (the `true`), and parameterized, unlike SET LOCAL.
        await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
        const guarded = guardTransaction(tx as Tx);
        try {
          return await tenantWork.run(true, () => work(guarded.tx));
        } finally {
          // Before COMMIT or ROLLBACK is even sent: nothing more may run in this transaction.
          guarded.end();
        }
      }, config);
      // A query builder made inside the callback (tx.select()…, tx.query.…) keeps the raw
      // session, not the guarded handle, so awaiting it later would run on the released pooled
      // connection, perhaps in another tenant's transaction. Once COMMIT or ROLLBACK is done
      // and the connection is back in the pool, cut the session off from it.
      const cut = () => poisonSession(session);
      return settled.then(
        (value) => {
          cut();
          return value;
        },
        (e: unknown) => {
          cut();
          throw e;
        },
      );
    },
    close: () => driver.close(),
  };
}

/** Marks the async context of a withTenant() callback; see {@link insideWithTenant}. */
const tenantWork = new AsyncLocalStorage<true>();

/**
 * Whether this code runs inside a withTenant() callback, in its async context however deep.
 * The PGlite queue connection uses it to refuse a call that would wait for the transaction the
 * caller holds open, and core/jobs to refuse an enqueue that would not be part of it anyway.
 */
export function insideWithTenant(): boolean {
  return tenantWork.getStore() === true;
}

/** Thrown for work that must not run inside a withTenant() callback. */
export class NestedWorkError extends Error {
  constructor(what: string) {
    super(
      `${what} can't run inside a withTenant() callback: on the embedded database it would ` +
        `wait for the transaction the callback holds open. Call it after that transaction commits.`,
    );
    this.name = "NestedWorkError";
  }
}

/** Makes every later use of a drizzle session's connection throw {@link TransactionEndedError}. */
function poisonSession(session: unknown): void {
  if (typeof session !== "object" || session === null || !("client" in session)) return;
  Object.defineProperty(session, "client", {
    configurable: false,
    get() {
      throw new TransactionEndedError();
    },
  });
}

/** Thrown when a transaction handle is used after its withTenant() callback settled. */
export class TransactionEndedError extends Error {
  constructor() {
    super(
      "this transaction has ended: a withTenant() handle was used after its callback settled " +
        "(await every query inside the callback, and never keep the handle)",
    );
    this.name = "TransactionEndedError";
  }
}

/**
 * Wraps `tx` in a proxy that works until `end()` is called and throws on every property access
 * after, so a leaked handle fails loudly instead of running on a pooled connection inside some
 * other tenant's transaction. Methods run on the real transaction, not the proxy.
 */
export function guardTransaction(tx: Tx): { tx: Tx; end: () => void } {
  let ended = false;
  const check = () => {
    if (ended) throw new TransactionEndedError();
  };
  const proxy = new Proxy(tx, {
    get(target, prop) {
      // Not thenable, ended or not, so returning the handle from `work` resolves normally.
      if (prop === "then") return undefined;
      check();
      if (prop === "transaction") {
        // A savepoint's handle is guarded the same way, for as long as its callback runs.
        return (work: (sp: Tx) => Promise<unknown>) => {
          check();
          return target.transaction(async (sp) => {
            const nested = guardTransaction(sp as Tx);
            try {
              return await work(nested.tx);
            } finally {
              nested.end();
            }
          });
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      return function (this: unknown, ...args: unknown[]) {
        check();
        return (value as (...a: unknown[]) => unknown).apply(this === proxy ? target : this, args);
      };
    },
    set(target, prop, value) {
      check();
      return Reflect.set(target, prop, value, target);
    },
    has(target, prop) {
      check();
      return Reflect.has(target, prop);
    },
  });
  return {
    tx: proxy,
    end: () => {
      ended = true;
    },
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
