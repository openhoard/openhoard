import { createHash, randomBytes } from "node:crypto";
import { oauthCodes, oauthGrants, oauthTokens, type Database, type Tx } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createServiceAccount,
  createUser,
  IdentityError,
  linkIdentity,
  lockUser,
  retireUser,
  unlinkIdentity,
  unlockUser,
  type EndedAccess,
  type User,
} from "./directory.js";
import {
  checkAccessToken,
  clientKeyOf,
  decideClient,
  getClient,
  grantIsLive,
  issueCode,
  listClients,
  MAX_PENDING_CLIENTS,
  MAX_PENDING_PER_PERSON,
  noteClient,
  oauthTokenTenant,
  parseScopes,
  pruneOAuth,
  redeemCode,
  redirectIdentity,
  refreshGrant,
  revokeByToken,
  revokeGrant,
  revokeUserGrants,
  type OAuthClient,
  type OAuthScope,
} from "./oauth.js";
import { PrincipalCache } from "./principal-cache.js";

/* T-105: OpenHoard's OAuth 2.1 authorization server, core half. */

const RESOURCE = "https://hoard.example/mcp";
const CLAUDE = "https://claude.ai/oauth/mcp-client.json";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let db: Database;
let t: SeededTenant;
let ana: User;
let client: OAuthClient;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  ana = await write((tx) =>
    createUser(tx, t.tenantId, { email: "ana@example.com", displayName: "Ana", source: "local" }),
  );
  client = (await write((tx) =>
    noteClient(
      tx,
      t.tenantId,
      { kind: "cimd", clientRef: CLAUDE, name: "Claude", redirectUris: [REDIRECT] },
      `user:${ana.id}`,
    ),
  )) as OAuthClient;
});
afterEach(() => db?.close());

const write = <T>(work: (tx: Tx) => Promise<T>, tenantId = t.tenantId) =>
  db.withTenant(tenantId, work);
const approve = (trust: "local" | "commercial" | "consumer" = "commercial") =>
  write((tx) =>
    decideClient(tx, t.tenantId, client.clientKey, { approve: true, trust }, "user:admin"),
  );
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
const code = async (scopes: OAuthScope[] = ["files:read"], userId = ana.id) => {
  const p = pkce();
  const c = await write((tx) =>
    issueCode(tx, t.tenantId, {
      userId,
      clientKey: client.clientKey,
      redirectUri: REDIRECT,
      codeChallenge: p.challenge,
      scopes,
      resource: RESOURCE,
    }),
  );
  return { code: c, verifier: p.verifier };
};
const redeem = (c: { code: string; verifier: string }, more: Record<string, string> = {}) =>
  write((tx) =>
    redeemCode(tx, t.tenantId, c.code, {
      clientKey: client.clientKey,
      redirectUri: REDIRECT,
      codeVerifier: c.verifier,
      resource: RESOURCE,
      ...more,
    }),
  );
const snap = { isolationLevel: "repeatable read", accessMode: "read only" } as const;
const check = (token: string, resource = RESOURCE, cache?: PrincipalCache) =>
  db.withTenant(
    t.tenantId,
    (tx) => checkAccessToken(tx, t.tenantId, token, resource, cache ? { cache } : {}),
    snap,
  );
const tokens = async (scopes: OAuthScope[] = ["files:read"]) => {
  const r = await redeem(await code(scopes));
  if (!r.ok) throw new Error(r.reason);
  return r;
};

