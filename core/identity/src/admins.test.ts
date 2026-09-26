import { sqlState, users, type Database, type Tx } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { grantAdmin, isAdmin, listAdmins, revokeAdmin } from "./admins.js";
import {
  addMember,
  createGroup,
  createServiceAccount,
  createUser,
  deleteGroup,
  getUser,
  IdentityError,
  lockUser,
  removeMember,
  resolvePrincipal,
  retireUser,
  setProviderActive,
  unlockUser,
  updateGroup,
  updateUser,
  type User,
} from "./directory.js";
import { PrincipalCache } from "./principal-cache.js";

/* T-106: tenant admins, by role held in OpenHoard or by the identity provider's admin group. */

const VIEW = { isolationLevel: "repeatable read", accessMode: "read only" } as const;
const GROUP = "entra-group-admins";

let db: Database;
let t: SeededTenant;
let ana: User;
let bo: User;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  ana = await person("ana");
  bo = await person("bo");
});
afterEach(() => db?.close());

const write = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work);
const read = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work, VIEW);
function person(name: string, source: "scim" | "local" = "scim"): Promise<User> {
  return write((tx) =>
    createUser(tx, t.tenantId, {
      email: `${name}@example.com`,
      displayName: name,
      source,
      ...(source === "scim" ? { externalId: `ext-${name}` } : {}),
    }),
  );
}
const grant = (userId: string, by = "system:admin-cli") =>
  write((tx) => grantAdmin(tx, t.tenantId, userId, by));
const revoke = (userId: string, adminGroupId?: string) =>
  write((tx) =>
    revokeAdmin(tx, t.tenantId, userId, "user:someone", adminGroupId ? { adminGroupId } : {}),
  );
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof IdentityError ? e.code : `not an IdentityError: ${String(e)}`;
  }
  return "no error";
};
/** A SCIM group with this external id and these members. */
async function scimGroup(externalId: string, members: User[]) {
  return write(async (tx) => {
    const g = await createGroup(tx, t.tenantId, { name: externalId, source: "scim", externalId });
    for (const m of members) await addMember(tx, t.tenantId, g.id, m.id, "scim");
    return g;
  });
}

describe("the admin role", () => {
  it("is granted to an active member once, and is part of their principal", async () => {
    expect((await read((tx) => resolvePrincipal(tx, t.tenantId, ana.id)))?.admin).toBeUndefined();
    expect(await grant(ana.id)).toBe(true);
    expect(await grant(ana.id, "user:other")).toBe(false);
    const stored = await read((tx) => getUser(tx, t.tenantId, ana.id));
    expect(stored?.adminRole).toMatchObject({ by: "system:admin-cli" });
    expect(await read((tx) => resolvePrincipal(tx, t.tenantId, ana.id))).toMatchObject({
      admin: true,
    });
    expect(await read((tx) => isAdmin(tx, t.tenantId, ana.id))).toBe(true);
    expect(await read((tx) => isAdmin(tx, t.tenantId, bo.id))).toBe(false);
  });

  it("is never a guest's, a service account's, a locked or retired person's", async () => {
    const guest = await write((tx) =>
      createUser(tx, t.tenantId, {
        email: "guest@elsewhere.example",
        displayName: "Guest",
        source: "local",
        kind: "guest",
      }),
    );
    expect(await code(grant(guest.id))).toBe("invalid");
    const bot = await write((tx) =>
      createServiceAccount(tx, t.tenantId, { displayName: "CI", by: "user:admin" }),
    );
    expect(await code(grant(bot.id))).toBe("invalid");
    await write((tx) => lockUser(tx, t.tenantId, bo.id, "user:admin"));
    expect(await code(grant(bo.id))).toBe("inactive");
    const cy = await person("cy", "local");
    await write((tx) => retireUser(tx, t.tenantId, cy.id, "user:admin"));
    expect(await code(grant(cy.id))).toBe("not-found");
    expect(await code(grant("usr_nope"))).toBe("not-found");
    expect(await code(grant(ana.id, "scim:tok"))).toBe("invalid");
    // The database holds it too: a service account never carries the role.
    const err = await write((tx) =>
      tx
        .update(users)
        .set({ adminAt: sql`now()`, adminBy: "system:x" })
        .where(and(eq(users.tenantId, t.tenantId), eq(users.id, bot.id))),
    ).catch((e: unknown) => e);
    expect(sqlState(err)).toBe("23514");
  });

  it("counts only while its holder is an active member, and goes with retirement", async () => {
    await grant(ana.id);
    await grant(bo.id);
    const admin = async (u: User) =>
      (await read((tx) => resolvePrincipal(tx, t.tenantId, u.id)))?.admin === true;
    await write((tx) => lockUser(tx, t.tenantId, ana.id, "user:admin"));
    expect(await admin(ana)).toBe(false);
    expect(await read((tx) => isAdmin(tx, t.tenantId, ana.id))).toBe(false);
    await write((tx) => unlockUser(tx, t.tenantId, ana.id, "user:admin"));
    expect(await admin(ana)).toBe(true);
    await write((tx) => setProviderActive(tx, t.tenantId, ana.id, false, "scim:tok"));
    expect(await admin(ana)).toBe(false);
    await write((tx) => setProviderActive(tx, t.tenantId, ana.id, true, "scim:tok"));
    await write((tx) => updateUser(tx, t.tenantId, ana.id, { kind: "guest" }, "scim"));
    expect(await admin(ana)).toBe(false);
    await write((tx) => updateUser(tx, t.tenantId, ana.id, { kind: "member" }, "scim"));
    expect(await admin(ana)).toBe(true);
    await write((tx) => retireUser(tx, t.tenantId, ana.id, "scim:tok"));
    expect((await read((tx) => getUser(tx, t.tenantId, ana.id)))?.adminRole).toBeNull();
  });
});

