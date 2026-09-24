import { Authorizer, createCedarEngine } from "@openhoard/core-policy";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromDriver, type Database, type Driver, type Tx } from "./database.js";
import {
  addGrant,
  DEFAULT_GRANT_DAYS,
  loadGrants,
  revokeGrant,
  type GrantInput,
} from "./grants.js";
import { newId } from "./ids.js";
import { facetValues, grants, groups, objects, users } from "./schema.js";
import { openTestDriver, seedTenant, type SeededTenant } from "./testing.js";

/* Grants as data (T-602): default expiry, revocation, and what a caller holds. */

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
const FOREIGN_KEY_VIOLATION = "23503";
const DAY = 24 * 60 * 60 * 1000;

let driver: Driver;
let db: Database;
let t: SeededTenant;
// Principals: two users and a group, created for each test.
let anaId: string, salesId: string;
let ana: string, bo: string, sales: string;
beforeEach(async () => {
  driver = await openTestDriver();
  db = fromDriver(driver);
  t = await seedTenant(db, 1);
  anaId = newId("user");
  const boId = newId("user");
  salesId = newId("group");
  [ana, bo, sales] = [`user:${anaId}`, `user:${boId}`, `group:${salesId}`];
  await db.withTenant(t.tenantId, async (tx) => {
    await tx.insert(facetValues).values([
      { tenantId: t.tenantId, facet: "client", value: "globex", label: "Globex", approved: true },
      { tenantId: t.tenantId, facet: "client", value: "initech", label: "Initech", approved: true },
    ]);
    const person = (id: string, name: string) => ({
      tenantId: t.tenantId,
      id,
      email: `${name}@example.com`,
      emailKey: `${name}@example.com`,
      displayName: name,
      source: "local" as const,
    });
    await tx.insert(users).values([person(anaId, "ana"), person(boId, "bo")]);
    await tx
      .insert(groups)
      .values({ tenantId: t.tenantId, id: salesId, name: "Sales", source: "local" });
  });
});
afterEach(() => driver?.close());

const inTenant = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work);
const grant = (input: Partial<GrantInput> = {}, now?: Date) =>
  inTenant((tx) =>
    addGrant(
      tx,
      t.tenantId,
      {
        principal: ana,
        role: "read",
        target: { tag: "client:globex" },
        grantedBy: "user:admin",
        ...input,
      },
      now,
    ),
  );
const load = (principals: string[], at?: Date) =>
  inTenant((tx) => loadGrants(tx, t.tenantId, principals, at));
const row = (id: string) =>
  inTenant(async (tx) => (await tx.select().from(grants).where(eq(grants.id, id)))[0]);

