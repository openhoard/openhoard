import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEV_CLIENT,
  type DevClient,
  generateTenant,
  SCIM_ENTERPRISE_USER,
  scimList,
  scimSeed,
  startDevOidc,
  type DevOidc,
} from "../index.js";

const tenant = generateTenant({ items: 200 });
let idp: DevOidc;

beforeAll(async () => {
  idp = await startDevOidc({ tenant });
});
afterAll(async () => {
  await idp.close();
});

/** Follows the browser side of the flow by hand: manual redirects and a cookie jar. */
class Browser {
  private readonly jar = new Map<string, string>();

  async go(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: {
        ...(init.headers as Record<string, string>),
        cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "),
      },
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair = ""] = c.split(";");
      const at = pair.indexOf("=");
      this.jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return res;
  }
}

const b64url = (b: Buffer) => b.toString("base64url");

interface SignInOptions {
  provider?: DevOidc;
  client?: DevClient;
  /** Extra authorization request parameters, e.g. `{ prompt: "consent" }`. */
  params?: Record<string, string>;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
}

interface Tokens {
  id_token: string;
  access_token: string;
  refresh_token?: string;
}

/** Tokens are sent with Basic auth for confidential clients and client_id for public ones. */
function tokenRequest(discovery: Discovery, client: DevClient, body: Record<string, string>) {
  const basic = client.clientSecret
    ? {
        authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
      }
    : {};
  return fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...basic },
    body: new URLSearchParams(
      client.clientSecret ? body : { ...body, client_id: client.clientId },
    ).toString(),
  });
}