describe("the admin group", () => {
  it("makes its members admins while the config names it, and they can't be removed here", async () => {
    const g = await scimGroup(GROUP, [ana]);
    const options = { adminGroupId: g.id };
    expect(await read((tx) => isAdmin(tx, t.tenantId, ana.id))).toBe(false);
    expect(await read((tx) => isAdmin(tx, t.tenantId, ana.id, options))).toBe(true);
    expect(
      await read((tx) => resolvePrincipal(tx, t.tenantId, ana.id, undefined, options)),
    ).toMatchObject({ admin: true });
    // The identity provider owns that membership.
    expect(await code(revoke(ana.id, g.id))).toBe("wrong-source");
    // Without the config's group, she simply isn't one.
    expect(await revoke(ana.id)).toEqual({ revoked: false, stillAdminByGroup: false });
    expect(await read((tx) => listAdmins(tx, t.tenantId, options))).toEqual([
      expect.objectContaining({ user: expect.objectContaining({ id: ana.id }), via: ["group"] }),
    ]);
  });

  it("is named by id: no external id, and no local group, makes anyone an admin", async () => {
    const g = await scimGroup(GROUP, [ana]);
    // Another SCIM group taking any external id (the admin group's too, once it lets go of it)
    // is still another group.
    await write((tx) => updateGroup(tx, t.tenantId, g.id, { externalId: "moved" }, "scim"));
    const other = await scimGroup(GROUP, [bo]);
    const options = { adminGroupId: g.id };
    const admin = async (u: User, o: { adminGroupId?: string } = options) =>
      (await read((tx) => resolvePrincipal(tx, t.tenantId, u.id, undefined, o)))?.admin === true;
    expect(await admin(ana)).toBe(true);
    expect(await admin(bo)).toBe(false);
    expect(await read((tx) => isAdmin(tx, t.tenantId, bo.id, options))).toBe(false);
    // An external id where the config expects an id names nothing.
    expect(await admin(bo, { adminGroupId: GROUP })).toBe(false);
    expect(await admin(bo, { adminGroupId: other.externalId as string })).toBe(false);
    // A local group named as the admin group makes nobody an admin (fail closed).
    const cy = await person("cy", "local");
    const local = await write(async (tx) => {
      const l = await createGroup(tx, t.tenantId, { name: "Local", source: "local" });
      await addMember(tx, t.tenantId, l.id, cy.id, "local");
      return { group: l, cy };
    });
    expect(await admin(local.cy, { adminGroupId: local.group.id })).toBe(false);
    expect(
      await read((tx) => isAdmin(tx, t.tenantId, local.cy.id, { adminGroupId: local.group.id })),
    ).toBe(false);
    // Deleted, it makes nobody an admin, cached or not.
    const cache = new PrincipalCache({ adminGroupId: () => g.id });
    expect((await read((tx) => cache.resolve(tx, t.tenantId, ana.id)))?.admin).toBe(true);
    await write((tx) => deleteGroup(tx, t.tenantId, g.id, "scim", "scim:tok"));
    expect(await admin(ana)).toBe(false);
    expect((await read((tx) => cache.resolve(tx, t.tenantId, ana.id)))?.admin).toBeUndefined();
    expect(await read((tx) => listAdmins(tx, t.tenantId, options))).toEqual([]);
  });

  it("reaches cached principals as soon as its members change", async () => {
    const g = await scimGroup(GROUP, [ana]);
    const cache = new PrincipalCache({
      adminGroupId: (id) => (id === t.tenantId ? g.id : undefined),
    });
    const cached = async (u: User) =>
      (await read((tx) => cache.resolve(tx, t.tenantId, u.id)))?.admin === true;
    expect(await cached(bo)).toBe(false);
    expect(await cached(bo)).toBe(false);
    expect(cache.stats().hits).toBeGreaterThan(0);
    await write((tx) => addMember(tx, t.tenantId, g.id, bo.id, "scim"));
    expect(await cached(bo)).toBe(true);
    await write((tx) => removeMember(tx, t.tenantId, g.id, bo.id, "scim"));
    expect(await cached(bo)).toBe(false);
    // Renaming it, or changing its external id, changes nothing.
    await write((tx) => updateGroup(tx, t.tenantId, g.id, { externalId: "renamed" }, "scim"));
    expect(await cached(ana)).toBe(true);
    // The role, too.
    await grant(bo.id);
    expect(await cached(bo)).toBe(true);
  });
});

