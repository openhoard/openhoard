import { createHash, randomBytes } from "node:crypto";
import { exportAudit } from "@openhoard/core-audit";
import type { Database } from "@openhoard/core-db";
import { openSharedTestDatabases, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import {
  authenticateApiKey,
  createGroup,
  createServiceAccount,
  createUser,
  decideClient,
  grantAdmin,
  issueApiKey,
  issueCode,
  issueScimToken,
  noteClient,
  PrincipalCache,
  retireUser,
  revokeApiKey,
  startSession,
} from "@openhoard/core-identity";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAdmin } from "./admin.js";
import { createApp } from "./app.js";
import type { AuthEnv } from "./auth.js";
import { ConfigSchema } from "./config.js";
import { whoami, type McpTool } from "./mcp.js";

/*
 * T-104: "Deprovisioning: disabling a user revokes sessions and tokens. Done when: revocation
 * < 60 s (integration test)."
 *
 * End to end, for every credential a person or a service account holds, through the real
 * deprovisioning paths: the identity provider's SCIM PATCH `active: false` and DELETE, the
 * operator's `openhoard admin user lock` and `scim-token revoke`, and an admin revoking an AI
 * client in the admin API. The very next request must be refused.
 *
 * Two app instances share the database, as two server processes would (two connection pools on
 * PostgreSQL; PGlite belongs to one process, so there they share it), each with its own
 * principal cache, SCIM limiter and client caches. Both are used before the change (warming
 * their caches) and refused after it, on the next request, well inside the cache's 60 s TTL:
 * what is revoked is read from the database on every request, and what is cached is invalidated
 * by the database's principal epoch, not by time.
 */

const PUBLIC = "https://hoard.example";
const RESOURCE = `${PUBLIC}/mcp`;
const CLIENT_ID = "https://client.example/oauth/mcp.json";
const REDIRECT = "https://client.example/cb";
const SESSION_COOKIE = "__Host-oh_session";
const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
/**
 * The bound this test holds every revocation to: well under T-104's 60 s (the principal cache's
 * TTL), and generous for slow CI runners. Locally each one takes milliseconds.
 */
const BOUND_MS = 10_000;

let shared: Awaited<ReturnType<typeof openSharedTestDatabases>>;
let t: SeededTenant;
let scimToken: string;
let scimTokenId: string;
let adminGroupId: string;
let clientKey: string;
/** Two server processes on one database. */
let a: Hono<AuthEnv>;
let b: Hono<AuthEnv>;

/** A tool that waits until the test lets it answer: a request in flight. */
let gate = { entered: deferred(), release: deferred() };
const slow: McpTool = {
  name: "slow",
  title: "Slow",
  description: "Waits for the test.",
  async run() {
    gate.entered.resolve();
    await gate.release.promise;
    return { content: [{ type: "text", text: "read something" }] };
  },
};

beforeAll(async () => {
  shared = await openSharedTestDatabases();
  t = await seedTenant(shared.first, 1);
  const setup = await shared.first.withTenant(t.tenantId, async (tx) => {
    const token = await issueScimToken(tx, t.tenantId, {
      name: "IdP",
      days: 30,
      by: "system:test",
    });
    const group = await createGroup(tx, t.tenantId, {
      name: "Entra admins",
      source: "scim",
      externalId: "entra-admins",
    });
    const noted = await noteClient(
      tx,
      t.tenantId,
      { kind: "cimd", clientRef: CLIENT_ID, name: "Client", redirectUris: [REDIRECT] },
      "system:test",
    );
    const key = noted?.clientKey as string;
    await decideClient(tx, t.tenantId, key, { approve: true, trust: "commercial" }, "system:test");
    return { token, groupId: group.id, clientKey: key };
  });
  scimToken = setup.token.token;
  scimTokenId = setup.token.id;
  adminGroupId = setup.groupId;
  clientKey = setup.clientKey;
  a = build(shared.first);
  b = build(shared.second);
});
afterAll(async () => {
  gate.release.resolve();
  await shared?.close();
});

