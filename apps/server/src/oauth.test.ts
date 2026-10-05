import { createHash, randomBytes } from "node:crypto";
import { exportAudit } from "@openhoard/core-audit";
import { oauthClients, type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import {
  createUser,
  decideClient,
  getClient,
  grantAdmin,
  lockUser,
  revokeAdmin,
  type User,
} from "@openhoard/core-identity";
import { generateTenant, startDevOidc, type DevOidc, type FakeUser } from "@openhoard/testkit";
import { sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { AuthEnv } from "./auth.js";
import { ConfigSchema, type Config } from "./config.js";
import {
  ClientError,
  ClientResolver,
  isPrivateAddress,
  matchRedirect,
  register,
} from "./oauth/clients.js";
import { canonicalResource } from "./oauth/routes.js";

/* T-105: OpenHoard's OAuth 2.1 authorization server for MCP clients, end to end. */

const PUBLIC = "https://hoard.example";
const RESOURCE = `${PUBLIC}/mcp`;
const CLIENT_ID = "https://client.example/oauth/mcp.json";
const CLIENT_REDIRECT = "https://client.example/cb";
const fake = generateTenant({ items: 20 });
const person = fake.users.find((u) => u.active && !u.guest) as FakeUser;

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
let metadata: Record<string, unknown>;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  ana = await db.withTenant(t.tenantId, (tx) =>
    createUser(tx, t.tenantId, {
      email: person.upn,
      displayName: person.displayName,
      source: "scim",
      externalId: person.id,
    }),
  );
  metadata = {
    client_id: CLIENT_ID,
    client_name: "Example MCP client",
    redirect_uris: [CLIENT_REDIRECT],
    token_endpoint_auth_method: "none",
  };
  app = build([{ tenantId: t.tenantId, clientId: CLIENT_ID, trust: "commercial" }]);
});
afterEach(() => db?.close());

function config(clients: unknown[]): Config {
  return ConfigSchema.parse({
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
      clients,
    },
  });
}

