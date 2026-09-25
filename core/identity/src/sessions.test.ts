import { sessions, type Database, type Tx } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createServiceAccount,
  createUser,
  findUserByIdentity,
  IdentityError,
  linkIdentity,
  lockUser,
  retireUser,
  setProviderActive,
  unlinkIdentity,
  unlockUser,
  updateUser,
  type User,
} from "./directory.js";
import { PrincipalCache } from "./principal-cache.js";
import {
  beginLogin,
  checkSession,
  isLocalPath,
  localPath,
  LOGIN_MAX_PENDING,
  parseSessionToken,
  pruneSessions,
  revokeSession,
  revokeUserSessions,
  signIn,
  startSession,
  takeLogin,
  touchSession,
} from "./sessions.js";

/* T-102: signing in through OpenID Connect, and sessions. */

let db: Database;
let t: SeededTenant;
let ana: User;
let bo: User;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  ana = await write((tx) =>
    createUser(tx, t.tenantId, {
      email: "ana@example.com",
      displayName: "Ana",
      source: "scim",
      externalId: "oid-ana",
    }),
  );
  bo = await write((tx) =>
    createUser(tx, t.tenantId, { email: "bo@example.com", displayName: "Bo", source: "local" }),
  );
});
afterEach(() => db?.close());

const write = <T>(work: (tx: Tx) => Promise<T>, tenantId = t.tenantId) =>
  db.withTenant(tenantId, work);
const ISSUER = "https://login.microsoftonline.com/tid-1/v2.0";
const start = (userId: string, more: { idleSeconds?: number; maxSeconds?: number } = {}) =>
  write((tx) =>
    startSession(tx, t.tenantId, {
      userId,
      provider: "acme-entra",
      issuer: ISSUER,
      subject: `sub-${userId}`,
      ...more,
    }),
  );
const check = (token: string, tenantId = t.tenantId) =>
  write((tx) => checkSession(tx, tenantId, token), tenantId);
const age = (sessionId: string, column: "last_seen_at" | "expires_at", by: string) =>
  write((tx) =>
    tx.execute(
      sql`update sessions set ${sql.raw(column)} = ${sql.raw(column)} - ${by}::interval,
            created_at = created_at - ${by}::interval where id = ${sessionId}`,
    ),
  );

describe("signIn", () => {
  it("finds a linked identity, never by email", async () => {
    await write((tx) => linkIdentity(tx, t.tenantId, bo.id, { issuer: ISSUER, subject: "s-bo" }));
    const r = await write((tx) => signIn(tx, t.tenantId, { issuer: ISSUER, subject: "s-bo" }));
    expect(r).toMatchObject({ ok: true, user: { id: bo.id }, linked: false });
    const other = await write((tx) =>
      signIn(tx, t.tenantId, { issuer: "https://other.example", subject: "s-bo" }),
    );
    expect(other).toEqual({ ok: false, refused: "unknown", userId: null });
  });

  it("matches a first sign-in once by external id, then by the linked identity", async () => {
    const first = await write((tx) =>
      signIn(tx, t.tenantId, { issuer: ISSUER, subject: "s-ana", externalId: "oid-ana" }),
    );
    expect(first).toMatchObject({ ok: true, user: { id: ana.id }, linked: true });
    const found = await write((tx) =>
      findUserByIdentity(tx, t.tenantId, { issuer: ISSUER, subject: "s-ana" }),
    );
    expect(found?.id).toBe(ana.id);
    // From now on, the pair decides, whatever the claim says.
    const again = await write((tx) =>
      signIn(tx, t.tenantId, { issuer: ISSUER, subject: "s-ana", externalId: "oid-other" }),
    );
    expect(again).toMatchObject({ ok: true, user: { id: ana.id }, linked: false });
  });

  it("matches external ids of SCIM users only, and creates nobody", async () => {
    // Bo is local: an external id can't reach him.
    const r = await write((tx) =>
      signIn(tx, t.tenantId, { issuer: ISSUER, subject: "s-x", externalId: "oid-bo" }),
    );
    expect(r).toEqual({ ok: false, refused: "unknown", userId: null });
    expect(
      await write((tx) => signIn(tx, t.tenantId, { issuer: ISSUER, subject: "s", externalId: "" })),
    ).toMatchObject({ ok: false, refused: "unknown" });
  });

  it("refuses locked, disabled and retired people, and service accounts", async () => {
    await write((tx) => lockUser(tx, t.tenantId, ana.id, "user:admin"));
    const locked = await write((tx) =>
      signIn(tx, t.tenantId, { issuer: ISSUER, subject: "s-ana", externalId: "oid-ana" }),
    );
    expect(locked).toEqual({ ok: false, refused: "inactive", userId: ana.id });
    // Nothing was linked for a refused sign-in.
    expect(
      await write((tx) => findUserByIdentity(tx, t.tenantId, { issuer: ISSUER, subject: "s-ana" })),
    ).toBeNull();
    await write((tx) => unlockUser(tx, t.tenantId, ana.id, "user:admin"));
    await write((tx) =>
      signIn(tx, t.tenantId, { issuer: ISSUER, subject: "s-ana", externalId: "oid-ana" }),
    );
    await write((tx) => setProviderActive(tx, t.tenantId, ana.id, false, "scim:entra"));
    expect(
      await write((tx) => signIn(tx, t.tenantId, { issuer: ISSUER, subject: "s-ana" })),
    ).toEqual({ ok: false, refused: "inactive", userId: ana.id });
    await write((tx) => retireUser(tx, t.tenantId, ana.id, "scim:entra"));
    expect(
      await write((tx) =>
        signIn(tx, t.tenantId, { issuer: ISSUER, subject: "s-ana", externalId: "oid-ana" }),
      ),
    ).toEqual({ ok: false, refused: "unknown", userId: null });
    await expect(
      write((tx) => signIn(tx, t.tenantId, { issuer: "", subject: "x" })),
    ).rejects.toThrow(IdentityError);
  });
});

