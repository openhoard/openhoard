import {
  addGrant,
  grants,
  groups,
  sqlState,
  userIdentities,
  users,
  type Database,
  type Tx,
} from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { Authorizer, createCedarEngine } from "@openhoard/core-policy";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addMember,
  createGroup,
  createUser,
  deleteGroup,
  emailKey,
  findGroupByExternalId,
  findUserByEmail,
  findUserByExternalId,
  findUserByIdentity,
  findUserByUserName,
  getGroup,
  getUser,
  groupPrincipal,
  groupsOf,
  IdentityError,
  linkIdentity,
  lockUser,
  membersOf,
  removeMember,
  renameGroup,
  resolvePrincipal,
  retireUser,
  setProviderActive,
  unlinkIdentity,
  unlockUser,
  updateUser,
  listGroups,
  listUsers,
  updateGroup,
  userNameKey,
  userPrincipal,
  type GroupQuery,
  type NewUser,
  type UserQuery,
} from "./directory.js";

/* T-101: users and groups from SCIM or OpenHoard itself, and who a user is to authorize(). */

let db: Database;
let t: SeededTenant;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
});
afterEach(() => db?.close());

const inTenant = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work);
const newUser = (email: string, more: object = {}) =>
  inTenant((tx) =>
    createUser(tx, t.tenantId, {
      email,
      displayName: email.split("@")[0] ?? email,
      source: "local",
      ...more,
    }),
  );
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof IdentityError ? e.code : `not an IdentityError: ${String(e)}`;
  }
  return "no error";
};