describe("clients", () => {
  it("are recorded pending, and only an admin's decision changes that", async () => {
    expect(client).toMatchObject({ status: "pending", trust: null, name: "Claude" });
    // Seen again: its self-description refreshes, the decision doesn't move.
    const again = await write((tx) =>
      noteClient(
        tx,
        t.tenantId,
        { kind: "cimd", clientRef: CLAUDE, name: "Claude (new)", redirectUris: [REDIRECT] },
        `user:${ana.id}`,
      ),
    );
    expect(again).toMatchObject({ status: "pending", name: "Claude (new)" });
    await approve("commercial");
    const approved = await write((tx) => getClient(tx, t.tenantId, client.clientKey));
    expect(approved).toMatchObject({
      status: "approved",
      trust: "commercial",
      decidedBy: "user:admin",
    });
    await write((tx) =>
      noteClient(
        tx,
        t.tenantId,
        { kind: "cimd", clientRef: CLAUDE, name: "Claude", redirectUris: [REDIRECT] },
        `user:${ana.id}`,
      ),
    );
    expect((await write((tx) => getClient(tx, t.tenantId, client.clientKey)))?.status).toBe(
      "approved",
    );
    expect(await write((tx) => listClients(tx, t.tenantId))).toHaveLength(1);
    await expect(
      write((tx) =>
        decideClient(
          tx,
          t.tenantId,
          client.clientKey,
          { approve: true, trust: "first-party" as never },
          "user:admin",
        ),
      ),
    ).rejects.toThrow(IdentityError);
    await expect(
      write((tx) => decideClient(tx, t.tenantId, client.clientKey, { approve: false }, "scim:x")),
    ).rejects.toThrow(IdentityError);
  });

  it("keep what the admin decided on, and stop recording past the pending cap", async () => {
    await approve();
    const again = await write((tx) =>
      noteClient(
        tx,
        t.tenantId,
        { kind: "cimd", clientRef: CLAUDE, name: "Claude?", redirectUris: [REDIRECT] },
        `user:${ana.id}`,
      ),
    );
    expect(again).toMatchObject({ status: "approved", name: "Claude" });
    const fill = (by: string, n: number) =>
      write((tx) =>
        tx.execute(sql`insert into oauth_clients (tenant_id, client_key, kind, client_ref, name, redirect_uris, requested_by)
          select ${t.tenantId}, md5(${by} || i::text) || md5(i::text), 'dcr', 'dcr:x', 'n', array['https://x.example/cb'], ${by}
            from generate_series(1, ${n}) i`),
      );
    const tryNew = (by: string, ref: string, approved = false) =>
      write((tx) =>
        noteClient(
          tx,
          t.tenantId,
          { kind: "cimd", clientRef: ref, name: "New", redirectUris: [REDIRECT] },
          by,
          { approved },
        ),
      );
    await fill(`user:${ana.id}`, MAX_PENDING_PER_PERSON);
    // Ana's room is full; someone else's isn't; an approved client doesn't count.
    expect(await tryNew(`user:${ana.id}`, "https://new.example/a.json")).toBeNull();
    expect(await tryNew("user:bo", "https://new.example/b.json")).toMatchObject({
      status: "pending",
    });
    expect(await tryNew(`user:${ana.id}`, "https://new.example/c.json", true)).toMatchObject({
      status: "pending",
    });
    // Old requests lapse.
    await write((tx) =>
      tx.execute(
        sql`update oauth_clients set requested_at = now() - interval '31 days' where requested_by = ${`user:${ana.id}`} and client_ref = 'dcr:x'`,
      ),
    );
    expect(await tryNew(`user:${ana.id}`, "https://new.example/d.json")).toMatchObject({
      status: "pending",
    });
    expect(MAX_PENDING_CLIENTS).toBeGreaterThan(MAX_PENDING_PER_PERSON);
  });

  it("are identified by metadata URL, or by redirect URIs with loopback ports ignored", () => {
    expect(clientKeyOf("cimd", CLAUDE)).not.toBe(clientKeyOf("cimd", CLAUDE + "x"));
    expect(clientKeyOf("dcr", ["http://127.0.0.1:5173/cb", "https://a.example/cb"])).toBe(
      clientKeyOf("dcr", ["https://a.example/cb", "http://127.0.0.1:61000/cb"]),
    );
    expect(clientKeyOf("dcr", ["https://a.example/cb"])).not.toBe(
      clientKeyOf("dcr", ["https://b.example/cb"]),
    );
    expect(redirectIdentity("https://a.example:8443/cb")).toBe("https://a.example:8443/cb");
  });

  it("parse scopes strictly", () => {
    expect(parseScopes("files:tag files:read files:read")).toEqual(["files:read", "files:tag"]);
    expect(parseScopes("")).toBeNull();
    expect(parseScopes("files:read admin")).toBeNull();
  });
});