describe("login requests", () => {
  const state = "s".repeat(43);
  const request = {
    provider: "acme-entra",
    codeVerifier: "v".repeat(43),
    nonce: "n".repeat(22),
    returnTo: "/files?x=1",
  };

  it("are taken once, for their provider only", async () => {
    await write((tx) => beginLogin(tx, t.tenantId, state, request));
    expect(await write((tx) => takeLogin(tx, t.tenantId, "other", state))).toBeNull();
    // A wrong provider used it up: it can't be retried.
    expect(await write((tx) => takeLogin(tx, t.tenantId, "acme-entra", state))).toBeNull();
    await write((tx) => beginLogin(tx, t.tenantId, state, request));
    expect(await write((tx) => takeLogin(tx, t.tenantId, "acme-entra", state))).toEqual(request);
    expect(await write((tx) => takeLogin(tx, t.tenantId, "acme-entra", state))).toBeNull();
  });

  it("expire, and another tenant can't see them", async () => {
    const other = await seedTenant(db, 2);
    await write((tx) => beginLogin(tx, t.tenantId, state, request));
    expect(
      await write((tx) => takeLogin(tx, other.tenantId, "acme-entra", state), other.tenantId),
    ).toBeNull();
    await write((tx) =>
      tx.execute(
        sql`update login_requests set created_at = created_at - interval '11 minutes',
              expires_at = expires_at - interval '11 minutes'`,
      ),
    );
    expect(await write((tx) => takeLogin(tx, t.tenantId, "acme-entra", state))).toBeNull();
  });

  it("refuse what they can't hold", async () => {
    for (const bad of [
      { ...request, returnTo: "//evil.example" },
      { ...request, returnTo: "/\\evil.example" },
      { ...request, returnTo: "https://evil.example" },
      { ...request, provider: "Acme" },
      { ...request, codeVerifier: "short" },
      { ...request, nonce: "short" },
    ]) {
      await expect(write((tx) => beginLogin(tx, t.tenantId, state, bad))).rejects.toThrow(
        IdentityError,
      );
    }
    await expect(write((tx) => beginLogin(tx, t.tenantId, "short", request))).rejects.toThrow(
      IdentityError,
    );
    expect(await write((tx) => takeLogin(tx, t.tenantId, "acme-entra", "short"))).toBeNull();
  });

  it("isLocalPath accepts only this server's paths", () => {
    for (const ok of ["/", "/files", "/a?b=//c", "/a#b"]) expect(isLocalPath(ok), ok).toBe(true);
    const bad = [
      "",
      "files",
      "//x",
      "/\\x",
      "http://x",
      "/a\nb",
      "/a\u0085b",
      "/.//evil.example",
      "/./a",
      3,
      "/".repeat(2049),
    ];
    for (const path of bad) expect(isLocalPath(path), String(path)).toBe(false);
    // localPath() normalizes as a browser would, and refuses what lands elsewhere.
    expect(localPath("/a/../b?x")).toBe("/b?x");
    expect(localPath("/.//evil.example")).toBeNull();
    expect(localPath("/%2F%2Fevil.example")).toBe("/%2F%2Fevil.example");
  });

  it("are bounded per tenant: anyone can start one", async () => {
    await write((tx) =>
      tx.execute(sql`insert into login_requests (tenant_id, state_hash, provider, code_verifier, nonce, return_to, expires_at)
        select ${t.tenantId}, lpad(to_hex(i), 64, '0'), 'p', repeat('v', 43), repeat('n', 16), '/', now() + interval '5 minutes'
          from generate_series(1, ${LOGIN_MAX_PENDING}) i`),
    );
    await expect(write((tx) => beginLogin(tx, t.tenantId, state, request))).rejects.toMatchObject({
      code: "busy",
    });
    // Expired ones don't count, and go.
    await write((tx) =>
      tx.execute(
        sql`update login_requests set created_at = created_at - interval '1 hour', expires_at = now() - interval '1 second'`,
      ),
    );
    await write((tx) => beginLogin(tx, t.tenantId, state, request));
  });
});

