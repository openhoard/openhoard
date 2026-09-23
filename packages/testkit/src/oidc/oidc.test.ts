import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEV_CLIENT,
  generateTenant,
  SCIM_ENTERPRISE_USER,
  scimList,
  scimSeed,
  startDevOidc,
  type DevOidc,
} from "../index.js";

const tenant = generateTenant({ items: 200 });
let idp: DevOidc;
const redirectUri = DEV_CLIENT.redirectUris[0] as string;

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

async function signIn(login: string) {
  const discovery = (await (
    await fetch(`${idp.issuer}/.well-known/openid-configuration`)
  ).json()) as {
    authorization_endpoint: string;
    token_endpoint: string;
    userinfo_endpoint: string;
    jwks_uri: string;
  };
  const verifier = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(12));
  const auth = new URL(discovery.authorization_endpoint);
  auth.search = new URLSearchParams({
    client_id: DEV_CLIENT.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile groups",
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    state: "st4te",
    nonce,
  }).toString();

  const browser = new Browser();
  const toLogin = await browser.go(auth.toString());
  const interaction = new URL(toLogin.headers.get("location") ?? "", idp.issuer).toString();
  const page = await browser.go(interaction);
  const html = await page.text();
  const submitted = await browser.go(`${interaction}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ login }).toString(),
  });
  if (submitted.status >= 400) return { html, error: await submitted.text() };
  let location = new URL(submitted.headers.get("location") ?? "", idp.issuer).toString();
  for (let hops = 0; !location.startsWith(redirectUri) && hops < 5; hops++) {
    const next = await browser.go(location);
    location = new URL(next.headers.get("location") ?? "", idp.issuer).toString();
  }
  const callback = new URL(location);
  const tokenRes = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code") ?? "",
      redirect_uri: redirectUri,
      client_id: DEV_CLIENT.clientId,
      code_verifier: verifier,
    }).toString(),
  });
  const tokens = (await tokenRes.json()) as { id_token: string; access_token: string };
  return { html, callback, tokens, discovery, nonce };
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

  it("accepts the sign-in name as well as the id, and marks guests", async () => {
    const guest = tenant.users.find((u) => u.guest);
    if (!guest) throw new Error("no guest");
    const r = await signIn(guest.upn.toUpperCase());
    if (!r.tokens || !r.discovery) throw new Error(`sign-in failed: ${r.error}`);
    const { payload } = await jwtVerify(
      r.tokens.id_token,
      createRemoteJWKSet(new URL(r.discovery.jwks_uri)),
    );
    expect(payload).toMatchObject({ sub: guest.id, guest: true });
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

  it("lists only active users on an escaped login page", async () => {
    const r = await signIn("nobody");
    const active = tenant.users.filter((u) => u.active);
    expect((r.html.match(/<option /g) ?? []).length).toBe(active.length);
    expect(r.html).not.toContain(tenant.users.find((u) => !u.active)?.upn);
    expect(r.html).toContain("&lt;");
  });

  it("rejects unregistered redirect URIs", async () => {
    const url = `${idp.issuer}/auth?client_id=${DEV_CLIENT.clientId}&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&response_type=code&scope=openid&code_challenge=x&code_challenge_method=S256`;
    const res = await fetch(url, { redirect: "manual" });
    expect(res.status).toBe(400);
  });

  it("supports confidential clients and rejects a GET to the login action", async () => {
    const other = await startDevOidc({
      tenant,
      clients: [{ clientId: "svc", clientSecret: "s3cret", redirectUris: ["http://127.0.0.1/cb"] }],
    });
    try {
      const d = (await (
        await fetch(`${other.issuer}/.well-known/openid-configuration`)
      ).json()) as { issuer: string };
      expect(d.issuer).toBe(other.issuer);
      const res = await fetch(`${other.issuer}/interaction/abc/login`);
      expect(res.status).toBe(400);
    } finally {
      await other.close();
    }
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
