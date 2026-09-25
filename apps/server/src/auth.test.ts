import { exportAudit } from "@openhoard/core-audit";
import { sessions, type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { createUser, lockUser, unlockUser, type User } from "@openhoard/core-identity";
import { generateTenant, startDevOidc, type DevOidc, type FakeUser } from "@openhoard/testkit";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { AuthEnv } from "./auth.js";
import { ConfigSchema, loadConfig, type Config } from "./config.js";
import { loginKey, openLogin, sealLogin, type LoginState } from "./login-state.js";

/* T-102: signing in through OpenID Connect against the dev provider (testkit). */

const PUBLIC = "http://127.0.0.1:7420";
const fake = generateTenant({ items: 20 });
const people = fake.users.filter((u) => u.active && !u.guest);
const anaFake = people[0] as FakeUser;
const boFake = people[1] as FakeUser;
const strangerFake = people[2] as FakeUser;

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
let ana: User;
let app: Hono<AuthEnv>;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  const provision = (u: FakeUser) =>
    db.withTenant(t.tenantId, (tx) =>
      createUser(tx, t.tenantId, {
        email: u.upn,
        displayName: u.displayName,
        source: "scim",
        externalId: u.id,
      }),
    );
  ana = await provision(anaFake);
  await provision(boFake);
  app = createApp(config(), undefined, { db });
});
afterEach(() => db?.close());

function config(more: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({
    dataDir: "/tmp/unused",
    auth: {
      publicUrl: PUBLIC,
      providers: [
        {
          id: "dev",
          kind: "generic",
          tenantId: t.tenantId,
          issuer: idp.issuer,
          clientId: "openhoard-test",
          // The dev provider's subject is the fake tenant's user id, which SCIM sends as the
          // external id.
          matchExternalId: true,
        },
      ],
      ...more,
    },
  });
}

/** A browser: a cookie jar, manual redirects, our server in-process and the provider over HTTP. */
class Browser {
  readonly jar = new Map<string, string>();