function build(db: Database): Hono<AuthEnv> {
  const config = ConfigSchema.parse({
    dataDir: "/tmp/unused",
    auth: {
      publicUrl: PUBLIC,
      cookieKey: "k".repeat(43),
      adminGroups: [{ tenantId: t.tenantId, groupId: adminGroupId }],
    },
  });
  return createApp(config, undefined, { db, mcpTools: [whoami, slow] });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// --- The identity provider, over SCIM -----------------------------------------------------------

let people = 0;
const scim = async (app: Hono<AuthEnv>, method: string, path: string, body?: unknown) => {
  const res = await app.request(`${PUBLIC}/scim/v2${path}`, {
    method,
    headers: {
      authorization: `Bearer ${scimToken}`,
      ...(body === undefined ? {} : { "content-type": "application/scim+json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
};

/** A person the identity provider provisions (on process A). */
async function provision(): Promise<string> {
  const n = ++people;
  const res = await scim(a, "POST", "/Users", {
    schemas: [USER],
    userName: `person${n}@example.com`,
    externalId: `oid-${n}`,
    displayName: `Person ${n}`,
    emails: [{ value: `person${n}@example.com`, type: "work", primary: true }],
    active: true,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

const deactivate = (app: Hono<AuthEnv>, userId: string) =>
  scim(app, "PATCH", `/Users/${userId}`, {
    schemas: [PATCH],
    Operations: [{ op: "Replace", path: "active", value: "False" }],
  });

// --- What a person holds ------------------------------------------------------------------------

interface Held {
  userId: string;
  /** The browser's session cookie. */
  cookie: string;
  /** An AI client's tokens (T-105), through the token endpoint. */
  access: string;
  refresh: string;
  /** A code the person consented to that the client hasn't redeemed yet. */
  pending: { code: string; verifier: string };
}

/** Signs the person in and lets the approved AI client in on their behalf. */
async function hold(userId: string): Promise<Held> {
  const session = await shared.first.withTenant(t.tenantId, (tx) =>
    startSession(tx, t.tenantId, {
      userId,
      provider: "dev",
      issuer: "https://idp.example",
      subject: userId,
    }),
  );
  const first = await consent(userId);
  const tokens = await tokenRequest(a, {
    grant_type: "authorization_code",
    code: first.code,
    redirect_uri: REDIRECT,
    code_verifier: first.verifier,
  });
  expect(tokens.status).toBe(200);
  return {
    userId,
    cookie: `${SESSION_COOKIE}=${session.token}`,
    access: tokens.body.access_token as string,
    refresh: tokens.body.refresh_token as string,
    pending: await consent(userId),
  };
}

/** A code for the person's consent, as the consent page issues it. */
async function consent(userId: string) {
  const verifier = randomBytes(32).toString("base64url");
  const code = await shared.first.withTenant(t.tenantId, (tx) =>
    issueCode(tx, t.tenantId, {
      userId,
      clientKey,
      redirectUri: REDIRECT,
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
      scopes: ["files:read"],
      resource: RESOURCE,
    }),
  );
  return { code, verifier };
}

const tokenRequest = async (app: Hono<AuthEnv>, form: Record<string, string>) => {
  const res = await app.request(`${PUBLIC}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, resource: RESOURCE, ...form }).toString(),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const me = (app: Hono<AuthEnv>, cookie: string) =>
  app.request(`${PUBLIC}/auth/me`, { headers: { cookie } });

const mcp = (app: Hono<AuthEnv>, access: string, tool = "whoami") =>
  app.request(RESOURCE, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${access}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: {} },
    }),
  });

/** Everything the person holds works, on both processes (their caches warm). */
async function expectWorking(h: Held): Promise<Held> {
  for (const app of [a, b]) {
    expect((await me(app, h.cookie)).status).toBe(200);
    expect((await mcp(app, h.access)).status).toBe(200);
  }
  // The refresh token works too; it rotates, and the new one is what the client holds now.
  const refreshed = await tokenRequest(b, {
    grant_type: "refresh_token",
    refresh_token: h.refresh,
  });
  expect(refreshed.status).toBe(200);
  return {
    ...h,
    access: refreshed.body.access_token as string,
    refresh: refreshed.body.refresh_token as string,
  };
}

/** Everything the person held is refused on the next request, on both processes. */
async function expectRefused(h: Held): Promise<void> {
  for (const app of [b, a]) {
    const session = await me(app, h.cookie);
    expect(session.status).toBe(401);
    const bearer = await mcp(app, h.access);
    expect(bearer.status).toBe(401);
    expect(bearer.headers.get("www-authenticate")).toMatch(/error="invalid_token"/);
  }
  const refreshed = await tokenRequest(b, {
    grant_type: "refresh_token",
    refresh_token: h.refresh,
  });
  expect(refreshed).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
  const redeemed = await tokenRequest(a, {
    grant_type: "authorization_code",
    code: h.pending.code,
    redirect_uri: REDIRECT,
    code_verifier: h.pending.verifier,
  });
  expect(redeemed).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
}

/** Runs `stop`, then `check`, and returns how long it all took, which must be within bounds. */
async function timed(stop: () => Promise<void>, check: () => Promise<void>): Promise<number> {
  const started = performance.now();
  await stop();
  await check();
  const took = performance.now() - started;
  expect(took).toBeLessThan(BOUND_MS);
  return took;
}

/** Runs an admin command against the shared database, as the operator would beside the server. */
async function admin(...argv: string[]) {
  let out = "";
  let err = "";
  const code = await runAdmin(argv, {
    env: { OPENHOARD_DATA_DIR: "/tmp/unused" },
    out: (s) => void (out += s),
    err: (s) => void (err += s),
    // A third process's handle on the database; each command closes its own.
    open: async () => ({ ...shared.second, close: async () => {} }),
  });
  return { code, out, err };
}

/** The tenant's audit records, oldest first. */
async function audit() {
  const lines: string[] = [];
  await exportAudit(shared.first, t.tenantId, {}, "ndjson", (s: string) => void lines.push(s));
  return lines
    .join("")
    .split("\n")
    .filter(Boolean)
    .map(
      (l) =>
        JSON.parse(l) as {
          actor: string;
          action: string;
          decision: string;
          detail?: Record<string, unknown>;
        },
    );
}

describe("deprovisioning a person (T-104)", () => {
  it("SCIM active: false ends their session, AI-client tokens, refresh and codes at once", async () => {
    const userId = await provision();
    const h = await expectWorking(await hold(userId));
    await timed(
      async () => {
        const off = await deactivate(a, userId);
        expect(off.body.active).toBe(false);
      },
      () => expectRefused(h),
    );
    // Reactivated by the provider: none of it comes back.
    await scim(a, "PATCH", `/Users/${userId}`, {
      schemas: [PATCH],
      Operations: [{ op: "Replace", path: "active", value: "True" }],
    });
    await expectRefused(h);
    // The audit says what the deactivation ended, and that the reactivation brought none back.
    const records = (await audit()).filter(
      (e) => e.action === "scim.user.patch" && e.detail?.target === userId,
    );
    expect(records.map((e) => e.detail)).toEqual([
      expect.objectContaining({
        deactivated: true,
        sessionsEnded: 1,
        oauthGrantsRevoked: 1,
        oauthCodesUsedUp: 1,
      }),
      expect.objectContaining({ reactivated: true }),
    ]);
  });

  it("the operator's lock does the same from another process, and unlocking revives nothing", async () => {
    const userId = await provision();
    const h = await expectWorking(await hold(userId));
    await timed(
      async () => {
        const locked = await admin("user", "lock", "--tenant", t.tenantId, "--user", userId);
        expect(locked.code, locked.err).toBe(0);
        expect(locked.err).toMatch(/Ended 1 session\(s\) and revoked 1 AI-client grant\(s\)/);
      },
      () => expectRefused(h),
    );
    expect((await admin("user", "lock", "--tenant", t.tenantId, "--user", userId)).err).toMatch(
      /locked already/,
    );
    const unlocked = await admin("user", "unlock", "--tenant", t.tenantId, "--user", userId);
    expect(unlocked.code).toBe(0);
    await expectRefused(h);
    expect((await admin("user", "unlock", "--tenant", t.tenantId, "--user", userId)).err).toMatch(
      /wasn't locked/,
    );
    // Someone the tenant doesn't have: refused, and audited.
    const nobody = await admin("user", "lock", "--tenant", t.tenantId, "--user", "x@y.z");
    expect(nobody.code).toBe(1);
    const records = (await audit()).filter((e) => e.actor === "system:admin-cli");
    expect(records.map((e) => [e.action, e.decision, e.detail])).toEqual([
      [
        "user.lock",
        "allow",
        { user: userId, sessionsEnded: 1, oauthGrantsRevoked: 1, oauthCodesUsedUp: 1 },
      ],
      ["user.lock", "allow", { user: userId, unchanged: true }],
      ["user.unlock", "allow", { user: userId }],
      ["user.unlock", "allow", { user: userId, unchanged: true }],
      ["user.lock", "deny", { reason: "unknown-user" }],
    ]);
  });

  it("SCIM DELETE retires them, with everything they held", async () => {
    const userId = await provision();
    const h = await expectWorking(await hold(userId));
    await timed(
      async () => {
        expect((await scim(a, "DELETE", `/Users/${userId}`)).status).toBe(204);
      },
      () => expectRefused(h),
    );
    const [record] = (await audit()).filter(
      (e) => e.action === "scim.user.delete" && e.detail?.target === userId,
    );
    expect(record?.detail).toMatchObject({
      retired: true,
      sessionsEnded: 1,
      oauthGrantsRevoked: 1,
    });
  });

  it("an MCP request in flight when they are cut off doesn't deliver its answer", async () => {
    const userId = await provision();
    const h = await expectWorking(await hold(userId));
    // Process B checks the token and starts reading...
    const inFlight = mcp(b, h.access, "slow");
    await gate.entered.promise;
    // ...the identity provider deactivates them on process A...
    const started = performance.now();
    expect((await deactivate(a, userId)).body.active).toBe(false);
    // ...and B, done reading, doesn't hand it over.
    gate.release.resolve();
    const res = await inFlight;
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/error="invalid_token"/);
    expect(await res.text()).not.toMatch(/read something/);
    expect(performance.now() - started).toBeLessThan(BOUND_MS);
  });

  it("nor does one whose access token its client revokes (RFC 7009) meanwhile", async () => {
    gate = { entered: deferred(), release: deferred() };
    const userId = await provision();
    const h = await expectWorking(await hold(userId));
    const inFlight = mcp(b, h.access, "slow");
    await gate.entered.promise;
    // The client revokes the access token alone: the grant (and its refresh token) stay.
    const revoked = await a.request(`${PUBLIC}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: h.access }).toString(),
    });
    expect(revoked.status).toBe(200);
    gate.release.resolve();
    const res = await inFlight;
    expect(res.status).toBe(401);
    expect(await res.text()).not.toMatch(/read something/);
    for (const app of [b, a]) expect((await mcp(app, h.access)).status).toBe(401);
    const refreshed = await tokenRequest(b, {
      grant_type: "refresh_token",
      refresh_token: h.refresh,
    });
    expect(refreshed.status).toBe(200);
    expect((await mcp(b, refreshed.body.access_token as string)).status).toBe(200);
  });

  it("a disabled admin, or one the provider takes out of the admin group, stops being one at once", async () => {
    const adminId = await provision();
    const other = await provision();
    // The provider makes both admins, through the admin group.
    const joined = await scim(a, "PATCH", `/Groups/${adminGroupId}`, {
      schemas: [PATCH],
      Operations: [{ op: "add", path: "members", value: [{ value: adminId }, { value: other }] }],
    });
    expect(joined.status).toBe(204);
    const cookies = [];
    for (const userId of [adminId, other]) {
      const session = await shared.first.withTenant(t.tenantId, (tx) =>
        startSession(tx, t.tenantId, {
          userId,
          provider: "dev",
          issuer: "https://idp.example",
          subject: userId,
        }),
      );
      cookies.push(`${SESSION_COOKIE}=${session.token}`);
    }
    const [adminCookie, otherCookie] = cookies as [string, string];
    const clients = (app: Hono<AuthEnv>, cookie: string) =>
      app.request(`${PUBLIC}/api/admin/clients`, { headers: { cookie } });
    for (const app of [a, b]) {
      expect((await clients(app, adminCookie)).status).toBe(200);
      expect((await clients(app, otherCookie)).status).toBe(200);
    }
    // Out of the group: still signed in, no longer an admin, on the other process too, although
    // its cache held them as one a moment ago.
    await timed(
      async () => {
        const left = await scim(a, "PATCH", `/Groups/${adminGroupId}`, {
          schemas: [PATCH],
          Operations: [{ op: "remove", path: `members[value eq "${other}"]` }],
        });
        expect(left.status).toBe(204);
      },
      async () => {
        expect((await clients(b, otherCookie)).status).toBe(403);
        expect((await me(b, otherCookie)).status).toBe(200);
      },
    );
    // Deactivated: signed out altogether.
    await timed(
      async () => {
        expect((await deactivate(a, adminId)).body.active).toBe(false);
      },
      async () => {
        expect((await clients(b, adminCookie)).status).toBe(401);
        expect((await clients(a, adminCookie)).status).toBe(401);
      },
    );
  });
});

describe("revoking a credential (T-104, T-106)", () => {
  it("an AI client an admin revokes stops on its next request, access and refresh alike", async () => {
    // A local admin, by role.
    const boss = await shared.first.withTenant(t.tenantId, async (tx) => {
      const u = await createUser(tx, t.tenantId, {
        email: "boss@example.com",
        displayName: "Boss",
        source: "local",
      });
      await grantAdmin(tx, t.tenantId, u.id, "system:admin-cli");
      return startSession(tx, t.tenantId, {
        userId: u.id,
        provider: "dev",
        issuer: "https://idp.example",
        subject: u.id,
      });
    });
    const userId = await provision();
    const h = await expectWorking(await hold(userId));
    await timed(
      async () => {
        const revoked = await a.request(`${PUBLIC}/api/admin/clients/${clientKey}/revoke`, {
          method: "POST",
          headers: {
            cookie: `${SESSION_COOKIE}=${boss.token}`,
            origin: PUBLIC,
            "content-type": "application/json",
          },
          body: "{}",
        });
        expect(revoked.status).toBe(200);
      },
      async () => {
        for (const app of [b, a]) expect((await mcp(app, h.access)).status).toBe(401);
        const refreshed = await tokenRequest(b, {
          grant_type: "refresh_token",
          refresh_token: h.refresh,
        });
        expect(refreshed.status).toBe(400);
        // The person's own session is theirs, not the client's: it stays.
        expect((await me(b, h.cookie)).status).toBe(200);
      },
    );
    // Approved again for the tests after this one; the revoked grant stays revoked.
    await shared.first.withTenant(t.tenantId, (tx) =>
      decideClient(
        tx,
        t.tenantId,
        clientKey,
        { approve: true, trust: "commercial" },
        "system:test",
      ),
    );
    expect((await mcp(b, h.access)).status).toBe(401);
  });

  it("a revoked SCIM token stops on its next request, on every process", async () => {
    for (const app of [a, b]) expect((await scim(app, "GET", "/Users?count=1")).status).toBe(200);
    await timed(
      async () => {
        const revoked = await admin(
          "scim-token",
          "revoke",
          "--tenant",
          t.tenantId,
          "--id",
          scimTokenId,
        );
        expect(revoked.code, revoked.err).toBe(0);
      },
      async () => {
        for (const app of [b, a]) {
          expect((await scim(app, "GET", "/Users?count=1")).status).toBe(401);
        }
      },
    );
    const refusals = (await audit()).filter(
      (e) => e.action === "scim.auth" && e.actor === `scim:${scimTokenId}`,
    );
    expect(refusals.map((e) => e.detail?.reason)).toEqual(["revoked", "revoked"]);
  });
});

describe("a service account's API keys (T-104, core: no API-key route yet)", () => {
  it("stop on the next check when the account is locked, on every process, and when revoked or retired", async () => {
    const { account, key } = await shared.first.withTenant(t.tenantId, async (tx) => {
      const acct = await createServiceAccount(tx, t.tenantId, {
        displayName: "CI",
        by: "system:test",
      });
      const issued = await issueApiKey(tx, t.tenantId, {
        userId: acct.id,
        name: "nightly",
        actions: ["read"],
        zones: ["indexed"],
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
        by: "system:test",
      });
      return { account: acct, key: issued };
    });
    // Each process has its principal cache, as the server's would; read in the snapshot the
    // server reads keys in, where the cache serves.
    const caches = [new PrincipalCache(), new PrincipalCache()];
    const dbs = [shared.first, shared.second];
    const check = (i: number, token = key.token) =>
      (dbs[i] as Database).withTenant(
        t.tenantId,
        (tx) => authenticateApiKey(tx, t.tenantId, token, { cache: caches[i] as PrincipalCache }),
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    for (const i of [0, 1]) expect(await check(i)).not.toBeNull();
    for (const i of [0, 1]) expect(await check(i)).not.toBeNull();
    expect(caches.map((c) => c.stats().hits)).toEqual([1, 1]);

    await timed(
      async () => {
        const locked = await admin("user", "lock", "--tenant", t.tenantId, "--user", account.id);
        expect(locked.err).toMatch(/Their API keys stop until they are unlocked/);
      },
      async () => {
        for (const i of [1, 0]) expect(await check(i)).toBeNull();
      },
    );
    // Locking suspends a key; unlocking brings it back (a key isn't a session: revoke it if it
    // leaked).
    await admin("user", "unlock", "--tenant", t.tenantId, "--user", account.id);
    for (const i of [1, 0]) expect(await check(i)).not.toBeNull();

    await timed(
      async () => {
        await shared.first.withTenant(t.tenantId, (tx) =>
          revokeApiKey(tx, t.tenantId, key.id, "system:test"),
        );
      },
      async () => {
        for (const i of [1, 0]) expect(await check(i)).toBeNull();
      },
    );

    const second = await shared.first.withTenant(t.tenantId, (tx) =>
      issueApiKey(tx, t.tenantId, {
        userId: account.id,
        name: "again",
        actions: ["read"],
        zones: ["indexed"],
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
        by: "system:test",
      }),
    );
    expect(await check(1, second.token)).not.toBeNull();
    const ended: unknown[] = [];
    await timed(
      async () => {
        await shared.first.withTenant(t.tenantId, (tx) =>
          retireUser(tx, t.tenantId, account.id, "system:test", {
            onEnded: (e) => ended.push(e),
          }),
        );
      },
      async () => {
        for (const i of [1, 0]) expect(await check(i, second.token)).toBeNull();
      },
    );
    expect(ended).toEqual([{ sessions: 0, oauthCodes: 0, oauthGrants: 0, apiKeys: 1 }]);
  });
});