describe("users", () => {
  it("creates members by default and finds them by id, email and external id", async () => {
    const u = await newUser("  Bo@Example.com ", { source: "scim", externalId: "entra-1" });
    expect(u).toMatchObject({
      email: "Bo@Example.com",
      kind: "member",
      active: true,
      source: "scim",
      externalId: "entra-1",
      lock: null,
      providerDisabled: null,
      retired: null,
    });
    expect(u.id).toMatch(/^usr_/);
    expect(await inTenant((tx) => getUser(tx, t.tenantId, u.id))).toEqual(u);
    expect(await inTenant((tx) => findUserByEmail(tx, t.tenantId, "BO@example.COM"))).toEqual(u);
    expect(await inTenant((tx) => findUserByExternalId(tx, t.tenantId, "entra-1"))).toEqual(u);
    expect(
      await inTenant((tx) => findUserByEmail(tx, t.tenantId, "nobody@example.com")),
    ).toBeNull();
    expect(await inTenant((tx) => findUserByExternalId(tx, t.tenantId, "entra-2"))).toBeNull();
  });

  it("refuses a second user with the same email or external id, and the transaction goes on", async () => {
    await newUser("bo@example.com", { source: "scim", externalId: "x-1" });
    const ok = await inTenant(async (tx) => {
      const make = (email: string, externalId?: string) =>
        createUser(tx, t.tenantId, {
          email,
          displayName: "Bo",
          source: "scim",
          ...(externalId ? { externalId } : {}),
        });
      expect(await code(make("BO@EXAMPLE.COM"))).toBe("conflict");
      expect(await code(make("other@example.com", "x-1"))).toBe("conflict");
      return make("third@example.com");
    });
    expect(ok.email).toBe("third@example.com");
  });

  it("keeps emails per tenant", async () => {
    const other = await seedTenant(db, 2);
    await newUser("bo@example.com");
    const there = await db.withTenant(other.tenantId, (tx) =>
      createUser(tx, other.tenantId, {
        email: "bo@example.com",
        displayName: "Bo",
        source: "local",
      }),
    );
    expect(there.email).toBe("bo@example.com");
    expect(
      await db.withTenant(other.tenantId, (tx) => getUser(tx, other.tenantId, t.userId)),
    ).toBeNull();
  });

  it.each<[string, object]>([
    ["an email without @", { email: "bo" }],
    ["an email with spaces", { email: "b o@example.com" }],
    ["a blank name", { displayName: "  " }],
    ["a long name", { displayName: "x".repeat(257) }],
    ["an empty external id", { externalId: "", source: "scim" }],
    ["an external id for a local user", { externalId: "e-1" }],
    ["a zero-width space in an email", { email: "ana\u200b@example.com" }],
    ["a Kelvin sign that folds into k", { email: "\u212aen@example.com" }],
    ["fullwidth letters", { email: "\uff41na@example.com" }],
    ["a NUL", { email: "ana\u0000@example.com" }],
    ["a domain that isn't a host name", { email: "ana@exa mple" }],
    ["an email too long once folded", { email: `${"\u0130".repeat(170)}@x.io` }],
    ["a percent-escape in the domain", { email: "ana@ex%61mple.com" }],
    ["an ideographic full stop", { email: "ana@example\u3002com" }],
    ["a trailing dot", { email: "ana@example.com." }],
    ["an IP address", { email: "ana@127.0.0.1" }],
    ["a numeric host", { email: "ana@0x7f.1" }],
    ["a bare host", { email: "ana@localhost" }],
    ["an unknown source", { source: "ldap" }],
    ["an unknown kind", { kind: "admin" }],
  ])("refuses %s", async (_, change) => {
    expect(
      await code(
        inTenant((tx) =>
          createUser(tx, t.tenantId, {
            email: "bo@example.com",
            displayName: "Bo",
            source: "local",
            ...change,
          } as NewUser),
        ),
      ),
    ).toBe("invalid");
  });

  it("changes details only as the managing source", async () => {
    const u = await newUser("bo@example.com", { source: "scim" });
    expect(
      await code(inTenant((tx) => updateUser(tx, t.tenantId, u.id, { displayName: "X" }, "local"))),
    ).toBe("wrong-source");
    const changed = await inTenant((tx) =>
      updateUser(
        tx,
        t.tenantId,
        u.id,
        { email: "robert@example.com", displayName: " Robert ", kind: "guest", externalId: "e-9" },
        "scim",
      ),
    );
    expect(changed).toMatchObject({
      email: "robert@example.com",
      displayName: "Robert",
      kind: "guest",
      externalId: "e-9",
    });
    expect(await inTenant((tx) => findUserByEmail(tx, t.tenantId, "bo@example.com"))).toBeNull();
    expect(await inTenant((tx) => updateUser(tx, t.tenantId, u.id, {}, "scim"))).toEqual(changed);
  });

  it("refuses to move a user onto another's email or external id", async () => {
    const a = await newUser("a@example.com", { source: "scim", externalId: "e-a" });
    await newUser("b@example.com", { source: "scim", externalId: "e-b" });
    const change = (c: object) => inTenant((tx) => updateUser(tx, t.tenantId, a.id, c, "scim"));
    expect(await code(change({ email: "B@example.com" }))).toBe("conflict");
    expect(await code(change({ externalId: "e-b" }))).toBe("conflict");
    expect(await change({ email: "A@example.com", externalId: null })).toMatchObject({
      email: "A@example.com",
      externalId: null,
    });
    expect(await code(inTenant((tx) => updateUser(tx, t.tenantId, "usr_nope", {}, "local")))).toBe(
      "not-found",
    );
  });

  it("keeps an admin's lock and the provider's disable independent", async () => {
    const u = await newUser("bo@example.com", { source: "scim" });
    const lock = (by = "user:admin") => inTenant((tx) => lockUser(tx, t.tenantId, u.id, by));
    const unlock = (by = "user:admin") => inTenant((tx) => unlockUser(tx, t.tenantId, u.id, by));
    const provider = (active: boolean) =>
      inTenant((tx) => setProviderActive(tx, t.tenantId, u.id, active, "scim:entra"));
    const active = async () => (await inTenant((tx) => getUser(tx, t.tenantId, u.id)))?.active;
    // The provider deactivates; an admin also locks. Re-activation upstream leaves the lock.
    expect(await provider(false)).toBe(true);
    expect(await provider(false)).toBe(false);
    expect(await lock()).toBe(true);
    expect(await lock()).toBe(false);
    expect(await provider(true)).toBe(true);
    expect(await active()).toBe(false);
    // An admin lifting the lock doesn't lift a provider disable either.
    await provider(false);
    expect(await unlock("user:other-admin")).toBe(true);
    expect(await unlock()).toBe(false);
    expect(await active()).toBe(false);
    expect(await provider(true)).toBe(true);
    expect(await active()).toBe(true);
    expect(await inTenant((tx) => getUser(tx, t.tenantId, u.id))).toMatchObject({
      lock: null,
      providerDisabled: null,
    });
  });

  it("records who stopped a user, and refuses the wrong kind of caller", async () => {
    const scimUser = await newUser("bo@example.com", { source: "scim" });
    const local = await newUser("cy@example.com");
    await inTenant((tx) => lockUser(tx, t.tenantId, scimUser.id, "system:offboarding"));
    expect(await inTenant((tx) => getUser(tx, t.tenantId, scimUser.id))).toMatchObject({
      active: false,
      lock: { by: "system:offboarding", at: expect.any(Date) },
    });
    expect(await code(inTenant((tx) => lockUser(tx, t.tenantId, local.id, "scim:entra")))).toBe(
      "invalid",
    );
    expect(await code(inTenant((tx) => lockUser(tx, t.tenantId, local.id, "group:x")))).toBe(
      "invalid",
    );
    // SCIM doesn't know local users, so it can't deactivate them.
    expect(
      await code(inTenant((tx) => setProviderActive(tx, t.tenantId, local.id, false, "scim:e"))),
    ).toBe("wrong-source");
    expect(
      await code(inTenant((tx) => setProviderActive(tx, t.tenantId, scimUser.id, false, "user:a"))),
    ).toBe("invalid");
    expect(await code(inTenant((tx) => lockUser(tx, t.tenantId, "usr_nope", "user:a")))).toBe(
      "not-found",
    );
  });

  it("retires for good: groups and grants go, the email is free, the row stays", async () => {
    const retire = (userId: string, by = "user:admin") =>
      inTenant((tx) => retireUser(tx, t.tenantId, userId, by));
    expect(await retire(t.userId)).toBe(true);
    expect(await retire(t.userId)).toBe(false);
    expect(await inTenant((tx) => getUser(tx, t.tenantId, t.userId))).toMatchObject({
      active: false,
      retired: { by: "user:admin" },
    });
    expect(await inTenant((tx) => groupsOf(tx, t.tenantId, t.userId))).toEqual([]);
    expect(await inTenant((tx) => findUserByEmail(tx, t.tenantId, "ana-1@example.com"))).toBeNull();
    // Someone new with the address is a new user with a new id: nothing carries over.
    const next = await newUser("ana-1@example.com");
    expect(next.id).not.toBe(t.userId);
    expect(await inTenant((tx) => resolvePrincipal(tx, t.tenantId, next.id))).toMatchObject({
      groupIds: [],
      tagGrants: [],
    });
    // Retired users can't be changed, locked or added to groups.
    expect(await code(inTenant((tx) => lockUser(tx, t.tenantId, t.userId, "user:a")))).toBe(
      "retired",
    );
    expect(
      await code(
        inTenant((tx) => updateUser(tx, t.tenantId, t.userId, { displayName: "X" }, "local")),
      ),
    ).toBe("retired");
    expect(
      await code(inTenant((tx) => addMember(tx, t.tenantId, t.groupId, t.userId, "local"))),
    ).toBe("retired");
    const rows = await inTenant((tx) => tx.select().from(users).where(eq(users.id, t.userId)));
    expect(rows).toHaveLength(1);
    // Each source retires its own: SCIM would re-create a SCIM user an admin retired.
    const local = await newUser("cy@example.com");
    expect(await code(retire(local.id, "scim:entra"))).toBe("wrong-source");
    const scimUser = await newUser("dee@example.com", { source: "scim", externalId: "e-dee" });
    expect(await code(retire(scimUser.id, "user:admin"))).toBe("wrong-source");
    expect(await retire(scimUser.id, "scim:entra")).toBe(true);
    expect(await inTenant((tx) => findUserByExternalId(tx, t.tenantId, "e-dee"))).toBeNull();
    expect(await code(retire("usr_nope"))).toBe("not-found");
  });

  it("revokes a retired user's direct grants", async () => {
    await inTenant((tx) =>
      addGrant(tx, t.tenantId, {
        principal: userPrincipal(t.userId),
        role: "read",
        target: { objectId: t.objectId },
        grantedBy: "user:admin",
      }),
    );
    await inTenant((tx) => retireUser(tx, t.tenantId, t.userId, "system:offboarding"));
    const [g] = await inTenant((tx) =>
      tx
        .select()
        .from(grants)
        .where(eq(grants.principal, userPrincipal(t.userId))),
    );
    expect(g).toMatchObject({ revokedBy: "system:offboarding" });
  });

  it("normalizes emails for matching", () => {
    expect(emailKey("  Ana@Example.COM ")).toBe("ana@example.com");
    expect(emailKey("jose\u0301@example.com")).toBe(emailKey("jos\u00e9@example.com"));
    expect(emailKey("ana@B\u00fccher.de")).toBe("ana@xn--bcher-kva.de");
    expect(emailKey("ana@xn--bcher-kva.de")).toBe("ana@xn--bcher-kva.de");
    expect(emailKey("no-at-sign")).toBe("");
    expect(emailKey("@example.com")).toBe("");
    expect(emailKey("ana@")).toBe("");
  });

  it("matches one mailbox however its domain is written", async () => {
    await newUser("ana@b\u00fccher.de");
    expect(await code(newUser("Ana@XN--BCHER-KVA.de"))).toBe("conflict");
    expect(
      await inTenant((tx) => findUserByEmail(tx, t.tenantId, "ana@xn--bcher-kva.de")),
    ).toMatchObject({
      email: "ana@b\u00fccher.de",
    });
    expect(await inTenant((tx) => findUserByEmail(tx, t.tenantId, "not an email"))).toBeNull();
  });

  it("keeps external ids to SCIM users, in the directory and the database", async () => {
    const local = await newUser("lo@example.com");
    expect(
      await code(
        inTenant((tx) => updateUser(tx, t.tenantId, local.id, { externalId: "e-1" }, "local")),
      ),
    ).toBe("invalid");
    // Clearing one is fine, and there is none to clear.
    expect(
      await inTenant((tx) => updateUser(tx, t.tenantId, local.id, { externalId: null }, "local")),
    ).toMatchObject({ externalId: null });
    const direct = inTenant((tx) =>
      tx.update(users).set({ externalId: "e-1" }).where(eq(users.id, local.id)),
    );
    expect(await direct.then(() => "no error", sqlState)).toBe("23514");
  });

  it("keeps a SCIM userName as sent, unique among current users regardless of case (T-103)", async () => {
    // "Émile", with the accent as a combining mark: NFC makes it one character.
    const emile = `E${String.fromCodePoint(0x301)}mile`;
    const u = await newUser("ana@example.com", {
      source: "scim",
      externalId: "oid-1",
      userName: "Ana.Lopez@Contoso.onmicrosoft.com",
      givenName: "Ana",
      familyName: "Lopez",
    });
    expect(u).toMatchObject({
      userName: "Ana.Lopez@Contoso.onmicrosoft.com",
      givenName: "Ana",
      familyName: "Lopez",
    });
    const find = (name: string) => inTenant((tx) => findUserByUserName(tx, t.tenantId, name));
    expect((await find("ana.lopez@contoso.ONMICROSOFT.com"))?.id).toBe(u.id);
    expect(await find("ana.lopez@contoso")).toBeNull();
    expect(userNameKey("ÉLAN")).toBe("élan");
    // Another user can't take it in another case, by creating or renaming.
    expect(
      await code(
        newUser("bo@example.com", {
          source: "scim",
          userName: "ANA.LOPEZ@contoso.onmicrosoft.com",
        }),
      ),
    ).toBe("conflict");
    const bo = await newUser("bo@example.com", { source: "scim", userName: "bo" });
    expect(
      await code(
        inTenant((tx) =>
          updateUser(
            tx,
            t.tenantId,
            bo.id,
            { userName: "ana.lopez@contoso.onmicrosoft.com" },
            "scim",
          ),
        ),
      ),
    ).toBe("conflict");
    // Only SCIM users have one, and it must be visible text.
    expect(await code(newUser("cy@example.com", { userName: "cy" }))).toBe("invalid");
    for (const userName of ["", "  ", `a${String.fromCodePoint(0x200b)}b`, "x".repeat(513), 5]) {
      expect(await code(newUser("dee@example.com", { source: "scim", userName }))).toBe("invalid");
    }
    expect(await code(newUser("dee@example.com", { source: "scim", givenName: " " }))).toBe(
      "invalid",
    );
    expect(await code(newUser("dee@example.com", { source: "scim", familyName: 3 }))).toBe(
      "invalid",
    );
    // Changing and clearing, and the database's own checks.
    const changed = await inTenant((tx) =>
      updateUser(
        tx,
        t.tenantId,
        u.id,
        { userName: emile, givenName: null, familyName: "López" },
        "scim",
      ),
    );
    expect(changed).toMatchObject({ userName: emile, givenName: null, familyName: "López" });
    expect((await find("émile"))?.id).toBe(u.id);
    const raw = (values: Partial<typeof users.$inferInsert>) =>
      inTenant((tx) => tx.update(users).set(values).where(eq(users.id, t.userId)));
    await expect(raw({ userName: "local", userNameKey: "local" })).rejects.toThrow();
    await expect(
      inTenant((tx) => tx.update(users).set({ userNameKey: null }).where(eq(users.id, u.id))),
    ).rejects.toThrow();
    // Retiring frees the userName for someone new.
    await inTenant((tx) => retireUser(tx, t.tenantId, u.id, "scim:sct_x"));
    expect(await find(emile)).toBeNull();
    const again = await newUser("ana@example.com", { source: "scim", userName: emile });
    expect(again.id).not.toBe(u.id);
  });

  it("finds only SCIM users by external id", async () => {
    const local = await newUser("lo@example.com");
    // A row from before the database checked it (the check dropped for this test's database).
    await inTenant(async (tx) => {
      await tx.execute(sql`alter table users drop constraint users_external_id_scim`);
      await tx.update(users).set({ externalId: "e-1" }).where(eq(users.id, local.id));
    });
    expect(await inTenant((tx) => findUserByExternalId(tx, t.tenantId, "e-1"))).toBeNull();
  });

  it("maps a concurrent email clash to a conflict and keeps the transaction usable", async () => {
    const a = await newUser("a@example.com");
    const result = await inTenant(async (tx) => {
      // Another user takes the address first (in the same transaction here; the savepoint is
      // what matters).
      await tx.insert(users).values({
        tenantId: t.tenantId,
        id: "usr_01bbbbbbbbbbbbbbbbbbbbbbbb",
        email: "b@example.com",
        emailKey: "b@example.com",
        displayName: "B",
        source: "local",
      });
      expect(
        await code(updateUser(tx, t.tenantId, a.id, { email: "B@example.com" }, "local")),
      ).toBe("conflict");
      return getUser(tx, t.tenantId, a.id);
    });
    expect(result?.email).toBe("a@example.com");
  });
});

