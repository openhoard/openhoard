import { appendAudit, verifyAudit } from "@openhoard/core-audit";
import {
  addGrant,
  apiKeys,
  KEY_ACTIONS,
  newId,
  userIdentities,
  users,
  type Database,
  type Tx,
} from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { ACTIONS, Authorizer, createCedarEngine, type AuthzResource } from "@openhoard/core-policy";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  authenticateApiKey,
  checkApiKey,
  issueApiKey,
  keyUseRecord,
  listApiKeys,
  revokeApiKey,
  type ApiKeyInput,
} from "./api-keys.js";
import {
  addMember,
  createGroup,
  createServiceAccount,
  createUser,
  IdentityError,
  linkIdentity,
  lockUser,
  retireUser,
  updateUser,
  userPrincipal,
  type User,
} from "./directory.js";
import { PrincipalCache } from "./principal-cache.js";

/* T-111: service accounts and scoped API keys, for machines, never for people. */

let authz: Authorizer;
beforeAll(() => {
  authz = new Authorizer(createCedarEngine());
});

let db: Database;
let t: SeededTenant;
let bot: User;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  bot = await write((tx) =>
    createServiceAccount(tx, t.tenantId, { displayName: "Nightly export", by: "user:admin" }),
  );
});
afterEach(() => db?.close());

const write = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work);
const inAYear = () => new Date(Date.now() + 364 * 24 * 3600 * 1000);
const issue = (more: Partial<ApiKeyInput> = {}) =>
  write((tx) =>
    issueApiKey(tx, t.tenantId, {
      userId: bot.id,
      name: "export",
      actions: ["search", "read"],
      zones: ["indexed"],
      expiresAt: inAYear(),
      by: "user:admin",
      ...more,
    }),
  );
const authenticate = (token: string, cache?: PrincipalCache) =>
  write((tx) => authenticateApiKey(tx, t.tenantId, token, cache ? { cache } : {}));
const identityCode = async (p: Promise<unknown>) =>
  p.then(
    () => "no error",
    (e: unknown) => (e instanceof IdentityError ? e.code : String(e)),
  );

describe("service accounts", () => {
  it("are machines: no email, never signing in, never becoming people", async () => {
    expect(bot).toMatchObject({ kind: "service", email: null, source: "local", active: true });
    expect(
      await identityCode(
        write((tx) => linkIdentity(tx, t.tenantId, bot.id, { issuer: "https://x", subject: "y" })),
      ),
    ).toBe("invalid");
    expect(
      await identityCode(
        write((tx) => updateUser(tx, t.tenantId, bot.id, { kind: "member" }, "local")),
      ),
    ).toBe("invalid");
    expect(
      await identityCode(
        write((tx) =>
          createUser(tx, t.tenantId, {
            email: "robot@example.com",
            displayName: "Robot",
            source: "local",
            kind: "service" as never,
          }),
        ),
      ),
    ).toBe("invalid");
    // The database holds it too: a person needs an email, a service account has none.
    const raw = (kind: "member" | "service", email: string | null) =>
      write((tx) =>
        tx.insert(users).values({
          tenantId: t.tenantId,
          id: newId("user"),
          email,
          emailKey: email,
          displayName: "X",
          kind,
          source: "local",
        }),
      );
    await expect(raw("member", null)).rejects.toThrow();
    await expect(raw("service", "x@example.com")).rejects.toThrow();
  });
});