function build(clients: unknown[]): Hono<AuthEnv> {
  return createApp(config(clients), undefined, {
    db,
    fetchMetadata: (url) => {
      if (url.href !== CLIENT_ID) return Promise.reject(new ClientError("not found"));
      return Promise.resolve({ body: JSON.stringify(metadata) });
    },
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

  /** Follows redirects (signing in at the provider as `login` when asked) until `stop` matches. */
  async follow(start: string, login: string, stop: (u: string) => boolean): Promise<Response> {
    let url = start;
    let res = await this.go(url);
    for (let hops = 0; hops < 15; hops++) {
      const loc = res.headers.get("location");
      if (![301, 302, 303, 307].includes(res.status) || !loc) return res;
      const next = new URL(loc, url).href;
      if (stop(next)) return res;
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
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

function authorizeUrl(params: Record<string, string | undefined> = {}) {
  const p = pkce();
  const q: Record<string, string | undefined> = {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: CLIENT_REDIRECT,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    state: "st4te-xyz",
    resource: RESOURCE,
    scope: "files:read",
  };
  const merged = Object.entries({ ...q, ...params }).filter(
    (e): e is [string, string] => e[1] !== undefined,
  );
  return {
    url: `${PUBLIC}/oauth/authorize?${new URLSearchParams(merged).toString()}`,
    verifier: p.verifier,
  };
}

/** Signs in, consents, and returns the redirect back to the client. */
async function consent(browser: Browser, url: string, decision = "allow") {
  const page = await browser.follow(url, person.upn, () => false);
  expect(page.status).toBe(200);
  const html = await page.text();
  const request = /name="request" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const answer = await browser.go(`${PUBLIC}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: PUBLIC },
    body: new URLSearchParams({ request, decision }).toString(),
  });
  return { page: html, answer, request };
}

/** A browser signed in (through a first consent page). */
async function signedIn(): Promise<Browser> {
  const browser = new Browser();
  const page = await browser.follow(authorizeUrl().url, person.upn, () => false);
  expect(page.status).toBe(200);
  return browser;
}

const form = (body: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body).toString(),
});

async function tokenFor(code: string, verifier: string, more: Record<string, string> = {}) {
  const res = await app.request(
    `${PUBLIC}/oauth/token`,
    form({
      grant_type: "authorization_code",
      code,
      redirect_uri: CLIENT_REDIRECT,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      resource: RESOURCE,
      ...more,
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, string | number> };
}

async function fullFlow(scope = "files:read") {
  const { url, verifier } = authorizeUrl({ scope });
  const { answer } = await consent(new Browser(), url);
  const back = new URL(answer.headers.get("location") ?? "");
  const code = back.searchParams.get("code") ?? "";
  const tokens = await tokenFor(code, verifier);
  expect(tokens.status).toBe(200);
  return tokens.body as { access_token: string; refresh_token: string; scope: string };
}

/** Calls the MCP server's whoami with the token, as a client would (T-801). */
const mcp = async (token?: string) => {
  const res = await app.request(RESOURCE, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
    }),
  });
  return {
    status: res.status,
    headers: res.headers,
    /** whoami's answer as { signedInAs, client, scopes }, or the error body. */
    json: async () => {
      const body = (await res.json()) as {
        result?: { structuredContent?: { user: { id: string }; client: unknown; scopes: unknown } };
      };
      const who = body.result?.structuredContent;
      return who ? { signedInAs: who.user.id, client: who.client, scopes: who.scopes } : body;
    },
  };
};

async function auditActions() {
  const lines: string[] = [];
  await exportAudit(db, t.tenantId, {}, "ndjson", (s: string) => void lines.push(s));
  return lines
    .join("")
    .split("\n")
    .filter(Boolean)
    .map(
      (l) =>
        JSON.parse(l) as { action: string; decision: string; detail?: Record<string, unknown> },
    );
}

describe("discovery", () => {
  it("points an unauthenticated MCP request at the protected-resource metadata", async () => {
    const res = await mcp();
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp", scope="files:read"`,
    );
    // The MCP Inspector runs on this machine: its origin may call /mcp and read the challenge.
    const inspector = "http://localhost:6274";
    const preflight = await app.request(RESOURCE, {
      method: "OPTIONS",
      headers: { origin: inspector, "access-control-request-method": "POST" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBe(inspector);
    const crossOrigin = await app.request(RESOURCE, {
      method: "POST",
      headers: { origin: inspector },
    });
    expect(crossOrigin.status).toBe(401);
    expect(crossOrigin.headers.get("access-control-expose-headers")).toMatch(/www-authenticate/);
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ]) {
      const meta = await (await app.request(`${PUBLIC}${path}`)).json();
      expect(meta).toMatchObject({ resource: RESOURCE, authorization_servers: [PUBLIC] });
    }
    const as = await app.request(`${PUBLIC}/.well-known/oauth-authorization-server`, {
      headers: { origin: "https://inspector.example" },
    });
    expect(as.headers.get("access-control-allow-origin")).toBe("*");
    expect(await as.json()).toMatchObject({
      issuer: PUBLIC,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });
});

describe("the authorization code flow", () => {
  it("signs the person in, asks their consent, and hands the client tokens for /mcp", async () => {
    const { url, verifier } = authorizeUrl();
    const browser = new Browser();
    const { page, answer } = await consent(browser, url);
    expect(page).toContain("Example MCP client");
    expect(page).toContain("client.example");
    expect(answer.status).toBe(302);
    const back = new URL(answer.headers.get("location") ?? "");
    expect(`${back.origin}${back.pathname}`).toBe(CLIENT_REDIRECT);
    expect(back.searchParams.get("state")).toBe("st4te-xyz");
    expect(back.searchParams.get("iss")).toBe(PUBLIC);
    const code = back.searchParams.get("code") ?? "";
    expect(code).toMatch(/^ohac\./);

    const tokens = await tokenFor(code, verifier);
    expect(tokens.status).toBe(200);
    expect(tokens.body).toMatchObject({
      token_type: "Bearer",
      expires_in: 3600,
      scope: "files:read",
    });
    const res = await mcp(tokens.body.access_token as string);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      signedInAs: ana.id,
      client: { id: CLIENT_ID, trust: "commercial" },
      scopes: ["files:read"],
    });
    // The same code again: refused, and what it made is revoked.
    expect((await tokenFor(code, verifier)).body).toMatchObject({ error: "invalid_grant" });
    expect((await mcp(tokens.body.access_token as string)).status).toBe(401);
    const actions = (await auditActions()).map((e) => `${e.action}:${e.decision}`);
    expect(actions).toEqual(
      expect.arrayContaining([
        "auth.sign-in:allow",
        "oauth.authorize:allow",
        "oauth.token:allow",
        "oauth.token:deny",
      ]),
    );
  });

  it("rotates refresh tokens, and a replayed one ends the grant", async () => {
    const first = await fullFlow();
    const refresh = (token: string) =>
      app.request(
        `${PUBLIC}/oauth/token`,
        form({ grant_type: "refresh_token", refresh_token: token, client_id: CLIENT_ID }),
      );
    const second = (await (await refresh(first.refresh_token)).json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await mcp(second.access_token)).status).toBe(200);
    const replay = await refresh(first.refresh_token);
    expect(replay.status).toBe(400);
    expect((await mcp(second.access_token)).status).toBe(401);
  });

  it("lets the person deny", async () => {
    const { answer } = await consent(new Browser(), authorizeUrl().url, "deny");
    const back = new URL(answer.headers.get("location") ?? "");
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("st4te-xyz");
  });

  it("accepts the consent form from a browser that sends Origin null for its own page", async () => {
    const browser = new Browser();
    const page = await browser.follow(authorizeUrl().url, person.upn, () => false);
    const request = /name="request" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const post = (headers: Record<string, string>) =>
      browser.go(`${PUBLIC}/oauth/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams({ request, decision: "deny" }).toString(),
      });
    expect((await post({ origin: "null" })).status).toBe(403);
    expect((await post({ origin: "null", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post({ origin: "null", "sec-fetch-site": "same-origin" })).status).toBe(302);
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
  });

  it("binds the consent form to its session and to ten minutes", async () => {
    const { request } = await consent(new Browser(), authorizeUrl().url, "deny");
    // Another person's browser posting it (the sealed request is for another session).
    const other = new Browser();
    await other.follow(authorizeUrl().url, person.upn, () => false);
    const res = await other.go(`${PUBLIC}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: PUBLIC },
      body: new URLSearchParams({ request, decision: "allow" }).toString(),
    });
    expect(res.status).toBe(400);
    // From another origin, with the cookie: refused before anything.
    const crossSite = await other.go(`${PUBLIC}/oauth/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
      },
      body: new URLSearchParams({ request, decision: "allow" }).toString(),
    });
    expect(crossSite.status).toBe(403);
  });
});

describe("clients need an admin", () => {
  it("records an unknown client as pending and tells the person", async () => {
    app = build([]);
    const page = await new Browser().follow(authorizeUrl().url, person.upn, () => false);
    expect(page.status).toBe(200);
    const waiting = await page.text();
    expect(waiting).toContain("isn't approved yet");
    // Someone who isn't an admin is told to wait, and offered nothing to decide.
    expect(waiting).toContain("Your admin has to approve");
    expect(waiting).not.toContain("/oauth/approve");
    const [row] = await db.withTenant(t.tenantId, (tx) => tx.select().from(oauthClients));
    expect(row).toMatchObject({
      status: "pending",
      clientRef: CLIENT_ID,
      requestedBy: `user:${ana.id}`,
    });
    expect((await auditActions()).find((e) => e.action === "oauth.authorize")).toMatchObject({
      decision: "deny",
      detail: { reason: "client-pending" },
    });
    // Approved in the app (T-106) instead of the config: the flow goes on.
    await db.withTenant(t.tenantId, (tx) =>
      decideClient(
        tx,
        t.tenantId,
        row?.clientKey as string,
        { approve: true, trust: "local" },
        "user:admin",
      ),
    );
    const tokens = await fullFlow();
    expect(await (await mcp(tokens.access_token)).json()).toMatchObject({
      client: { trust: "local" },
    });
  });

  describe("who is signed in", () => {
    const makeAdmin = (userId = ana.id) =>
      db.withTenant(t.tenantId, (tx) => grantAdmin(tx, t.tenantId, userId, "system:admin-cli"));
    /** The page an admin gets for a client that waits, and the request its form carries. */
    async function asked(browser: Browser, url = authorizeUrl().url) {
      const page = await browser.follow(url, person.upn, () => false);
      const html = await page.text();
      return {
        status: page.status,
        html,
        request: /name="request" value="([^"]+)"/.exec(html)?.[1] ?? "",
      };
    }
    const decide = (
      browser: Browser,
      body: Record<string, string>,
      headers: Record<string, string> = { origin: PUBLIC },
    ) =>
      browser.go(`${PUBLIC}/oauth/approve`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams(body).toString(),
      });
    const status = async () =>
      (await db.withTenant(t.tenantId, (tx) => tx.select().from(oauthClients)))[0];

    beforeEach(() => {
      app = build([]);
    });
    afterEach(() => vi.useRealTimers());

    it("approves the client there and then, and goes on to their own consent", async () => {
      await makeAdmin();
      const browser = new Browser();
      const { url, verifier } = authorizeUrl();
      const page = await asked(browser, url);
      expect(page.status).toBe(200);
      expect(page.html).toContain("You administer this OpenHoard");
      expect(page.html).toContain('action="/oauth/approve"');
      // Where its answers go, whole, and that the name is only what it calls itself.
      expect(page.html).toContain(`<li><span class="host">${CLIENT_REDIRECT}</span></li>`);
      expect(page.html).toContain("anyone can send you a link to this page");
      expect(page.html).not.toContain("a program on the computer");
      // Nothing is chosen for them: a trust label is theirs to pick, least first.
      expect(page.html).not.toContain("checked");
      expect([...page.html.matchAll(/name="trust" value="(\w+)"/g)].map((m) => m[1])).toEqual([
        "consumer",
        "commercial",
        "local",
      ]);
      expect(page.html.indexOf('value="refuse"')).toBeLessThan(
        page.html.indexOf('value="approve"'),
      );

      const answer = await decide(browser, {
        request: page.request,
        decision: "approve",
        trust: "local",
      });
      // Back to the same authorization request, on this server.
      expect(answer.status).toBe(303);
      const back = answer.headers.get("location") ?? "";
      expect(back).toBe(url.slice(PUBLIC.length));
      expect(await status()).toMatchObject({
        status: "approved",
        trust: "local",
        decidedBy: `user:${ana.id}`,
      });
      // Their own consent next, as for anyone; then the client works, with that label.
      const { answer: consented } = await consent(browser, `${PUBLIC}${back}`);
      const code = new URL(consented.headers.get("location") ?? "").searchParams.get("code") ?? "";
      const tokens = await tokenFor(code, verifier);
      expect(tokens.status).toBe(200);
      expect(await (await mcp(tokens.body.access_token as string)).json()).toMatchObject({
        client: { trust: "local" },
      });
      const approvals = (await auditActions()).filter((e) => e.action === "oauth-client.approve");
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({
        decision: "allow",
        detail: { via: "authorize", trust: "local", was: "pending" },
      });
      // The same form sent again changes nothing: the client isn't waiting any more.
      const again = await decide(browser, {
        request: page.request,
        decision: "approve",
        trust: "consumer",
      });
      expect(again.status).toBe(303);
      expect((await status())?.trust).toBe("local");
    });

    it("refuses the client there, for everyone", async () => {
      await makeAdmin();
      const browser = new Browser();
      const page = await asked(browser);
      const answer = await decide(browser, { request: page.request, decision: "refuse" });
      expect(answer.status).toBe(200);
      expect(await answer.text()).toContain("You refused this client");
      expect(await status()).toMatchObject({ status: "refused", decidedBy: `user:${ana.id}` });
      expect((await auditActions()).find((e) => e.action === "oauth-client.refuse")).toMatchObject({
        decision: "allow",
        detail: { via: "authorize", was: "pending" },
      });
      // Refusing it again (the form sent twice) changes nothing, and says so.
      const twice = await decide(browser, { request: page.request, decision: "refuse" });
      expect(await twice.text()).toContain("nothing was changed");

      // A refusal by mistake is theirs to undo: the page offers to approve after all, only.
      const { url, verifier } = authorizeUrl();
      const again = await asked(browser, url);
      expect(again.status).toBe(200);
      expect(again.html).toContain("was refused");
      expect(again.html).toContain("an admin refused this client before");
      expect(again.html).not.toContain('value="refuse"');
      expect((await decide(browser, { request: again.request, decision: "refuse" })).status).toBe(
        400,
      );
      const undone = await decide(browser, {
        request: again.request,
        decision: "approve",
        trust: "consumer",
      });
      expect(undone.status).toBe(303);
      expect(await status()).toMatchObject({ status: "approved", trust: "consumer" });
      const { answer: consented } = await consent(browser, url);
      const code = new URL(consented.headers.get("location") ?? "").searchParams.get("code") ?? "";
      expect((await tokenFor(code, verifier)).status).toBe(200);
      expect(
        (await auditActions()).filter((e) => e.action === "oauth-client.approve").at(-1),
      ).toMatchObject({ decision: "allow", detail: { was: "refused", trust: "consumer" } });
    });

    it("lifts a refusal of a client the config lists, with the config's label, and nothing else of the config's", async () => {
      await makeAdmin();
      const browser = new Browser();
      const first = await asked(browser);
      await decide(browser, { request: first.request, decision: "refuse" });
      // Now the config lists it: its refusal in the app still stands, until an admin lifts it.
      app = build([{ tenantId: t.tenantId, clientId: CLIENT_ID, trust: "local" }]);
      const { url } = authorizeUrl();
      const page = await asked(browser, url);
      expect(page.status).toBe(200);
      expect(page.html).toContain("as <strong>Stays on our computers</strong>");
      expect(page.html).not.toContain('name="trust"');
      // Whatever label is sent, the config's is the one it gets.
      const lifted = await decide(browser, {
        request: page.request,
        decision: "approve",
        trust: "consumer",
      });
      expect(lifted.status).toBe(303);
      expect(await status()).toMatchObject({ status: "approved", trust: "local" });
      expect((await asked(browser, url)).html).toContain("Allow Example MCP client");
      // An approval the config gave isn't this page's to take away or relabel.
      const again = await decide(browser, { request: first.request, decision: "refuse" });
      expect([again.status, await again.text()]).toEqual([
        403,
        expect.stringContaining("The server&#39;s config (auth.clients) decides for this client"),
      ]);
      expect((await status())?.status).toBe("approved");
    });

    it("approves again a client the config approved once and no longer lists", async () => {
      await makeAdmin();
      app = build([{ tenantId: t.tenantId, clientId: CLIENT_ID, trust: "commercial" }]);
      const browser = new Browser();
      await consent(browser, authorizeUrl().url);
      expect(await status()).toMatchObject({ status: "approved", decidedBy: "system:config" });
      app = build([]);
      const { url } = authorizeUrl();
      const page = await asked(browser, url);
      expect(page.status).toBe(200);
      expect(page.html).toContain("config approved this client once");
      expect(page.html).not.toContain('value="refuse"');
      const done = await decide(browser, {
        request: page.request,
        decision: "approve",
        trust: "commercial",
      });
      expect(done.status).toBe(303);
      expect(await status()).toMatchObject({
        status: "approved",
        trust: "commercial",
        decidedBy: `user:${ana.id}`,
      });
      expect((await asked(browser, url)).html).toContain("Allow Example MCP client");
    });

    it("tells anyone else that a refused client is refused", async () => {
      const browser = new Browser();
      await asked(browser);
      const row = await status();
      await db.withTenant(t.tenantId, (tx) =>
        decideClient(tx, t.tenantId, row?.clientKey as string, { approve: false }, "user:admin"),
      );
      const next = await asked(browser);
      expect([next.status, next.html]).toEqual([
        200,
        expect.stringContaining("Your admin refused this client"),
      ]);
      expect(next.html).not.toContain("/oauth/approve");
    });

    it("warns about a client that answers on the connecting computer, and says why it can't ask", async () => {
      await makeAdmin();
      metadata.redirect_uris = [CLIENT_REDIRECT, "http://127.0.0.1:33418/oauth/callback"];
      const browser = new Browser();
      const page = await asked(browser);
      expect(page.html).toContain("It answers to a program on the computer of whoever connects it");
      expect(page.html).toContain(
        '<li><span class="host">http://127.0.0.1:33418/oauth/callback</span></li>',
      );
      // A request too long to come back to: said, not shown as someone else's to approve.
      const long = await asked(
        browser,
        authorizeUrl({ state: "s".repeat(1024), scope: "files:read ".repeat(90).trim() }).url,
      );
      expect(long.status).toBe(200);
      expect(long.html).toContain("too long to be put to you for approval");
      expect(long.html).not.toContain("Your admin has to approve");
      // Only a form, never a file upload.
      const multipart = new FormData();
      multipart.set("request", page.request);
      multipart.set("decision", "approve");
      multipart.set("trust", "local");
      const sent = await browser.go(`${PUBLIC}/oauth/approve`, {
        method: "POST",
        headers: { origin: PUBLIC },
        body: multipart,
      });
      expect(sent.status).toBe(415);
      expect((await status())?.status).toBe("pending");
    });

    it("takes only its own form, whole, from this site, from someone still an admin", async () => {
      await makeAdmin();
      const browser = new Browser();
      const page = await asked(browser);
      const ok = { request: page.request, decision: "approve", trust: "commercial" };
      // Another site's page can't answer for the admin (the session's Origin check).
      expect((await decide(browser, ok, { origin: "https://evil.test" })).status).toBe(403);
      expect((await decide(browser, ok, {})).status).toBe(403);
      // Not a decision, not a trust label, not a request, nobody signed in.
      for (const body of [
        { ...ok, decision: "maybe" },
        { ...ok, trust: "first-party" },
        { request: page.request, decision: "approve" },
        { ...ok, request: "nonsense" },
        { decision: "approve", trust: "local" },
      ]) {
        expect((await decide(browser, body)).status).toBe(400);
      }
      expect((await decide(new Browser(), ok)).status).toBe(400);
      // Another session of the same person: the form was sealed to the one that saw it.
      const second = new Browser();
      await asked(second);
      expect((await decide(second, ok)).status).toBe(400);
      expect((await status())?.status).toBe("pending");

      // No longer an admin when the form comes back (someone else took over meanwhile).
      const bo = await db.withTenant(t.tenantId, (tx) =>
        createUser(tx, t.tenantId, { email: "bo@example.com", displayName: "Bo", source: "local" }),
      );
      await makeAdmin(bo.id);
      await db.withTenant(t.tenantId, (tx) =>
        revokeAdmin(tx, t.tenantId, ana.id, "system:admin-cli"),
      );
      const late = await decide(browser, ok);
      expect([late.status, await late.text()]).toEqual([
        403,
        expect.stringContaining("Only an admin decides this"),
      ]);
      expect((await status())?.status).toBe("pending");
      expect(
        (await auditActions()).filter((e) => e.action === "oauth-client.approve"),
      ).toMatchObject([{ decision: "deny", detail: { reason: "not-admin", via: "authorize" } }]);
      // And the page they get now offers nothing to decide.
      expect((await asked(browser)).html).not.toContain("/oauth/approve");
    });

    it("asks for a recent sign-in to approve, not to refuse", async () => {
      await makeAdmin();
      const browser = new Browser();
      await asked(browser);
      // Sixteen minutes on (auth.adminSignInMinutes is 15): a new form, from the same session.
      vi.useFakeTimers({ now: Date.now() + 16 * 60_000, toFake: ["Date"] });
      const page = await asked(browser);
      expect(page.html).toContain('action="/oauth/approve"');
      const stale = await decide(browser, {
        request: page.request,
        decision: "approve",
        trust: "commercial",
      });
      expect([stale.status, await stale.text()]).toEqual([
        403,
        expect.stringContaining("You signed in a while ago"),
      ]);
      expect((await status())?.status).toBe("pending");
      expect((await auditActions()).find((e) => e.action === "oauth-client.approve")).toMatchObject(
        { decision: "deny", detail: { reason: "sign-in-again" } },
      );
      // Refusing only cuts off: no wait.
      const refused = await decide(browser, { request: page.request, decision: "refuse" });
      expect(refused.status).toBe(200);
      expect((await status())?.status).toBe("refused");
    });
  });

  it("lets a client the config approves in however many others wait", async () => {
    await db.withTenant(t.tenantId, (tx) =>
      tx.execute(sql`insert into oauth_clients (tenant_id, client_key, kind, client_ref, name, redirect_uris, requested_by)
        select ${t.tenantId}, md5(i::text) || md5('x' || i::text), 'dcr', 'dcr:x', 'n', array['https://x.example/cb'], ${`user:${ana.id}`}
          from generate_series(1, 50) i`),
    );
    const tokens = await fullFlow();
    expect((await mcp(tokens.access_token)).status).toBe(200);
  });

  it("sends a refused client away, config or not", async () => {
    await fullFlow();
    const key = (await db.withTenant(t.tenantId, (tx) => tx.select().from(oauthClients)))[0]
      ?.clientKey as string;
    await db.withTenant(t.tenantId, (tx) =>
      decideClient(tx, t.tenantId, key, { approve: false }, "user:admin"),
    );
    const res = await new Browser().follow(authorizeUrl().url, person.upn, () => false);
    // Shown here: nothing goes back to a client the admin refused.
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("refused this client");
  });

  it("stops a client approved in the config once it is taken out", async () => {
    const tokens = await fullFlow();
    const stored = await db.withTenant(t.tenantId, async (tx) => {
      const [row] = await tx.select().from(oauthClients);
      return getClient(tx, t.tenantId, row?.clientKey as string);
    });
    expect(stored).toMatchObject({ status: "approved", decidedBy: "system:config" });
    app = build([]);
    expect((await mcp(tokens.access_token)).status).toBe(401);
  });

  it("registers dynamically, and approves such a client by its redirect URIs", async () => {
    const reg = await app.request(`${PUBLIC}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Desktop client",
        redirect_uris: ["http://127.0.0.1:33418/callback"],
      }),
    });
    expect(reg.status).toBe(201);
    const { client_id: clientId } = (await reg.json()) as { client_id: string };
    expect(clientId).toMatch(/^ohdcr\./);
    app = build([
      { tenantId: t.tenantId, redirectUris: ["http://127.0.0.1/callback"], trust: "local" },
    ]);
    // Another port on the loopback address is the same client (RFC 8252).
    const redirect = "http://127.0.0.1:51000/callback";
    const { url, verifier } = authorizeUrl({ client_id: clientId, redirect_uri: redirect });
    const { page, answer } = await consent(new Browser(), url);
    expect(page).toContain("a program on this computer");
    const code = new URL(answer.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const tokens = await tokenFor(code, verifier, { client_id: clientId, redirect_uri: redirect });
    expect(tokens.status).toBe(200);
    expect(await (await mcp(tokens.body.access_token as string)).json()).toMatchObject({
      client: { trust: "local" },
    });
  });
});