describe("sign-in identities", () => {
  const ms = { issuer: "https://login.microsoftonline.com/t/v2.0", subject: "oid-1" };
  const link = (userId: string, identity = ms) =>
    inTenant((tx) => linkIdentity(tx, t.tenantId, userId, identity));
  const find = (identity = ms) => inTenant((tx) => findUserByIdentity(tx, t.tenantId, identity));

  it("links an (issuer, subject) to one user, idempotently", async () => {
    expect(await link(t.userId)).toBe(true);
    expect(await link(t.userId)).toBe(false);
    expect((await find())?.id).toBe(t.userId);
    const bo = await newUser("bo@example.com");
    expect(await code(link(bo.id))).toBe("conflict");
    expect(await link(bo.id, { ...ms, subject: "oid-2" })).toBe(true);
    expect(await find({ ...ms, subject: "oid-3" })).toBeNull();
    // The seeded identity, on another issuer.
    expect((await find({ issuer: "https://login.example.com", subject: "ana-1" }))?.id).toBe(
      t.userId,
    );
  });

  it("unlinks, and retiring a user frees their identities for someone new", async () => {
    await link(t.userId);
    const unlink = () =>
      inTenant((tx) => unlinkIdentity(tx, t.tenantId, t.userId, ms, "user:admin"));
    expect(await unlink()).toBe(true);
    expect(await unlink()).toBe(false);
    await link(t.userId);
    await inTenant((tx) => retireUser(tx, t.tenantId, t.userId, "user:admin"));
    expect(await find()).toBeNull();
    expect(await code(link(t.userId))).toBe("retired");
    const next = await newUser("next@example.com");
    expect(await link(next.id)).toBe(true);
  });

  it("never signs in a retired user, even with an identity still linked", async () => {
    await link(t.userId);
    // Retiring unlinks identities; a row retired some other way keeps its link.
    await inTenant((tx) =>
      tx
        .update(users)
        .set({ retiredAt: new Date(), retiredBy: "user:admin" })
        .where(eq(users.id, t.userId)),
    );
    const [linked] = await inTenant((tx) =>
      tx.select().from(userIdentities).where(eq(userIdentities.subject, ms.subject)),
    );
    expect(linked?.userId).toBe(t.userId);
    expect(await find()).toBeNull();
  });

  it("refuses empty or oversized issuers and subjects, and unknown users", async () => {
    expect(await code(link(t.userId, { issuer: "", subject: "x" }))).toBe("invalid");
    expect(await code(link(t.userId, { issuer: "i", subject: "x".repeat(513) }))).toBe("invalid");
    expect(await code(link("usr_01aaaaaaaaaaaaaaaaaaaaaaaa"))).toBe("not-found");
  });
});

