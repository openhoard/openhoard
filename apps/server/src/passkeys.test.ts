import { exportAudit } from "@openhoard/core-audit";
import type { Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import {
  createUser,
  issueInvite,
  lockUser,
  parseUserHandle,
  type User,
} from "@openhoard/core-identity";
import { encodeCbor, SoftAuthenticator, type Bend } from "@openhoard/core-identity/testing";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { AuthEnv } from "./auth.js";
import { ConfigSchema } from "./config.js";
import { PASSKEY_SCRIPT } from "./oauth/pages.js";
import { mountPasskeys } from "./passkeys.js";

/*
 * Built-in accounts over HTTP (T-108): an invite makes a passkey and signs its person in; the
 * passkey signs them in afterwards, from anywhere the server is reached (a tunnel); and what
 * each request refuses.
 */

const PUBLIC = "https://files.example.com";

let db: Database;
let t: SeededTenant;
let steve: User;
let app: Hono<AuthEnv>;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  steve = await db.withTenant(t.tenantId, (tx) =>
    createUser(tx, t.tenantId, {
      email: "steve@example.com",
      displayName: "Steve",
      source: "local",
    }),
  );
  app = build();
});
afterEach(() => {
  vi.useRealTimers();
  return db?.close();
});

function build(auth: Record<string, unknown> = {}): Hono<AuthEnv> {
  const config = ConfigSchema.parse({
    dataDir: "/tmp/unused",
    auth: { publicUrl: PUBLIC, cookieKey: "k".repeat(43), passkeys: true, ...auth },
  });
  return createApp(config, undefined, { db });
}

const invite = async (userId = steve.id) =>
  (
    await db.withTenant(t.tenantId, (tx) =>
      issueInvite(tx, t.tenantId, { userId, by: "system:admin-cli" }),
    )
  ).token;

