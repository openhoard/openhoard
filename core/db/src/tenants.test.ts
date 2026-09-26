import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database } from "./database.js";
import { newId } from "./ids.js";
import { principalEpochs } from "./schema.js";
import { createTenant, getTenant } from "./tenants.js";
import { openSharedTestDatabases, openTestDatabase } from "./testing.js";

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