async function signIn(login: string, options: SignInOptions = {}) {
  const provider = options.provider ?? idp;
  const client = options.client ?? DEV_CLIENT;
  const redirect = client.redirectUris[0] as string;
  const discovery = (await (
    await fetch(`${provider.issuer}/.well-known/openid-configuration`)
  ).json()) as Discovery;
  const verifier = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(12));
  const auth = new URL(discovery.authorization_endpoint);
  auth.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirect,
    response_type: "code",
    scope: "openid email profile groups",
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    state: "st4te",
    nonce,
    ...options.params,
  }).toString();

  const browser = new Browser();
  const toLogin = await browser.go(auth.toString());
  const interaction = new URL(toLogin.headers.get("location") ?? "", provider.issuer).toString();
  const page = await browser.go(interaction);
  const html = await page.text();
  const csp = page.headers.get("content-security-policy") ?? "";
  const submitted = await browser.go(`${interaction}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ login }).toString(),
  });
  if (submitted.status >= 400) return { html, csp, error: await submitted.text() };
  let location = new URL(submitted.headers.get("location") ?? "", provider.issuer).toString();
  for (let hops = 0; !location.startsWith(redirect) && hops < 8; hops++) {
    const next = await browser.go(location);
    if (next.status >= 400) return { html, csp, error: await next.text() };
    location = new URL(next.headers.get("location") ?? "", provider.issuer).toString();
  }
  const callback = new URL(location);
  const tokenRes = await tokenRequest(discovery, client, {
    grant_type: "authorization_code",
    code: callback.searchParams.get("code") ?? "",
    redirect_uri: redirect,
    code_verifier: verifier,
  });
  if (!tokenRes.ok) return { html, csp, error: await tokenRes.text() };
  const tokens = (await tokenRes.json()) as Tokens;
  return { html, csp, callback, tokens, discovery, nonce, client };
}

describe("startDevOidc", () => {
  it("signs a seeded user in with authorization code + PKCE and issues verifiable tokens", async () => {
    const user = tenant.users.find((u) => u.active && !u.guest);
    if (!user) throw new Error("no active user");
    const r = await signIn(user.id);
    if (!r.tokens || !r.discovery) throw new Error(`sign-in failed: ${r.error}`);
    expect(r.callback.searchParams.get("state")).toBe("st4te");

    const { payload } = await jwtVerify(
      r.tokens.id_token,
      createRemoteJWKSet(new URL(r.discovery.jwks_uri)),
      {
        issuer: idp.issuer,
        audience: DEV_CLIENT.clientId,
      },
    );
    expect(payload).toMatchObject({
      sub: user.id,
      email: user.upn,
      name: user.displayName,
      nonce: r.nonce,
    });
    const groups = tenant.groups.filter((g) => g.members.includes(user.id)).map((g) => g.id);
    expect(payload.groups).toEqual(groups);

    const info = await fetch(r.discovery.userinfo_endpoint, {
      headers: { authorization: `Bearer ${r.tokens.access_token}` },
    });
    expect(await info.json()).toMatchObject({ sub: user.id, groups, guest: false });
  });

  it("issues refresh tokens that work", async () => {
    const user = tenant.users.find((u) => u.active && !u.guest);
    const r = await signIn(user?.id ?? "");
    if (!r.tokens?.refresh_token || !r.discovery || !r.client)
      throw new Error(`no refresh token: ${r.error}`);
    const res = await tokenRequest(r.discovery, r.client, {
      grant_type: "refresh_token",
      refresh_token: r.tokens.refresh_token,
    });
    expect(res.status).toBe(200);
    const refreshed = (await res.json()) as Tokens;
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.access_token).not.toBe(r.tokens.access_token);
  });

  it("grants consent automatically when the client asks for it", async () => {
    const user = tenant.users.find((u) => u.active && !u.guest);
    const r = await signIn(user?.id ?? "", {
      params: { prompt: "consent", scope: "openid email offline_access" },
    });
    expect(r.error).toBeUndefined();
    expect(r.tokens?.refresh_token).toBeTruthy();
  });

  it("accepts the sign-in name as well as the id, and marks guests without their company in family_name", async () => {
    const guest = tenant.users.find((u) => u.guest);
    if (!guest) throw new Error("no guest");
    const r = await signIn(guest.upn.toUpperCase());
    if (!r.tokens || !r.discovery) throw new Error(`sign-in failed: ${r.error}`);
    const { payload } = await jwtVerify(
      r.tokens.id_token,
      createRemoteJWKSet(new URL(r.discovery.jwks_uri)),
    );
    expect(payload).toMatchObject({ sub: guest.id, guest: true });
    expect(String(payload.family_name)).not.toContain("(");
  });

  it("refuses people who have left and unknown users", async () => {
    const departed = tenant.users.find((u) => !u.active);
    if (!departed) throw new Error("no departed user");
    for (const login of [departed.id, "nobody@hoard.test"]) {
      const r = await signIn(login);
      expect(r.error).toMatch(/unknown or disabled user/);
      expect(r.tokens).toBeUndefined();
    }
  });

  it("lists only active users on an escaped login page whose CSP allows the redirect back", async () => {
    const r = await signIn("nobody");
    const active = tenant.users.filter((u) => u.active);
    expect((r.html.match(/<option /g) ?? []).length).toBe(active.length);
    expect(r.html).not.toContain(tenant.users.find((u) => !u.active)?.upn);
    const ampersand = active.find((u) => u.displayName.includes("&"));
    if (!ampersand) throw new Error("fixture: no display name with &");
    expect(r.html).toContain(ampersand.displayName.replace(/&/g, "&#38;"));
    expect(r.html).not.toContain(ampersand.displayName);
    expect(r.csp).toContain("form-action 'self' http://127.0.0.1:7420 http://localhost:7420");
  });

  it("rejects unregistered redirect URIs", async () => {
    const url = `${idp.issuer}/auth?client_id=${DEV_CLIENT.clientId}&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&response_type=code&scope=openid&code_challenge=x&code_challenge_method=S256`;
    const res = await fetch(url, { redirect: "manual" });
    expect(res.status).toBe(400);
  });

  it("supports confidential clients end to end and rejects a GET to the login action", async () => {
    const svc: DevClient = {
      clientId: "svc",
      clientSecret: "s3cret",
      redirectUris: ["http://127.0.0.1:9/cb"],
    };
    const other = await startDevOidc({ tenant, clients: [svc] });
    try {
      const user = tenant.users.find((u) => u.active);
      const r = await signIn(user?.id ?? "", { provider: other, client: svc });
      expect(r.error).toBeUndefined();
      expect(r.tokens?.id_token).toBeTruthy();
      const wrong = await signIn(user?.id ?? "", {
        provider: other,
        client: { ...svc, clientSecret: "nope" },
      });
      expect(wrong.error).toMatch(/invalid_client/);
      expect((await fetch(`${other.issuer}/interaction/abc/login`)).status).toBe(400);
    } finally {
      await other.close();
    }
  });

  it("fails to start, rather than hanging, when the port is taken", async () => {
    const port = Number(new URL(idp.issuer).port);
    await expect(startDevOidc({ tenant, port })).rejects.toThrow(/EADDRINUSE/);
  });
});

describe("scimSeed", () => {
  it("emits RFC 7643 users and groups that reference each other", () => {
    const { users, groups } = scimSeed(tenant, "https://idp.test/scim/v2");
    expect(users).toHaveLength(tenant.users.length);
    const ids = new Set(users.map((u) => u.id));
    for (const g of groups) for (const m of g.members) expect(ids.has(m.value)).toBe(true);
    const member = users.find((u) => u.userType === "Member");
    expect(member?.[SCIM_ENTERPRISE_USER]?.department).toBeTruthy();
    const guest = users.find((u) => u.userType === "Guest");
    expect(guest?.schemas).toEqual(["urn:ietf:params:scim:schemas:core:2.0:User"]);
    expect(guest?.name.formatted).toContain("(");
    expect(users.some((u) => !u.active)).toBe(true);
  });

  it("pages list responses with a 1-based startIndex", () => {
    const { users } = scimSeed(tenant);
    const page = scimList(users, 3, 2);
    expect(page).toMatchObject({ totalResults: users.length, startIndex: 3, itemsPerPage: 2 });
    expect(page.Resources.map((u) => u.id)).toEqual(users.slice(2, 4).map((u) => u.id));
    expect(() => scimList(users, 0)).toThrow(RangeError);
  });
});
