import { eq, getTableName, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fromDriver,
  insideWithTenant,
  MAX_TENANT_PAGE,
  NestedWorkError,
  openDriver,
  queryRows,
  SessionRoleError,
  TransactionEndedError,
  type Database,
  type Driver,
  type Tx,
} from "./database.js";
import { newId } from "./ids.js";
import { queueConnectionOf } from "./queue.js";
import {
  auditEvents,
  blobs,
  facets,
  facetValues,
  grants,
  objects,
  objectTags,
  scimTokens,
  sourceRefs,
  tables,
  tenants,
  versions,
  zones,
} from "./schema.js";
import { openTestDriver, seedTenant, TEST_POSTGRES_ENV, type SeededTenant } from "./testing.js";

/*
 * Tenant isolation (T-201: "RLS test passes"). Row-level security is the backstop under every
 * query the application writes, so these tests look at it from the database's side: the
 * catalog (every table is covered), the policies' behaviour, and the transaction boundary.
 */

/** The SQLSTATE of a rejected query; Drizzle wraps driver errors in `cause`. */
async function sqlState(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    return err.cause?.code ?? err.code ?? `no SQLSTATE: ${String(e)}`;
  }
  return "no error";
}

const INSUFFICIENT_PRIVILEGE = "42501"; // also raised for a row that fails a policy check
const FOREIGN_KEY_VIOLATION = "23503";

let driver: Driver;
let db: Database;
let a: SeededTenant;
let b: SeededTenant;

beforeEach(async () => {
  driver = await openTestDriver();
  db = fromDriver(driver);
  a = await seedTenant(db, 1);
  b = await seedTenant(db, 2);
});
afterEach(() => driver?.close());

const counts = (tenantId: string) =>
  db.withTenant(tenantId, async (tx) => ({
    tenants: (await tx.select().from(tenants)).length,
    zones: (await tx.select().from(zones)).length,
    blobs: (await tx.select().from(blobs)).length,
    objects: (await tx.select().from(objects)).length,
    versions: (await tx.select().from(versions)).length,
    sourceRefs: (await tx.select().from(sourceRefs)).length,
    facets: (await tx.select().from(facets)).length,
    facetValues: (await tx.select().from(facetValues)).length,
    objectTags: (await tx.select().from(objectTags)).length,
    grants: (await tx.select().from(grants)).length,
  }));

