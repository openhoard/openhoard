import { createHash, randomBytes } from "node:crypto";
import { exportAudit } from "@openhoard/core-audit";
import { oauthClients, sessions, type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import {
  addMember,
  createGroup,
  createUser,
  grantAdmin,
  lockUser,
  type User,
} from "@openhoard/core-identity";
import { generateTenant, startDevOidc, type DevOidc, type FakeUser } from "@openhoard/testkit";
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { AuthEnv } from "./auth.js";
import { ConfigSchema } from "./config.js";
import { ClientError } from "./oauth/clients.js";

/*
 * T-106: the AI-client allowlist and tenant admins, over the admin API. "Done when: unlisted
 * client refused; label available to policy."
 */

const PUBLIC = "https://hoard.example";
const RESOURCE = `${PUBLIC}/mcp`;
const CLIENT_ID = "https://client.example/oauth/mcp.json";
const CLIENT_REDIRECT = "https://client.example/cb";
const fake = generateTenant({ items: 20 });
const [adminPerson, memberPerson, thirdPerson] = fake.users.filter((u) => u.active && !u.guest) as [
  FakeUser,
  FakeUser,
  FakeUser,
];
const ADMIN_GROUP = "entra-admins";

let idp: DevOidc;
beforeAll(async () => {
  idp = await startDevOidc({
    tenant: fake,
    clients: [{ clientId: "openhoard-test", redirectUris: [`${PUBLIC}/auth/callback/dev`] }],
  });
});
afterAll(() => idp?.close());

let db: Database;
let t: SeededTenant;
let admin: User;
let member: User;
let third: User;
let app: Hono<AuthEnv>;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  const scimUser = (p: FakeUser) =>
    db.withTenant(t.tenantId, (tx) =>
      createUser(tx, t.tenantId, {
        email: p.upn,
        displayName: p.displayName,
        source: "scim",
        externalId: p.id,
        userName: p.upn,
      }),
    );
  admin = await scimUser(adminPerson);
  member = await scimUser(memberPerson);
  third = await scimUser(thirdPerson);
  await db.withTenant(t.tenantId, (tx) => grantAdmin(tx, t.tenantId, admin.id, "system:admin-cli"));
  app = build();
});
afterEach(() => db?.close());

function build(auth: Record<string, unknown> = {}): Hono<AuthEnv> {
  const config = ConfigSchema.parse({
    dataDir: "/tmp/unused",
    auth: {
      publicUrl: PUBLIC,
      cookieKey: "k".repeat(43),
      providers: [
        {
          id: "dev",
          kind: "generic",
          tenantId: t.tenantId,
          issuer: idp.issuer,
          clientId: "openhoard-test",
          matchExternalId: true,
        },
      ],
      ...auth,
    },
  });
  return createApp(config, undefined, {
    db,
    fetchMetadata: (url) =>
      url.href === CLIENT_ID
        ? Promise.resolve({
            body: JSON.stringify({
              client_id: CLIENT_ID,
              client_name: "Claude (really)",
              redirect_uris: [CLIENT_REDIRECT],
            }),
          })
        : Promise.reject(new ClientError("not found")),
  });
}

/** A browser: our server in-process, the provider over HTTP, cookies, manual redirects. */
class Browser {
  readonly jar = new Map<string, string>();