/** A browser: the cookies it holds, and requests as its pages on this origin send them. */
class Browser {
  readonly cookies = new Map<string, string>();
  async post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await app.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: PUBLIC,
        cookie: this.cookieHeader(),
        ...headers,
      },
      body: JSON.stringify(body),
    });
    this.keep(res);
    return res;
  }
  async request(path: string, method = "GET", headers: Record<string, string> = {}) {
    const res = await app.request(path, {
      method,
      headers: { cookie: this.cookieHeader(), origin: PUBLIC, ...headers },
    });
    this.keep(res);
    return res;
  }
  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  private keep(res: Response) {
    for (const set of res.headers.getSetCookie()) {
      const [pair] = set.split(";") as [string];
      const at = pair.indexOf("=");
      const [name, value] = [pair.slice(0, at), pair.slice(at + 1)];
      if (value === "" || /max-age=0/i.test(set)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  async me() {
    const res = await this.request("/auth/me");
    return res.status === 200 ? ((await res.json()) as { user: { id: string } }).user.id : null;
  }
}

/** The invite page's ceremony: options, the authenticator, the registration. */
async function accept(
  browser: Browser,
  token: string,
  device = new SoftAuthenticator(),
  bend: Bend = {},
) {
  const options = await browser.post("/auth/passkey/register/options", { invite: token });
  if (options.status !== 200) return options;
  const response = device.create((await options.json()) as Record<string, unknown>, PUBLIC, bend);
  return browser.post("/auth/passkey/register", { invite: token, name: "Phone", response });
}

/** The sign-in page's ceremony. */
async function signIn(browser: Browser, device: SoftAuthenticator, bend: Bend = {}, back?: string) {
  const options = await browser.post("/auth/passkey/options", {});
  const response = device.get((await options.json()) as Record<string, unknown>, PUBLIC, bend);
  return browser.post("/auth/passkey", {
    response,
    ...(back === undefined ? {} : { return_to: back }),
  });
}

async function enrolled() {
  const browser = new Browser();
  const device = new SoftAuthenticator();
  const res = await accept(browser, await invite(), device);
  expect(res.status).toBe(200);
  return { browser, device };
}

async function audit() {
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

describe("an invite", () => {
  it("makes a passkey, signs its person in, and works once", async () => {
    const token = await invite();
    const browser = new Browser();
    const page = await browser.request("/auth/invite");
    expect(page.status).toBe(200);
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("default-src 'none'");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const html = await page.text();
    expect(html).toContain('<script src="/auth/passkey.js" defer></script>');
    // The page is the same for everyone: the token is in the link's fragment, never sent here.
    expect(html).not.toContain("ohi.");
    const script = await browser.request("/auth/passkey.js");
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(await script.text()).toBe(PASSKEY_SCRIPT);

    const options = await browser.post("/auth/passkey/register/options", { invite: token });
    expect(options.status).toBe(200);
    expect(options.headers.get("cache-control")).toBe("no-store");
    const asked = (await options.clone().json()) as Record<string, unknown> & {
      user: { id: string };
      challenge: string;
    };
    expect(asked).toMatchObject({
      rp: { id: "files.example.com", name: "OpenHoard" },
      user: { name: "steve@example.com", displayName: "Steve" },
      attestation: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: [],
    });
    expect(parseUserHandle(asked.user.id)).toEqual({
      tenantId: t.tenantId,
      userId: steve.id,
    });
    // The challenge rides in a cookie only this path gets, sealed, for five minutes.
    const set = options.headers.getSetCookie().join("\n");
    expect(set).toMatch(
      /__Secure-oh_passkey_new=[^;]+; Max-Age=300; Path=\/auth\/passkey; HttpOnly; Secure; SameSite=Strict/,
    );
    expect(set).not.toContain(asked.challenge);

    const device = new SoftAuthenticator();
    const done = await browser.post("/auth/passkey/register", {
      invite: token,
      name: "Phone",
      response: device.create(asked, PUBLIC),
    });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ ok: true, passkey: { name: "Phone", synced: true } });
    expect(done.headers.getSetCookie().join("\n")).toMatch(
      /__Host-oh_session=ohs\.[^;]+; Max-Age=\d+; Path=\/; HttpOnly; Secure; SameSite=Lax/,
    );
    expect(browser.cookies.has("__Secure-oh_passkey_new")).toBe(false);
    expect(await browser.me()).toBe(steve.id);

    // The same link in another browser: told why, and nothing made.
    const second = await accept(new Browser(), token);
    expect([second.status, await second.json()]).toEqual([
      401,
      { error: "sign-in failed", reason: "used" },
    ]);
    // Someone who kept a ceremony from before it was used, answering it over and over: refused
    // each time, and in the audit log once.
    const late = new Browser();
    const fresh = await invite();
    const begun = await late.post("/auth/passkey/register/options", { invite: fresh });
    const cookie = late.cookieHeader();
    const answer = {
      invite: fresh,
      response: new SoftAuthenticator().create(
        (await begun.json()) as Record<string, unknown>,
        PUBLIC,
      ),
    };
    await invite(); // replaces `fresh`
    for (let i = 0; i < 3; i++) {
      const res = await new Browser().post("/auth/passkey/register", answer, { cookie });
      expect(res.status).toBe(401);
    }
    const listed = (await (await browser.request("/auth/passkeys")).json()) as {
      passkeys: object[];
    };
    expect(listed.passkeys).toHaveLength(1);
    expect(Object.keys(listed.passkeys[0] ?? {}).sort()).toEqual(
      ["createdAt", "id", "lastUsedAt", "name", "synced"].sort(),
    );

    const events = await audit();
    expect(events.map((e) => [e.action, e.decision, e.detail?.reason])).toEqual([
      ["passkey.register", "allow", undefined],
      ["auth.sign-in", "allow", undefined],
      ["passkey.register", "deny", "revoked"],
    ]);
    expect(events[1]).toMatchObject({
      actor: `user:${steve.id}`,
      detail: { provider: "passkey" },
    });
    // Neither the token nor anything of the key is in the audit log.
    expect(JSON.stringify(events)).not.toContain(token.split(".")[3]);
  });

  it("is refused from another site, without its challenge, or with another's", async () => {
    const token = await invite();
    const browser = new Browser();
    const device = new SoftAuthenticator();
    // Another site can't start or finish a ceremony, cookie or not.
    for (const headers of [{ origin: "https://evil.test" }, { origin: "null" }]) {
      const res = await browser.post("/auth/passkey/register/options", { invite: token }, headers);
      expect(res.status).toBe(403);
    }
    expect(
      (
        await browser.post(
          "/auth/passkey/register/options",
          { invite: token },
          { origin: "null", "sec-fetch-site": "same-origin" },
        )
      ).status,
    ).toBe(200);
    const options = await browser.post("/auth/passkey/register/options", { invite: token });
    const asked = (await options.json()) as Record<string, unknown>;
    const ceremonyCookie = browser.cookieHeader();

    // A registration with no ceremony under way in this browser.
    const stranger = new Browser();
    const noCookie = await stranger.post("/auth/passkey/register", {
      invite: token,
      response: device.create(asked, PUBLIC),
    });
    expect(noCookie.status).toBe(400);
    // A passkey that doesn't check out: refused, audited, and the challenge is spent.
    const bad = await browser.post("/auth/passkey/register", {
      invite: token,
      response: new SoftAuthenticator().create(asked, PUBLIC, { userVerified: false }),
    });
    expect([bad.status, await bad.json()]).toEqual([401, { error: "sign-in failed" }]);
    const spent = browser.cookieHeader();
    const again = await browser.post("/auth/passkey/register", {
      invite: token,
      response: new SoftAuthenticator().create(asked, PUBLIC),
    });
    expect(again.status).toBe(400);
    // Even with the cookie put back (a copied request): that challenge was answered.
    const copied = await new Browser().post(
      "/auth/passkey/register",
      { invite: token, response: new SoftAuthenticator().create(asked, PUBLIC) },
      { cookie: ceremonyCookie },
    );
    expect([copied.status, await copied.json()]).toEqual([401, { error: "sign-in failed" }]);
    expect(spent).not.toContain("oh_passkey_new");
    // A key padded past anything a key is: refused as a bad passkey, not an internal error.
    const padded = await accept(browser, token, new SoftAuthenticator(), {
      publicKey: encodeCbor(
        new Map<number, number | Buffer>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.alloc(32, 1)],
          [-3, Buffer.alloc(32, 2)],
          [99, Buffer.alloc(3000)],
        ]),
      ),
    });
    expect(padded.status).toBe(401);
    // A challenge issued for one invite doesn't serve another person's.
    const ana = await db.withTenant(t.tenantId, (tx) =>
      createUser(tx, t.tenantId, { email: "ana@example.com", displayName: "Ana", source: "local" }),
    );
    const anas = await invite(ana.id);
    const mine = await browser.post("/auth/passkey/register/options", { invite: token });
    const crossed = await browser.post("/auth/passkey/register", {
      invite: anas,
      response: new SoftAuthenticator().create(
        (await mine.json()) as Record<string, unknown>,
        PUBLIC,
      ),
    });
    expect(crossed.status).toBe(401);
    // Not JSON, not an object, no invite, a wrong secret.
    expect((await browser.post("/auth/passkey/register/options", [])).status).toBe(400);
    expect(
      (await browser.post("/auth/passkey/register/options", {}, { "content-type": "text/plain" }))
        .status,
    ).toBe(400);
    expect((await browser.post("/auth/passkey/register/options", { invite: "nope" })).status).toBe(
      401,
    );
    const wrong = await browser.post("/auth/passkey/register/options", {
      invite: `${token.slice(0, token.lastIndexOf("."))}.${"A".repeat(43)}`,
    });
    expect([wrong.status, await wrong.json()]).toEqual([401, { error: "sign-in failed" }]);
    expect(
      (await browser.post("/auth/passkey/register/options", { invite: "x".repeat(70000) })).status,
    ).toBe(413);

    // After all that the invite still works, and nobody was signed in meanwhile.
    expect(await browser.me()).toBeNull();
    expect(await stranger.me()).toBeNull();
    expect((await accept(browser, token)).status).toBe(200);
    expect(await browser.me()).toBe(steve.id);
    const events = await audit();
    expect(events.map((e) => [e.action, e.decision, e.detail?.reason, e.detail?.why])).toEqual([
      ["passkey.register", "deny", "invalid-passkey", "user-verification"],
      // (The copied request added nothing here.)
      ["passkey.register", "deny", "invalid-passkey", "key"],
      // (Ana's invite, answered with a challenge issued for Steve's: nothing of Ana's was touched.)
      ["passkey.register", "allow", undefined, undefined],
      ["auth.sign-in", "allow", undefined, undefined],
    ]);
  });

  it("stops with a lock, and expires with its challenge", async () => {
    const token = await invite();
    const browser = new Browser();
    const options = await browser.post("/auth/passkey/register/options", { invite: token });
    const asked = (await options.json()) as Record<string, unknown>;
    // Five minutes on, the ceremony is over.
    vi.useFakeTimers({ now: Date.now() + 301_000, toFake: ["Date"] });
    const late = await browser.post("/auth/passkey/register", {
      invite: token,
      response: new SoftAuthenticator().create(asked, PUBLIC),
    });
    expect(late.status).toBe(400);
    vi.useRealTimers();

    await db.withTenant(t.tenantId, (tx) => lockUser(tx, t.tenantId, steve.id, "user:admin"));
    const locked = await accept(browser, token);
    expect([locked.status, await locked.json()]).toEqual([
      401,
      { error: "sign-in failed", reason: "revoked" },
    ]);
  });
});

