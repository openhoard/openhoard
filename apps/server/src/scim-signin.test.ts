import { exportAudit } from "@openhoard/core-audit";
import type { Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { issueScimToken } from "@openhoard/core-identity";
import { generateTenant, startDevOidc, type DevOidc, type FakeUser } from "@openhoard/testkit";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { AuthEnv } from "./auth.js";
import { ConfigSchema } from "./config.js";

/*
 * T-102 and T-103 together, end to end: the identity provider provisions a person over SCIM
 * with its id for them as externalId (Entra's objectId), they sign in through OpenID Connect
 * and are matched by that id (the `oid` claim; the dev provider's `sub`), and when the provider
 * deactivates them over SCIM their session ends at once.
 */

const PUBLIC = "http://127.0.0.1:7420";
const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const fake = generateTenant({ items: 20 });
const person = fake.users.filter((u) => u.active && !u.guest)[0] as FakeUser;

let idp: DevOidc;
let db: Database;
let t: SeededTenant;
let app: Hono<AuthEnv>;
let token: string;

beforeAll(async () => {
  idp = await startDevOidc({
    tenant: fake,
    clients: [{ clientId: "openhoard-test", redirectUris: [`${PUBLIC}/auth/callback/dev`] }],
  });
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  token = (
    await db.withTenant(t.tenantId, (tx) =>
      issueScimToken(tx, t.tenantId, { name: "IdP", days: 30, by: "system:test" }),
    )
  ).token;
  app = createApp(
    ConfigSchema.parse({
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
            matchExternalId: true,
          },
        ],
      },
    }),
    undefined,
    { db },
  );
});
afterAll(async () => {
  await db?.close();
  await idp?.close();
});

const scim = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(`${PUBLIC}/scim/v2${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/scim+json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

/** A browser: a cookie jar, our server in-process, the provider over HTTP. */
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

  async signIn(login: string): Promise<Response> {
    const start = await this.go(`${PUBLIC}/auth/login/dev`);
    const toLogin = await this.go(start.headers.get("location") ?? "");
    const interaction = new URL(toLogin.headers.get("location") ?? "", idp.issuer).href;
    await this.go(interaction);
    const submitted = await this.go(`${interaction}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ login }).toString(),
    });
    let location = new URL(submitted.headers.get("location") ?? "", idp.issuer).href;
    for (let hops = 0; !location.startsWith(PUBLIC) && hops < 8; hops++) {
      const next = await this.go(location);
      location = new URL(next.headers.get("location") ?? "", idp.issuer).href;
    }
    return this.go(location);
  }
}

describe("SCIM provisioning and sign-in together", () => {
  it("signs in a SCIM-provisioned person by external id, and a SCIM deactivation ends it", async () => {
    // Provisioned as Entra would: userName the UPN, externalId the objectId (here, the dev
    // provider's subject for the person).
    const created = await scim("POST", "/Users", {
      schemas: [USER],
      userName: person.upn,
      externalId: person.id,
      displayName: person.displayName,
      emails: [{ value: person.upn, type: "work", primary: true }],
      active: true,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const userId = created.body.id as string;

    const browser = new Browser();
    const signedIn = await browser.signIn(person.upn);
    expect(signedIn.status).toBe(302);
    const me = await browser.go(`${PUBLIC}/auth/me`);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ user: { id: userId } });

    // The identity provider deactivates them: the session ends on the next request.
    const off = await scim("PATCH", `/Users/${userId}`, {
      schemas: [PATCH],
      Operations: [{ op: "Replace", path: "active", value: "False" }],
    });
    expect(off.body.active).toBe(false);
    expect((await browser.go(`${PUBLIC}/auth/me`)).status).toBe(401);
    // And they can't sign in again while deactivated.
    expect((await new Browser().signIn(person.upn)).status).toBe(401);

    // Reactivated, they sign in again, as the identity they linked the first time.
    await scim("PATCH", `/Users/${userId}`, {
      schemas: [PATCH],
      Operations: [{ op: "Replace", path: "active", value: "True" }],
    });
    const back = new Browser();
    expect((await back.signIn(person.upn)).status).toBe(302);
    expect((await back.go(`${PUBLIC}/auth/me`)).status).toBe(200);

    // Deleted upstream: retired, and out for good.
    expect(
      (
        await app.request(`${PUBLIC}/scim/v2/Users/${userId}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(204);
    expect((await back.go(`${PUBLIC}/auth/me`)).status).toBe(401);

    const lines: string[] = [];
    await exportAudit(db, t.tenantId, {}, "ndjson", (s: string) => void lines.push(s));
    const events = lines
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { actor: string; action: string; decision: string });
    expect(events.map((e) => `${e.action}:${e.decision}`)).toEqual([
      "scim.user.create:allow",
      "auth.sign-in:allow",
      "scim.user.patch:allow",
      "auth.sign-in:deny",
      "scim.user.patch:allow",
      "auth.sign-in:allow",
      "scim.user.delete:allow",
    ]);
  });
});