  async go(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = {
      ...(init.headers as Record<string, string>),
      cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "),
    };
    const res =
      new URL(url).origin === PUBLIC
        ? await app.request(url, { ...init, headers })
        : await fetch(url, { ...init, headers, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [pair = ""] = c.split(";");
      const at = pair.indexOf("=");
      const value = pair.slice(at + 1);
      if (value === "" || /max-age=0/i.test(c)) this.jar.delete(pair.slice(0, at));
      else this.jar.set(pair.slice(0, at), value);
    }
    return res;
  }

  /** Follows redirects, signing in at the provider as `login` when asked. */
  async follow(start: string, login: string): Promise<Response> {
    let url = start;
    let res = await this.go(url);
    for (let hops = 0; hops < 15; hops++) {
      const loc = res.headers.get("location");
      if (![301, 302, 303, 307].includes(res.status) || !loc) return res;
      const next = new URL(loc, url).href;
      if (new URL(next).origin === new URL(CLIENT_REDIRECT).origin) return res;
      if (next.includes("/interaction/")) {
        await this.go(next);
        url = `${next}/login`;
        res = await this.go(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ login }).toString(),
        });
        continue;
      }
      url = next;
      res = await this.go(next);
    }
    return res;
  }

  /** The admin API, as the admin UI will call it: JSON, from this origin. */
  api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return this.go(`${PUBLIC}/api/admin${path}`, {
      method,
      headers: {
        origin: PUBLIC,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
}

async function signedIn(p: FakeUser): Promise<Browser> {
  const b = new Browser();
  const res = await b.follow(`${PUBLIC}/auth/sign-in?return_to=%2F`, p.upn);
  expect(res.status).toBe(200);
  return b;
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
function authorizeUrl() {
  const p = pkce();
  const q = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: CLIENT_REDIRECT,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    state: "s",
    resource: RESOURCE,
    scope: "files:read",
  });
  return { url: `${PUBLIC}/oauth/authorize?${q.toString()}`, verifier: p.verifier };
}
const form = (body: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body).toString(),
});