describe("sessions", () => {
  it("start with a token only their secret matches", async () => {
    const s = await start(ana.id);
    expect(s.token).toMatch(/^ohs\.ten_\w{26}\.ses_\w{26}\.[\w-]{43}$/);
    expect(parseSessionToken(s.token)).toEqual({ tenantId: t.tenantId, sessionId: s.id });
    const ok = await check(s.token);
    expect(ok).toMatchObject({ ok: true, session: { id: s.id, userId: ana.id } });
    expect(ok.ok && ok.principal.userId).toBe(ana.id);
    const wrong = s.token.slice(0, -1) + (s.token.endsWith("A") ? "B" : "A");
    expect(await check(wrong)).toEqual({ ok: false, refused: "wrong-secret", userId: ana.id });
    expect(await check("ohs.nope")).toEqual({ ok: false, refused: "unknown" });
    expect(parseSessionToken("nope")).toBeNull();
    // Only a hash is stored.
    const [row] = await write((tx) => tx.select().from(sessions).where(eq(sessions.id, s.id)));
    expect(s.token).not.toContain(row?.secretHash);
  });

  it("stay in their tenant", async () => {
    const other = await seedTenant(db, 2);
    const s = await start(ana.id);
    expect(await check(s.token, other.tenantId)).toEqual({ ok: false, refused: "unknown" });
  });

  it("end when revoked, expired or idle too long", async () => {
    const a = await start(ana.id);
    expect(await write((tx) => revokeSession(tx, t.tenantId, a.id, `user:${ana.id}`))).toBe(true);
    expect(await write((tx) => revokeSession(tx, t.tenantId, a.id, `user:${ana.id}`))).toBe(false);
    expect(await check(a.token)).toEqual({ ok: false, refused: "ended" });

    const b = await start(ana.id, { maxSeconds: 3600, idleSeconds: 600 });
    await age(b.id, "expires_at", "2 hours");
    expect(await check(b.token)).toEqual({ ok: false, refused: "ended" });

    const c = await start(ana.id, { maxSeconds: 3600, idleSeconds: 600 });
    await age(c.id, "last_seen_at", "11 minutes");
    expect(await check(c.token)).toEqual({ ok: false, refused: "ended" });
  });

  it("say when their use should be recorded, which keeps them alive", async () => {
    const s = await start(ana.id, { maxSeconds: 3600, idleSeconds: 600 });
    const seen = async () =>
      (await write((tx) => tx.select().from(sessions).where(eq(sessions.id, s.id))))[0]?.lastSeenAt;
    const fresh = await check(s.token);
    expect(fresh.ok && fresh.stale).toBe(false);
    // A quarter of the idle limit (here 150 s), at most a minute.
    await age(s.id, "last_seen_at", "2 minutes");
    const stale = await check(s.token);
    expect(stale.ok && stale.stale).toBe(true);
    const aged = await seen();
    expect(await write((tx) => touchSession(tx, t.tenantId, s.id))).toBe(true);
    expect((await seen())?.getTime()).toBeGreaterThan(aged?.getTime() ?? Infinity);
    // A short idle limit is touched often enough to stay usable.
    const short = await start(ana.id, { maxSeconds: 3600, idleSeconds: 60 });
    await age(short.id, "last_seen_at", "20 seconds");
    const r = await check(short.token);
    expect(r.ok && r.stale).toBe(true);
    // An ended session isn't brought back by a touch.
    await write((tx) => revokeSession(tx, t.tenantId, s.id, "user:admin"));
    expect(await write((tx) => touchSession(tx, t.tenantId, s.id))).toBe(false);
  });

  it("serve from the principal cache in a read-only snapshot", async () => {
    const s = await start(ana.id);
    const cache = new PrincipalCache();
    const snap = { isolationLevel: "repeatable read", accessMode: "read only" } as const;
    for (let i = 0; i < 3; i++) {
      const r = await db.withTenant(
        t.tenantId,
        (tx) => checkSession(tx, t.tenantId, s.token, { cache }),
        snap,
      );
      expect(r.ok).toBe(true);
    }
    expect(cache.stats().hits).toBe(2);
  });

  it("end for good when their person is locked, disabled or retired", async () => {
    const s = await start(ana.id);
    await write((tx) => lockUser(tx, t.tenantId, ana.id, "user:admin"));
    expect(await check(s.token)).toEqual({ ok: false, refused: "ended" });
    // Unlocking doesn't bring back a session (a stolen cookie) from before the lock.
    await write((tx) => unlockUser(tx, t.tenantId, ana.id, "user:admin"));
    expect(await check(s.token)).toEqual({ ok: false, refused: "ended" });

    const d = await start(ana.id);
    await write((tx) => setProviderActive(tx, t.tenantId, ana.id, false, "scim:entra"));
    await write((tx) => setProviderActive(tx, t.tenantId, ana.id, true, "scim:entra"));
    expect(await check(d.token)).toEqual({ ok: false, refused: "ended" });

    const r = await start(ana.id);
    await write((tx) => retireUser(tx, t.tenantId, ana.id, "scim:entra"));
    const [row] = await write((tx) => tx.select().from(sessions).where(eq(sessions.id, r.id)));
    expect(row?.revokedBy).toBe("scim:entra");
    expect(await check(r.token)).toEqual({ ok: false, refused: "ended" });
  });

  it("fail while their person is inactive, however that happened", async () => {
    const s = await start(ana.id);
    // A stop that bypassed lockUser() (e.g. SQL by an operator) still refuses at once.
    await write((tx) =>
      tx.execute(
        sql`update users set locked_at = now(), locked_by = 'system:x' where id = ${ana.id}`,
      ),
    );
    expect(await check(s.token)).toEqual({ ok: false, refused: "account-inactive" });
  });

  it("signed in with an identity end when it is unlinked", async () => {
    await write((tx) =>
      linkIdentity(tx, t.tenantId, bo.id, { issuer: ISSUER, subject: `sub-${bo.id}` }),
    );
    await write((tx) => linkIdentity(tx, t.tenantId, bo.id, { issuer: ISSUER, subject: "other" }));
    const s = await start(bo.id);
    const kept = await write((tx) =>
      startSession(tx, t.tenantId, {
        userId: bo.id,
        provider: "p",
        issuer: ISSUER,
        subject: "other",
      }),
    );
    await write((tx) =>
      unlinkIdentity(tx, t.tenantId, bo.id, { issuer: ISSUER, subject: `sub-${bo.id}` }),
    );
    expect(await check(s.token)).toEqual({ ok: false, refused: "ended" });
    expect((await check(kept.token)).ok).toBe(true);
  });

  it("follow a person who becomes a guest", async () => {
    const s = await start(bo.id);
    await write((tx) => updateUser(tx, t.tenantId, bo.id, { kind: "guest" }, "local"));
    const r = await check(s.token);
    expect(r.ok && r.principal.guest).toBe(true);
  });

  it("are for people: never a service account, a retired or unknown user", async () => {
    const bot = await write((tx) =>
      createServiceAccount(tx, t.tenantId, { displayName: "Bot", by: "user:admin" }),
    );
    await expect(start(bot.id)).rejects.toThrow(/service account/);
    await expect(start("usr_01k5xr3c8v0q6m2d4n7p9s1t3w")).rejects.toMatchObject({
      code: "not-found",
    });
    await write((tx) => retireUser(tx, t.tenantId, bo.id, "user:admin"));
    await expect(start(bo.id)).rejects.toMatchObject({ code: "retired" });
    for (const bad of [
      { idleSeconds: 30 },
      { maxSeconds: 31 * 24 * 3600 },
      { idleSeconds: 7200, maxSeconds: 3600 },
    ]) {
      await expect(start(ana.id, bad)).rejects.toMatchObject({ code: "invalid" });
    }
  });

  it("end together for a user, and ended ones can be pruned", async () => {
    const a = await start(ana.id);
    await start(ana.id);
    const b = await start(bo.id);
    expect(await write((tx) => revokeUserSessions(tx, t.tenantId, ana.id, "system:t-104"))).toBe(2);
    expect((await check(a.token)).ok).toBe(false);
    expect((await check(b.token)).ok).toBe(true);
    await expect(
      write((tx) => revokeUserSessions(tx, t.tenantId, ana.id, "nobody")),
    ).rejects.toThrow(IdentityError);
    const pruned = await write((tx) =>
      pruneSessions(tx, t.tenantId, new Date(Date.now() + 60_000)),
    );
    expect(pruned).toBe(2);
  });
});