describe("groups", () => {
  it("creates, finds, renames and lists members, as the managing source", async () => {
    const g = await inTenant((tx) =>
      createGroup(tx, t.tenantId, { name: " Sales ", source: "scim", externalId: "g-1" }),
    );
    expect(g).toMatchObject({ name: "Sales", source: "scim", externalId: "g-1" });
    expect(await inTenant((tx) => findGroupByExternalId(tx, t.tenantId, "g-1"))).toEqual(g);
    expect(await inTenant((tx) => findGroupByExternalId(tx, t.tenantId, "g-2"))).toBeNull();
    expect(await code(inTenant((tx) => renameGroup(tx, t.tenantId, g.id, "X", "local")))).toBe(
      "wrong-source",
    );
    expect(
      await inTenant((tx) => renameGroup(tx, t.tenantId, g.id, "Sales EU", "scim")),
    ).toMatchObject({ name: "Sales EU" });
    expect(
      await code(
        inTenant((tx) =>
          createGroup(tx, t.tenantId, { name: "Dup", source: "scim", externalId: "g-1" }),
        ),
      ),
    ).toBe("conflict");
  });

  it("changes a group's external id, keeping it unique, as the managing source", async () => {
    const make = (name: string, externalId: string) =>
      inTenant((tx) => createGroup(tx, t.tenantId, { name, source: "scim", externalId }));
    const a = await make("A", "g-a");
    await make("B", "g-b");
    const update = (changes: { name?: string; externalId?: string | null }, as: "scim" | "local") =>
      inTenant((tx) => updateGroup(tx, t.tenantId, a.id, changes, as));
    expect(await update({ externalId: "g-a2", name: "A2" }, "scim")).toMatchObject({
      name: "A2",
      externalId: "g-a2",
    });
    expect(await update({}, "scim")).toMatchObject({ name: "A2" });
    expect(await update({ externalId: null }, "scim")).toMatchObject({ externalId: null });
    expect(await code(update({ externalId: "g-b" }, "scim"))).toBe("conflict");
    expect(await code(update({ name: "" }, "scim"))).toBe("invalid");
    expect(await code(update({ name: "x" }, "local"))).toBe("wrong-source");
    expect(
      await code(
        inTenant((tx) => updateGroup(tx, t.tenantId, t.groupId, { externalId: "x" }, "local")),
      ),
    ).toBe("invalid");
  });

  it("lists users and groups by what SCIM filters on, a page at a time", async () => {
    const make = (i: number, more: object = {}) =>
      newUser(`p${i}@example.com`, {
        source: "scim",
        userName: `P${i}@Contoso.example`,
        externalId: `oid-${i}`,
        displayName: `Person ${i}`,
        ...more,
      });
    const people = [await make(1), await make(2), await make(3)];
    await inTenant((tx) => setProviderActive(tx, t.tenantId, people[1]?.id ?? "", false, "scim:x"));
    await inTenant((tx) => retireUser(tx, t.tenantId, people[2]?.id ?? "", "scim:x"));
    const list = (q: UserQuery, page = {}) => inTenant((tx) => listUsers(tx, t.tenantId, q, page));
    expect((await list({})).total).toBe(3); // the seeded local user and two current SCIM users
    expect((await list({ source: "scim" })).users.map((u) => u.id)).toEqual(
      people.slice(0, 2).map((u) => u.id),
    );
    const one = async (q: UserQuery) =>
      (await list({ source: "scim", ...q })).users.map((u) => u.id);
    expect(await one({ userName: "p1@contoso.EXAMPLE" })).toEqual([people[0]?.id]);
    expect(await one({ externalId: "oid-2" })).toEqual([people[1]?.id]);
    expect(await one({ externalId: "OID-2" })).toEqual([]);
    expect(await one({ email: "P1@example.com" })).toEqual([people[0]?.id]);
    expect(await one({ email: "not an address" })).toEqual([]);
    expect(await one({ id: people[0]?.id ?? "" })).toEqual([people[0]?.id]);
    expect(await one({ displayName: "Person 2" })).toEqual([people[1]?.id]);
    expect(await one({ providerActive: false })).toEqual([people[1]?.id]);
    expect(await one({ providerActive: true })).toEqual([people[0]?.id]);
    expect(await one({ externalId: "oid-3" })).toEqual([]); // retired
    const page = await list({}, { offset: 1, limit: 1 });
    expect(page.total).toBe(3);
    expect(page.users).toHaveLength(1);
    expect((await list({}, { limit: 0 })).users).toEqual([]);
    for (const bad of [{ offset: -1 }, { limit: 1001 }, { limit: 1.5 }]) {
      expect(await code(list({}, bad))).toBe("invalid");
    }

    const g = await inTenant((tx) =>
      createGroup(tx, t.tenantId, { name: "Sales", source: "scim", externalId: "g-s" }),
    );
    const groupsBy = async (q: GroupQuery, page = {}) =>
      (await inTenant((tx) => listGroups(tx, t.tenantId, q, page))).groups.map((x) => x.id);
    expect(await groupsBy({ source: "scim" })).toEqual([g.id]);
    expect(await groupsBy({ name: "Sales" })).toEqual([g.id]);
    expect(await groupsBy({ name: "sales" })).toEqual([]);
    expect(await groupsBy({ externalId: "g-s", id: g.id })).toEqual([g.id]);
    expect(await groupsBy({}, { limit: 0 })).toEqual([]);
    await inTenant((tx) => addMember(tx, t.tenantId, g.id, people[0]?.id ?? "", "scim"));
    expect(await groupsBy({ memberId: people[0]?.id ?? "" })).toEqual([g.id]);
    expect(await groupsBy({ memberId: t.userId })).toEqual([t.groupId]);
    expect(await groupsBy({ memberId: t.userId, source: "scim" })).toEqual([]);
    expect((await inTenant((tx) => listGroups(tx, t.tenantId, {}))).total).toBe(2);
  });

  it("keeps external ids to SCIM groups, and finds only those by it", async () => {
    expect(
      await code(
        inTenant((tx) =>
          createGroup(tx, t.tenantId, { name: "Local", source: "local", externalId: "g-9" }),
        ),
      ),
    ).toBe("invalid");
    const direct = inTenant((tx) =>
      tx.update(groups).set({ externalId: "g-9" }).where(eq(groups.id, t.groupId)),
    );
    expect(await direct.then(() => "no error", sqlState)).toBe("23514");
    await inTenant(async (tx) => {
      await tx.execute(sql`alter table groups drop constraint groups_external_id_scim`);
      await tx.update(groups).set({ externalId: "g-9" }).where(eq(groups.id, t.groupId));
    });
    expect(await inTenant((tx) => findGroupByExternalId(tx, t.tenantId, "g-9"))).toBeNull();
  });

  it("changes membership only as the group's source", async () => {
    const bo = await newUser("bo@example.com");
    const scimGroup = await inTenant((tx) =>
      createGroup(tx, t.tenantId, { name: "Sales", source: "scim" }),
    );
    const add = (groupId: string, userId: string, as: "scim" | "local") =>
      inTenant((tx) => addMember(tx, t.tenantId, groupId, userId, as));
    expect(await code(add(scimGroup.id, bo.id, "local"))).toBe("wrong-source");
    expect(await add(scimGroup.id, bo.id, "scim")).toBe(true);
    expect(await add(scimGroup.id, bo.id, "scim")).toBe(false);
    expect(await code(add(t.groupId, "usr_01aaaaaaaaaaaaaaaaaaaaaaaa", "local"))).toBe("not-found");
    expect(await code(add("grp_01aaaaaaaaaaaaaaaaaaaaaaaa", bo.id, "local"))).toBe("not-found");
    expect(await add(t.groupId, bo.id, "local")).toBe(true);
    expect((await inTenant((tx) => groupsOf(tx, t.tenantId, bo.id))).map((g) => g.name)).toEqual([
      "Readers 1",
      "Sales",
    ]);
    expect(
      (await inTenant((tx) => membersOf(tx, t.tenantId, t.groupId))).map((u) => u.email),
    ).toEqual(["ana-1@example.com", "bo@example.com"]);
    const remove = (as: "scim" | "local") =>
      inTenant((tx) => removeMember(tx, t.tenantId, scimGroup.id, bo.id, as));
    expect(await code(remove("local"))).toBe("wrong-source");
    expect(await remove("scim")).toBe(true);
    expect(await remove("scim")).toBe(false);
    expect(await inTenant((tx) => membersOf(tx, t.tenantId, scimGroup.id))).toEqual([]);
  });

  it("pages through members", async () => {
    const more = [];
    for (const n of [1, 2, 3]) {
      const u = await newUser(`m${n}@example.com`);
      await inTenant((tx) => addMember(tx, t.tenantId, t.groupId, u.id, "local"));
      more.push(u.id);
    }
    const page = (after?: string) =>
      inTenant((tx) =>
        membersOf(tx, t.tenantId, t.groupId, { limit: 2, ...(after ? { after } : {}) }),
      );
    const first = await page();
    const second = await page(first.at(-1)?.id);
    expect([...first, ...second].map((u) => u.id)).toEqual([t.userId, ...more]);
    expect(await page(second.at(-1)?.id)).toEqual([]);
    expect(await code(inTenant((tx) => membersOf(tx, t.tenantId, t.groupId, { limit: 0 })))).toBe(
      "invalid",
    );
  });

  it("revokes a deleted group's grants, so no later group inherits them", async () => {
    await inTenant((tx) => deleteGroup(tx, t.tenantId, t.groupId, "local", "user:admin"));
    expect(await inTenant((tx) => getGroup(tx, t.tenantId, t.groupId))).toBeNull();
    const [g] = await inTenant((tx) =>
      tx
        .select()
        .from(grants)
        .where(eq(grants.principal, groupPrincipal(t.groupId))),
    );
    expect(g).toMatchObject({ revokedBy: "user:admin", revokedAt: expect.any(Date) });
    expect(await inTenant((tx) => groupsOf(tx, t.tenantId, t.userId))).toEqual([]);
    expect(
      await code(inTenant((tx) => deleteGroup(tx, t.tenantId, t.groupId, "local", "user:a"))),
    ).toBe("not-found");
  });
});