describe("addGrant", () => {
  it(`expires grants after ${DEFAULT_GRANT_DAYS} days unless told otherwise`, async () => {
    const now = new Date();
    const id = await grant({}, now);
    expect((await row(id))?.expiresAt?.getTime()).toBe(now.getTime() + DEFAULT_GRANT_DAYS * DAY);
    const until = new Date(now.getTime() + 7 * DAY);
    expect((await row(await grant({ expiresAt: until }, now)))?.expiresAt).toEqual(until);
    expect((await row(await grant({ expiresAt: null }, now)))?.expiresAt).toBeNull();
  });

  it("grants a tag or one object, never both or neither", async () => {
    const id = await grant({ target: { objectId: t.objectId }, role: "write" });
    expect(await row(id)).toMatchObject({ objectId: t.objectId, facet: null, value: null });
    const both = inTenant((tx) =>
      tx.insert(grants).values({
        tenantId: t.tenantId,
        id: newId("grant"),
        principal: ana,
        role: "read",
        facet: "client",
        value: "globex",
        objectId: t.objectId,
        grantedBy: "user:admin",
      }),
    );
    expect(await sqlState(both)).toBe(CHECK_VIOLATION);
    const neither = inTenant((tx) =>
      tx.insert(grants).values({
        tenantId: t.tenantId,
        id: newId("grant"),
        principal: ana,
        role: "read",
        grantedBy: "user:admin",
      }),
    );
    expect(await sqlState(neither)).toBe(CHECK_VIOLATION);
  });

  it.each<[string, Partial<GrantInput>, string]>([
    [
      "an object that does not exist",
      { target: { objectId: newId("object") } },
      FOREIGN_KEY_VIOLATION,
    ],
    ["a granter that is not a principal", { grantedBy: "admin" }, CHECK_VIOLATION],
    [
      "an expiry that has already passed",
      { expiresAt: new Date(Date.now() - DAY) },
      CHECK_VIOLATION,
    ],
    ["an unknown role", { role: "admin" as "read" }, CHECK_VIOLATION],
  ])("refuses %s", async (_, input, code) => {
    expect(await sqlState(grant(input))).toBe(code);
  });

  it("refuses principals that aren't a current user or an existing group", async () => {
    await expect(grant({ principal: "tag:client:globex" })).rejects.toThrow(
      "user:<id> or group:<id>",
    );
    await expect(grant({ principal: `user:${newId("user")}` })).rejects.toMatchObject({
      name: "GrantError",
      code: "unknown-principal",
    });
    await expect(grant({ principal: `group:${newId("group")}` })).rejects.toThrow("no such group");
    const other = await seedTenant(db, 2);
    await expect(grant({ principal: `user:${other.userId}` })).rejects.toThrow("no such user");
    await inTenant((tx) =>
      tx
        .update(users)
        .set({ retiredAt: new Date(), retiredBy: "user:admin" })
        .where(eq(users.id, anaId)),
    );
    await expect(grant()).rejects.toThrow("no such user");
    expect(await grant({ principal: sales })).toMatch(/^grt_/);
  });

  it("refuses another tenant's object", async () => {
    const other = await seedTenant(db, 2);
    expect(await sqlState(grant({ target: { objectId: other.objectId } }))).toBe(
      FOREIGN_KEY_VIOLATION,
    );
  });

  it("refuses a target naming both a tag and an object, or neither", async () => {
    const both = { tag: "client:globex", objectId: t.objectId } as unknown as { tag: string };
    await expect(grant({ target: both })).rejects.toThrow("not both or neither");
    await expect(grant({ target: {} as { tag: string } })).rejects.toThrow("not both or neither");
  });

  it("refuses a proposed value that nobody has approved", async () => {
    await inTenant((tx) =>
      tx
        .insert(facetValues)
        .values({ tenantId: t.tenantId, facet: "client", value: "proposed", label: "Proposed" }),
    );
    await expect(grant({ target: { tag: "client:proposed" } })).rejects.toThrow(
      "not an approved tag",
    );
    await expect(grant({ target: { tag: "client:nobody" } })).rejects.toThrow(
      "not an approved tag",
    );
  });

  it("refuses a revocation dated before the grant", async () => {
    const now = new Date();
    const id = await grant({}, now);
    const early = inTenant((tx) =>
      revokeGrant(tx, t.tenantId, id, "user:admin", new Date(now.getTime() - DAY)),
    );
    expect(await sqlState(early)).toBe(CHECK_VIOLATION);
  });

  it.each(["client", "client:", ":globex", ""])("refuses the tag %j", async (tag) => {
    await expect(grant({ target: { tag } })).rejects.toThrow("a tag is facet:value");
  });
});

