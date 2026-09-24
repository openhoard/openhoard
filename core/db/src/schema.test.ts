import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fromDriver,
  openDatabase,
  queryRows,
  openDriver,
  prepareDriver,
  type Database,
  type Driver,
  type Tx,
} from "./database.js";
import { PGlite } from "@electric-sql/pglite";
import { checkServer, DatabaseCheckError } from "./checks.js";
import { newId } from "./ids.js";
import { migrationsFolder } from "./migrations.js";
import { blobs, objects, sourceRefs, tenants, versions, zones } from "./schema.js";
import {
  openTestDatabase,
  openTestDriver,
  seedTenant,
  TEST_POSTGRES_ENV,
  type SeededTenant,
} from "./testing.js";

async function sqlState(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    return err.cause?.code ?? err.code ?? `no SQLSTATE: ${String(e)}`;
  }
  return "no error";
}
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

describe("schema", () => {
  let driver: Driver;
  let db: Database;
  let t: SeededTenant;
  beforeEach(async () => {
    driver = await openTestDriver();
    db = fromDriver(driver);
    t = await seedTenant(db);
  });
  afterEach(() => driver.close());

  const inTenant = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work);

  it("round-trips a seeded tenant with the mapped types", async () => {
    const [blob] = await inTenant((tx) => tx.select().from(blobs));
    expect(blob).toEqual({
      tenantId: t.tenantId,
      id: t.blobId,
      size: 1234, // int8 → number (mode: "number")
      location: null,
      createdAt: expect.any(Date),
    });
    const [obj] = await inTenant((tx) => tx.select().from(objects));
    expect(obj?.createdAt).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - (obj?.createdAt.getTime() ?? 0))).toBeLessThan(60_000);
  });

  it("returns raw int8 as a string on every driver (spike S2)", async () => {
    expect(await driver.query("select 9007199254740993::int8 as n")).toEqual([
      { n: "9007199254740993" },
    ]);
    const raw = await inTenant((tx) => queryRows(tx, sql`select size from blobs`));
    expect(raw).toEqual([{ size: "1234" }]);
  });

  it("stores and returns timestamps in UTC", async () => {
    const [r] = await driver.query(
      "select current_setting('TimeZone') as tz, '2026-01-01T12:00:00Z'::timestamptz::text as ts",
    );
    expect(r).toEqual({ tz: "UTC", ts: "2026-01-01 12:00:00+00" });
  });

  it.each([
    ["a malformed object id", { id: "obj_nope" }],
    ["a version id in an object's place", { id: newId("version") }],
    ["an empty title", { title: "" }],
    ["an owner that is not a principal", { ownerId: "steve" }],
  ])("rejects %s", async (_, patch) => {
    const insert = inTenant((tx) =>
      tx.insert(objects).values({
        tenantId: t.tenantId,
        id: newId("object"),
        zoneId: t.zoneId,
        title: "ok",
        ownerId: "user:1",
        ...patch,
      }),
    );
    expect(await sqlState(insert)).toBe(CHECK_VIOLATION);
  });

  it.each([
    [
      "a zone kind outside the four",
      () => ({
        table: zones,
        row: { tenantId: t.tenantId, id: newId("zone"), kind: "cloud" as "managed", name: "x" },
      }),
    ],
    [
      "a raw content hash as a blob id",
      () => ({ table: blobs, row: { tenantId: t.tenantId, id: `b3:${"0".repeat(64)}`, size: 1 } }),
    ],
    [
      "a negative blob size",
      () => ({
        table: blobs,
        row: { tenantId: t.tenantId, id: `b3t:${"1".repeat(64)}`, size: -1 },
      }),
    ],
    [
      "an upper-case source name",
      () => ({
        table: sourceRefs,
        row: { tenantId: t.tenantId, source: "SharePoint", externalId: "x", objectId: t.objectId },
      }),
    ],
    [
      "an empty external id",
      () => ({
        table: sourceRefs,
        row: { tenantId: t.tenantId, source: "sp", externalId: "", objectId: t.objectId },
      }),
    ],
  ])("rejects %s", async (_, make) => {
    const { table, row } = make();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- one insert over several tables
    expect(await sqlState(inTenant((tx) => tx.insert(table as any).values(row)))).toBe(
      CHECK_VIOLATION,
    );
  });

  it.each([
    ["seq 0", { seq: 0 }],
    ["a mime type with parameters", { mime: "text/csv; charset=utf-8" }],
    ["an upper-case mime type", { mime: "Text/CSV" }],
    ["an author that is not a principal", { authorId: "someone" }],
  ])("rejects a version with %s", async (_, patch) => {
    const insert = inTenant((tx) =>
      tx.insert(versions).values({
        tenantId: t.tenantId,
        id: newId("version"),
        objectId: t.objectId,
        seq: 2,
        blobId: t.blobId,
        mime: "text/csv",
        ...patch,
      }),
    );
    expect(await sqlState(insert)).toBe(CHECK_VIOLATION);
  });

  it("numbers versions uniquely per object", async () => {
    const again = inTenant((tx) =>
      tx.insert(versions).values({
        tenantId: t.tenantId,
        id: newId("version"),
        objectId: t.objectId,
        seq: 1,
        blobId: t.blobId,
        mime: "text/plain",
      }),
    );
    expect(await sqlState(again)).toBe(UNIQUE_VIOLATION);
  });

  it("keeps zone names unique per tenant", async () => {
    const dup = inTenant((tx) =>
      tx
        .insert(zones)
        .values({ tenantId: t.tenantId, id: newId("zone"), kind: "managed", name: "SharePoint" }),
    );
    expect(await sqlState(dup)).toBe(UNIQUE_VIOLATION);
  });

  it("identifies a source item once per tenant", async () => {
    const dup = inTenant((tx) =>
      tx.insert(sourceRefs).values({
        tenantId: t.tenantId,
        source: "sharepoint",
        externalId: t.externalId,
        objectId: t.objectId,
      }),
    );
    expect(await sqlState(dup)).toBe(UNIQUE_VIOLATION);
  });

  it("deletes an object's versions and source refs with it, but keeps the blob", async () => {
    await inTenant((tx) => tx.delete(objects).where(eq(objects.id, t.objectId)));
    const left = await inTenant(async (tx) => ({
      versions: (await tx.select().from(versions)).length,
      sourceRefs: (await tx.select().from(sourceRefs)).length,
      blobs: (await tx.select().from(blobs)).length,
    }));
    expect(left).toEqual({ versions: 0, sourceRefs: 0, blobs: 1 });
  });

  it("refuses to delete a blob a version still uses, or a zone that has objects", async () => {
    expect(await sqlState(inTenant((tx) => tx.delete(blobs)))).toBe(FOREIGN_KEY_VIOLATION);
    expect(await sqlState(inTenant((tx) => tx.delete(zones)))).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("never deletes a tenant's data as a side effect of deleting the tenant", async () => {
    expect(await sqlState(inTenant((tx) => tx.delete(tenants)))).toBe(FOREIGN_KEY_VIOLATION);
    // Deliberate removal, children first, works.
    await inTenant(async (tx) => {
      await tx.delete(objects); // takes versions and source refs with it
      await tx.delete(blobs);
      await tx.delete(zones);
      await tx.delete(tenants);
    });
    // The policies match on tenant_id alone, so orphans would still be visible here.
    const left = await inTenant((tx) =>
      queryRows(
        tx,
        sql`select (select count(*) from tenants) + (select count(*) from zones) +
                   (select count(*) from blobs) + (select count(*) from objects) +
                   (select count(*) from versions) + (select count(*) from source_refs) as n`,
      ),
    );
    expect(left).toEqual([{ n: "0" }]); // raw int8 is a string (see above)
  });

  it("moves updated_at on every update", async () => {
    const [before] = await inTenant((tx) => tx.select().from(objects));
    // now() is the transaction start, so the update must run in a later transaction.
    await new Promise((r) => setTimeout(r, 5));
    await inTenant((tx) => tx.update(objects).set({ title: "Renamed.docx" }));
    const [after] = await inTenant((tx) => tx.select().from(objects));
    expect(after?.updatedAt.getTime()).toBeGreaterThan(before?.updatedAt.getTime() ?? Infinity);
    expect(after?.createdAt).toEqual(before?.createdAt);
  });
});