describe("API keys", () => {
  it("are shown once: only a hash of the secret is kept", async () => {
    const key = await issue();
    expect(key.token).toMatch(/^ohk\.key_[0-9a-hjkmnp-tv-z]{26}\.[A-Za-z0-9_-]{43}$/);
    const secret = key.token.split(".")[2] ?? "";
    const [row] = await write((tx) => tx.select().from(apiKeys).where(eq(apiKeys.id, key.id)));
    expect(row?.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(secret);
    const [listed] = await write((tx) => listApiKeys(tx, t.tenantId, bot.id));
    expect(listed).not.toHaveProperty("token");
    expect(listed).toMatchObject({
      id: key.id,
      scope: { actions: ["read", "search"], zones: ["indexed"] },
    });
  });

  it("are for service accounts only, scoped, named and expiring within a year", async () => {
    const cases: [Partial<ApiKeyInput>, string][] = [
      [{ userId: t.userId }, "invalid"],
      [{ userId: "usr_00000000000000000000000000" }, "not-found"],
      [{ actions: [] }, "invalid"],
      [{ actions: ["delete" as never] }, "invalid"],
      [{ zones: [] }, "invalid"],
      [{ zones: ["legal"] }, "invalid"],
      [{ name: "" }, "invalid"],
      [{ name: "x".repeat(201) }, "invalid"],
      [{ expiresAt: new Date(Date.now() - 1000) }, "invalid"],
      [{ expiresAt: new Date(Date.now() + 400 * 24 * 3600 * 1000) }, "invalid"],
      [{ by: "scim:entra" }, "invalid"],
    ];
    for (const [more, code] of cases) {
      expect(await identityCode(issue(more)), JSON.stringify(more)).toBe(code);
    }
  });

  it("authenticate as the service account, limited to the key's scope", async () => {
    const key = await issue();
    const use = await authenticate(key.token);
    expect(use).toMatchObject({
      keyId: key.id,
      userId: bot.id,
      principal: { userId: bot.id, service: true, active: true, scope: key.scope },
    });
    expect(Object.isFrozen(use?.principal)).toBe(true);
    // Through the cache, the same.
    expect((await authenticate(key.token, new PrincipalCache()))?.principal).toEqual(
      use?.principal,
    );
  });

  it("answer null alike for anything but a valid key", async () => {
    const key = await issue();
    const [, id, secret] = key.token.split(".");
    const other = `ohk.key_00000000000000000000000000.${secret}`;
    const wrong = `ohk.${id}.${"A".repeat(43)}`;
    for (const token of [
      other,
      wrong,
      "",
      "ohk",
      `${key.token}x`,
      key.token.replace("ohk", "OHK"),
      42,
    ]) {
      expect(await authenticate(token as string)).toBeNull();
    }
    // Another tenant's key is unknown here.
    const t2 = await seedTenant(db, 2);
    expect(
      await db.withTenant(t2.tenantId, (tx) => authenticateApiKey(tx, t2.tenantId, key.token)),
    ).toBeNull();
  });

  it("stop at once when revoked, and on expiry", async () => {
    const key = await issue();
    expect(await authenticate(key.token)).not.toBeNull();
    expect(await write((tx) => revokeApiKey(tx, t.tenantId, key.id, "user:admin"))).toBe(true);
    expect(await authenticate(key.token)).toBeNull();
    expect(await write((tx) => revokeApiKey(tx, t.tenantId, key.id, "user:admin"))).toBe(false);
    const soon = await issue({ expiresAt: new Date(Date.now() + 1200) });
    expect(await authenticate(soon.token)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 1400));
    expect(await authenticate(soon.token)).toBeNull();
  });

  it("stop when the service account is locked or retired; retiring revokes them", async () => {
    const key = await issue();
    await write((tx) => lockUser(tx, t.tenantId, bot.id, "user:admin"));
    expect(await authenticate(key.token)).toBeNull();
    await write((tx) => retireUser(tx, t.tenantId, bot.id, "user:admin"));
    const [row] = await write((tx) => listApiKeys(tx, t.tenantId, bot.id));
    expect(row).toMatchObject({ revokedBy: "user:admin", revokedAt: expect.any(Date) });
    expect(await identityCode(issue())).toBe("retired");
  });

  it("are scoped through authorize(): within scope a grant still decides, outside it nothing does", async () => {
    const key = await issue({ actions: ["read"], zones: ["indexed"] });
    await write((tx) =>
      addGrant(tx, t.tenantId, {
        principal: userPrincipal(bot.id),
        role: "write",
        target: { tag: t.tag },
        grantedBy: "user:admin",
      }),
    );
    const use = await authenticate(key.token);
    if (!use) throw new Error("expected a key use");
    const resource = (zone: string): AuthzResource => ({
      id: t.objectId,
      ownerId: "user:someone",
      tags: [t.tag],
      allTags: [t.tag],
      zone,
    });
    const decide = (action: "read" | "tag", zone = "indexed") =>
      authz.authorize({
        principal: use.principal,
        action,
        resource: resource(zone),
        client: { id: "ci", trust: "first-party" },
      });
    expect(decide("read")).toMatchObject({ allow: true });
    expect(decide("tag")).toMatchObject({ allow: false, policies: ["core/scope"] });
    expect(decide("read", "managed")).toMatchObject({ allow: false, policies: ["core/scope"] });
  });

  it("are audited on every use: the record names the service account and the key", async () => {
    const key = await issue();
    const use = await authenticate(key.token);
    if (!use) throw new Error("expected a key use");
    const record = keyUseRecord(use, { action: "read", decision: "allow", object: t.objectId });
    expect(record).toEqual({
      actor: `user:${bot.id}`,
      action: "read",
      decision: "allow",
      object: t.objectId,
      detail: { apiKey: key.id },
    });
    const event = await write((tx) => appendAudit(tx, t.tenantId, record));
    expect(event).toMatchObject({ actor: `user:${bot.id}`, detail: { apiKey: key.id } });
    expect(await verifyAudit(db, t.tenantId)).toMatchObject({ ok: true });
  });

  it("need read to search, and can be kept to some zones", async () => {
    expect(await identityCode(issue({ actions: ["search"] }))).toBe("invalid");
    expect(await identityCode(issue({ zoneIds: ["legal"] }))).toBe("invalid");
    expect(await identityCode(issue({ zoneIds: [] }))).toBe("invalid");
    expect(await identityCode(issue({ name: "ci\u202egnp" }))).toBe("invalid");
    const key = await issue({ zoneIds: [t.zoneId] });
    const use = await authenticate(key.token);
    expect(use?.principal.scope).toEqual({
      actions: ["read", "search"],
      zones: ["indexed"],
      zoneIds: [t.zoneId],
    });
    // Frozen all the way down.
    expect(Object.isFrozen(use?.principal.scope?.actions)).toBe(true);
    expect(Object.isFrozen(use?.principal.tagGrants)).toBe(true);
  });

  it("say why a real key was refused, for the audit, and nothing for unknown ones", async () => {
    const key = await issue();
    const [, id] = key.token.split(".");
    const check = async (token: string) => {
      const c = await write((tx) => checkApiKey(tx, t.tenantId, token));
      return c.ok ? "ok" : (c.refused?.reason ?? "unknown");
    };
    expect(await check(key.token)).toBe("ok");
    expect(await check(`ohk.${id}.${"A".repeat(43)}`)).toBe("wrong-secret");
    expect(await check(`ohk.key_00000000000000000000000000.${"A".repeat(43)}`)).toBe("unknown");
    expect(await check("nonsense")).toBe("unknown");
    await write((tx) => lockUser(tx, t.tenantId, bot.id, "user:admin"));
    expect(await check(key.token)).toBe("account-inactive");
    await write((tx) => revokeApiKey(tx, t.tenantId, key.id, "user:admin"));
    expect(await check(key.token)).toBe("revoked-or-expired");
  });

  it("check zone ids against the tenant's zones and the key's kinds", async () => {
    expect(await identityCode(issue({ zoneIds: ["zon_00000000000000000000000000"] }))).toBe(
      "invalid",
    );
    expect(await identityCode(issue({ zones: ["managed"], zoneIds: [t.zoneId] }))).toBe("invalid");
  });

  it("use the principal cache in read-only snapshots", async () => {
    const key = await issue();
    const cache = new PrincipalCache();
    const inSnapshot = () =>
      db.withTenant(t.tenantId, (tx) => authenticateApiKey(tx, t.tenantId, key.token, { cache }), {
        isolationLevel: "repeatable read",
        accessMode: "read only",
      });
    expect(await inSnapshot()).not.toBeNull();
    expect(await inSnapshot()).not.toBeNull();
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
    await write((tx) => lockUser(tx, t.tenantId, bot.id, "user:admin"));
    expect(await inSnapshot()).toBeNull();
  });

  it("scope with exactly the actions authorize() knows", () => {
    expect([...KEY_ACTIONS]).toEqual([...ACTIONS]);
  });
});

