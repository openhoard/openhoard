import { eq, getTableName, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromDriver, queryRows, type Database, type Driver, type Tx } from "./database.js";
import { newId } from "./ids.js";
import { blobs, objects, sourceRefs, tables, tenants, versions, zones } from "./schema.js";
import { openTestDriver, seedTenant, type SeededTenant } from "./testing.js";

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
afterEach(() => driver.close());

const counts = (tenantId: string) =>
  db.withTenant(tenantId, async (tx) => ({
    tenants: (await tx.select().from(tenants)).length,
    zones: (await tx.select().from(zones)).length,
    blobs: (await tx.select().from(blobs)).length,
    objects: (await tx.select().from(objects)).length,
    versions: (await tx.select().from(versions)).length,
    sourceRefs: (await tx.select().from(sourceRefs)).length,
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
                       'check', pg_get_expr(p.polwithcheck, p.polrelid)))
                from pg_policy p where p.polrelid = c.oid) as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p')
       order by 1`);
    const declared = Object.values(tables).map((t) => getTableName(t));
    expect(rows.map((r) => r.table)).toEqual(declared.sort());
    for (const r of rows) {
      const column = r.table === "tenants" ? "id" : "tenant_id";
      const predicate = `(${column} = current_setting('app.tenant_id'::text, true))`;
      expect(r, String(r.table)).toEqual({
        table: r.table,
        enabled: true,
        forced: true,
        // No grants to anyone: another role on the cluster cannot even try.
        owner_only: true,
        // One permissive policy for every command and every role, and nothing looser.
        policies: [
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

  it("puts tenant_id in every foreign key, so no row can point into another tenant", () => {
    for (const table of Object.values(tables)) {
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
    const one = { tenants: 1, zones: 1, blobs: 1, objects: 1, versions: 1, sourceRefs: 1 };
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
});
