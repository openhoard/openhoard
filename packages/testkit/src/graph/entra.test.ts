import { createPrivateKey, X509Certificate } from "node:crypto";
import { SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FakeEntra,
  FakeGraph,
  generateTenant,
  selfSignedCertificate,
  type FakeTenant,
  type TestCertificate,
} from "../index.js";

/*
 * The fake Entra token endpoint (T-302) refuses what Entra refuses, and the fake Graph applies
 * what its tokens say.
 */

const tenant: FakeTenant = generateTenant({ items: 120 });
const CLIENT = "11111111-2222-4333-8444-555555555555";
const GRAPH = "https://graph.test";
const TENANT_GUID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const TOKEN_URL = `https://login.test/${tenant.domain}/oauth2/v2.0/token`;
let cert: TestCertificate;
let entra: FakeEntra;
let now: number;

beforeAll(() => {
  cert = selfSignedCertificate();
});

beforeEach(() => {
  now = Date.parse("2026-10-02T12:00:00Z");
  entra = new FakeEntra(tenant, { graph: GRAPH, now: () => now, aliases: [TENANT_GUID] });
  entra.registerApp({
    clientId: CLIENT,
    secret: "secret",
    certificate: cert.certificate,
    appRoles: ["Sites.Selected"],
  });
});