describe("the database", () => {
  it("never lets a person become a service account, or the other way round", async () => {
    const person = await write((tx) =>
      createUser(tx, t.tenantId, { email: "p@example.com", displayName: "P", source: "local" }),
    );
    await expect(
      write((tx) =>
        tx
          .update(users)
          .set({ kind: "service", email: null, emailKey: null })
          .where(eq(users.id, person.id)),
      ),
    ).rejects.toThrow();
    await expect(
      write((tx) =>
        tx
          .update(users)
          .set({ kind: "member", email: "b@example.com", emailKey: "b@example.com" })
          .where(eq(users.id, bot.id)),
      ),
    ).rejects.toThrow();
  });

  it("never keeps a key for a person, or a sign-in identity for a service account", async () => {
    await expect(
      write((tx) =>
        tx.insert(apiKeys).values({
          tenantId: t.tenantId,
          id: newId("apiKey"),
          userId: t.userId,
          name: "sneaky",
          secretHash: "0".repeat(64),
          actions: ["read"],
          zones: ["indexed"],
          createdBy: "user:admin",
          expiresAt: inAYear(),
        }),
      ),
    ).rejects.toThrow();
    await expect(
      write((tx) =>
        tx.insert(userIdentities).values({
          tenantId: t.tenantId,
          issuer: "https://login.example.com",
          subject: "bot",
          userId: bot.id,
        }),
      ),
    ).rejects.toThrow();
  });

  it("keeps only well-formed zone ids on a key", async () => {
    const raw = (zoneIds: string[]) =>
      write((tx) =>
        tx.insert(apiKeys).values({
          tenantId: t.tenantId,
          id: newId("apiKey"),
          userId: bot.id,
          name: "raw",
          secretHash: "0".repeat(64),
          actions: ["read"],
          zones: ["indexed"],
          zoneIds,
          createdBy: "user:admin",
          expiresAt: inAYear(),
        }),
      );
    await expect(raw(["junk"])).rejects.toThrow();
    await expect(raw([t.zoneId, "zon_x"])).rejects.toThrow();
    await expect(raw([t.zoneId])).resolves.toBeDefined();
  });

  it("keeps service accounts out of groups the identity provider manages", async () => {
    const scimGroup = await write((tx) =>
      createGroup(tx, t.tenantId, { name: "Everyone", source: "scim", externalId: "all" }),
    );
    expect(
      await identityCode(write((tx) => addMember(tx, t.tenantId, scimGroup.id, bot.id, "scim"))),
    ).toBe("invalid");
  });
});