describe("bad requests", () => {
  it("does nothing for someone not signed in but send them to sign in", async () => {
    // Not even a bad client is looked at, nor an error sent anywhere.
    const res = await new Browser().go(
      authorizeUrl({ client_id: "https://unknown.example/c.json" }).url,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/auth\/sign-in\?return_to=/);
  });

  it("shows errors instead of redirecting until client and redirect check out", async () => {
    const browser = await signedIn();
    for (const params of [
      { client_id: "https://unknown.example/c.json" },
      { client_id: "not-a-client" },
      { client_id: "https://claude.ai@client.example/oauth/mcp.json" },
      { client_id: "https://127.0.0.1/oauth/mcp.json" },
      { redirect_uri: "https://evil.example/cb" },
      { redirect_uri: undefined },
    ]) {
      const res = await browser.go(authorizeUrl(params).url);
      expect(res.status, JSON.stringify(params)).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
    // A document naming another client_id (a fresh server: documents are cached for minutes).
    metadata = { ...metadata, client_id: "https://other.example/c.json" };
    app = build([{ tenantId: t.tenantId, clientId: CLIENT_ID, trust: "commercial" }]);
    expect((await browser.go(authorizeUrl().url)).status).toBe(400);
  });

  it("redirects protocol errors back with state and iss, for an approved client only", async () => {
    const browser = await signedIn();
    const cases: [Record<string, string | undefined>, string][] = [
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ code_challenge: undefined }, "invalid_request"],
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ resource: "https://evil.example/mcp" }, "invalid_target"],
      [{ scope: "files:read admin" }, "invalid_scope"],
    ];
    for (const [params, error] of cases) {
      const res = await browser.go(authorizeUrl(params).url);
      const back = new URL(res.headers.get("location") ?? "");
      expect(back.searchParams.get("error"), error).toBe(error);
      expect(back.searchParams.get("state")).toBe("st4te-xyz");
      expect(back.searchParams.get("iss")).toBe(PUBLIC);
    }
    // A client nobody approved gets no redirect, not even an error (no open redirect).
    app = build([]);
    const res = await browser.go(authorizeUrl({ response_type: "token" }).url);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("takes small bodies of the right type only", async () => {
    const multipart = new FormData();
    multipart.set("grant_type", "authorization_code");
    expect(
      (await app.request(`${PUBLIC}/oauth/token`, { method: "POST", body: multipart })).status,
    ).toBe(415);
    const big = await app.request(
      `${PUBLIC}/oauth/token`,
      form({ grant_type: "x".repeat(70_000) }),
    );
    expect(big.status).toBe(413);
    const register = await app.request(`${PUBLIC}/oauth/register`, form({ redirect_uris: "x" }));
    expect(register.status).toBe(415);
  });

  it("refuses a resource of a long run of slashes at the token endpoint, quickly", async () => {
    const started = performance.now();
    const res = await app.request(
      `${PUBLIC}/oauth/token`,
      form({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code:
          "ohac.ten_01k5xr3c8v0q6m2d4n7p9s1t3w.oac_01k5xr3c8v0q6m2d4n7p9s1t3w." + "a".repeat(43),
        // URL-encoded, 18,000 slashes are 54 KB: inside the endpoint's 64 KiB body limit.
        resource: `${PUBLIC}/${"/".repeat(18_000)}x`,
      }),
    );
    expect(await res.json()).toMatchObject({ error: "invalid_target" });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("refuses token requests that don't match their code", async () => {
    const { url, verifier } = authorizeUrl();
    const { answer } = await consent(new Browser(), url);
    const code = new URL(answer.headers.get("location") ?? "").searchParams.get("code") ?? "";
    expect((await tokenFor(code, verifier, { client_id: "nope" })).body).toMatchObject({
      error: "invalid_client",
    });
    expect(
      (await tokenFor(code, verifier, { resource: "https://evil.example/mcp" })).body,
    ).toMatchObject({
      error: "invalid_target",
    });
    expect((await tokenFor(code, pkce().verifier)).body).toMatchObject({ error: "invalid_grant" });
    const unsupported = await app.request(
      `${PUBLIC}/oauth/token`,
      form({ grant_type: "password", client_id: CLIENT_ID }),
    );
    expect(await unsupported.json()).toMatchObject({ error: "unsupported_grant_type" });
    const garbage = await app.request(
      `${PUBLIC}/oauth/token`,
      form({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code:
          "ohac.ten_01k5xr3c8v0q6m2d4n7p9s1t3w.oac_01k5xr3c8v0q6m2d4n7p9s1t3w." + "a".repeat(43),
      }),
    );
    expect(await garbage.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("asks for more scope when a token lacks it, and refuses a locked person's token", async () => {
    const tagOnly = await fullFlow("files:tag");
    const res = await mcp(tagOnly.access_token);
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toMatch(
      /error="insufficient_scope", scope="files:tag files:read"/,
    );
    const reader = await fullFlow();
    await db.withTenant(t.tenantId, (tx) => lockUser(tx, t.tenantId, ana.id, "user:admin"));
    const locked = await mcp(reader.access_token);
    expect(locked.status).toBe(401);
    expect(locked.headers.get("www-authenticate")).toMatch(/error="invalid_token"/);
    expect((await mcp("Basic abc")).status).toBe(401);
  });

  it("revokes what a client hands back, and answers the same for anything", async () => {
    const tokens = await fullFlow();
    const revoke = (token: string) => app.request(`${PUBLIC}/oauth/revoke`, form({ token }));
    expect((await revoke(tokens.refresh_token)).status).toBe(200);
    expect((await mcp(tokens.access_token)).status).toBe(401);
    expect((await revoke("nonsense")).status).toBe(200);
  });
});

describe("the sign-in page", () => {
  it("offers every provider when there are several, and goes straight to the only one", async () => {
    const one = await app.request(`${PUBLIC}/auth/sign-in?return_to=/x`);
    expect(one.headers.get("location")).toBe("/auth/login/dev?return_to=%2Fx");
    const two = createApp(
      ConfigSchema.parse({
        dataDir: "/tmp/unused",
        auth: {
          publicUrl: PUBLIC,
          providers: [
            { id: "dev", kind: "generic", tenantId: t.tenantId, issuer: idp.issuer, clientId: "a" },
            {
              id: "g",
              label: "Google <b>",
              kind: "google",
              tenantId: t.tenantId,
              issuer: "https://accounts.google.com",
              clientId: "b",
            },
          ],
        },
      }),
      undefined,
      { db },
    );
    const page = await two.request(`${PUBLIC}/auth/sign-in?return_to=//evil.example`);
    const html = await page.text();
    expect(html).toContain("/auth/login/g?return_to=%2F");
    expect(html).toContain("Google &lt;b&gt;");
    expect(page.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
  });
});

describe("client resolution", () => {
  it("registers public clients only, with safe redirect URIs", () => {
    expect(() => register({ redirect_uris: ["http://evil.example/cb"] })).toThrow(ClientError);
    expect(() => register({ redirect_uris: ["https://a.example/cb#x"] })).toThrow(ClientError);
    expect(() => register({ redirect_uris: [] })).toThrow(ClientError);
    expect(() =>
      register({
        redirect_uris: ["https://a.example/cb"],
        token_endpoint_auth_method: "client_secret_basic",
      }),
    ).toThrow(ClientError);
    const r = register({ redirect_uris: ["https://a.example/cb"], client_name: "A\u202eB\u0000" });
    expect(r.client_name).toBe("AB");
  });

  it("resolves metadata documents strictly and caches them", async () => {
    let fetched = 0;
    const docs: Record<string, unknown> = {
      "https://a.example/c.json": {
        client_id: "https://a.example/c.json",
        redirect_uris: ["https://a.example/cb"],
      },
      "https://b.example/c.json": {
        client_id: "https://other.example/c.json",
        redirect_uris: ["https://b.example/cb"],
      },
      "https://c.example/c.json": {
        client_id: "https://c.example/c.json",
        redirect_uris: ["https://c.example/cb"],
        token_endpoint_auth_method: "private_key_jwt",
      },
    };
    const resolver = new ClientResolver((url) => {
      fetched++;
      return Promise.resolve({ body: JSON.stringify(docs[url.href] ?? null), maxAgeSeconds: 60 });
    });
    const a = await resolver.resolve("https://a.example/c.json");
    expect(a).toMatchObject({
      kind: "cimd",
      name: "a.example",
      redirectUris: ["https://a.example/cb"],
    });
    await resolver.resolve("https://a.example/c.json");
    expect(fetched).toBe(1);
    await expect(resolver.resolve("https://b.example/c.json")).rejects.toThrow(/another client_id/);
    await expect(resolver.resolve("https://c.example/c.json")).rejects.toThrow(/public clients/);
    await expect(resolver.resolve("http://a.example/c.json")).rejects.toThrow(ClientError);
    await expect(resolver.resolve("https://a.example/")).rejects.toThrow(ClientError);
    expect(resolver.keyOf("https://a.example/c.json")).toEqual({
      clientKey: a.clientKey,
      clientRef: "https://a.example/c.json",
    });
    expect(resolver.keyOf(42)).toBeNull();
    // Only the exact encoding registration made: junk that decodes the same is another id.
    const dcr = String(register({ redirect_uris: ["https://a.example/cb"] }).client_id);
    expect(resolver.keyOf(dcr)).not.toBeNull();
    expect(resolver.keyOf(`${dcr}%00`)).toBeNull();
    expect(resolver.keyOf(`${dcr}.`)).toBeNull();
    for (const id of [
      "https://u:p@a.example/c.json",
      "https://a.example/x/../c.json",
      "https://[::1]/c.json",
      "https://A.example/c.json",
    ]) {
      await expect(resolver.resolve(id), id).rejects.toThrow(ClientError);
    }
    expect(matchRedirect(a, undefined)).toBeNull();
    expect(matchRedirect(a, "https://a.example/cb")).toBe("https://a.example/cb");
    expect(matchRedirect(a, "https://a.example/cb2")).toBeNull();
  });

  it("never fetches a metadata document from a private address", async () => {
    const { fetchMetadata } = await import("./oauth/clients.js");
    for (const url of [
      "https://127.0.0.1/c.json",
      "https://[::1]/c.json",
      "https://10.0.0.8/c.json",
      "https://localhost/c.json",
      "http://a.example/c.json",
    ]) {
      await expect(fetchMetadata(new URL(url)), url).rejects.toThrow(ClientError);
    }
  });

  it("lets one person have only two documents in flight", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const resolver = new ClientResolver(async (url) => {
      await gate;
      return {
        body: JSON.stringify({ client_id: url.href, redirect_uris: ["https://a.example/cb"] }),
      };
    });
    const a = resolver.resolve("https://a.example/1.json", "ana");
    const b = resolver.resolve("https://a.example/2.json", "ana");
    await expect(resolver.resolve("https://a.example/3.json", "ana")).rejects.toThrow(/too many/);
    const other = resolver.resolve("https://a.example/4.json", "bo");
    release();
    await Promise.all([a, b, other]);
    await resolver.resolve("https://a.example/5.json", "ana");
  });

  it("knows which addresses aren't public, IPv4 inside IPv6 too", () => {
    for (const a of [
      "::ffff:7f00:1",
      "::ffff:a00:1",
      "0:0:0:0:0:ffff:7f00:1",
      "::7f00:1",
      "fec0::1",
      "2002:7f00:1::",
      "64:ff9b::a00:1",
      "not-an-ip",
    ]) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of [
      "10.1.2.3",
      "127.0.0.1",
      "169.254.169.254",
      "192.168.0.1",
      "172.16.0.1",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
    ]) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ["8.8.8.8", "140.82.112.3", "2606:4700::1111"])
      expect(isPrivateAddress(a), a).toBe(false);
  });

  it("canonicalizes resource URIs", () => {
    expect(canonicalResource("HTTPS://Hoard.Example/mcp/")).toBe(RESOURCE);
    expect(canonicalResource("https://hoard.example/mcp#x")).toBeNull();
    expect(canonicalResource("nope")).toBeNull();
    // Trailing slashes go in linear time, however many; past 2,048 characters it isn't parsed.
    const started = performance.now();
    expect(canonicalResource(`${RESOURCE}${"/".repeat(2000)}`)).toBe(RESOURCE);
    expect(canonicalResource(`${RESOURCE}${"/".repeat(60_000)}`)).toBeNull();
    expect(canonicalResource(`${RESOURCE}${"/".repeat(60_000)}x`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