/** The member asks to connect the client; returns the page, and after consent, the tokens. */
async function connect(browser: Browser) {
  const { url, verifier } = authorizeUrl();
  const page = await browser.follow(url, memberPerson.upn);
  if (page.status !== 200) return { status: page.status, text: await page.text() };
  const request = /name="request" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
  const answer = await browser.go(`${PUBLIC}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: PUBLIC },
    body: new URLSearchParams({ request, decision: "allow" }).toString(),
  });
  const code = new URL(answer.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const res = await app.request(
    `${PUBLIC}/oauth/token`,
    form({
      grant_type: "authorization_code",
      code,
      redirect_uri: CLIENT_REDIRECT,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      resource: RESOURCE,
    }),
  );
  return { status: 200, tokens: (await res.json()) as Record<string, string> };
}

const mcp = async (token: string) => {
  const res = await app.request(RESOURCE, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
    }),
  });
  if (res.status !== 200) return { status: res.status };
  const body = (await res.json()) as { result: { structuredContent: { client: unknown } } };
  return { status: 200, client: body.result.structuredContent.client };
};

async function auditLog() {
  const lines: string[] = [];
  await exportAudit(db, t.tenantId, {}, "ndjson", (s: string) => void lines.push(s));
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
          client?: string;
          detail?: Record<string, unknown>;
        },
    );
}
const decisions = async (prefix: string) =>
  (await auditLog())
    .filter((e) => e.action.startsWith(prefix))
    .map((e) => `${e.action}:${e.decision}:${String(e.detail?.reason ?? "")}`);

async function clientKey(): Promise<string> {
  const [row] = await db.withTenant(t.tenantId, (tx) => tx.select().from(oauthClients));
  return row?.clientKey as string;
}

describe("the AI-client allowlist (T-106)", () => {
  it("refuses an unlisted client until an admin approves it, then until they revoke it", async () => {
    const person = await signedIn(memberPerson);
    // Unlisted: pending, and nothing goes back to the client.
    const pending = await connect(person);
    expect(pending.status).toBe(403);
    expect(pending.text).toContain("isn't approved yet");
    // The admin sees what identifies it: its metadata URL and redirect URIs, and its claimed
    // name only as such.
    const boss = await signedIn(adminPerson);
    const listed = (await (await boss.api("GET", "/clients")).json()) as {
      clients: Record<string, unknown>[];
    };
    const key = await clientKey();
    expect(listed.clients).toEqual([
      expect.objectContaining({
        clientKey: key,
        clientId: CLIENT_ID,
        redirectUris: [CLIENT_REDIRECT],
        approved: false,
        trust: null,
        status: "pending",
        managedBy: "app",
        requestedBy: `user:${member.id}`,
        claimedName: "Claude (really)",
      }),
    ]);
    expect(listed.clients[0]).not.toHaveProperty("name");
    // A code or token can't be had for it meanwhile.
    const early = await app.request(
      `${PUBLIC}/oauth/token`,
      form({ grant_type: "refresh_token", refresh_token: "x", client_id: CLIENT_ID }),
    );
    expect(early.status).toBe(400);

    const approved = await boss.api("POST", `/clients/${key}/approve`, { trust: "commercial" });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({
      client: {
        approved: true,
        trust: "commercial",
        status: "approved",
        decidedBy: `user:${admin.id}`,
      },
    });
    const first = await connect(person);
    const tokens = first.tokens as Record<string, string>;
    expect(await mcp(tokens.access_token as string)).toEqual({
      status: 200,
      client: { id: CLIENT_ID, trust: "commercial" },
    });

    // A new label reaches the next request of the token already out (and so policy: T-604).
    await boss.api("POST", `/clients/${key}/approve`, { trust: "consumer" });
    expect(await mcp(tokens.access_token as string)).toMatchObject({
      client: { trust: "consumer" },
    });

    // Revoked: the token stops on its next request, the refresh token too, and the person is
    // told at the next attempt.
    const revoked = await boss.api("POST", `/clients/${key}/revoke`, {});
    expect(revoked.status).toBe(200);
    expect(await mcp(tokens.access_token as string)).toEqual({ status: 401 });
    const refreshed = await app.request(
      `${PUBLIC}/oauth/token`,
      form({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token as string,
        client_id: CLIENT_ID,
      }),
    );
    expect(refreshed.status).toBeGreaterThanOrEqual(400);
    const again = await connect(person);
    expect(again.status).toBe(403);
    expect(again.text).toContain("refused this client");
    // Revoking twice isn't a thing: it was refused already.
    expect((await boss.api("POST", `/clients/${key}/revoke`, {})).status).toBe(409);

    expect(await decisions("oauth-client.")).toEqual([
      "oauth-client.approve:allow:",
      "oauth-client.approve:allow:",
      "oauth-client.revoke:allow:",
      "oauth-client.revoke:deny:status-changed",
    ]);
    const relabel = (await auditLog()).filter((e) => e.action === "oauth-client.approve")[1];
    expect(relabel).toMatchObject({
      actor: `user:${admin.id}`,
      client: CLIENT_ID,
      detail: { trust: "consumer", previousTrust: "commercial", was: "approved" },
    });
  });

  it("refuses a pending client, and can let a refused one in later", async () => {
    await connect(await signedIn(memberPerson));
    const key = await clientKey();
    const boss = await signedIn(adminPerson);
    expect((await boss.api("POST", `/clients/${key}/refuse`, {})).status).toBe(200);
    expect((await connect(await signedIn(memberPerson))).text).toContain("refused this client");
    // Refuse is for pending clients; an approved one is revoked.
    expect((await boss.api("POST", `/clients/${key}/refuse`, {})).status).toBe(409);
    expect((await boss.api("POST", `/clients/${key}/approve`, { trust: "local" })).status).toBe(
      200,
    );
    expect((await boss.api("POST", `/clients/${key}/refuse`, {})).status).toBe(409);
    expect((await connect(await signedIn(memberPerson))).status).toBe(200);
  });

  it("leaves a client the config approves to the config", async () => {
    app = build({ clients: [{ tenantId: t.tenantId, clientId: CLIENT_ID, trust: "commercial" }] });
    const tokens = (await connect(await signedIn(memberPerson))).tokens as Record<string, string>;
    const key = await clientKey();
    const boss = await signedIn(adminPerson);
    const listed = (await (await boss.api("GET", "/clients")).json()) as {
      clients: Record<string, unknown>[];
    };
    expect(listed.clients[0]).toMatchObject({
      managedBy: "config",
      approved: true,
      trust: "commercial",
    });
    for (const [action, body] of [
      ["revoke", {}],
      ["approve", { trust: "consumer" }],
    ] as const) {
      const res = await boss.api("POST", `/clients/${key}/${action}`, body);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: expect.stringContaining("auth.clients") });
    }
    expect(await mcp(tokens.access_token as string)).toMatchObject({ status: 200 });
    expect(await decisions("oauth-client.")).toEqual([
      "oauth-client.revoke:deny:config-managed",
      "oauth-client.approve:deny:config-managed",
    ]);
  });

  it("checks the request: JSON, a known client, a trust label", async () => {
    await connect(await signedIn(memberPerson));
    const key = await clientKey();
    const boss = await signedIn(adminPerson);
    expect(
      (await boss.api("POST", `/clients/${key}/approve`, { trust: "first-party" })).status,
    ).toBe(400);
    expect((await boss.api("POST", `/clients/${key}/approve`, {})).status).toBe(400);
    expect((await boss.api("POST", `/clients/nope/approve`, { trust: "local" })).status).toBe(404);
    expect(
      (await boss.api("POST", `/clients/${"0".repeat(64)}/approve`, { trust: "local" })).status,
    ).toBe(404);
    const asForm = await boss.go(`${PUBLIC}/api/admin/clients/${key}/approve`, {
      method: "POST",
      headers: { origin: PUBLIC, "content-type": "application/x-www-form-urlencoded" },
      body: "trust=local",
    });
    expect(asForm.status).toBe(415);
  });
});

describe("the admin API's gate", () => {
  it("lets only a signed-in admin in, and audits everyone else it refuses", async () => {
    expect((await app.request(`${PUBLIC}/api/admin/clients`)).status).toBe(401);
    const person = await signedIn(memberPerson);
    expect((await person.api("GET", "/clients")).status).toBe(403);
    expect((await person.api("POST", "/admins", { userId: member.id })).status).toBe(403);
    expect(await decisions("admin.access")).toEqual([
      "admin.access:deny:not-admin",
      "admin.access:deny:not-admin",
    ]);
    const me = (await (await person.go(`${PUBLIC}/auth/me`)).json()) as { admin: boolean };
    expect(me.admin).toBe(false);
    const boss = await signedIn(adminPerson);
    expect(((await (await boss.go(`${PUBLIC}/auth/me`)).json()) as { admin: boolean }).admin).toBe(
      true,
    );
  });

  it("takes changes only from this origin (the session's CSRF check)", async () => {
    await connect(await signedIn(memberPerson));
    const key = await clientKey();
    const boss = await signedIn(adminPerson);
    const approve = (headers: Record<string, string>) =>
      boss.go(`${PUBLIC}/api/admin/clients/${key}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ trust: "local" }),
      });
    expect((await approve({ origin: "https://evil.example" })).status).toBe(403);
    expect((await approve({})).status).toBe(403);
    expect((await approve({ origin: "null", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(await clientKey()).toBe(key);
    const [row] = await db.withTenant(t.tenantId, (tx) => tx.select().from(oauthClients));
    expect(row?.status).toBe("pending");
    expect((await approve({ origin: PUBLIC })).status).toBe(200);
  });

  it("asks for a recent sign-in to let anything in, never to cut it off", async () => {
    await connect(await signedIn(memberPerson));
    const key = await clientKey();
    const boss = await signedIn(adminPerson);
    await db.withTenant(t.tenantId, (tx) =>
      tx
        .update(sessions)
        .set({ createdAt: sql`created_at - interval '1 hour'` })
        .where(eq(sessions.userId, admin.id)),
    );
    const stale = await boss.api("POST", `/clients/${key}/approve`, { trust: "local" });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({
      error: "sign in again to do this",
      signIn: "/auth/sign-in",
    });
    expect((await boss.api("POST", "/admins", { userId: member.id })).status).toBe(403);
    expect((await boss.api("DELETE", `/admins/${admin.id}`)).status).toBe(403);
    // Refusing needs no fresh sign-in.
    expect((await boss.api("POST", `/clients/${key}/refuse`, {})).status).toBe(200);
    expect(await decisions("oauth-client.approve")).toEqual([
      "oauth-client.approve:deny:sign-in-again",
    ]);
  });

  it("checks again in the change's own transaction: a removed admin can't act", async () => {
    await connect(await signedIn(memberPerson));
    const key = await clientKey();
    const boss = await signedIn(adminPerson);
    await db.withTenant(t.tenantId, (tx) => lockUser(tx, t.tenantId, admin.id, "user:other"));
    // The lock ended the session too; either way nothing is decided.
    const res = await boss.api("POST", `/clients/${key}/approve`, { trust: "local" });
    expect([401, 403]).toContain(res.status);
    const [row] = await db.withTenant(t.tenantId, (tx) => tx.select().from(oauthClients));
    expect(row?.status).toBe("pending");
  });
});

