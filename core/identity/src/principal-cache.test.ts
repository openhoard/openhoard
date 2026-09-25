import {
  addGrant,
  groupMembers,
  queryRows,
  revokeGrant,
  type Database,
  type Tx,
} from "@openhoard/core-db";
import {
  openTestDatabase,
  seedTenant,
  TEST_POSTGRES_ENV,
  type SeededTenant,
} from "@openhoard/core-db/testing";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addMember,
  createGroup,
  createUser,
  deleteGroup,
  groupPrincipal,
  lockUser,
  removeMember,
  resolvePrincipal,
  retireUser,
  setProviderActive,
  unlockUser,
  updateUser,
  userPrincipal,
} from "./directory.js";
import { PrincipalCache } from "./principal-cache.js";

/* T-107: the principal-set service, cached, invalidated by every change it reads. */

const VIEW = { isolationLevel: "repeatable read", accessMode: "read only" } as const;

let db: Database;
let t: SeededTenant;
let cache: PrincipalCache;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  cache = new PrincipalCache();
});
afterEach(() => db?.close());

const write = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work);
const resolved = (userId = t.userId, c = cache) =>
  db.withTenant(t.tenantId, (tx) => c.resolve(tx, t.tenantId, userId), VIEW);
const fresh = (userId = t.userId) =>
  db.withTenant(t.tenantId, (tx) => resolvePrincipal(tx, t.tenantId, userId), VIEW);
const grant = (principal: string, objectId = t.objectId, expiresAt?: Date) =>
  write((tx) =>
    addGrant(tx, t.tenantId, {
      principal,
      role: "read",
      target: { objectId },
      grantedBy: "user:admin",
      ...(expiresAt === undefined ? {} : { expiresAt }),
    }),
  );