describe("resolvePrincipal", () => {
  const authz = new Authorizer(createCedarEngine());
  const canRead = async (userId: string) => {
    const principal = await inTenant((tx) => resolvePrincipal(tx, t.tenantId, userId));
    if (!principal) return "no principal";
    return authz.authorize({
      principal,
      action: "read",
      resource: {
        id: t.objectId,
        ownerId: "user:owner-1",
        tags: [t.tag],
        allTags: [],
        zone: "indexed",
      },
      client: { id: "openhoard-web", trust: "first-party" },
    }).allow;
  };

  it("gathers groups and grants held directly and through groups", async () => {
    const bo = await newUser("bo@example.com");
    await inTenant((tx) =>
      addGrant(tx, t.tenantId, {
        principal: userPrincipal(bo.id),
        role: "write",
        target: { objectId: t.objectId },
        grantedBy: "user:admin",
      }),
    );
    expect(await inTenant((tx) => resolvePrincipal(tx, t.tenantId, t.userId))).toEqual({
      userId: t.userId,
      groupIds: [t.groupId],
      tagGrants: [t.tag],
      tagWriteGrants: [],
      objectGrants: [],
      objectWriteGrants: [],
      guest: false,
      active: true,
    });
    expect(await inTenant((tx) => resolvePrincipal(tx, t.tenantId, bo.id))).toMatchObject({
      groupIds: [],
      tagGrants: [],
      objectWriteGrants: [t.objectId],
    });
    expect(await inTenant((tx) => resolvePrincipal(tx, t.tenantId, "usr_nope"))).toBeNull();
  });

  it("drives authorize(): a group member reads, and loses it on leaving or being disabled", async () => {
    expect(await canRead(t.userId)).toBe(true);
    await inTenant((tx) => removeMember(tx, t.tenantId, t.groupId, t.userId, "local"));
    expect(await canRead(t.userId)).toBe(false);
    await inTenant((tx) => addMember(tx, t.tenantId, t.groupId, t.userId, "local"));
    expect(await canRead(t.userId)).toBe(true);
    await inTenant((tx) => lockUser(tx, t.tenantId, t.userId, "user:admin"));
    expect(await inTenant((tx) => resolvePrincipal(tx, t.tenantId, t.userId))).toMatchObject({
      active: false,
    });
    expect(await canRead(t.userId)).toBe(false);
  });

  it("lists group ids in id order", async () => {
    const more = [];
    for (const name of ["Zeta", "Alpha"]) {
      const g = await inTenant((tx) => createGroup(tx, t.tenantId, { name, source: "local" }));
      await inTenant((tx) => addMember(tx, t.tenantId, g.id, t.userId, "local"));
      more.push(g.id);
    }
    const principal = await inTenant((tx) => resolvePrincipal(tx, t.tenantId, t.userId));
    expect(principal?.groupIds).toEqual([t.groupId, ...more].sort());
  });

  it("applies `at` to grants only: memberships and stops are the current ones", async () => {
    const at = new Date(Date.now() + 60 * 60 * 1000);
    await inTenant((tx) => removeMember(tx, t.tenantId, t.groupId, t.userId, "local"));
    await inTenant((tx) => lockUser(tx, t.tenantId, t.userId, "user:admin"));
    // The group's grant is live at `at`, but the user is no longer in the group, and is locked.
    expect(await inTenant((tx) => resolvePrincipal(tx, t.tenantId, t.userId, at))).toMatchObject({
      groupIds: [],
      tagGrants: [],
      active: false,
    });
  });

  it("marks guests, and answers for a given moment", async () => {
    const guest = await newUser("vendor@partner.example", { kind: "guest" });
    const at = new Date(Date.now() - 24 * 60 * 60 * 1000);
    expect(await inTenant((tx) => resolvePrincipal(tx, t.tenantId, guest.id, at))).toMatchObject({
      guest: true,
      tagGrants: [],
    });
    // The seeded grant was created just now, so a day ago the member held nothing.
    expect(
      (await inTenant((tx) => resolvePrincipal(tx, t.tenantId, t.userId, at)))?.tagGrants,
    ).toEqual([]);
  });
});