describe("admins (T-106)", () => {
  const list = async (b: Browser) =>
    (
      (await (await b.api("GET", "/admins")).json()) as {
        admins: { userId: string; via: string[]; effective: boolean; grantedBy: string | null }[];
      }
    ).admins;

  it("makes and removes admins, never the last, all audited", async () => {
    const boss = await signedIn(adminPerson);
    expect(await list(boss)).toEqual([
      expect.objectContaining({
        userId: admin.id,
        via: ["role"],
        effective: true,
        grantedBy: "system:admin-cli",
      }),
    ]);
    expect((await boss.api("DELETE", `/admins/${admin.id}`)).status).toBe(409);
    const byEmail = await boss.api("POST", "/admins", { email: memberPerson.upn.toUpperCase() });
    expect(byEmail.status).toBe(200);
    expect(await byEmail.json()).toMatchObject({ user: { userId: member.id }, granted: true });
    // The new admin is one on their next request.
    const person = await signedIn(memberPerson);
    expect((await person.api("GET", "/admins")).status).toBe(200);
    // One admin removes the other; the last one stays.
    expect((await person.api("DELETE", `/admins/${admin.id}`)).status).toBe(200);
    expect((await boss.api("GET", "/admins")).status).toBe(403);
    expect((await person.api("DELETE", `/admins/${member.id}`)).status).toBe(409);
    expect(await decisions("admin.")).toEqual([
      "admin.revoke:deny:last-admin",
      "admin.grant:allow:",
      "admin.revoke:allow:",
      "admin.access:deny:not-admin",
      "admin.revoke:deny:last-admin",
    ]);
  });

  it("never makes a guest or a service account an admin, and names one person", async () => {
    const boss = await signedIn(adminPerson);
    const guest = await db.withTenant(t.tenantId, (tx) =>
      createUser(tx, t.tenantId, {
        email: "guest@partner.example",
        displayName: "Guest",
        source: "local",
        kind: "guest",
      }),
    );
    expect((await boss.api("POST", "/admins", { userId: guest.id })).status).toBe(400);
    expect((await boss.api("POST", "/admins", { email: "nobody@example.com" })).status).toBe(404);
    expect((await boss.api("POST", "/admins", {})).status).toBe(400);
    expect(
      (await boss.api("POST", "/admins", { userId: member.id, email: memberPerson.upn })).status,
    ).toBe(400);
    expect((await boss.api("POST", "/admins", { userName: thirdPerson.upn })).status).toBe(200);
    expect((await boss.api("DELETE", "/admins/usr_nope")).status).toBe(404);
  });

  it("counts the identity provider's admin group, whose members can't be removed here", async () => {
    await db.withTenant(t.tenantId, async (tx) => {
      const g = await createGroup(tx, t.tenantId, {
        name: "OpenHoard admins",
        source: "scim",
        externalId: ADMIN_GROUP,
      });
      await addMember(tx, t.tenantId, g.id, third.id, "scim");
    });
    app = build({ adminGroups: [{ tenantId: t.tenantId, externalId: ADMIN_GROUP }] });
    const viaGroup = await signedIn(thirdPerson);
    const admins = await list(viaGroup);
    expect(admins.map((a) => [a.userId, a.via])).toEqual(
      expect.arrayContaining([
        [admin.id, ["role"]],
        [third.id, ["group"]],
      ]),
    );
    const res = await viaGroup.api("DELETE", `/admins/${third.id}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("identity provider") });
    // The group admin counts: the role admin may go.
    expect((await viaGroup.api("DELETE", `/admins/${admin.id}`)).status).toBe(200);
  });

  it("refuses a config naming two admin groups for one tenant", () => {
    expect(() =>
      build({
        adminGroups: [
          { tenantId: t.tenantId, externalId: "a" },
          { tenantId: t.tenantId, externalId: "b" },
        ],
      }),
    ).toThrow(/one admin group per tenant/);
  });
});