  async go(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = {
      ...(init.headers as Record<string, string>),
      cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "),
    };
    const res = url.startsWith(PUBLIC)
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

  /** Signs in as `login` at the provider, and stops at our callback URL (not yet visited). */
  async toCallback(login: string, returnTo = "/files"): Promise<string> {
    const start = await this.go(
      `${PUBLIC}/auth/login/dev?return_to=${encodeURIComponent(returnTo)}`,
    );
    expect(start.status).toBe(302);
    let location = start.headers.get("location") ?? "";
    expect(location.startsWith(idp.issuer)).toBe(true);
    const toLogin = await this.go(location);
    const interaction = new URL(toLogin.headers.get("location") ?? "", idp.issuer).href;
    await this.go(interaction);
    const submitted = await this.go(`${interaction}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ login }).toString(),
    });
    location = new URL(submitted.headers.get("location") ?? "", idp.issuer).href;
    for (let hops = 0; !location.startsWith(PUBLIC) && hops < 8; hops++) {
      const next = await this.go(location);
      location = new URL(next.headers.get("location") ?? "", idp.issuer).href;
    }
    expect(location.startsWith(`${PUBLIC}/auth/callback/dev?`)).toBe(true);
    return location;
  }

  async signIn(login: string, returnTo?: string): Promise<Response> {
    return this.go(await this.toCallback(login, returnTo));
  }
}

/** The sign-in-under-way cookie a browser holds (there is one per sign-in). */
function loginCookieOf(browser: Browser): [string, string] {
  const found = [...browser.jar].find(([k]) => k.startsWith("oh_login_"));
  if (!found) throw new Error("no login cookie");
  return found;
}

async function auditEvents() {
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
          detail?: Record<string, unknown>;
        },
    );
}

describe("sign-in", () => {
  it("signs a provisioned person in, links them, and returns where they were going", async () => {
    const browser = new Browser();
    const back = await browser.signIn(anaFake.upn, "/files?q=report");
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/files?q=report");
    const cookie = back.headers.getSetCookie().find((c) => c.startsWith("oh_session="));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);

    const me = await browser.go(`${PUBLIC}/auth/me`);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      user: { id: ana.id, displayName: anaFake.displayName, kind: "member" },
      tenantId: t.tenantId,
    });
    const [event] = (await auditEvents()).filter((e) => e.action === "auth.sign-in");
    expect(event).toMatchObject({
      actor: `user:${ana.id}`,
      decision: "allow",
      detail: { provider: "dev", linked: true },
    });

    // The second time, the linked identity decides.
    const again = new Browser();
    expect((await again.signIn(anaFake.upn)).status).toBe(302);
    const second = (await auditEvents()).filter((e) => e.action === "auth.sign-in")[1];
    expect(second?.detail).toMatchObject({ linked: false });
  });

  it("signs out only from this origin, and the session is then gone", async () => {
    const browser = new Browser();
    await browser.signIn(boFake.upn);
    const crossSite = await browser.go(`${PUBLIC}/auth/logout`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(crossSite.status).toBe(403);
    expect((await browser.go(`${PUBLIC}/auth/me`)).status).toBe(200);
    const token = browser.jar.get("oh_session") as string;
    const out = await browser.go(`${PUBLIC}/auth/logout`, {
      method: "POST",
      headers: { origin: PUBLIC },
    });
    expect(out.status).toBe(204);
    expect(browser.jar.has("oh_session")).toBe(false);
    // The old cookie, replayed, is refused and cleared.
    const replay = await app.request(`${PUBLIC}/auth/me`, {
      headers: { cookie: `oh_session=${token}` },
    });
    expect(replay.status).toBe(401);
    expect(replay.headers.getSetCookie().join()).toMatch(/oh_session=;/);
    expect((await auditEvents()).map((e) => e.action)).toContain("auth.sign-out");
  });

  it("refuses someone nobody provisioned, and audits it with their subject", async () => {
    const res = await new Browser().signIn(strangerFake.upn);
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().join()).not.toMatch(/oh_session=\w/);
    const [event] = (await auditEvents()).filter((e) => e.action === "auth.sign-in");
    expect(event).toMatchObject({
      actor: "oidc:dev",
      decision: "deny",
      detail: { provider: "dev", reason: "unknown", subject: strangerFake.id },
    });
  });

  it("refuses a locked person", async () => {
    await db.withTenant(t.tenantId, (tx) => lockUser(tx, t.tenantId, ana.id, "user:admin"));
    const res = await new Browser().signIn(anaFake.upn);
    expect(res.status).toBe(401);
    const [event] = (await auditEvents()).filter((e) => e.action === "auth.sign-in");
    expect(event).toMatchObject({
      actor: `user:${ana.id}`,
      decision: "deny",
      detail: { reason: "inactive" },
    });
  });

  it("replaces the session a browser had when it signs in again", async () => {
    const browser = new Browser();
    await browser.signIn(anaFake.upn);
    const first = browser.jar.get("oh_session") as string;
    // A fresh browser holding only our session cookie (none of the provider's), as Bo.
    const again = new Browser();
    again.jar.set("oh_session", first);
    await again.signIn(boFake.upn);
    const old = await app.request(`${PUBLIC}/auth/me`, {
      headers: { cookie: `oh_session=${first}` },
    });
    expect(old.status).toBe(401);
    expect(await (await again.go(`${PUBLIC}/auth/me`)).json()).toMatchObject({
      user: { displayName: boFake.displayName },
    });
  });

  it("keeps a locked person out after the lock is lifted, until they sign in again", async () => {
    const browser = new Browser();
    await browser.signIn(anaFake.upn);
    const cookie = browser.jar.get("oh_session") as string;
    await db.withTenant(t.tenantId, (tx) => lockUser(tx, t.tenantId, ana.id, "user:admin"));
    await db.withTenant(t.tenantId, (tx) => unlockUser(tx, t.tenantId, ana.id, "user:admin"));
    const stolen = await app.request(`${PUBLIC}/auth/me`, {
      headers: { cookie: `oh_session=${cookie}` },
    });
    expect(stolen.status).toBe(401);
  });

  it("ends a session at once when its person is locked", async () => {
    const browser = new Browser();
    await browser.signIn(anaFake.upn);
    await db.withTenant(t.tenantId, (tx) => lockUser(tx, t.tenantId, ana.id, "user:admin"));
    // The principal cache holds for up to a minute; its epoch trigger invalidates it now.
    expect((await browser.go(`${PUBLIC}/auth/me`)).status).toBe(401);
  });
});

describe("the sign-in round trip is bound to its browser", () => {
  it("refuses a callback without this browser's state cookie", async () => {
    const callback = await new Browser().toCallback(anaFake.upn);
    // Another browser (an attacker's link) gets nothing.
    expect((await new Browser().go(callback)).status).toBe(400);
  });

  it("uses a sign-in once", async () => {
    const browser = new Browser();
    const callback = await browser.toCallback(anaFake.upn);
    const [name, value] = loginCookieOf(browser);
    expect((await browser.go(callback)).status).toBe(302);
    // Replayed with the same cookie: the provider refuses a code used twice.
    const replay = await app.request(callback, { headers: { cookie: `${name}=${value}` } });
    expect(replay.status).toBe(401);
    const events = (await auditEvents()).filter((e) => e.action === "auth.sign-in");
    expect(events.at(-1)).toMatchObject({
      decision: "deny",
      detail: { reason: "provider:invalid_grant" },
    });
  });

  it("refuses another browser's state, even with its own cookie", async () => {
    const a = new Browser();
    const b = new Browser();
    const callbackA = await a.toCallback(anaFake.upn);
    await b.toCallback(boFake.upn);
    // B's state cookie with A's code and state: named for B's state, so A's isn't there.
    const [name, value] = loginCookieOf(b);
    const res = await app.request(callbackA, { headers: { cookie: `${name}=${value}` } });
    expect(res.status).toBe(400);
  });

  it("keeps the sign-in under way sealed, and refuses a cookie changed, expired or for another provider", async () => {
    const key = "k".repeat(43);
    app = createApp(config({ cookieKey: key }), undefined, { db });
    const browser = new Browser();
    const callback = await browser.toCallback(anaFake.upn);
    const [name, value] = loginCookieOf(browser);
    const state = new URL(callback).searchParams.get("state") ?? "";
    // The state and verifier aren't readable in the cookie.
    expect(value).not.toContain(state);
    const opened = openLogin(loginKey(key), value);
    expect(opened).toMatchObject({ provider: "dev", state, returnTo: "/files" });
    expect(value).not.toContain(opened?.codeVerifier);
    const tries = {
      tampered: value.slice(0, -2) + (value.endsWith("AA") ? "BB" : "AA"),
      expired: sealLogin(loginKey(key), { ...(opened as LoginState), expiresAt: Date.now() - 1 }),
      otherProvider: sealLogin(loginKey(key), { ...(opened as LoginState), provider: "other" }),
      otherKey: sealLogin(loginKey(), opened as LoginState),
    };
    for (const [why, cookie] of Object.entries(tries)) {
      const res = await app.request(callback, { headers: { cookie: `${name}=${cookie}` } });
      expect(res.status, why).toBe(400);
    }
    // The genuine one still works.
    expect((await browser.go(callback)).status).toBe(302);
  });

  it("lets two tabs sign in at once", async () => {
    const browser = new Browser();
    const first = await browser.toCallback(anaFake.upn);
    const start = await browser.go(`${PUBLIC}/auth/login/dev?return_to=/second`);
    expect(start.status).toBe(302);
    // The second tab's cookie didn't replace the first's.
    expect((await browser.go(first)).status).toBe(302);
  });

  it("refuses a provider's error response, and audits it", async () => {
    const browser = new Browser();
    const start = await browser.go(`${PUBLIC}/auth/login/dev`);
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const res = await browser.go(
      `${PUBLIC}/auth/callback/dev?error=access_denied&state=${encodeURIComponent(state)}` +
        `&iss=${encodeURIComponent(idp.issuer)}`,
    );
    expect(res.status).toBe(401);
    const [event] = (await auditEvents()).filter((e) => e.action === "auth.sign-in");
    expect(event).toMatchObject({ decision: "deny", detail: { reason: "provider:access_denied" } });
  });

  it("returns only to this server, and knows only its providers", async () => {
    for (const evil of ["//evil.example/x", "https://evil.example", "/\\evil.example"]) {
      const back = await new Browser().signIn(anaFake.upn, evil);
      expect(back.headers.get("location"), evil).toBe("/");
    }
    const browser = new Browser();
    expect((await browser.go(`${PUBLIC}/auth/login/nope`)).status).toBe(404);
    expect((await browser.go(`${PUBLIC}/auth/callback/nope?state=x`)).status).toBe(404);
    const list = await (await browser.go(`${PUBLIC}/auth/providers`)).json();
    expect(list).toEqual({ providers: [{ id: "dev", label: "dev", kind: "generic" }] });
  });

  it("says sign-in is unavailable when the provider can't be reached", async () => {
    const down = createApp(
      ConfigSchema.parse({
        dataDir: "/tmp/unused",
        auth: {
          publicUrl: PUBLIC,
          providers: [
            {
              id: "down",
              kind: "generic",
              tenantId: t.tenantId,
              issuer: "http://127.0.0.1:9",
              clientId: "x",
            },
          ],
        },
      }),
      undefined,
      { db },
    );
    expect((await down.request(`${PUBLIC}/auth/login/down`)).status).toBe(503);
  });
});

describe("sessions over https", () => {
  it("use __Host- cookies, Secure", async () => {
    // Only the cookie attributes are checked here; the round trip is the same.
    const secureApp = createApp(config({ publicUrl: "https://hoard.example" }), undefined, { db });
    const res = await secureApp.request("https://hoard.example/auth/login/dev");
    const login = res.headers.getSetCookie().join();
    expect(login).toMatch(/__Secure-oh_login_[0-9a-f]{16}=/);
    expect(login).toMatch(/Secure/);
    const me = await secureApp.request("https://hoard.example/auth/me", {
      headers: { cookie: "__Host-oh_session=ohs.nope" },
    });
    expect(me.status).toBe(401);
  });
});

describe("auth config", () => {
  const provider = {
    id: "acme",
    kind: "entra",
    tenantId: "ten_01k5xr3c8v0q6m2d4n7p9s1t3w",
    issuer: "https://login.microsoftonline.com/7f1c2b8e-0d3a-4c5b-9e6f-1a2b3c4d5e6f/v2.0",
    clientId: "client",
  };
  const parse = (auth: Record<string, unknown>) =>
    ConfigSchema.safeParse({
      dataDir: "/x",
      auth: { publicUrl: "https://hoard.example", ...auth },
    });

  it("accepts a tenant-specific Entra issuer, and refuses common", () => {
    expect(parse({ providers: [provider] }).success).toBe(true);
    for (const issuer of [
      "https://login.microsoftonline.com/common/v2.0",
      "https://login.microsoftonline.com/organizations/v2.0",
    ]) {
      expect(parse({ providers: [{ ...provider, issuer }] }).success, issuer).toBe(false);
    }
    expect(
      parse({ providers: [{ ...provider, kind: "google", issuer: "https://accounts.google.com" }] })
        .success,
    ).toBe(true);
    expect(parse({ providers: [{ ...provider, kind: "google" }] }).success).toBe(false);
  });

  it("wants https, except on this machine", () => {
    expect(parse({ publicUrl: "http://hoard.example" }).success).toBe(false);
    expect(parse({ publicUrl: "http://localhost:7420" }).success).toBe(true);
    expect(parse({ publicUrl: "https://hoard.example/app" }).success).toBe(false);
    const generic = { ...provider, kind: "generic" };
    expect(parse({ providers: [{ ...generic, issuer: "http://idp.example" }] }).success).toBe(
      false,
    );
    expect(parse({ providers: [{ ...generic, issuer: "http://127.0.0.1:5556" }] }).success).toBe(
      true,
    );
  });

  it("lets one provider per tenant match external ids, never Google", () => {
    const generic = { ...provider, id: "other", kind: "generic", issuer: "https://idp.example" };
    // Entra matches by default; a second matching provider in the tenant is refused.
    expect(parse({ providers: [provider, { ...generic, matchExternalId: true }] }).success).toBe(
      false,
    );
    expect(parse({ providers: [provider, generic] }).success).toBe(true);
    expect(
      parse({
        providers: [
          { ...provider, matchExternalId: false },
          { ...generic, matchExternalId: true },
        ],
      }).success,
    ).toBe(true);
    const google = { ...provider, kind: "google", issuer: "https://accounts.google.com" };
    expect(parse({ providers: [{ ...google, matchExternalId: true }] }).success).toBe(false);
    // The claim is fixed by the kind: no configuring email-like claims.
    expect(parse({ providers: [{ ...generic, externalIdClaim: "email" }] }).success).toBe(false);
  });

  it("refuses duplicate providers and an idle limit longer than the session", () => {
    expect(parse({ providers: [provider, provider] }).success).toBe(false);
    expect(parse({ sessionIdleMinutes: 120, sessionMaxHours: 1 }).success).toBe(false);
    expect(parse({ providers: [{ ...provider, extra: 1 }] }).success).toBe(false);
  });

  it("takes client secrets from the environment", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const cwd = mkdtempSync(join(tmpdir(), "oh-auth-"));
    mkdirSync(join(cwd, ".openhoard"));
    writeFileSync(
      join(cwd, ".openhoard", "config.json"),
      JSON.stringify({
        auth: {
          publicUrl: "https://hoard.example",
          providers: [{ ...provider, id: "acme-entra" }],
        },
      }),
    );
    const c = loadConfig({ OPENHOARD_AUTH_ACME_ENTRA_CLIENT_SECRET: "s3cret" }, cwd);
    expect(c.auth?.providers[0]?.clientSecret).toBe("s3cret");
    expect(c.auth?.sessionIdleMinutes).toBe(720);
    const keyed = loadConfig({ OPENHOARD_AUTH_COOKIE_KEY: "a".repeat(43) }, cwd);
    expect(keyed.auth?.cookieKey).toBe("a".repeat(43));
    expect(() => loadConfig({ OPENHOARD_AUTH_COOKIE_KEY: "short" }, cwd)).toThrow(/cookieKey/);
  });

  it("needs the database when sign-in is on", () => {
    expect(() => createApp(config())).toThrow(/database/);
  });
});

describe("session rows", () => {
  it("are stored hashed, with the limits configured", async () => {
    const custom = createApp(config({ sessionIdleMinutes: 30, sessionMaxHours: 2 }), undefined, {
      db,
    });
    app = custom;
    await new Browser().signIn(anaFake.upn);
    const [row] = await db.withTenant(t.tenantId, (tx) =>
      tx
        .select({
          idle: sessions.idleSeconds,
          created: sessions.createdAt,
          expires: sessions.expiresAt,
          provider: sessions.provider,
          issuer: sessions.issuer,
        })
        .from(sessions),
    );
    expect(row).toMatchObject({ idle: 1800, provider: "dev", issuer: idp.issuer });
    expect((row?.expires.getTime() ?? 0) - (row?.created.getTime() ?? 0)).toBe(7200 * 1000);
  });
});