describe("migrations", () => {
  it("are all listed in the journal, in order", () => {
    const journal = JSON.parse(
      readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string; when: number }[] };
    const files = readdirSync(migrationsFolder)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(files).toEqual(journal.entries.map((e) => `${e.tag}.sql`));
    expect(journal.entries.map((e) => e.idx)).toEqual(files.map((_, i) => i));
    // Drizzle applies a migration only if it is newer than the last one applied, so a
    // migration stamped earlier (clock skew, a rebase) would be skipped on existing databases.
    const when = journal.entries.map((e) => e.when);
    expect(when).toEqual([...when].sort((x, y) => x - y));
    expect(new Set(when).size).toBe(when.length);
  });

  it("give every test an empty database", async () => {
    const db = await openTestDatabase();
    try {
      expect(await db.withTenant(newId("tenant"), (tx) => tx.select().from(tenants))).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("apply again as a no-op", async () => {
    const driver = await openTestDriver();
    try {
      await driver.migrate();
      const [n] = await driver.query("select count(*)::int as n from drizzle.__drizzle_migrations");
      expect(n?.n).toBe(readdirSync(migrationsFolder).filter((f) => f.endsWith(".sql")).length);
    } finally {
      await driver.close();
    }
  });
});

describe.runIf(process.env[TEST_POSTGRES_ENV])("migrations on PostgreSQL", () => {
  it("apply once when several processes start at the same time", async () => {
    const { createPostgresDatabase } = await import("./testing-postgres.js");
    const first = await createPostgresDatabase(process.env[TEST_POSTGRES_ENV] ?? "");
    const others = await Promise.all([1, 2, 3].map(() => openDriver({ url: first.url })));
    try {
      await Promise.all([first, ...others].map((d) => d.migrate()));
      const [n] = await first.query("select count(*)::int as n from drizzle.__drizzle_migrations");
      expect(n?.n).toBe(readdirSync(migrationsFolder).filter((f) => f.endsWith(".sql")).length);
    } finally {
      await Promise.all(others.map((d) => d.close()));
      await first.close();
    }
  });
});

describe("openDatabase", () => {
  it("persists an embedded database in the data directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openhoard-db-"));
    try {
      const first = await openDatabase({ url: "pglite", dataDir: dir });
      const { tenantId } = await seedTenant(first);
      await first.close();
      const second = await openDatabase({ url: "pglite", dataDir: dir });
      const rows = await second.withTenant(tenantId, (tx) => tx.select().from(objects));
      await second.close();
      expect(rows).toHaveLength(1);
      expect(readdirSync(join(dir, "pgdata")).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("lets only one process open an embedded database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openhoard-db-"));
    try {
      const first = await openDatabase({ url: "pglite", dataDir: dir });
      await expect(openDatabase({ url: "pglite", dataDir: dir })).rejects.toThrow(
        `already open in process ${process.pid}`,
      );
      await first.close();
      // Closing releases the lock.
      const again = await openDatabase({ url: "pglite", dataDir: dir });
      await again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("refuses PGlite's superuser session, which would skip row-level security", async () => {
    const raw = await PGlite.create();
    try {
      const problems = await checkServer(
        async (text) => (await raw.query<Record<string, unknown>>(text)).rows,
      );
      expect(problems).toContainEqual(expect.stringMatching(/postgres is a superuser/));
    } finally {
      await raw.close();
    }
  }, 60_000);

  it("can skip migrations", async () => {
    const db = await openDatabase({ url: "pglite:memory", migrate: false });
    try {
      const probe = db.withTenant(newId("tenant"), (tx) => tx.select().from(tenants));
      await expect(probe).rejects.toThrow();
    } finally {
      await db.close();
    }
  }, 60_000);

  it("closes the connection and throws when the server does not qualify", async () => {
    let closed = false;
    const driver = {
      kind: "postgres",
      db: undefined as never,
      query: () => Promise.resolve([{ num: 160013, version: "16.13", tz: "UTC" }]),
      migrate: () => Promise.reject(new Error("must not migrate")),
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    } satisfies Driver;
    await expect(prepareDriver(driver, { migrate: true })).rejects.toThrow(DatabaseCheckError);
    expect(closed).toBe(true);
  });

  it("opens postgres:// URLs lazily, without connecting", async () => {
    for (const url of ["postgres://u:p@127.0.0.1:1/db", "postgresql://u@127.0.0.1:1/db"]) {
      const driver = await openDriver({ url });
      expect(driver.kind).toBe("postgres");
      await driver.close();
    }
  });

  it("needs a data directory for pglite", async () => {
    await expect(openDriver({ url: "pglite" })).rejects.toThrow('"pglite" needs a dataDir');
  });

  it("rejects other URLs without echoing them (they may hold passwords)", async () => {
    const attempt = openDriver({ url: "mysql://root:hunter2@db/openhoard" });
    await expect(attempt).rejects.toThrow("unsupported database url");
    await expect(attempt).rejects.not.toThrow("hunter2");
  });
});