describe("authorization codes", () => {
  it("need an approved client and an active person", async () => {
    await expect(code()).rejects.toThrow(/not approved/);
    await approve();
    await write((tx) => lockUser(tx, t.tenantId, ana.id, "user:admin"));
    await expect(code()).rejects.toMatchObject({ code: "inactive" });
    await write((tx) => unlockUser(tx, t.tenantId, ana.id, "user:admin"));
    const bot = await write((tx) =>
      createServiceAccount(tx, t.tenantId, { displayName: "Bot", by: "user:admin" }),
    );
    await expect(code(["files:read"], bot.id)).rejects.toThrow(/service account/);
    const p = pkce();
    await expect(
      write((tx) =>
        issueCode(tx, t.tenantId, {
          userId: ana.id,
          clientKey: client.clientKey,
          redirectUri: REDIRECT,
          codeChallenge: "plain-verifier",
          scopes: ["files:read"],
          resource: RESOURCE,
        }),
      ),
    ).rejects.toThrow(/S256/);
    expect(p.challenge).toHaveLength(43);
  });

  it("redeem once, with the verifier, for tokens", async () => {
    await approve();
    const c = await code(["files:read", "files:tag"]);
    expect(oauthTokenTenant(c.code)).toBe(t.tenantId);
    const r = await redeem(c);
    expect(r).toMatchObject({ ok: true, scopes: ["files:read", "files:tag"], expiresIn: 3600 });
    if (!r.ok) return;
    expect(r.accessToken).toMatch(/^ohat\.ten_\w{26}\.oat_\w{26}\.[\w-]{43}$/);
    expect(r.refreshToken).toMatch(/^ohrt\.ten_\w{26}\.ogr_\w{26}\.[\w-]{43}$/);
    // Used twice: refused, and the grant it made is revoked with its tokens.
    const again = await redeem(c);
    expect(again).toMatchObject({ ok: false, error: "invalid_grant", grantId: r.grantId });
    expect(await check(r.accessToken)).toEqual({
      ok: false,
      refused: "revoked",
      grantId: r.grantId,
    });
  });

  it("refuse a wrong verifier, client, redirect, resource, or an expired code, and are then used up", async () => {
    await approve();
    const other = (await write((tx) =>
      noteClient(
        tx,
        t.tenantId,
        { kind: "dcr", clientRef: "dcr:x", name: "Other", redirectUris: ["https://o.example/cb"] },
        `user:${ana.id}`,
      ),
    )) as OAuthClient;
    const cases: [string, Record<string, string>, string][] = [
      ["verifier", { codeVerifier: pkce().verifier }, "invalid_grant"],
      ["client", { clientKey: other.clientKey }, "invalid_grant"],
      ["redirect", { redirectUri: "https://claude.ai/other" }, "invalid_grant"],
      ["resource", { resource: "https://evil.example/mcp" }, "invalid_target"],
      ["short verifier", { codeVerifier: "abc" }, "invalid_grant"],
    ];
    for (const [why, more, error] of cases) {
      const c = await code();
      expect(await redeem(c, more), why).toMatchObject({ ok: false, error });
      // A failed redemption uses the code up: the right values don't help afterwards.
      expect((await redeem(c)).ok, `${why} then right`).toBe(false);
    }
    const late = await code();
    await write((tx) =>
      tx.execute(sql`update oauth_codes set created_at = created_at - interval '2 minutes',
                       expires_at = expires_at - interval '2 minutes'`),
    );
    expect(await redeem(late)).toMatchObject({ ok: false, reason: "code expired" });
    expect(
      await write((tx) =>
        redeemCode(tx, t.tenantId, "ohac.nope", {
          clientKey: client.clientKey,
          redirectUri: REDIRECT,
          codeVerifier: "x",
          resource: RESOURCE,
        }),
      ),
    ).toMatchObject({ ok: false, reason: "unknown code" });
  });

  it("aren't redeemed once the client is refused or the person locked", async () => {
    await approve();
    const a = await code();
    await write((tx) => lockUser(tx, t.tenantId, ana.id, "user:admin"));
    // Locking used the code up: it can't be redeemed, now or after unlocking.
    expect(await redeem(a)).toMatchObject({ ok: false, error: "invalid_grant" });
    await write((tx) => unlockUser(tx, t.tenantId, ana.id, "user:admin"));
    const b = await code();
    await write((tx) =>
      decideClient(tx, t.tenantId, client.clientKey, { approve: false }, "user:admin"),
    );
    // The refusal used the code up (T-106), as the lock did.
    expect(await redeem(b)).toMatchObject({ ok: false, error: "invalid_grant" });
  });

  // T-106: an admin's approval, refusal, revocation and relabelling, as the admin API makes them.
  it("decide only from the status the admin saw, and a refusal uses up waiting codes", async () => {
    const approved = await write((tx) =>
      decideClient(
        tx,
        t.tenantId,
        client.clientKey,
        { approve: true, trust: "consumer" },
        "user:admin",
        { expect: ["pending"] },
      ),
    );
    expect(approved).toMatchObject({ status: "approved", trust: "consumer", was: "pending" });
    // Another admin acting on the pending client they saw: it moved on.
    const late = write((tx) =>
      decideClient(tx, t.tenantId, client.clientKey, { approve: false }, "user:other", {
        expect: ["pending"],
      }),
    );
    await expect(late).rejects.toMatchObject({ code: "conflict" });
    expect(await write((tx) => getClient(tx, t.tenantId, client.clientKey))).toMatchObject({
      status: "approved",
      decidedBy: "user:admin",
    });
    // A new label reaches the next check of a token issued under the old one.
    const r = await tokens();
    expect(await check(r.accessToken)).toMatchObject({ ok: true, client: { trust: "consumer" } });
    await approve("commercial");
    expect(await check(r.accessToken)).toMatchObject({
      ok: true,
      client: { trust: "commercial" },
    });
    // Revoked: its grants end, and a code waiting to be redeemed is used up, so approving the
    // client again within the code's minute doesn't turn consent from before into a grant.
    const waiting = await code();
    const revoked = await write((tx) =>
      decideClient(tx, t.tenantId, client.clientKey, { approve: false }, "user:admin", {
        expect: ["approved"],
      }),
    );
    expect(revoked).toMatchObject({ status: "refused", trust: null, was: "approved" });
    expect(await check(r.accessToken)).toMatchObject({ ok: false, refused: "revoked" });
    await approve();
    expect(await redeem(waiting)).toMatchObject({ ok: false, error: "invalid_grant" });
    await expect(
      write((tx) => decideClient(tx, t.tenantId, "0".repeat(64), { approve: false }, "user:admin")),
    ).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("access tokens", () => {
  it("carry the person, the grant's scopes as a credential scope, and the client's trust", async () => {
    await approve("local");
    const r = await tokens(["files:read"]);
    const cache = new PrincipalCache();
    const ok = await check(r.accessToken, RESOURCE, cache);
    expect(ok).toMatchObject({
      ok: true,
      client: { id: CLAUDE, trust: "local" },
      scopes: ["files:read"],
    });
    if (!ok.ok) return;
    expect(ok.principal.userId).toBe(ana.id);
    expect(ok.principal.scope?.actions).toEqual(["open", "read", "search"]);
    expect(ok.principal.scope?.zones).toEqual(["managed", "indexed", "local-only", "code"]);
  });

  it("are for their resource only, and stay in their tenant", async () => {
    await approve();
    const r = await tokens();
    expect(await check(r.accessToken, "https://hoard.example/other")).toMatchObject({
      ok: false,
      refused: "wrong-audience",
    });
    const other = await seedTenant(db, 2);
    const there = await db.withTenant(
      other.tenantId,
      (tx) => checkAccessToken(tx, other.tenantId, r.accessToken, RESOURCE),
      snap,
    );
    expect(there).toEqual({ ok: false, refused: "unknown" });
    const tampered = r.accessToken.slice(0, -1) + (r.accessToken.endsWith("A") ? "B" : "A");
    expect(await check(tampered)).toEqual({ ok: false, refused: "unknown" });
  });

  it("expire, and end with their grant, their client or their person", async () => {
    await approve();
    const r = await tokens();
    await write((tx) =>
      tx.execute(sql`update oauth_tokens set created_at = created_at - interval '2 hours',
                       expires_at = expires_at - interval '2 hours'`),
    );
    expect(await check(r.accessToken)).toMatchObject({ ok: false, refused: "expired" });

    const a = await tokens();
    await write((tx) => lockUser(tx, t.tenantId, ana.id, "user:admin"));
    expect(await check(a.accessToken)).toMatchObject({ ok: false, refused: "revoked" });
    await write((tx) => unlockUser(tx, t.tenantId, ana.id, "user:admin"));
    // Unlocking doesn't revive what the lock ended.
    expect(await check(a.accessToken)).toMatchObject({ ok: false, refused: "revoked" });

    const b = await tokens();
    await write((tx) =>
      decideClient(tx, t.tenantId, client.clientKey, { approve: false }, "user:admin"),
    );
    expect(await check(b.accessToken)).toMatchObject({ ok: false, refused: "revoked" });
    await approve();

    const c = await tokens();
    await write((tx) => revokeUserGrants(tx, t.tenantId, ana.id, "system:t-104"));
    expect(await check(c.accessToken)).toMatchObject({ ok: false, refused: "revoked" });

    // A code not yet redeemed when the identity goes can't be redeemed after.
    const pendingCode = await code();
    const u = await tokens();
    await write((tx) =>
      linkIdentity(tx, t.tenantId, ana.id, { issuer: "https://i.example", subject: "s" }),
    );
    await write((tx) =>
      unlinkIdentity(
        tx,
        t.tenantId,
        ana.id,
        { issuer: "https://i.example", subject: "s" },
        "user:admin",
      ),
    );
    expect(await check(u.accessToken)).toMatchObject({ ok: false, refused: "revoked" });
    expect((await redeem(pendingCode)).ok).toBe(false);

    const d = await tokens();
    await write((tx) => retireUser(tx, t.tenantId, ana.id, "user:admin"));
    expect(await check(d.accessToken)).toMatchObject({ ok: false, refused: "revoked" });
  });

  it("say whether their grant still holds, and a stop says what it ended (T-104)", async () => {
    await approve();
    const live = (grantId: string) =>
      db.withTenant(t.tenantId, (tx) => grantIsLive(tx, t.tenantId, grantId), snap);
    const a = await tokens();
    const pending = await code();
    expect(await live(a.grantId)).toBe(true);
    expect(await live("ogr_not-an-id")).toBe(false);
    expect(await live(a.grantId.slice(0, -1) + (a.grantId.endsWith("0") ? "1" : "0"))).toBe(false);
    const ended: EndedAccess[] = [];
    await write((tx) =>
      lockUser(tx, t.tenantId, ana.id, "user:admin", { onEnded: (e) => ended.push(e) }),
    );
    expect(ended).toEqual([{ sessions: 0, oauthCodes: 1, oauthGrants: 1, apiKeys: 0 }]);
    expect(await live(a.grantId)).toBe(false);
    expect((await redeem(pending)).ok).toBe(false);
    // Locked already: nothing ends, and nothing is reported.
    await write((tx) =>
      lockUser(tx, t.tenantId, ana.id, "user:admin", { onEnded: (e) => ended.push(e) }),
    );
    expect(ended).toHaveLength(1);
    await write((tx) => unlockUser(tx, t.tenantId, ana.id, "user:admin"));

    // Even a grant nobody revoked fails for a person who can't sign in, or a refused client.
    const b = await tokens();
    await write((tx) =>
      tx.execute(sql`update users set locked_at = now(), locked_by = 'user:admin'
                       where id = ${ana.id}`),
    );
    expect(await live(b.grantId)).toBe(false);
    await write((tx) =>
      tx.execute(sql`update users set locked_at = null, locked_by = null where id = ${ana.id}`),
    );
    expect(await live(b.grantId)).toBe(true);
    await write((tx) => tx.execute(sql`update oauth_clients set status = 'refused', trust = null`));
    expect(await live(b.grantId)).toBe(false);
    await approve();

    // Retirement reports it too.
    await tokens();
    const retired: EndedAccess[] = [];
    await write((tx) =>
      retireUser(tx, t.tenantId, ana.id, "user:admin", { onEnded: (e) => retired.push(e) }),
    );
    expect(retired).toEqual([{ sessions: 0, oauthCodes: 0, oauthGrants: 2, apiKeys: 0 }]);
  });

  it("take a configured trust over a pending client, never over a refused one", async () => {
    await approve();
    const r = await tokens();
    // Back to pending, as if the admin's approval lived in config only.
    await write((tx) =>
      tx.execute(
        sql`update oauth_clients set status = 'pending', trust = null, decided_at = null, decided_by = null`,
      ),
    );
    expect(await check(r.accessToken)).toMatchObject({ ok: false, refused: "client-not-approved" });
    const configured = await db.withTenant(
      t.tenantId,
      (tx) =>
        checkAccessToken(tx, t.tenantId, r.accessToken, RESOURCE, {
          clientTrust: () => "consumer",
        }),
      snap,
    );
    expect(configured).toMatchObject({ ok: true, client: { trust: "consumer" } });
  });
});

describe("refresh", () => {
  it("rotates the refresh token, and a replayed one revokes the grant", async () => {
    await approve();
    const first = await tokens();
    const refresh = (
      token: string,
      more: Partial<{ resource: string; scopes: OAuthScope[] }> = {},
    ) =>
      write((tx) => refreshGrant(tx, t.tenantId, token, { clientKey: client.clientKey, ...more }));
    const second = await refresh(first.refreshToken);
    expect(second).toMatchObject({ ok: true, grantId: first.grantId });
    if (!second.ok) return;
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect((await check(second.accessToken)).ok).toBe(true);
    // The old refresh token again: a replay. The grant and all its tokens end.
    expect(await refresh(first.refreshToken)).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(await check(second.accessToken)).toMatchObject({ ok: false, refused: "revoked" });
    expect((await refresh(second.refreshToken)).ok).toBe(false);
  });

  it("may narrow scopes for the new token, never widen them, and checks resource and client", async () => {
    await approve();
    const r = await tokens(["files:read", "files:tag"]);
    const narrowed = await write((tx) =>
      refreshGrant(tx, t.tenantId, r.refreshToken, {
        clientKey: client.clientKey,
        scopes: ["files:read"],
      }),
    );
    expect(narrowed).toMatchObject({ ok: true, scopes: ["files:read"] });
    if (!narrowed.ok) return;
    const got = await check(narrowed.accessToken);
    expect(got.ok && got.principal.scope?.actions).toEqual(["open", "read", "search"]);

    const narrow = await tokens(["files:read"]);
    const widen = await write((tx) =>
      refreshGrant(tx, t.tenantId, narrow.refreshToken, {
        clientKey: client.clientKey,
        scopes: ["files:read", "files:tag"],
      }),
    );
    expect(widen).toMatchObject({ ok: false, error: "invalid_scope" });
    const target = await write((tx) =>
      refreshGrant(tx, t.tenantId, narrow.refreshToken, {
        clientKey: client.clientKey,
        resource: "https://evil.example/mcp",
      }),
    );
    expect(target).toMatchObject({ ok: false, error: "invalid_target" });
    const wrongClient = await write((tx) =>
      refreshGrant(tx, t.tenantId, narrow.refreshToken, { clientKey: "0".repeat(64) }),
    );
    expect(wrongClient).toMatchObject({ ok: false, error: "invalid_grant" });
  });
});

describe("revocation and pruning", () => {
  it("lets a client revoke what it holds, and ignores what isn't a token", async () => {
    await approve();
    const r = await tokens();
    expect(await write((tx) => revokeByToken(tx, t.tenantId, r.accessToken))).toBe(true);
    expect(await check(r.accessToken)).toMatchObject({ ok: false, refused: "unknown" });
    expect(await write((tx) => revokeByToken(tx, t.tenantId, r.refreshToken))).toBe(true);
    expect(await write((tx) => revokeByToken(tx, t.tenantId, "nope"))).toBe(false);
    expect(
      await write((tx) => revokeByToken(tx, t.tenantId, r.refreshToken.slice(0, -1) + "Z")),
    ).toBe(false);
    const s = await tokens();
    expect(await write((tx) => revokeGrant(tx, t.tenantId, s.grantId, "user:admin"))).toBe(true);
    expect(await write((tx) => revokeGrant(tx, t.tenantId, s.grantId, "user:admin"))).toBe(false);
  });

  it("prunes what ended", async () => {
    await approve();
    await tokens();
    const live = await tokens();
    await write((tx) => revokeGrant(tx, t.tenantId, live.grantId, "user:admin"));
    const later = new Date(Date.now() + 2 * 3600 * 1000);
    const pruned = await write((tx) => pruneOAuth(tx, t.tenantId, later));
    expect(pruned.codes).toBe(2);
    expect(pruned.tokens).toBe(2);
    // Both grants' codes went first; the revoked grant goes, the live one stays.
    expect(pruned.grants).toBe(1);
    const counts = await write(async (tx) => ({
      codes: (await tx.select().from(oauthCodes)).length,
      grants: (await tx.select().from(oauthGrants)).length,
      tokens: (await tx.select().from(oauthTokens)).length,
    }));
    expect(counts).toEqual({ codes: 0, grants: 1, tokens: 0 });
  });
});