interface Answer {
  status: number;
  body: Record<string, unknown> & { error_codes?: number[] };
  headers: Headers;
}
async function ask(form: Record<string, string>, url = TOKEN_URL, type?: string): Promise<Answer> {
  const res = await entra.fetch(url, {
    method: "POST",
    headers: { "content-type": type ?? "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  return {
    status: res.status,
    body: (await res.json()) as Answer["body"],
    headers: res.headers,
  };
}
const app = (over: Record<string, string> = {}) => ({
  grant_type: "client_credentials",
  client_id: CLIENT,
  client_secret: "secret",
  scope: `${GRAPH}/.default`,
  ...over,
});
/** A client assertion as an app would sign it, with whatever is wrong with it. */
async function assertion(
  over: {
    alg?: string;
    thumbprint?: string;
    aud?: string;
    iss?: string;
    life?: number;
    jti?: string | null;
    key?: string;
    nbf?: boolean;
  } = {},
): Promise<string> {
  const x509 = new X509Certificate(cert.certificate);
  const seconds = Math.floor(now / 1000);
  const jwt = new SignJWT({})
    .setProtectedHeader({
      alg: over.alg ?? "PS256",
      typ: "JWT",
      "x5t#S256":
        over.thumbprint ??
        Buffer.from(x509.fingerprint256.replaceAll(":", ""), "hex").toString("base64url"),
    })
    .setAudience(over.aud ?? TOKEN_URL)
    .setIssuer(over.iss ?? CLIENT)
    .setSubject(over.iss ?? CLIENT)
    .setIssuedAt(seconds)
    .setExpirationTime(seconds + (over.life ?? 300));
  if (over.nbf !== false) jwt.setNotBefore(seconds);
  if (over.jti !== null) jwt.setJti(over.jti ?? crypto.randomUUID());
  return jwt.sign(createPrivateKey(over.key ?? cert.privateKey));
}
const withCert = async (over: Parameters<typeof assertion>[0] = {}) => {
  const { client_secret: _dropped, ...rest } = app();
  return {
    ...rest,
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: await assertion(over),
  };
};

describe("the client credentials grant", () => {
  it("issues an app-only token Graph's side can verify, for a secret or a certificate", async () => {
    const bySecret = await ask(app());
    expect(bySecret.status).toBe(200);
    expect(bySecret.body).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(bySecret.headers.get("cache-control")).toBe("no-store");
    expect(await entra.verify(bySecret.body.access_token as string)).toEqual({
      appId: CLIENT,
      roles: ["Sites.Selected"],
      certificate: false,
    });
    const byCert = await ask(await withCert());
    expect(byCert.status).toBe(200);
    // (SharePoint's REST API takes only an app that signed in with a certificate.)
    expect(await entra.verify(byCert.body.access_token as string)).toMatchObject({
      certificate: true,
    });
    // The tenant's id works as its domain does, and so does a name it was given.
    expect((await ask(app(), TOKEN_URL.replace(tenant.domain, tenant.id))).status).toBe(200);
    expect((await ask(app(), TOKEN_URL.replace(tenant.domain, TENANT_GUID))).status).toBe(200);
    expect(entra.requests.map((r) => r.auth)).toEqual([
      "secret",
      "certificate",
      "secret",
      "secret",
    ]);
  });

  it("refuses with Entra's errors and codes", async () => {
    const codes = async (form: Record<string, string>, url?: string, type?: string) => {
      const a = await ask(form, url, type);
      return [a.status, a.body.error, a.body.error_codes?.[0]];
    };
    expect(await codes(app({ client_secret: "wrong" }))).toEqual([401, "invalid_client", 7000215]);
    expect(await codes(app({ client_secret: "" }))).toEqual([401, "invalid_client", 7000218]);
    expect(await codes(app({ client_id: "22222222-2222-4333-8444-555555555555" }))).toEqual([
      400,
      "unauthorized_client",
      700016,
    ]);
    expect(await codes(app(), TOKEN_URL.replace(tenant.domain, "elsewhere.test"))).toEqual([
      400,
      "invalid_request",
      90002,
    ]);
    expect(await codes(app({ scope: `${GRAPH}/Sites.Selected` }))).toEqual([
      400,
      "invalid_scope",
      1002012,
    ]);
    expect(await codes(app({ scope: "https://other.test/.default" }))).toEqual([
      400,
      "invalid_resource",
      500011,
    ]);
    expect(await codes(app({ scope: "" }))).toEqual([400, "invalid_request", 900144]);
    expect(await codes(app({ grant_type: "password" }))).toEqual([
      400,
      "unsupported_grant_type",
      70003,
    ]);
    expect(await codes(app(), TOKEN_URL, "application/json")).toEqual([
      400,
      "invalid_request",
      900144,
    ]);
    const refused = await ask(app({ client_secret: "wrong" }));
    expect(refused.body.error_description).toMatch(/^AADSTS7000215: .*\r\nTrace ID: /s);
    expect(refused.body.timestamp).toBe("2026-10-02 12:00:00Z");
    // One way of proving who is asking, not two.
    expect(await codes({ ...(await withCert()), client_secret: "secret" })).toEqual([
      400,
      "invalid_request",
      7000219,
    ]);
    expect((await entra.fetch("/nowhere")).status).toBe(404);
    // An app registered with a certificate only has no secret to match.
    entra.registerApp({ clientId: CLIENT, certificate: cert.certificate });
    expect(await codes(app())).toEqual([401, "invalid_client", 7000215]);
  });

  it("checks a certificate assertion as Entra's documentation describes it", async () => {
    const refusedFor = async (over: Parameters<typeof assertion>[0]) => {
      const a = await ask(await withCert(over));
      return [a.status, a.body.error_codes?.[0]];
    };
    const other = selfSignedCertificate();
    expect(await refusedFor({ key: other.privateKey })).toEqual([401, 700027]);
    expect(await refusedFor({ thumbprint: "AAAA" })).toEqual([401, 700027]);
    expect(await refusedFor({ alg: "RS256" })).toEqual([401, 700027]);
    expect(await refusedFor({ aud: "https://login.test/other/oauth2/v2.0/token" })).toEqual([
      401, 700027,
    ]);
    expect(await refusedFor({ iss: "someone-else" })).toEqual([401, 700027]);
    expect(await refusedFor({ life: 3600 })).toEqual([401, 700027]);
    expect(await refusedFor({ life: -600 })).toEqual([401, 700027]);
    expect(await refusedFor({ jti: null })).toEqual([401, 700027]);
    expect(await refusedFor({ nbf: false })).toEqual([401, 700027]);
    // Used once: the same assertion again is refused.
    expect(await refusedFor({ jti: "once" })).toEqual([200, undefined]);
    expect(await refusedFor({ jti: "once" })).toEqual([401, 700025]);
    const noType = await withCert();
    expect((await ask({ ...noType, client_assertion_type: "jwt" })).body.error).toBe(
      "invalid_request",
    );
    entra.registerApp({ clientId: CLIENT, secret: "secret" });
    expect(await refusedFor({})).toEqual([401, 700027]);
  });

  it("fails as told, with a Retry-After when given one", async () => {
    entra.failNext(429, 1, 9);
    entra.failNext(503);
    const throttled = await ask(app());
    expect([throttled.status, throttled.headers.get("retry-after")]).toEqual([429, "9"]);
    const down = await ask(app());
    expect([down.status, down.body.error, down.headers.get("retry-after")]).toEqual([
      503,
      "temporarily_unavailable",
      null,
    ]);
    expect((await ask(app())).status).toBe(200);
  });
});

describe("its tokens", () => {
  it("lapse, and are nobody else's", async () => {
    const token = (await ask(app())).body.access_token as string;
    expect(await entra.verify(token)).toBeDefined();
    now += 3_601_000;
    expect(await entra.verify(token)).toBeUndefined();
    expect(await entra.verify("fake-graph-token")).toBeUndefined();
    const other = new FakeEntra(tenant, { graph: GRAPH });
    other.registerApp({ clientId: CLIENT, secret: "secret" });
    const res = await other.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(app()).toString(),
    });
    const foreign = ((await res.json()) as { access_token: string }).access_token;
    expect(await entra.verify(foreign)).toBeUndefined();
  });

  it("are served over HTTP too", async () => {
    const served = await entra.listen();
    try {
      const res = await fetch(`${served.url}/${tenant.domain}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(app()).toString(),
      });
      expect(res.status).toBe(200);
    } finally {
      await served.close();
    }
  });
});

describe("the fake Graph with a fake Entra", () => {
  const get = (graph: FakeGraph, path: string, token: string) =>
    graph.fetch(path, { headers: { authorization: `Bearer ${token}` } });

  it("applies Sites.Selected site by site, and refuses other tokens", async () => {
    const graph = new FakeGraph(tenant, { entra, now: () => now });
    const [granted, other] = [tenant.sites[0], tenant.sites[1]] as [
      (typeof tenant.sites)[0],
      (typeof tenant.sites)[0],
    ];
    entra.grantSite(CLIENT, granted.id);
    expect(entra.siteRole(CLIENT, granted.id)).toBe("read");
    const token = (await ask(app())).body.access_token as string;
    expect((await get(graph, `/v1.0/sites/${granted.id}`, token)).status).toBe(200);
    expect((await get(graph, `/v1.0/sites/${granted.id}/drive`, token)).status).toBe(200);
    expect((await get(graph, `/v1.0/drives/${granted.driveId}`, token)).status).toBe(200);
    expect((await get(graph, `/v1.0/drives/${granted.driveId}/root/delta`, token)).status).toBe(
      200,
    );
    expect((await get(graph, `/v1.0/sites/${other.id}`, token)).status).toBe(403);
    expect((await get(graph, `/v1.0/drives/${other.driveId}/root/children`, token)).status).toBe(
      403,
    );
    expect((await get(graph, "/v1.0/sites", token)).status).toBe(403);
    expect((await get(graph, "/v1.0/sites/s-nowhere", token)).status).toBe(404);
    expect((await get(graph, "/v1.0/me", token)).status).toBe(400);
    // The fixed token of a Graph without Entra is not a token here; nor is none.
    expect((await get(graph, `/v1.0/sites/${granted.id}`, "fake-graph-token")).status).toBe(401);
    expect((await graph.fetch(`/v1.0/sites/${granted.id}`)).status).toBe(401);
    // By host and path, as an admin writes a site.
    const named = (s: { webUrl: string }) =>
      `/v1.0/sites/${new URL(s.webUrl).host}:${new URL(s.webUrl).pathname}`;
    const byPath = await get(graph, named(granted), token);
    expect([byPath.status, ((await byPath.json()) as { id: string }).id]).toEqual([
      200,
      granted.id,
    ]);
    expect((await get(graph, `${named(granted)}/`, token)).status).toBe(200);
    expect((await get(graph, named(other), token)).status).toBe(403);
    expect((await get(graph, `${named(granted)}-none`, token)).status).toBe(404);
    expect((await get(graph, `${named(granted)}/%E0%A4%A`, token)).status).toBe(400);
    entra.revokeSite(CLIENT, granted.id);
    expect((await get(graph, `/v1.0/sites/${granted.id}`, token)).status).toBe(403);
  });

  it("gives an app its own subscriptions, on drives it reaches", async () => {
    const graph = new FakeGraph(tenant, {
      entra,
      now: () => now,
      notify: (url) =>
        Promise.resolve(new Response(new URL(url).searchParams.get("validationToken"))),
    });
    const [granted, other] = [tenant.sites[0], tenant.sites[1]] as [
      (typeof tenant.sites)[0],
      (typeof tenant.sites)[0],
    ];
    entra.grantSite(CLIENT, granted.id);
    const OTHER_APP = "22222222-2222-4333-8444-555555555555";
    entra.registerApp({ clientId: OTHER_APP, secret: "secret", appRoles: ["Sites.Read.All"] });
    const mine = (await ask(app())).body.access_token as string;
    const theirs = (await ask(app({ client_id: OTHER_APP }))).body.access_token as string;
    const subscribe = (token: string, drive: string) =>
      graph.fetch("/v1.0/subscriptions", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          changeType: "updated",
          notificationUrl: "https://hook.test/n",
          resource: `/drives/${drive}/root`,
          expirationDateTime: new Date(now + 3_600_000).toISOString(),
        }),
      });
    expect((await subscribe(mine, other.driveId)).status).toBe(403);
    const made = await subscribe(mine, granted.driveId);
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as { id: string };
    const list = async (token: string) =>
      ((await (await get(graph, "/v1.0/subscriptions", token)).json()) as { value: unknown[] })
        .value.length;
    expect([await list(mine), await list(theirs)]).toEqual([1, 0]);
    expect((await get(graph, `/v1.0/subscriptions/${id}`, theirs)).status).toBe(404);
    const change = (token: string, method: string) =>
      graph.fetch(`/v1.0/subscriptions/${id}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ expirationDateTime: new Date(now + 7_200_000).toISOString() }),
      });
    expect((await change(theirs, "PATCH")).status).toBe(404);
    expect((await change(theirs, "DELETE")).status).toBe(404);
    expect((await change(mine, "PATCH")).status).toBe(200);
    expect((await get(graph, `/v1.0/subscriptions/${id}`, mine)).status).toBe(200);
    expect((await change(mine, "DELETE")).status).toBe(204);
    expect(await list(mine)).toBe(0);
  });

  it("lets a tenant-wide permission list and reach every site", async () => {
    entra.registerApp({ clientId: CLIENT, secret: "secret", appRoles: ["Sites.Read.All"] });
    const graph = new FakeGraph(tenant, { entra, now: () => now });
    const token = (await ask(app())).body.access_token as string;
    const listed = (await (await get(graph, "/v1.0/sites", token)).json()) as { value: unknown[] };
    expect(listed.value).toHaveLength(tenant.sites.length);
  });
});

describe("a test certificate", () => {
  it("is a self-signed X.509 certificate whose key signs for it", () => {
    const made = selfSignedCertificate({ commonName: "tëst", days: 400 });
    const x509 = new X509Certificate(made.certificate);
    expect(x509.subject).toBe("CN=tëst");
    expect(x509.verify(x509.publicKey)).toBe(true);
    expect(x509.checkPrivateKey(createPrivateKey(made.privateKey))).toBe(true);
    expect(Date.parse(x509.validTo) - Date.parse(x509.validFrom)).toBe(400 * 86_400_000);
    expect(new X509Certificate(selfSignedCertificate().certificate).serialNumber).not.toBe(
      x509.serialNumber,
    );
    // Its dates are written with two-digit years: outside their range is refused, not wrapped.
    expect(() => selfSignedCertificate({ days: 36_500 })).toThrow(RangeError);
    expect(() => selfSignedCertificate({ from: new Date("1949-06-01T00:00:00Z") })).toThrow(
      RangeError,
    );
  });
});