describe("the principal cache", () => {
  it("answers what resolvePrincipal answers, and the second time from the cache", async () => {
    const first = await resolved();
    expect(first).toEqual(await fresh());
    expect(await resolved()).toBe(first);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, bypassed: 0, size: 1 });
  });

  it("hands out principals nobody can change", async () => {
    const p = await resolved();
    expect(Object.isFrozen(p)).toBe(true);
    expect(() => (p?.groupIds as string[]).push("grp_x")).toThrow(TypeError);
  });

  it("sees a grant added or revoked at once", async () => {
    expect((await resolved())?.objectGrants).toEqual([]);
    const id = await grant(userPrincipal(t.userId));
    expect((await resolved())?.objectGrants).toEqual([t.objectId]);
    await write((tx) => revokeGrant(tx, t.tenantId, id, "user:admin"));
    expect((await resolved())?.objectGrants).toEqual([]);
  });

  it("sees a membership added or removed at once, and grants to that group with it", async () => {
    const g = await write((tx) =>
      createGroup(tx, t.tenantId, { name: "Auditors", source: "local" }),
    );
    await grant(groupPrincipal(g.id));
    const before = await resolved();
    expect(before?.groupIds).not.toContain(g.id);
    await write((tx) => addMember(tx, t.tenantId, g.id, t.userId, "local"));
    expect(await resolved()).toMatchObject({ groupIds: expect.arrayContaining([g.id]) });
    expect((await resolved())?.objectGrants).toEqual([t.objectId]);
    await write((tx) => removeMember(tx, t.tenantId, g.id, t.userId, "local"));
    expect((await resolved())?.groupIds).not.toContain(g.id);
  });

  it("sees a user's stops at once: lock, provider disable, retirement", async () => {
    expect((await resolved())?.active).toBe(true);
    await write((tx) => lockUser(tx, t.tenantId, t.userId, "user:admin"));
    expect((await resolved())?.active).toBe(false);
    await write((tx) => unlockUser(tx, t.tenantId, t.userId, "user:admin"));
    expect((await resolved())?.active).toBe(true);
    const scim = await write((tx) =>
      createUser(tx, t.tenantId, {
        email: "cy@example.com",
        displayName: "Cy",
        source: "scim",
        externalId: "entra-cy",
      }),
    );
    expect((await resolved(scim.id))?.active).toBe(true);
    await write((tx) => setProviderActive(tx, t.tenantId, scim.id, false, "scim:entra"));
    expect((await resolved(scim.id))?.active).toBe(false);
    await write((tx) => retireUser(tx, t.tenantId, t.userId, "system:offboarding"));
    expect((await resolved())?.active).toBe(false);
  });

  it("sees a change of kind at once, but a rename changes nothing", async () => {
    await resolved();
    await write((tx) => updateUser(tx, t.tenantId, t.userId, { displayName: "Ana B" }, "local"));
    await resolved();
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
    await write((tx) => updateUser(tx, t.tenantId, t.userId, { kind: "guest" }, "local"));
    expect((await resolved())?.guest).toBe(true);
  });

  it("drops a grant when it expires, without anything being written", async () => {
    const soon = new Date(Date.now() + 1500);
    await grant(userPrincipal(t.userId), t.objectId, soon);
    expect((await resolved())?.objectGrants).toEqual([t.objectId]);
    await new Promise((r) => setTimeout(r, 1700));
    expect((await resolved())?.objectGrants).toEqual([]);
  });

  it("keeps entries no longer than the time to live", async () => {
    const short = new PrincipalCache({ ttlMillis: 0 });
    await resolved(t.userId, short);
    await resolved(t.userId, short);
    expect(short.stats()).toMatchObject({ hits: 0, misses: 2 });
  });

  it("is used only by read-only transactions: a writer may see its own changes, and roll back", async () => {
    // A transaction grants, reads through the cache, and rolls back.
    await db
      .withTenant(t.tenantId, async (tx) => {
        await addGrant(tx, t.tenantId, {
          principal: userPrincipal(t.userId),
          role: "read",
          target: { objectId: t.objectId },
          grantedBy: "user:admin",
        });
        expect((await cache.resolve(tx, t.tenantId, t.userId))?.objectGrants).toEqual([t.objectId]);
        throw new Error("roll back");
      })
      .catch(() => undefined);
    expect(cache.stats()).toMatchObject({ bypassed: 1, size: 0 });
    // Another change moves the epoch as far as the rolled-back one would have: nothing stale.
    const g = await write((tx) => createGroup(tx, t.tenantId, { name: "G", source: "local" }));
    await write((tx) => addMember(tx, t.tenantId, g.id, t.userId, "local"));
    expect((await resolved())?.objectGrants).toEqual([]);
  });

  it("keeps tenants apart, and forgets on request", async () => {
    const other = await seedTenant(db, 2);
    await resolved();
    await db.withTenant(
      other.tenantId,
      (tx) => cache.resolve(tx, other.tenantId, other.userId),
      VIEW,
    );
    // A change in one tenant leaves the other's entries alone.
    await grant(userPrincipal(t.userId));
    await db.withTenant(
      other.tenantId,
      (tx) => cache.resolve(tx, other.tenantId, other.userId),
      VIEW,
    );
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 2, size: 2 });
    cache.clear(t.tenantId);
    expect(cache.stats().size).toBe(1);
    cache.clear();
    expect(cache.stats().size).toBe(0);
  });

  it("returns null for an unknown user and keeps nothing for it", async () => {
    expect(await resolved("usr_00000000000000000000000000")).toBeNull();
    expect(cache.stats().size).toBe(0);
  });

  it("drops the least recently used entry past its size", async () => {
    const small = new PrincipalCache({ maxEntries: 1 });
    const bo = await write((tx) =>
      createUser(tx, t.tenantId, { email: "bo@example.com", displayName: "Bo", source: "local" }),
    );
    await resolved(t.userId, small);
    await resolved(bo.id, small);
    await resolved(t.userId, small);
    expect(small.stats()).toMatchObject({ hits: 0, misses: 3, size: 1 });
    expect(() => new PrincipalCache({ maxEntries: 0 })).toThrow(RangeError);
    expect(() => new PrincipalCache({ ttlMillis: -1 })).toThrow(RangeError);
  });

  it("resolves grants as of the moment it reads, not the transaction's start", async () => {
    const id = await grant(userPrincipal(t.userId));
    // Revoked a little from now (a writer's now() can be later than a reader's start).
    await write((tx) => revokeGrant(tx, t.tenantId, id, "user:admin", new Date(Date.now() + 300)));
    const late = await db.withTenant(
      t.tenantId,
      async (tx) => {
        await tx.execute(sql`select pg_sleep(0.6)`);
        return cache.resolve(tx, t.tenantId, t.userId);
      },
      VIEW,
    );
    expect(late?.objectGrants).toEqual([]);
    expect((await resolved())?.objectGrants).toEqual([]);
  });

  it("keeps nothing from a READ COMMITTED reader, or for a tenant with no epoch yet", async () => {
    await db.withTenant(t.tenantId, (tx) => cache.resolve(tx, t.tenantId, t.userId), {
      accessMode: "read only",
    });
    expect(cache.stats()).toMatchObject({ bypassed: 1, size: 0 });
    await write((tx) => tx.execute(sql`delete from principal_epochs`));
    await resolved();
    expect(cache.stats()).toMatchObject({ bypassed: 2, size: 0 });
  });

  it("bumps the epoch once for a statement that changes many memberships", async () => {
    const epoch = async () =>
      (
        await db.withTenant(t.tenantId, (tx) =>
          queryRows<{ e: string }>(tx, sql`select epoch::text as e from principal_epochs`),
        )
      )[0]?.e;
    const g = await write((tx) => createGroup(tx, t.tenantId, { name: "All", source: "local" }));
    const people = await write(async (tx) =>
      Promise.all(
        ["a", "b", "c"].map((n) =>
          createUser(tx, t.tenantId, {
            email: `${n}@example.com`,
            displayName: n,
            source: "local",
          }),
        ),
      ),
    );
    const before = BigInt((await epoch()) ?? "0");
    await write((tx) =>
      tx
        .insert(groupMembers)
        .values(people.map((p) => ({ tenantId: t.tenantId, groupId: g.id, userId: p.id }))),
    );
    expect(BigInt((await epoch()) ?? "0") - before).toBe(1n);
  });

  it("invalidates entries in every cache, as it would in every process", async () => {
    const other = new PrincipalCache();
    await resolved(t.userId, cache);
    await resolved(t.userId, other);
    const g = await write((tx) => createGroup(tx, t.tenantId, { name: "Gone", source: "local" }));
    await write((tx) => addMember(tx, t.tenantId, g.id, t.userId, "local"));
    for (const c of [cache, other]) {
      expect((await resolved(t.userId, c))?.groupIds).toContain(g.id);
    }
    await write((tx) => deleteGroup(tx, t.tenantId, g.id, "local", "user:admin"));
    for (const c of [cache, other]) {
      expect((await resolved(t.userId, c))?.groupIds).not.toContain(g.id);
    }
  });

  it.runIf(process.env[TEST_POSTGRES_ENV])(
    "takes the epoch lock first, so two membership changes can't deadlock (PostgreSQL)",
    async () => {
      const g1 = await write((tx) => createGroup(tx, t.tenantId, { name: "G1", source: "local" }));
      const g2 = await write((tx) => createGroup(tx, t.tenantId, { name: "G2", source: "local" }));
      const u3 = await write((tx) =>
        createUser(tx, t.tenantId, { email: "u3@example.com", displayName: "U3", source: "local" }),
      );
      let release = () => {};
      const held = new Promise<void>((r) => (release = r));
      let signal = () => {};
      const first = new Promise<void>((r) => (signal = r));
      const a = write(async (tx) => {
        await addMember(tx, t.tenantId, g1.id, t.userId, "local");
        signal();
        await held;
        await addMember(tx, t.tenantId, g2.id, t.userId, "local");
      });
      await first;
      const b = write((tx) => addMember(tx, t.tenantId, g2.id, u3.id, "local"));
      // Let B reach its first lock, then let A go on.
      await new Promise((r) => setTimeout(r, 200));
      release();
      await expect(Promise.all([a, b])).resolves.toBeDefined();
    },
  );

  it("counts on the database: each change the resolver reads bumps the tenant's epoch", async () => {
    const epoch = async (tenantId = t.tenantId) => {
      const [row] = await db.withTenant(tenantId, (tx) =>
        queryRows<{ e: string; n: number }>(
          tx,
          sql`select coalesce(max(epoch), 0)::text as e, count(*)::int as n from principal_epochs`,
        ),
      );
      return row;
    };
    const other = await seedTenant(db, 3);
    const start = BigInt((await epoch())?.e ?? "0");
    const theirs = await epoch(other.tenantId);
    await grant(userPrincipal(t.userId));
    expect(BigInt((await epoch())?.e ?? "0")).toBeGreaterThan(start);
    // Row-level security keeps each tenant's counter to itself, and ours moved alone.
    expect(await epoch(other.tenantId)).toEqual(theirs);
    expect(theirs?.n).toBe(1);
  });
});