describe("loadGrants", () => {
  it("collects a user's grants and their groups', by kind and role", async () => {
    await grant({ principal: ana, target: { tag: "client:globex" } });
    await grant({ principal: sales, target: { tag: "client:initech" }, role: "write" });
    await grant({ principal: sales, target: { objectId: t.objectId } });
    await grant({ principal: ana, target: { objectId: t.objectId }, role: "write" });
    await grant({ principal: bo, target: { tag: "client:acme-1" } });
    expect(await load([ana, sales, "tag:client:x"])).toEqual({
      tagGrants: ["client:globex"],
      tagWriteGrants: ["client:initech"],
      objectGrants: [t.objectId],
      objectWriteGrants: [t.objectId],
    });
  });

  it("includes the seeded group's permanent grant and nothing for unknown principals", async () => {
    expect((await load([`group:${t.groupId}`])).tagGrants).toEqual([t.tag]);
    expect(await load(["user:nobody"])).toEqual({
      tagGrants: [],
      tagWriteGrants: [],
      objectGrants: [],
      objectWriteGrants: [],
    });
    expect((await load([])).tagGrants).toEqual([]);
  });

  it("lists each grant once, however many principals hold it", async () => {
    await grant({ principal: ana });
    await grant({ principal: sales });
    await grant({ principal: sales, expiresAt: null });
    expect((await load([ana, sales, ana])).tagGrants).toEqual(["client:globex"]);
  });

  it("stops counting a grant the moment it expires, with no job run", async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 1500);
    await grant({ expiresAt }, now);
    expect((await load([ana])).tagGrants).toEqual(["client:globex"]);
    await new Promise((r) => setTimeout(r, expiresAt.getTime() - Date.now() + 50));
    expect((await load([ana])).tagGrants).toEqual([]);
  });

  it("answers for the moment asked: not before the grant existed, and still after a later revocation", async () => {
    const now = new Date();
    const id = await grant({ expiresAt: new Date(now.getTime() + 30 * DAY) }, now);
    expect((await load([ana], new Date(now.getTime() - DAY))).tagGrants).toEqual([]);
    const revokedAt = new Date(now.getTime() + 5 * DAY);
    await inTenant((tx) => revokeGrant(tx, t.tenantId, id, "user:admin", revokedAt));
    expect((await load([ana], new Date(now.getTime() + DAY))).tagGrants).toEqual(["client:globex"]);
    expect((await load([ana], revokedAt)).tagGrants).toEqual([]);
  });

  it("answers for any moment: live before expiry, gone at and after it", async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * DAY);
    await grant({ expiresAt }, now);
    expect((await load([ana], new Date(expiresAt.getTime() - 1))).tagGrants).toHaveLength(1);
    expect((await load([ana], expiresAt)).tagGrants).toEqual([]);
    expect((await load([ana], new Date(now.getTime() + 11 * DAY))).tagGrants).toEqual([]);
  });

  it("goes away with a deleted object", async () => {
    await grant({ target: { objectId: t.objectId } });
    await inTenant((tx) => tx.delete(objects).where(eq(objects.id, t.objectId)));
    expect((await load([ana])).objectGrants).toEqual([]);
  });
});

describe("revokeGrant", () => {
  it("revokes once, keeps the row, and stops the grant counting", async () => {
    const id = await grant();
    expect(await inTenant((tx) => revokeGrant(tx, t.tenantId, id, "user:admin"))).toBe(true);
    expect(await inTenant((tx) => revokeGrant(tx, t.tenantId, id, "user:admin"))).toBe(false);
    expect(await row(id)).toMatchObject({ revokedBy: "user:admin", revokedAt: expect.any(Date) });
    expect((await load([ana])).tagGrants).toEqual([]);
  });

  it("knows nothing of unknown ids", async () => {
    expect(await inTenant((tx) => revokeGrant(tx, t.tenantId, newId("grant"), "user:admin"))).toBe(
      false,
    );
  });

  it("records who revoked", async () => {
    const id = await grant();
    const half = inTenant((tx) =>
      tx.update(grants).set({ revokedAt: new Date() }).where(eq(grants.id, id)),
    );
    expect(await sqlState(half)).toBe(CHECK_VIOLATION);
  });
});

describe("with authorize()", () => {
  it("allows while a grant is live and denies once it expires, with nothing run in between", async () => {
    const authz = new Authorizer(createCedarEngine());
    const now = new Date();
    const expiresAt = new Date(now.getTime() + DAY);
    await grant({ principal: sales, target: { objectId: t.objectId }, expiresAt }, now);
    const decide = async (at: Date) => {
      const held = await load([ana, sales], at);
      return authz.authorize({
        principal: {
          userId: anaId,
          groupIds: [salesId],
          guest: false,
          active: true,
          ...held,
        },
        action: "open",
        resource: { id: t.objectId, ownerId: "user:owner-1", tags: [], zone: "indexed" },
        client: { id: "openhoard-web", trust: "first-party" },
      }).allow;
    };
    expect(await decide(now)).toBe(true);
    expect(await decide(new Date(expiresAt.getTime() + 1))).toBe(false);
  });
});