describe("a passkey", () => {
  it("signs its person in from the sign-in page, and returns them where they were going", async () => {
    const { device } = await enrolled();
    const browser = new Browser();
    const page = await browser.request("/auth/sign-in?return_to=/oauth/authorize%3Fx%3D1");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await page.text()).toContain(
      'id="oh-passkey" data-mode="sign-in" data-return="/oauth/authorize?x=1"',
    );

    const options = await browser.post("/auth/passkey/options", {});
    const asked = (await options.clone().json()) as Record<string, unknown>;
    expect(asked).toMatchObject({
      rpId: "files.example.com",
      userVerification: "required",
      allowCredentials: [],
    });
    const done = await signIn(browser, device, {}, "/oauth/authorize?x=1");
    expect([done.status, await done.json()]).toEqual([
      200,
      { ok: true, returnTo: "/oauth/authorize?x=1" },
    ]);
    expect(await browser.me()).toBe(steve.id);
    // Signed in: the sign-in page sends the browser straight back.
    const back = await browser.request("/auth/sign-in?return_to=/oauth/authorize%3Fx%3D1");
    expect([back.status, back.headers.get("location")]).toEqual([302, "/oauth/authorize?x=1"]);
    // Somewhere that isn't this server: home instead.
    const away = await signIn(new Browser(), device, {}, "https://evil.test/");
    expect(await away.json()).toEqual({ ok: true, returnTo: "/" });
  });

  it("is refused when the assertion doesn't hold, and each challenge serves once", async () => {
    const { device } = await enrolled();
    const browser = new Browser();
    for (const bend of [
      { wrongKey: true },
      { userVerified: false },
      { origin: "https://files.example.com.evil.test" },
      { userHandle: null },
      { userHandle: "bm9uc2Vuc2U" },
    ] satisfies Bend[]) {
      const res = await signIn(browser, device, bend);
      expect([res.status, await res.json()]).toEqual([401, { error: "sign-in failed" }]);
    }
    // A captured sign-in sent again, cookie and all: its challenge was answered, so it starts
    // no second session, however often it is sent.
    const options = await browser.post("/auth/passkey/options", {});
    const asked = (await options.json()) as Record<string, unknown>;
    const response = device.get(asked, PUBLIC);
    const kept = browser.cookieHeader();
    expect(kept).toContain("__Secure-oh_passkey_use=");
    expect((await browser.post("/auth/passkey", { response })).status).toBe(200);
    // The browser dropped the cookie: no ceremony.
    expect((await browser.post("/auth/passkey", { response })).status).toBe(400);
    for (const answer of [response, device.get(asked, PUBLIC)]) {
      const copied = await new Browser().post(
        "/auth/passkey",
        { response: answer },
        { cookie: kept },
      );
      expect([copied.status, copied.headers.getSetCookie().join()]).toEqual([
        401,
        expect.not.stringContaining("oh_session"),
      ]);
    }
    // Another browser's challenge isn't this assertion's.
    const other = new Browser();
    await other.post("/auth/passkey/options", {});
    expect((await other.post("/auth/passkey", { response })).status).toBe(401);
    // From another site: refused before anything is read.
    expect(
      (await browser.post("/auth/passkey/options", {}, { origin: "https://evil.test" })).status,
    ).toBe(403);
    expect(
      (await browser.post("/auth/passkey", { response }, { origin: "https://evil.test" })).status,
    ).toBe(403);

    const denied = (await audit()).filter(
      (e) => e.action === "auth.sign-in" && e.decision === "deny",
    );
    // Only assertions naming the real passkey are audited: the two bad handles are not.
    expect(denied.map((e) => [e.detail?.reason, e.detail?.why])).toEqual([
      ["invalid", "signature"],
      ["invalid", "user-verification"],
      ["invalid", "origin"],
      ["invalid", "challenge"],
    ]);
  });

  it("stops when its person is locked, at once", async () => {
    const { browser, device } = await enrolled();
    expect(await browser.me()).toBe(steve.id);
    await db.withTenant(t.tenantId, (tx) => lockUser(tx, t.tenantId, steve.id, "user:admin"));
    expect(await browser.me()).toBeNull();
    const res = await signIn(new Browser(), device);
    expect(res.status).toBe(401);
    expect((await audit()).at(-1)).toMatchObject({
      action: "auth.sign-in",
      decision: "deny",
      detail: { provider: "passkey", reason: "inactive" },
    });
  });

  it("is added by its signed-in person only with a recent sign-in, and removed with its sessions", async () => {
    const { browser, device } = await enrolled();
    const add = async (authenticator: SoftAuthenticator, who = browser) => {
      const options = await who.post("/auth/passkey/register/options", {});
      if (options.status !== 200) return options;
      return who.post("/auth/passkey/register", {
        name: "Key",
        response: authenticator.create((await options.json()) as Record<string, unknown>, PUBLIC),
      });
    };
    expect((await add(new SoftAuthenticator(), new Browser())).status).toBe(401);
    // The options name the passkey already held, so the same authenticator declines.
    await expect(add(device)).rejects.toThrow(/holds a passkey already/);
    const key = new SoftAuthenticator({ algorithm: -8, counter: true, backupEligible: false });
    const added = await add(key);
    expect(added.status).toBe(200);
    const { passkey } = (await added.json()) as { passkey: { id: string; synced: boolean } };
    expect(passkey.synced).toBe(false);

    // The second passkey signs in elsewhere; removing it ends that session and no other.
    const elsewhere = new Browser();
    expect((await signIn(elsewhere, key)).status).toBe(200);
    expect(
      (
        await elsewhere.request(`/auth/passkeys/${passkey.id}`, "DELETE", {
          origin: "https://evil.test",
        })
      ).status,
    ).toBe(403);
    expect((await new Browser().request(`/auth/passkeys/${passkey.id}`, "DELETE")).status).toBe(
      401,
    );
    expect(
      (await browser.request("/auth/passkeys/pky_00000000000000000000000000", "DELETE")).status,
    ).toBe(404);
    expect((await browser.request(`/auth/passkeys/${passkey.id}`, "DELETE")).status).toBe(204);
    expect(await elsewhere.me()).toBeNull();
    expect(await browser.me()).toBe(steve.id);
    expect((await signIn(new Browser(), key)).status).toBe(401);

    // Fifteen minutes on (auth.adminSignInMinutes), the session no longer adds passkeys.
    vi.useFakeTimers({ now: Date.now() + 16 * 60_000, toFake: ["Date"] });
    const stale = await add(new SoftAuthenticator());
    expect([stale.status, await stale.json()]).toEqual([
      403,
      { error: "sign in again to do this", signIn: "/auth/sign-in" },
    ]);
    // Nor removes them: an old session can't lock its person out.
    const mine = (await (await browser.request("/auth/passkeys")).json()) as {
      passkeys: { id: string }[];
    };
    const kept = await browser.request(`/auth/passkeys/${mine.passkeys[0]?.id}`, "DELETE");
    expect(kept.status).toBe(403);
    expect(await browser.me()).toBe(steve.id);
    vi.useRealTimers();

    const events = (await audit()).filter((e) => e.action.startsWith("passkey."));
    expect(events.map((e) => [e.action, e.decision])).toEqual([
      ["passkey.register", "allow"],
      ["passkey.register", "allow"],
      ["passkey.remove", "allow"],
    ]);
    expect(events[2]?.detail).toMatchObject({ passkey: passkey.id, sessionsEnded: 1 });
  });

  it("isn't for someone who signs in through an identity provider", async () => {
    const { browser } = await enrolled();
    // Steve becomes the identity provider's (an adoption, which only a migration could do).
    const { users } = await import("@openhoard/core-db");
    const { eq } = await import("drizzle-orm");
    await db.withTenant(t.tenantId, (tx) =>
      tx.update(users).set({ source: "scim", externalId: "ext-1" }).where(eq(users.id, steve.id)),
    );
    const res = await browser.post("/auth/passkey/register/options", {});
    expect(res.status).toBe(403);
  });
});

