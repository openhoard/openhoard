import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fromDriver, type Database } from "./database.js";
import { newId } from "./ids.js";
import { eq } from "drizzle-orm";
import { facets, facetValues, principalEpochs } from "./schema.js";
import {
  BUILT_IN_VOCABULARY,
  createTenant,
  ensureBuiltInVocabulary,
  getTenant,
} from "./tenants.js";
import {
  openSharedTestDatabases,
  openTestDatabase,
  openTestDriver,
  seedTenant,
} from "./testing.js";

/* T-103's bootstrap: a tenant with what every tenant needs. */

let db: Database;
beforeEach(async () => {
  db = await openTestDatabase();
});
afterEach(() => db?.close());

describe("openSharedTestDatabases", () => {
  it("gives two handles on one database, as two server processes would hold", async () => {
    const shared = await openSharedTestDatabases();
    try {
      const id = newId("tenant");
      await shared.first.withTenant(id, (tx) => createTenant(tx, id, { name: "Shared" }));
      expect(await shared.second.withTenant(id, (tx) => getTenant(tx, id))).toMatchObject({
        id,
        name: "Shared",
      });
    } finally {
      await shared.close();
    }
  });
});

describe("createTenant", () => {
  it("creates the tenant with fail-closed defaults and its principal epoch", async () => {
    const id = newId("tenant");
    const made = await db.withTenant(id, (tx) => createTenant(tx, id, { name: "  Acme  " }));
    expect(made).toMatchObject({ id, name: "Acme" });
    const seen = await db.withTenant(id, async (tx) => ({
      tenant: await getTenant(tx, id),
      epochs: await tx.select().from(principalEpochs),
    }));
    expect(seen.tenant).toMatchObject({ id, name: "Acme" });
    expect(seen.epochs).toHaveLength(1);
    expect(seen.epochs[0]?.epoch).toBeGreaterThan(0);
    expect(await db.tenantIds()).toEqual([id]);
  });

  it("gives the tenant the built-in vocabulary, and puts it back if changed", async () => {
    const id = newId("tenant");
    await db.withTenant(id, (tx) => createTenant(tx, id, { name: "Acme" }));
    const risk = () =>
      db.withTenant(id, async (tx) => ({
        facets: await tx.select().from(facets).where(eq(facets.key, "risk")),
        values: await tx.select().from(facetValues).where(eq(facetValues.facet, "risk")),
      }));
    expect(await risk()).toMatchObject({
      facets: [{ key: "risk", public: false }],
      values: [{ value: "injection", approved: true, exposure: "metadata-only", visibility: null }],
    });
    // A pack or an admin loosened it: the next ensure restores it; a second changes nothing.
    await db.withTenant(id, (tx) =>
      tx
        .update(facetValues)
        .set({ approved: false, exposure: "full" })
        .where(eq(facetValues.facet, "risk")),
    );
    await db.withTenant(id, (tx) => ensureBuiltInVocabulary(tx, id));
    await db.withTenant(id, (tx) => ensureBuiltInVocabulary(tx, id));
    expect((await risk()).values).toMatchObject([{ approved: true, exposure: "metadata-only" }]);
    expect(BUILT_IN_VOCABULARY.facet.key).toBe("risk");
  });

  it("migration 0046 gives tenants that existed before the built-in vocabulary", async () => {
    const driver = await openTestDriver();
    try {
      const before = fromDriver(driver);
      const a = await seedTenant(before, 1);
      const b = await seedTenant(before, 2);
      // b had it, loosened by an admin: put back.
      await before.withTenant(b.tenantId, async (tx) => {
        await tx.insert(facets).values({ tenantId: b.tenantId, key: "risk", label: "Mine" });
        await tx.insert(facetValues).values({
          tenantId: b.tenantId,
          facet: "risk",
          value: "injection",
          label: "x",
          approved: false,
          exposure: "full",
        });
      });
      const migration = readFileSync(
        fileURLToPath(new URL("../migrations/0046_built_in_vocabulary.sql", import.meta.url)),
        "utf8",
      );
      await driver.query(migration);
      for (const t of [a, b]) {
        const values = await before.withTenant(t.tenantId, (tx) =>
          tx.select().from(facetValues).where(eq(facetValues.facet, "risk")),
        );
        expect(values, t.tenantId).toMatchObject([
          { value: "injection", approved: true, exposure: "metadata-only" },
        ]);
      }
      // Nothing is left set on the session.
      expect(await driver.query("select current_setting('app.tenant_id', true) as t")).toEqual([
        { t: "" },
      ]);
    } finally {
      await driver.close();
    }
  });

  it("refuses a bad id or name, and a tenant that exists", async () => {
    const id = newId("tenant");
    await expect(
      db.withTenant(id, (tx) => createTenant(tx, "ten_x", { name: "A" })),
    ).rejects.toThrow(/not a tenant id/);
    for (const name of ["", "   ", "x".repeat(201), `a${String.fromCodePoint(0x200b)}b`]) {
      await expect(db.withTenant(id, (tx) => createTenant(tx, id, { name }))).rejects.toThrow(
        /1 to 200 visible characters/,
      );
    }
    await db.withTenant(id, (tx) => createTenant(tx, id, { name: "Acme" }));
    await expect(
      db.withTenant(id, (tx) => createTenant(tx, id, { name: "Again" })),
    ).rejects.toThrow();
  });

  it("can't create another tenant than the transaction's", async () => {
    const id = newId("tenant");
    const other = newId("tenant");
    await expect(
      db.withTenant(id, (tx) => createTenant(tx, other, { name: "X" })),
    ).rejects.toThrow();
    expect(await db.withTenant(id, (tx) => getTenant(tx, id))).toBeNull();
  });
});