describe("catalog", () => {
  it("covers every table with forced row-level security and exactly the tenant policy", async () => {
    const rows = await driver.query(`
      select c.relname as table,
             c.relrowsecurity as enabled,
             c.relforcerowsecurity as forced,
             c.relacl is null as owner_only,
             (select json_agg(json_build_object(
                       'name', p.polname, 'cmd', p.polcmd, 'permissive', p.polpermissive,
                       'roles', p.polroles::oid[]::text,
                       'using', pg_get_expr(p.polqual, p.polrelid),
                       'check', pg_get_expr(p.polwithcheck, p.polrelid))
                  order by p.polname)
                from pg_policy p where p.polrelid = c.oid) as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p')
       order by 1`);
    const declared = Object.values(tables).map((t) => getTableName(t));
    expect(rows.map((r) => r.table)).toEqual(declared.sort());
    for (const r of rows) {
      const column = r.table === "tenants" ? "id" : "tenant_id";
      const predicate = `(${column} = current_setting('app.tenant_id'::text, true))`;
      // The tenant directory (0031): tenants rows, SELECT only, in a transaction that asked.
      const directory = {
        name: "tenant_directory",
        cmd: "r",
        permissive: true,
        roles: "{0}",
        using:
          "((current_setting('app.tenant_directory'::text, true) = 'on'::text) AND " +
          "(COALESCE(current_setting('app.tenant_id'::text, true), ''::text) = ''::text))",
        check: null,
      };
      expect(r, String(r.table)).toEqual({
        table: r.table,
        enabled: true,
        forced: true,
        // No grants to anyone: another role on the cluster cannot even try.
        owner_only: true,
        // One permissive policy for every command and every role, and nothing looser.
        policies: [
          ...(r.table === "tenants" ? [directory] : []),
          {
            name: "tenant_isolation",
            cmd: "*",
            permissive: true,
            roles: "{0}",
            using: predicate,
            check: predicate,
          },
        ],
      });
    }
  });

  it("keeps the audit log append-only: read and insert policies, no grants, guard triggers", async () => {
    const [r] = await driver.query(`
      select c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
             c.relacl is null as owner_only,
             (select json_agg(json_build_object('name', p.polname, 'cmd', p.polcmd,
                       'using', pg_get_expr(p.polqual, p.polrelid),
                       'check', pg_get_expr(p.polwithcheck, p.polrelid)) order by p.polname)
                from pg_policy p where p.polrelid = c.oid) as policies,
             (select json_agg(t.tgname order by t.tgname) from pg_trigger t
                where t.tgrelid = c.oid and not t.tgisinternal) as triggers
        from pg_class c where c.oid = 'audit.events'::regclass`);
    const predicate = "(tenant_id = current_setting('app.tenant_id'::text, true))";
    expect(r).toEqual({
      enabled: true,
      forced: true,
      owner_only: true,
      policies: [
        { name: "tenant_append", cmd: "a", using: null, check: predicate },
        { name: "tenant_read", cmd: "r", using: predicate, check: null },
      ],
      triggers: ["events_append_only", "events_extend_chain", "events_no_truncate"],
    });
  });

  it("puts tenant_id in every foreign key, so no row can point into another tenant", () => {
    for (const table of [...Object.values(tables), auditEvents]) {
      for (const fk of getTableConfig(table).foreignKeys) {
        const { columns, foreignColumns, foreignTable } = fk.reference();
        const name = `${getTableName(table)}.${fk.getName()}`;
        expect(columns[0]?.name, name).toBe("tenant_id");
        const target = getTableName(foreignTable) === "tenants" ? "id" : "tenant_id";
        expect(foreignColumns[0]?.name, name).toBe(target);
      }
    }
  });

  it("connects as an ordinary role that row-level security applies to", async () => {
    const [r] = await driver.query(`
      select r.rolsuper as super, r.rolbypassrls as bypass,
             (select datdba = r.oid from pg_database where datname = current_database()) as owns_db
        from pg_roles r where r.rolname = current_user`);
    expect(r).toEqual({ super: false, bypass: false, owns_db: true });
  });
});