describe("configuration", () => {
  it("offers no passkey routes unless turned on, and keeps one provider's redirect", async () => {
    app = build({ passkeys: false });
    const browser = new Browser();
    expect((await browser.request("/auth/invite")).status).toBe(404);
    expect((await browser.request("/auth/passkey.js")).status).toBe(404);
    expect((await browser.post("/auth/passkey/options", {})).status).toBe(404);
    const page = await browser.request("/auth/sign-in");
    expect(page.headers.get("content-security-policy")).not.toContain("script-src");
    expect(await page.text()).toContain("No sign-in is configured.");

    const provider = {
      id: "entra",
      kind: "generic",
      tenantId: t.tenantId,
      issuer: "https://login.example.com",
      clientId: "abc",
    };
    app = build({ passkeys: false, providers: [provider] });
    expect((await browser.request("/auth/sign-in")).status).toBe(302);
    // With passkeys beside it, the page offers both.
    app = build({ providers: [provider] });
    const both = await (await browser.request("/auth/sign-in")).text();
    expect(both).toContain("Sign in with a passkey");
    expect(both).toContain("/auth/login/entra");
  });

  it("checks the origin and the size of all four ceremony requests, once, and of nothing else", async () => {
    // The routes on a bare app, with a same-origin check that counts its calls.
    const config = ConfigSchema.parse({
      dataDir: "/tmp/unused",
      auth: { publicUrl: PUBLIC, cookieKey: "k".repeat(43), passkeys: true },
    });
    if (!config.auth) throw new Error("no auth");
    let checks = 0;
    const bare = new Hono<AuthEnv>();
    mountPasskeys(bare, {
      auth: config.auth,
      db,
      key: Buffer.alloc(32, 1),
      sameOrigin: (origin) => {
        checks += 1;
        return origin === PUBLIC;
      },
      signedIn: async () => {},
      audit: async () => {},
      returnPath: () => "/",
    });
    const post = (path: string, body: unknown, origin = PUBLIC) =>
      bare.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify(body),
      });
    for (const path of [
      "/auth/passkey/register/options",
      "/auth/passkey/register",
      "/auth/passkey/options",
      "/auth/passkey",
    ]) {
      checks = 0;
      const elsewhere = await post(path, {}, "https://evil.test");
      expect([path, elsewhere.status, checks]).toEqual([path, 403, 1]);
      const big = await post(path, { x: "y".repeat(70_000) });
      expect([path, big.status]).toEqual([path, 413]);
      // Just under the limit, the body is still read whole (and then refused for what it is).
      checks = 0;
      const whole = await post(path, { x: "y".repeat(60_000) });
      expect([path, whole.status < 500 && whole.status !== 413, checks]).toEqual([path, true, 1]);
      // No Origin at all (not a browser's page): refused like another site's.
      const none = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect([path, none.status]).toEqual([path, 403]);
    }
    // The list, the script and the page are not ceremonies: no origin asked for.
    checks = 0;
    expect((await bare.request("/auth/passkeys")).status).toBe(401);
    expect((await bare.request("/auth/passkeys/pky_x", { method: "DELETE" })).status).toBe(401);
    expect((await bare.request("/auth/passkey.js")).status).toBe(200);
    expect((await bare.request("/auth/invite")).status).toBe(200);
    expect(checks).toBe(0);
  });

  it("needs a host name: a passkey can't belong to an address", () => {
    const parse = (publicUrl: string) =>
      ConfigSchema.safeParse({ dataDir: "/tmp/unused", auth: { publicUrl, passkeys: true } });
    expect(parse("https://files.example.com").success).toBe(true);
    expect(parse("http://localhost:7420").success).toBe(true);
    for (const url of ["http://127.0.0.1:7420", "http://[::1]:7420", "https://192.0.2.7"]) {
      const result = parse(url);
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain("passkeys belong to a host name");
    }
  });
});