describe("removing an admin", () => {
  it("removes the role, but never the last admin who counts", async () => {
    await grant(ana.id);
    expect(await code(revoke(ana.id))).toBe("conflict");
    await grant(bo.id);
    expect(await revoke(ana.id)).toEqual({ revoked: true, stillAdminByGroup: false });
    expect(await revoke(ana.id)).toEqual({ revoked: false, stillAdminByGroup: false });
    expect(await code(revoke(bo.id))).toBe("conflict");
    expect((await read((tx) => resolvePrincipal(tx, t.tenantId, ana.id)))?.admin).toBeUndefined();
  });

  it("counts group admins, and doesn't count locked ones", async () => {
    await grant(ana.id);
    await grant(bo.id);
    await write((tx) => lockUser(tx, t.tenantId, bo.id, "user:admin"));
    // Bo is locked: Ana is the only admin who counts.
    expect(await code(revoke(ana.id))).toBe("conflict");
    // Removing a role that doesn't count now is fine.
    expect(await revoke(bo.id)).toEqual({ revoked: true, stillAdminByGroup: false });
    // A group admin counts: Ana may go.
    const cy = await person("cy");
    const g = await scimGroup(GROUP, [cy]);
    expect(await code(revoke(ana.id, g.id))).toBe("no error");
    // Someone with the role and the group loses the role and stays an admin, last or not.
    await grant(cy.id);
    expect(await revoke(cy.id, g.id)).toEqual({ revoked: true, stillAdminByGroup: true });
    const listed = await read((tx) => listAdmins(tx, t.tenantId, { adminGroupId: g.id }));
    expect(listed.map((a) => [a.user.id, a.via, a.effective])).toEqual([[cy.id, ["group"], true]]);
  });

  it("lists every holder, saying who counts now", async () => {
    await grant(ana.id);
    await grant(bo.id);
    await write((tx) => lockUser(tx, t.tenantId, bo.id, "user:admin"));
    const listed = await read((tx) => listAdmins(tx, t.tenantId));
    expect(
      listed
        .map((a) => [a.user.id, a.via, a.effective] as const)
        .sort((x, y) => (x[0] < y[0] ? -1 : 1)),
    ).toEqual(
      [
        [ana.id, ["role"], true],
        [bo.id, ["role"], false],
      ].sort((x, y) => ((x[0] as string) < (y[0] as string) ? -1 : 1)),
    );
    expect(await code(revoke("usr_nope"))).toBe("not-found");
  });
});