describe("withTenant", () => {
  it("sees only its own tenant's rows, in every table", async () => {
    const one = {
      tenants: 1,
      zones: 1,
      blobs: 1,
      objects: 1,
      versions: 1,
      sourceRefs: 1,
      facets: 1,
      facetValues: 1,
      objectTags: 1,
      grants: 1,
    };
    expect(await counts(a.tenantId)).toEqual(one);
    expect(await counts(b.tenantId)).toEqual(one);
    const [obj] = await db.withTenant(a.tenantId, (tx) => tx.select().from(objects));
    expect(obj?.id).toBe(a.objectId);
  });

  it("finds nothing by another tenant's ids, even when asking for them directly", async () => {
    const found = await db.withTenant(a.tenantId, async (tx) => [
      ...(await tx.select().from(objects).where(eq(objects.id, b.objectId))),
      ...(await tx.select().from(tenants).where(eq(tenants.id, b.tenantId))),
      ...(await queryRows(tx, sql`select * from versions where tenant_id = ${b.tenantId}`)),
    ]);
    expect(found).toEqual([]);
  });

  it("cannot write rows for another tenant", async () => {
    const insert = db.withTenant(a.tenantId, (tx) =>
      tx
        .insert(zones)
        .values({ tenantId: b.tenantId, id: newId("zone"), kind: "managed", name: "x" }),
    );
    expect(await sqlState(insert)).toBe(INSUFFICIENT_PRIVILEGE);
    const newTenant = db.withTenant(a.tenantId, (tx) =>
      tx.insert(tenants).values({ id: newId("tenant"), name: "Sneaky" }),
    );
    expect(await sqlState(newTenant)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("keeps SCIM tokens to their tenant: unseen, unwritable and unrevocable from another", async () => {
    // A token of tenant B's, as core/identity issues them (T-103).
    const tokenId = newId("scimToken");
    const token = {
      id: tokenId,
      name: "Entra",
      secretHash: "0".repeat(64),
      createdBy: "system:test",
      expiresAt: sql`now() + interval '30 days'`,
    };
    await db.withTenant(b.tenantId, (tx) =>
      tx.insert(scimTokens).values({ tenantId: b.tenantId, ...token }),
    );
    const seenFromA = await db.withTenant(a.tenantId, async (tx) => {
      await tx
        .update(scimTokens)
        .set({ revokedAt: sql`now()`, revokedBy: "user:x" })
        .where(eq(scimTokens.id, tokenId));
      return tx.select().from(scimTokens);
    });
    expect(seenFromA).toEqual([]);
    const planted = db.withTenant(a.tenantId, (tx) =>
      tx.insert(scimTokens).values({ tenantId: b.tenantId, ...token, id: newId("scimToken") }),
    );
    expect(await sqlState(planted)).toBe(INSUFFICIENT_PRIVILEGE);
    const [own] = await db.withTenant(b.tenantId, (tx) => tx.select().from(scimTokens));
    expect(own).toMatchObject({ id: tokenId, revokedAt: null });
  });

  it("cannot move its rows to another tenant", async () => {
    const move = db.withTenant(a.tenantId, (tx) =>
      tx.update(objects).set({ tenantId: b.tenantId }).where(eq(objects.id, a.objectId)),
    );
    // The composite foreign keys or the policy reject it; either way nothing moves.
    expect([INSUFFICIENT_PRIVILEGE, FOREIGN_KEY_VIOLATION]).toContain(await sqlState(move));
    expect((await counts(a.tenantId)).objects).toBe(1);
  });

  it("cannot update or delete another tenant's rows (they match nothing)", async () => {
    await db.withTenant(a.tenantId, async (tx) => {
      await tx.update(objects).set({ title: "pwned" }).where(eq(objects.id, b.objectId));
      await tx.delete(sourceRefs).where(eq(sourceRefs.tenantId, b.tenantId));
      await tx.delete(tenants).where(eq(tenants.id, b.tenantId));
    });
    const [obj] = await db.withTenant(b.tenantId, (tx) => tx.select().from(objects));
    expect(obj?.title).toBe("Report 2.docx");
    expect(await counts(b.tenantId)).toMatchObject({ tenants: 1, sourceRefs: 1 });
  });

  it("cannot reference another tenant's rows", async () => {
    // Tenant A points a new version at tenant B's blob. The blob id is B's, so only the composite
    // (tenant_id, blob_id) foreign key stands between A and B's content.
    const steal = db.withTenant(a.tenantId, (tx) =>
      tx.insert(versions).values({
        tenantId: a.tenantId,
        id: newId("version"),
        objectId: a.objectId,
        seq: 2,
        blobId: b.blobId,
        mime: "text/plain",
      }),
    );
    expect(await sqlState(steal)).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("fails closed without a tenant: no rows, no writes", async () => {
    // A transaction that never set app.tenant_id, as if a code path forgot the tenant.
    const rows = await driver.db.transaction((tx) =>
      queryRows(tx as Tx, sql`select id from objects`),
    );
    expect(rows).toEqual([]);
    expect(await driver.query("select count(*)::int as n from tenants")).toEqual([{ n: 0 }]);
    const write = driver.db.transaction(async (tx) => {
      await tx.insert(tenants).values({ id: newId("tenant"), name: "No context" });
    });
    expect(await sqlState(write)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("leaves nothing behind on the connection", async () => {
    await db.withTenant(a.tenantId, (tx) => tx.select().from(objects));
    const [after] = await driver.query(
      "select current_user = session_user as same_user, current_setting('app.tenant_id', true) as tenant",
    );
    expect(after?.same_user).toBe(true);
    // Once set in a session, a custom setting reads '' after the transaction, never the tenant.
    expect(["", null]).toContain(after?.tenant);
  });

  it("rolls back everything when the work throws", async () => {
    const failing = db.withTenant(a.tenantId, async (tx) => {
      await tx.update(objects).set({ title: "half done" });
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    const [obj] = await db.withTenant(a.tenantId, (tx) => tx.select().from(objects));
    expect(obj?.title).toBe("Report 1.docx");
  });

  it("makes a handle that escaped its callback unusable", async () => {
    let leaked: Tx | undefined;
    let savepoint: Tx | undefined;
    const returned = await db.withTenant(a.tenantId, async (tx) => {
      leaked = tx;
      await tx.transaction(async (sp) => {
        savepoint = sp;
        await sp.select().from(objects);
      });
      return tx; // not thenable, so returning it is harmless
    });
    expect(returned).toBe(leaked);
    for (const handle of [leaked, savepoint]) {
      expect(() => handle?.select().from(objects)).toThrow(TransactionEndedError);
      expect(() => handle?.execute(sql`select 1`)).toThrow("this transaction has ended");
      expect(() => handle?.transaction(() => Promise.resolve())).toThrow(TransactionEndedError);
    }
    // A query started from the callback but never awaited fails too, instead of running later.
    let late: Promise<unknown> | undefined;
    await db.withTenant(a.tenantId, (tx) => {
      late = new Promise((r) => setTimeout(r, 10)).then(() => tx.select().from(objects));
      return Promise.resolve();
    });
    await expect(late).rejects.toThrow(TransactionEndedError);
  });

  it.runIf(process.env[TEST_POSTGRES_ENV])(
    "never lets a leaked handle read inside another tenant's later transaction (PostgreSQL)",
    async () => {
      // One pooled connection, so tenant B's transaction runs on the leaked handle's client.
      const { createPostgresDatabase } = await import("./testing-postgres.js");
      const own = await createPostgresDatabase(process.env[TEST_POSTGRES_ENV] ?? "");
      const single = await openDriver({ url: own.url, postgres: { max: 1 } });
      try {
        await own.migrate();
        const pg = fromDriver(single);
        const ta = await seedTenant(pg, 1);
        const tb = await seedTenant(pg, 2);
        let leaked: Tx | undefined;
        // A builder made inside the callback, and the relational query API, keep drizzle's raw
        // session rather than the guarded handle.
        let builder: PromiseLike<unknown> | undefined;
        let relational: Tx["query"] | undefined;
        await pg.withTenant(ta.tenantId, async (tx) => {
          leaked = tx;
          builder = tx.select({ id: objects.id }).from(objects);
          relational = tx.query;
          await tx.select().from(objects);
        });
        const attempt = async (run: () => PromiseLike<unknown> | undefined) => {
          try {
            return await run();
          } catch (e) {
            return e;
          }
        };
        const seen = await pg.withTenant(tb.tenantId, async (tx) => {
          const mine = await tx.select({ id: objects.id }).from(objects);
          return {
            mine,
            stolen: await attempt(() => leaked?.select({ id: objects.id }).from(objects)),
            built: await attempt(() => builder),
            related: await attempt(() => relational?.objects.findMany()),
          };
        });
        expect(seen.mine).toEqual([{ id: tb.objectId }]);
        expect(seen.stolen).toBeInstanceOf(TransactionEndedError);
        expect(seen.built).toBeInstanceOf(TransactionEndedError);
        expect(seen.related).toBeInstanceOf(TransactionEndedError);
      } finally {
        await single.close();
        await own.close();
      }
    },
  );

  it.each([
    "",
    "t1",
    "obj_00000000000000000000000000",
    "ten_x' or '1'='1",
    "ten_00000000000000000000000000 ",
  ])("refuses %j as a tenant id before touching the database", async (id) => {
    await expect(db.withTenant(id, () => Promise.resolve())).rejects.toThrow(
      "withTenant: not a tenant id",
    );
  });

  it("marks its callback's async context while the transaction is open, and only then", async () => {
    expect(insideWithTenant()).toBe(false);
    let later: Promise<boolean> | undefined;
    const seen = await db.withTenant(a.tenantId, async (tx) => {
      await tx.select().from(objects);
      const nested = await new Promise<boolean>((r) => setTimeout(() => r(insideWithTenant()), 1));
      // Started inside, run after the commit: outside by then.
      later = new Promise<boolean>((r) => setTimeout(() => r(insideWithTenant()), 20));
      return [insideWithTenant(), nested];
    });
    expect(seen).toEqual([true, true]);
    expect(insideWithTenant()).toBe(false);
    expect(await later).toBe(false);
  });

  it("refuses a transaction inside another one, which would wait for it forever", async () => {
    const nested = db.withTenant(a.tenantId, () =>
      db.withTenant(b.tenantId, (tx) => tx.select().from(objects)),
    );
    await expect(nested).rejects.toThrow(NestedWorkError);
    // Even deep in the callback's async work, and for its own tenant.
    const deep = db.withTenant(a.tenantId, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return db.withTenant(a.tenantId, () => Promise.resolve(1));
    });
    await expect(deep).rejects.toThrow(NestedWorkError);
    // After the commit, a timer the callback started opens its own transaction normally.
    let after: Promise<number> | undefined;
    await db.withTenant(a.tenantId, () => {
      after = new Promise<void>((r) => setTimeout(r, 10)).then(() =>
        db.withTenant(a.tenantId, async (tx) => (await tx.select().from(objects)).length),
      );
      return Promise.resolve();
    });
    expect(await after).toBe(1);
  });
});

describe("tenant directory", () => {
  it("lists every tenant's id in order, a page at a time", async () => {
    const [first, second] = [a.tenantId, b.tenantId].sort() as [string, string];
    expect(await db.tenantIds()).toEqual([first, second]);
    expect(await db.tenantIds({ limit: 1 })).toEqual([first]);
    expect(await db.tenantIds({ after: first, limit: 1 })).toEqual([second]);
    expect(await db.tenantIds({ after: second })).toEqual([]);
  });

  it("opens tenants to SELECT only, and nothing else, in the transaction that asks", async () => {
    const seen = await driver.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_directory', 'on', true)`);
      return {
        tenants: (await tx.select({ id: tenants.id }).from(tenants)).length,
        objects: (await tx.select().from(objects)).length,
        audit: (await queryRows(tx as Tx, sql`select 1 from audit.events`)).length,
      };
    });
    expect(seen).toEqual({ tenants: 2, objects: 0, audit: 0 });
    const writes = [
      (tx: Tx) => tx.insert(tenants).values({ id: newId("tenant"), name: "Directory" }),
      (tx: Tx) => tx.update(tenants).set({ name: "renamed" }).returning({ id: tenants.id }),
      (tx: Tx) => tx.delete(tenants).returning({ id: tenants.id }),
    ];
    const outcomes = [];
    for (const write of writes) {
      const attempt = driver.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.tenant_directory', 'on', true)`);
        return write(tx as Tx);
      });
      outcomes.push(
        await attempt.then(
          (rows) => rows,
          (e: unknown) => sqlState(Promise.reject(e)),
        ),
      );
    }
    // The insert fails the policy check; the update and delete see no row to change.
    expect(outcomes).toEqual([INSUFFICIENT_PRIVILEGE, [], []]);
    // And the setting is transaction-local: the next transaction sees nothing again.
    expect(await driver.query("select count(*)::int as n from tenants")).toEqual([{ n: 0 }]);
  });

  it("changes nothing inside a tenant's transaction, even set for the whole session", async () => {
    const inTenant = await db.withTenant(a.tenantId, async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_directory', 'on', true)`);
      return (await tx.select({ id: tenants.id }).from(tenants)).map((r) => r.id);
    });
    expect(inTenant).toEqual([a.tenantId]);
    // Session-level (only raw SQL could do this): a tenant's transactions still see one tenant.
    const single = await openSingleConnection();
    try {
      await single.query("select set_config('app.tenant_directory', 'on', false)");
      const pinned = fromDriver(single);
      const seen = await pinned.withTenant(b.tenantId, async (tx) =>
        (await tx.select({ id: tenants.id }).from(tenants)).map((r) => r.id),
      );
      expect(seen).toEqual([b.tenantId]);
    } finally {
      if (single !== driver) await single.close();
    }
  });

  it("refuses a bad page, and a call from inside a tenant's transaction", async () => {
    await expect(db.tenantIds({ limit: 0 })).rejects.toThrow(RangeError);
    await expect(db.tenantIds({ limit: MAX_TENANT_PAGE + 1 })).rejects.toThrow(RangeError);
    await expect(db.tenantIds({ after: "ten_x' or '1'='1" })).rejects.toThrow(TypeError);
    await expect(db.withTenant(a.tenantId, () => db.tenantIds())).rejects.toThrow(NestedWorkError);
  });
});

/** A driver on one connection: the test's own on PGlite, a one-connection pool on PostgreSQL. */
async function openSingleConnection(): Promise<Driver> {
  const url = (driver as Driver & { url?: string }).url;
  if (url === undefined) return driver;
  return openDriver({ url, postgres: { max: 1 } });
}

describe("queue connection", () => {
  const pglite = !process.env[TEST_POSTGRES_ENV];

  it("is not on the Database, only behind the internal entry point", () => {
    expect("queueConnection" in db).toBe(false);
    expect(() =>
      queueConnectionOf({ ...db, withTenant: db.withTenant.bind(db) } as Database),
    ).toThrow(TypeError);
  });

  it.skipIf(pglite)("hands pg-boss the URL and the pool's session settings on PostgreSQL", () => {
    const queue = queueConnectionOf(db);
    if (queue.kind !== "postgres") throw new Error("expected PostgreSQL");
    expect(new URL(queue.connectionString).pathname).toMatch(/^\/openhoard_test_/);
    expect(queue.options).toBe(
      "-c TimeZone=UTC -c statement_timeout=60000 -c idle_in_transaction_session_timeout=60000",
    );
    expect(queue.connectionTimeoutMillis).toBe(10_000);
  });

  it.runIf(pglite)("runs pg-boss's statements on the embedded database, as its owner", async () => {
    const queue = queueConnectionOf(db);
    if (queue.kind !== "pglite") throw new Error("expected PGlite");
    const run = queue.executeSql;
    expect((await run("select current_user as who, $1::int as n", [7])).rows).toEqual([
      { who: "openhoard", n: 7 },
    ]);
    await run("create schema qtest; create table qtest.t (n int primary key)");
    // A block that fails half way leaves no aborted transaction behind for the application.
    await expect(
      run("begin; insert into qtest.t values (1); insert into qtest.t values (1); commit"),
    ).rejects.toThrow();
    expect((await run("select count(*)::int as n from qtest.t")).rows).toEqual([{ n: 0 }]);
    expect(await counts(a.tenantId)).toMatchObject({ objects: 1 });
    // RETURNING rows before a COMMIT come back.
    expect((await run("begin; insert into qtest.t values (2) returning n; commit")).rows).toEqual([
      { n: 2 },
    ]);
    // Concurrent index DDL can't run in a transaction block: it runs on its own; a failure
    // leaves no transaction behind.
    await run("create index concurrently qtest_n on qtest.t (n)");
    await run("reindex index concurrently qtest.qtest_n");
    await expect(run("create index concurrently qtest_n on qtest.t (n)")).rejects.toThrow();
    await run("drop index concurrently qtest.qtest_n");
    expect(await counts(a.tenantId)).toMatchObject({ objects: 1 });
    // Only statements that start with such DDL: this one merely mentions the word.
    expect((await run("select 'concurrently' as w")).rows).toEqual([{ w: "concurrently" }]);
    // Nothing that changes the shared session's settings or role.
    for (const [text, values] of [
      ["select set_config('app.tenant_directory', 'on', false)", undefined],
      ["select set_config($1, 'on', false)", ["app.tenant_directory"]],
      ["select current_setting($1, true)", [" app.tenant_id"]],
      ["reset session authorization", undefined],
      ["set role postgres", undefined],
      ["reset all", undefined],
    ] as const) {
      await expect(run(text, values ? [...values] : undefined)).rejects.toThrow(
        /refuses statements that change session settings/,
      );
    }
    expect((await run("select current_user as who")).rows).toEqual([{ who: "openhoard" }]);
    // Inside a tenant's transaction it would wait forever for it: it throws instead.
    await expect(db.withTenant(a.tenantId, () => run("select 1"))).rejects.toThrow(NestedWorkError);
  });

  it.runIf(pglite)(
    "is a tripwire, not a boundary: what gets past it still can't widen a tenant's view",
    async () => {
      // This test's own database (beforeEach), closed after it: the session it breaks is its own.
      const queue = queueConnectionOf(db);
      if (queue.kind !== "pglite") throw new Error("expected PGlite");
      const run = queue.executeSql;
      // Quoting gets past the refusal list, as the comments say.
      await run(`SET "app".tenant_directory TO 'on'`);
      const own = await db.withTenant(a.tenantId, async (tx) =>
        (await tx.select({ id: tenants.id }).from(tenants)).map((r) => r.id),
      );
      expect(own).toEqual([a.tenantId]);
      await run(`select "set_config"('session_' || 'authorization', 'postgres', false)`);
      expect((await run("select current_user as who")).rows).toEqual([{ who: "postgres" }]);
      // A superuser skips row-level security: every transaction refuses to run from now on.
      await expect(db.withTenant(a.tenantId, (tx) => tx.select().from(objects))).rejects.toThrow(
        SessionRoleError,
      );
      await expect(db.tenantIds()).rejects.toThrow(SessionRoleError);
    },
  );
});
