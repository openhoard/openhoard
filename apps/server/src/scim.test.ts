import { exportAudit } from "@openhoard/core-audit";
import { newId, type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { createHash, randomBytes } from "node:crypto";
import {
  checkAccessToken,
  createServiceAccount,
  decideClient,
  getUser,
  issueCode,
  issueScimToken,
  listScimTokens,
  lockUser,
  noteClient,
  redeemCode,
  resolvePrincipal,
  revokeScimToken,
} from "@openhoard/core-identity";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { AuthEnv } from "./auth.js";
import { ConfigSchema } from "./config.js";
import { FailureLimiter } from "./scim/limiter.js";

/*
 * T-103: a SCIM 2.0 compliance suite, modelled on the Microsoft SCIM validator's cases and the
 * RFC 7644 examples, with Entra's own request shapes (learn.microsoft.com, "Tutorial: Develop
 * and plan provisioning for a SCIM endpoint" and "Known issues and resolutions with SCIM 2.0
 * protocol compliance").
 */

const ORIGIN = "http://127.0.0.1:7420";
const BASE = `${ORIGIN}/scim/v2`;
const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const ENTERPRISE = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
const LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";

type Json = Record<string, unknown>;

let db: Database;
let t: SeededTenant;
let other: SeededTenant;
let token: string;
let tokenId: string;
let app: Hono<AuthEnv>;

const config = () => ConfigSchema.parse({ dataDir: "/tmp/unused" });
const issue = (tenantId = t.tenantId, lifetimeMs = 30 * 24 * 3600 * 1000) =>
  db.withTenant(tenantId, (tx) =>
    issueScimToken(tx, tenantId, {
      name: "Entra",
      expiresAt: new Date(Date.now() + lifetimeMs),
      by: "system:test",
    }),
  );

beforeAll(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  other = await seedTenant(db, 2);
  ({ token, id: tokenId } = await issue());
  app = createApp(config(), undefined, { db, scim: { maxFailures: 10_000 } });
});
afterAll(() => db?.close());

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  on: Hono<AuthEnv> = app,
): Promise<{ status: number; body: Json; headers: Headers }> {
  const res = await on.request(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/scim+json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text === "" ? {} : (JSON.parse(text) as Json),
    headers: res.headers,
  };
}

let n = 0;
/** An Entra-shaped user (the create request from Microsoft's tutorial). */
function entraUser(more: Json = {}): Json {
  n++;
  return {
    schemas: [USER, ENTERPRISE],
    externalId: `oid-${n}-${Math.random().toString(36).slice(2)}`,
    userName: `Test_User_${n}@contoso.example`,
    active: true,
    emails: [
      { primary: true, type: "work", value: `test.user.${n}@contoso.example` },
      { type: "other", value: `alias.${n}@contoso.example` },
    ],
    // Entra's other default mappings: accepted and dropped.
    title: "Analyst",
    preferredLanguage: "en-US",
    phoneNumbers: [{ type: "mobile", value: "+1 555 0100" }],
    addresses: [{ type: "work", streetAddress: "1 Main St", postalCode: "12345" }],
    password: "never-kept",
    meta: { resourceType: "User" },
    name: { formatted: `Given${n} Family${n}`, familyName: `Family${n}`, givenName: `Given${n}` },
    roles: [],
    [ENTERPRISE]: { department: "Finance", employeeNumber: "42" },
    ...more,
  };
}

async function createUser(more: Json = {}): Promise<Json> {
  const res = await call("POST", "/Users", entraUser(more));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function auditEvents(tenantId = t.tenantId) {
  const lines: string[] = [];
  await exportAudit(db, tenantId, {}, "ndjson", (s: string) => void lines.push(s));
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

const expectError = (res: { status: number; body: Json }, status: number, scimType?: string) => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(res.body).toMatchObject({ schemas: [ERROR], status: String(status) });
  if (scimType) expect(res.body.scimType).toBe(scimType);
  expect(typeof res.body.detail).toBe("string");
};

describe("SCIM users", () => {
  it("creates a user: 201, Location, the resource, application/scim+json", async () => {
    const sent = entraUser();
    const res = await call("POST", "/Users", sent);
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("application/scim+json");
    const id = res.body.id as string;
    expect(id).toMatch(/^usr_/);
    expect(res.headers.get("location")).toBe(`${BASE}/Users/${id}`);
    expect(res.body).toEqual({
      schemas: [USER],
      id,
      externalId: sent.externalId,
      userName: sent.userName,
      name: {
        givenName: (sent.name as Json).givenName,
        familyName: (sent.name as Json).familyName,
        formatted: (sent.name as Json).formatted,
      },
      displayName: (sent.name as Json).formatted,
      emails: [{ value: (sent.emails as Json[])[0]?.value, type: "work", primary: true }],
      userType: "Member",
      active: true,
      meta: { resourceType: "User", created: expect.any(String), location: `${BASE}/Users/${id}` },
    });
    // It is an OpenHoard SCIM user, with nothing of the enterprise extension kept.
    const stored = await db.withTenant(t.tenantId, (tx) => getUser(tx, t.tenantId, id));
    expect(stored).toMatchObject({
      source: "scim",
      email: (sent.emails as Json[])[0]?.value,
      externalId: sent.externalId,
      userName: sent.userName,
      kind: "member",
      active: true,
    });
    const got = await call("GET", `/Users/${id}`);
    expect(got.status).toBe(200);
    expect(got.body).toEqual(res.body);
  });

  it("refuses a second user with the same userName (in any case) or externalId: 409", async () => {
    const first = await createUser();
    const dupName = await call(
      "POST",
      "/Users",
      entraUser({ userName: (first.userName as string).toUpperCase() }),
    );
    expectError(dupName, 409, "uniqueness");
    const dupExternal = await call("POST", "/Users", entraUser({ externalId: first.externalId }));
    expectError(dupExternal, 409, "uniqueness");
  });

  it("never adopts a local user: the same email is a 409 and the local user stays local", async () => {
    const res = await call(
      "POST",
      "/Users",
      entraUser({ userName: "ana-1@example.com", emails: undefined }),
    );
    expectError(res, 409, "uniqueness");
    expect(JSON.stringify(res.body)).not.toContain(t.userId);
    const local = await db.withTenant(t.tenantId, (tx) => getUser(tx, t.tenantId, t.userId));
    expect(local).toMatchObject({ source: "local", externalId: null, userName: null });
    // Nor can SCIM read or change it.
    expectError(await call("GET", `/Users/${t.userId}`), 404);
    expectError(
      await call("PATCH", `/Users/${t.userId}`, {
        schemas: [PATCH],
        Operations: [{ op: "replace", path: "active", value: false }],
      }),
      404,
    );
    expectError(await call("DELETE", `/Users/${t.userId}`), 404);
  });

  it("derives email and displayName: emails, else an email userName; displayName, else name", async () => {
    const plain = await createUser({
      userName: `plain.${n}@contoso.example`,
      emails: undefined,
      name: { givenName: "Ada", familyName: "Byron" },
      displayName: undefined,
    });
    expect(plain.emails).toEqual([{ value: plain.userName, type: "work", primary: true }]);
    expect(plain.displayName).toBe("Ada Byron");
    const bare = await createUser({ name: undefined, displayName: undefined });
    expect(bare.displayName).toBe(bare.userName);
    // A work email among others, none primary.
    const work = await createUser({
      emails: [
        { type: "home", value: "home@example.net" },
        { type: "work", value: "work.only@contoso.example" },
      ],
    });
    expect((work.emails as Json[])[0]?.value).toBe("work.only@contoso.example");
    // No email at all: refused, saying what to send.
    const none = await call(
      "POST",
      "/Users",
      entraUser({ userName: "no-email", emails: undefined }),
    );
    expectError(none, 400, "invalidValue");
    expect(none.body.detail).toMatch(/needs an email/);
  });

  it("refuses what isn't a user: no userName, wrong types, no schemas, bad JSON, wrong type", async () => {
    expectError(
      await call("POST", "/Users", entraUser({ userName: undefined })),
      400,
      "invalidValue",
    );
    expectError(await call("POST", "/Users", entraUser({ userName: 5 })), 400, "invalidValue");
    expectError(await call("POST", "/Users", entraUser({ active: "maybe" })), 400, "invalidValue");
    expectError(
      await call("POST", "/Users", entraUser({ userType: "Admin" })),
      400,
      "invalidValue",
    );
    expectError(await call("POST", "/Users", entraUser({ name: "Ada" })), 400, "invalidValue");
    expectError(
      await call("POST", "/Users", entraUser({ emails: ["x@y.z"] })),
      400,
      "invalidValue",
    );
    expectError(
      await call("POST", "/Users", entraUser({ schemas: [GROUP] })),
      400,
      "invalidSyntax",
    );
    expectError(await call("POST", "/Users", "{not json"), 400, "invalidSyntax");
    expectError(await call("POST", "/Users", "[1]"), 400, "invalidSyntax");
    expectError(await call("POST", "/Users", entraUser(), { "content-type": "text/plain" }), 415);
    expectError(
      await call("POST", "/Users", entraUser({ displayName: "x".repeat(300) })),
      400,
      "invalidValue",
    );
    // application/json is fine too.
    const json = await call("POST", "/Users", entraUser(), {
      "content-type": "application/json; charset=utf-8",
    });
    expect(json.status).toBe(201);
  });

  it("makes a Guest a guest, and a guest a member again", async () => {
    const guest = await createUser({ userType: "Guest" });
    expect(guest.userType).toBe("Guest");
    const principal = await db.withTenant(t.tenantId, (tx) =>
      resolvePrincipal(tx, t.tenantId, guest.id as string),
    );
    expect(principal?.guest).toBe(true);
    const member = await call("PATCH", `/Users/${String(guest.id)}`, {
      schemas: [PATCH],
      Operations: [{ op: "Replace", path: "userType", value: "Member" }],
    });
    expect(member.body.userType).toBe("Member");
  });

  it("finds users by userName (any case), externalId, email and id; nobody is an empty list", async () => {
    const u = await createUser();
    const find = async (filter: string) => {
      const res = await call("GET", `/Users?filter=${encodeURIComponent(filter)}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.schemas).toEqual([LIST]);
      return res.body as { totalResults: number; Resources: Json[]; itemsPerPage: number };
    };
    const one = async (filter: string) => {
      const found = await find(filter);
      expect(found.totalResults, filter).toBe(1);
      expect(found.Resources[0]?.id, filter).toBe(u.id);
    };
    await one(`userName eq "${(u.userName as string).toUpperCase()}"`);
    await one(`USERNAME EQ "${String(u.userName)}"`);
    await one(`${USER}:userName eq "${String(u.userName)}"`);
    await one(`externalId eq "${String(u.externalId)}"`);
    await one(`id eq "${String(u.id)}"`);
    const email = (u.emails as Json[])[0]?.value as string;
    await one(`emails[type eq "work"].value eq "${email.toUpperCase()}"`);
    await one(`emails.value eq "${email}"`);
    await one(`emails eq "${email}"`);
    await one(`displayName eq "${String(u.displayName)}" and active eq true`);
    await one(`userName eq "${String(u.userName)}" and externalId eq "${String(u.externalId)}"`);
    // externalId is case-exact (RFC 7643).
    expect(
      (await find(`externalId eq "${(u.externalId as string).toUpperCase()}"`)).totalResults,
    ).toBe(0);
    // Entra's Test Connection: a random userName, expecting 200 and nobody.
    const nobody = await find(`userName eq "${crypto.randomUUID()}"`);
    expect(nobody).toMatchObject({
      totalResults: 0,
      Resources: [],
      startIndex: 1,
      itemsPerPage: 0,
    });
    expect((await find(`emails[type eq "home"].value eq "${email}"`)).totalResults).toBe(0);
    expect((await find(`userName eq "a" and userName eq "b"`)).totalResults).toBe(0);
    expect((await find(`emails eq "not an address"`)).totalResults).toBe(0);
  });

  it("refuses filters it can't answer: 400 invalidFilter", async () => {
    for (const filter of [
      'userName sw "Test"',
      'userName eq "a" or userName eq "b"',
      'not (userName eq "a")',
      "userName pr",
      'title eq "Boss"',
      `${ENTERPRISE}:department eq "Finance"`,
      "userName eq 5",
      'active eq "true"',
      'emails[value sw "a"].value eq "x"',
      'name[givenName eq "a"] eq "b"',
      'name.givenName eq "Ada"',
      "userName eq",
      'userName eq "unterminated',
      '(userName eq "a"',
      'userName xx "a"',
      'userName eq "a" junk',
      "",
    ]) {
      const res = await call("GET", `/Users?filter=${encodeURIComponent(filter)}`);
      expectError(res, 400, "invalidFilter");
    }
  });

  it("pages with startIndex and count, and counts all matches", async () => {
    const before = await call("GET", "/Users?count=0");
    expect(before.body).toMatchObject({ Resources: [], itemsPerPage: 0 });
    const total = before.body.totalResults as number;
    for (let i = 0; i < 3; i++) await createUser();
    const all = await call("GET", "/Users?startIndex=1&count=200");
    expect(all.body.totalResults).toBe(total + 3);
    const ids = (all.body.Resources as Json[]).map((r) => r.id);
    const page = await call("GET", "/Users?startIndex=2&count=2");
    expect(page.body).toMatchObject({ totalResults: total + 3, startIndex: 2, itemsPerPage: 2 });
    expect((page.body.Resources as Json[]).map((r) => r.id)).toEqual(ids.slice(1, 3));
    // Out-of-range values are brought into range (RFC 7644 3.4.2.4); garbage is refused.
    const low = await call("GET", "/Users?startIndex=-4&count=-1");
    expect(low.body).toMatchObject({ startIndex: 1, itemsPerPage: 0 });
    const past = await call("GET", `/Users?startIndex=${total + 100}`);
    expect(past.body).toMatchObject({ Resources: [], totalResults: total + 3 });
    expectError(await call("GET", "/Users?count=ten"), 400, "invalidValue");
    // Only the attributes asked for.
    const some = await call("GET", "/Users?count=1&attributes=userName");
    expect(Object.keys((some.body.Resources as Json[])[0] ?? {}).sort()).toEqual([
      "id",
      "schemas",
      "userName",
    ]);
    const without = await call("GET", "/Users?count=1&excludedAttributes=emails,name.givenName");
    expect((without.body.Resources as Json[])[0]).not.toHaveProperty("emails");
    expect((without.body.Resources as Json[])[0]).not.toHaveProperty("name");
  });

  it("patches as Entra does: capitalized ops, filtered email paths, name parts, value objects", async () => {
    const u = await createUser();
    const res = await call("PATCH", `/Users/${String(u.id)}`, {
      schemas: [PATCH],
      Operations: [
        {
          op: "Replace",
          path: 'emails[type eq "work"].value',
          value: `updated.${n}@contoso.example`,
        },
        { op: "Replace", path: "name.familyName", value: "updatedFamilyName" },
        { op: "Add", path: "nickName", value: "Babs" },
        { op: "Replace", path: `${ENTERPRISE}:employeeNumber`, value: "7" },
        { op: "Add", path: 'phoneNumbers[type eq "mobile"].value', value: "555" },
        { op: "Add", path: 'emails[type eq "other"].Value', value: "proxy@contoso.example" },
        { op: "Add", path: 'addresses[type eq "other"].Formatted', value: "Room 1" },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      emails: [{ value: `updated.${n}@contoso.example`, type: "work", primary: true }],
      name: { familyName: "updatedFamilyName", givenName: (u.name as Json).givenName },
    });
    expect(res.body).not.toHaveProperty("nickName");
    // With aadOptscim062020: lower-case ops, and several attributes in one value object.
    const flagged = await call("PATCH", `/Users/${String(u.id)}`, {
      schemas: [PATCH],
      Operations: [
        {
          op: "replace",
          path: 'emails[type eq "work"].value',
          value: `again.${n}@contoso.example`,
        },
        {
          op: "replace",
          value: {
            displayName: "Bjfe",
            "name.givenName": "Kkom",
            "name.familyName": "Unua",
            [`${ENTERPRISE}:employeeNumber`]: "Aklq",
            [ENTERPRISE]: { department: "Sales" },
            [`${USER}:userType`]: "Member",
          },
        },
      ],
    });
    expect(flagged.status).toBe(200);
    expect(flagged.body).toMatchObject({
      displayName: "Bjfe",
      name: { givenName: "Kkom", familyName: "Unua", formatted: "Kkom Unua" },
      emails: [{ value: `again.${n}@contoso.example` }],
    });
    // userName and externalId replace (a rename upstream, a mapping change to objectId).
    const renamed = await call("PATCH", `/Users/${String(u.id)}`, {
      schemas: [PATCH],
      Operations: [
        { op: "Replace", path: "userName", value: `renamed.${n}@contoso.example` },
        { op: "Replace", path: "externalId", value: "new-object-id" },
        { op: "add", path: "name", value: { givenName: "Ada" } },
      ],
    });
    expect(renamed.body).toMatchObject({
      userName: `renamed.${n}@contoso.example`,
      externalId: "new-object-id",
      name: { givenName: "Ada", familyName: "Unua" },
    });
    const got = await call("GET", `/Users/${String(u.id)}`);
    expect(got.body).toEqual(renamed.body);
  });

  it("removes attributes, and refuses to remove what a user needs", async () => {
    const u = await createUser({ userName: `rm.${n}@contoso.example` });
    const patch = (Operations: Json[]) =>
      call("PATCH", `/Users/${String(u.id)}`, { schemas: [PATCH], Operations });
    const removed = await patch([
      { op: "Remove", path: "name.givenName" },
      { op: "remove", path: 'emails[type eq "work"]' },
      { op: "remove", path: "displayName" },
      { op: "remove", path: "externalId" },
    ]);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    // The email falls back to the userName; the display name to what is left of the name.
    expect(removed.body).toMatchObject({
      emails: [{ value: u.userName }],
      displayName: (u.name as Json).familyName,
    });
    expect(removed.body).not.toHaveProperty("externalId");
    expect((await patch([{ op: "remove", path: "name" }])).body).not.toHaveProperty("name");
    expectError(await patch([{ op: "remove", path: "userName" }]), 400, "invalidValue");
    expectError(await patch([{ op: "remove", path: "active" }]), 400, "invalidValue");
    expectError(await patch([{ op: "remove" }]), 400, "noTarget");
    expectError(await patch([{ op: "replace", value: "x" }]), 400, "invalidValue");
    expectError(await patch([{ op: "replace", path: "id", value: "usr_x" }]), 400, "mutability");
    expectError(await patch([{ op: "copy", path: "userName", value: "x" }]), 400, "invalidSyntax");
    expectError(
      await patch([{ op: "replace", path: "name[x eq 1]", value: "x" }]),
      400,
      "invalidPath",
    );
    expectError(
      await patch([{ op: "replace", path: "userName..x", value: "x" }]),
      400,
      "invalidPath",
    );
    expectError(await patch([{ op: "replace", path: 7, value: "x" }]), 400, "invalidSyntax");
    expectError(await patch([7 as unknown as Json]), 400, "invalidSyntax");
    expectError(await patch([]), 400, "invalidSyntax");
    expectError(
      await call("PATCH", `/Users/${String(u.id)}`, {
        Operations: [{ op: "remove", path: "title" }],
      }),
      400,
      "invalidSyntax",
    );
    expectError(
      await patch([
        { op: "replace", path: 'emails[type eq "work"].value', value: "not an address" },
      ]),
      400,
      "invalidValue",
    );
    // A refused PATCH changed nothing, even the operations before the bad one.
    const partial = await patch([
      { op: "replace", path: "displayName", value: "Half done" },
      { op: "replace", path: "active", value: "perhaps" },
    ]);
    expectError(partial, 400, "invalidValue");
    expect((await call("GET", `/Users/${String(u.id)}`)).body.displayName).not.toBe("Half done");
  });

  it("deactivates (soft delete) and reactivates with active as a string, ending sessions", async () => {
    const u = await createUser();
    const id = u.id as string;
    const off = await call("PATCH", `/Users/${id}`, {
      schemas: [PATCH],
      Operations: [{ op: "Replace", path: "active", value: "False" }],
    });
    expect(off.body.active).toBe(false);
    const stored = await db.withTenant(t.tenantId, (tx) => getUser(tx, t.tenantId, id));
    expect(stored).toMatchObject({ active: false, providerDisabled: { by: `scim:${tokenId}` } });
    // Still there for the provider: by id and by filter.
    expect((await call("GET", `/Users/${id}`)).body.active).toBe(false);
    const found = await call(
      "GET",
      `/Users?filter=${encodeURIComponent(`userName eq "${String(u.userName)}"`)}`,
    );
    expect(found.body.totalResults).toBe(1);
    const inactive = await call("GET", `/Users?filter=${encodeURIComponent("active eq false")}`);
    expect((inactive.body.Resources as Json[]).map((r) => r.id)).toContain(id);
    const on = await call("PATCH", `/Users/${id}`, {
      schemas: [PATCH],
      Operations: [{ op: "replace", path: "active", value: true }],
    });
    expect(on.body.active).toBe(true);
    // The provider's switch doesn't lift an admin's lock (and isn't reported as one).
    await db.withTenant(t.tenantId, (tx) => lockUser(tx, t.tenantId, id, "user:admin"));
    const still = await call("PATCH", `/Users/${id}`, {
      schemas: [PATCH],
      Operations: [{ op: "replace", path: "active", value: true }],
    });
    expect(still.body.active).toBe(true);
    const locked = await db.withTenant(t.tenantId, (tx) => getUser(tx, t.tenantId, id));
    expect(locked).toMatchObject({ active: false, lock: { by: "user:admin" } });
    // Created inactive.
    expect((await createUser({ active: false })).active).toBe(false);
  });

  it("replaces a user with PUT; absent attributes go, absent active stays", async () => {
    const u = await createUser();
    const id = u.id as string;
    await call("PATCH", `/Users/${id}`, {
      schemas: [PATCH],
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    const put = await call("PUT", `/Users/${id}`, {
      schemas: [USER],
      userName: u.userName,
      emails: u.emails,
      displayName: "Put Name",
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toMatchObject({ displayName: "Put Name", active: false });
    expect(put.body).not.toHaveProperty("name");
    expect(put.body).not.toHaveProperty("externalId");
    const back = await call("PUT", `/Users/${id}`, { ...entraUser(), active: true });
    expect(back.body).toMatchObject({ active: true });
    expectError(await call("PUT", `/Users/usr_${"0".repeat(26)}`, entraUser()), 404);
  });

  it("ends what AI clients hold (T-105 OAuth grants) when the provider deactivates or deletes", async () => {
    const resource = "https://hoard.example/mcp";
    const redirect = "https://claude.ai/api/mcp/auth_callback";
    /** A person's OAuth access token, through the core flow (consent, code, redemption). */
    const accessFor = async (userId: string) => {
      const client = await db.withTenant(t.tenantId, async (tx) => {
        const noted = await noteClient(
          tx,
          t.tenantId,
          {
            kind: "cimd",
            clientRef: `https://claude.ai/oauth/${userId}.json`,
            name: "Claude",
            redirectUris: [redirect],
          },
          `user:${userId}`,
        );
        if (!noted) throw new Error("no client");
        await decideClient(
          tx,
          t.tenantId,
          noted.clientKey,
          { approve: true, trust: "commercial" },
          "user:admin",
        );
        return noted;
      });
      const verifier = randomBytes(32).toString("base64url");
      const code = await db.withTenant(t.tenantId, (tx) =>
        issueCode(tx, t.tenantId, {
          userId,
          clientKey: client.clientKey,
          redirectUri: redirect,
          codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
          scopes: ["files:read"],
          resource,
        }),
      );
      const redeemed = await db.withTenant(t.tenantId, (tx) =>
        redeemCode(tx, t.tenantId, code, {
          clientKey: client.clientKey,
          redirectUri: redirect,
          codeVerifier: verifier,
          resource,
        }),
      );
      if (!redeemed.ok) throw new Error(redeemed.reason);
      return redeemed.accessToken;
    };
    const check = (token: string) =>
      db.withTenant(t.tenantId, (tx) => checkAccessToken(tx, t.tenantId, token, resource));

    const u = await createUser();
    const token = await accessFor(u.id as string);
    expect((await check(token)).ok).toBe(true);
    await call("PATCH", `/Users/${String(u.id)}`, {
      schemas: [PATCH],
      Operations: [{ op: "Replace", path: "active", value: "False" }],
    });
    expect(await check(token)).toMatchObject({ ok: false, refused: "revoked" });
    // Reactivated, the person consents again: the old grant stays revoked.
    await call("PATCH", `/Users/${String(u.id)}`, {
      schemas: [PATCH],
      Operations: [{ op: "Replace", path: "active", value: "True" }],
    });
    expect((await check(token)).ok).toBe(false);

    const v = await createUser();
    const other = await accessFor(v.id as string);
    expect((await call("DELETE", `/Users/${String(v.id)}`)).status).toBe(204);
    expect(await check(other)).toMatchObject({ ok: false, refused: "revoked" });
  });

  it("deletes for good: 404 after, and a new POST makes a new user", async () => {
    const sent = entraUser();
    const u = (await call("POST", "/Users", sent)).body;
    const id = u.id as string;
    const del = await call("DELETE", `/Users/${id}`);
    expect(del.status).toBe(204);
    expectError(await call("GET", `/Users/${id}`), 404);
    expectError(await call("DELETE", `/Users/${id}`), 404);
    const stored = await db.withTenant(t.tenantId, (tx) => getUser(tx, t.tenantId, id));
    expect(stored?.retired?.by).toBe(`scim:${tokenId}`);
    const filter = encodeURIComponent(`externalId eq "${String(sent.externalId)}"`);
    expect((await call("GET", `/Users?filter=${filter}`)).body.totalResults).toBe(0);
    const again = await call("POST", "/Users", sent);
    expect(again.status).toBe(201);
    expect(again.body.id).not.toBe(id);
  });

  it("answers 404 for ids that aren't SCIM users", async () => {
    for (const id of ["nope", `usr_${"0".repeat(26)}`, t.groupId]) {
      const res = await call("GET", `/Users/${id}`);
      expectError(res, 404);
      expect(res.body.detail).toBe("user not found");
    }
    const bot = await db.withTenant(t.tenantId, (tx) =>
      createServiceAccount(tx, t.tenantId, { displayName: "CI", by: "user:admin" }),
    );
    expectError(await call("GET", `/Users/${bot.id}`), 404);
  });
});

describe("SCIM groups", () => {
  it("creates a group with members, finds it, and returns members unless excluded", async () => {
    const a = await createUser();
    const res = await call("POST", "/Groups", {
      schemas: [GROUP, "http://schemas.microsoft.com/2006/11/ResourceManagement/ADSCIM/2.0/Group"],
      externalId: "8aa1a0c0-c4c3-4bc0-b4a5-2ef676900159",
      displayName: "Finance",
      members: [{ value: a.id }],
      meta: { resourceType: "Group" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = res.body.id as string;
    expect(id).toMatch(/^grp_/);
    expect(res.headers.get("location")).toBe(`${BASE}/Groups/${id}`);
    expect(res.body).toEqual({
      schemas: [GROUP],
      id,
      externalId: "8aa1a0c0-c4c3-4bc0-b4a5-2ef676900159",
      displayName: "Finance",
      members: [
        {
          value: a.id,
          display: a.displayName,
          type: "User",
          $ref: `${BASE}/Users/${String(a.id)}`,
        },
      ],
      meta: {
        resourceType: "Group",
        created: expect.any(String),
        location: `${BASE}/Groups/${id}`,
      },
    });
    const bare = await call("GET", `/Groups/${id}?excludedAttributes=members`);
    expect(bare.body).not.toHaveProperty("members");
    expect(bare.body.displayName).toBe("Finance");
    const filtered = await call(
      "GET",
      `/Groups?excludedAttributes=members&filter=${encodeURIComponent('displayName eq "Finance"')}`,
    );
    expect(filtered.body).toMatchObject({ totalResults: 1, itemsPerPage: 1 });
    expect((filtered.body.Resources as Json[])[0]).not.toHaveProperty("members");
    const byExternal = await call(
      "GET",
      `/Groups?filter=${encodeURIComponent('externalId eq "8aa1a0c0-c4c3-4bc0-b4a5-2ef676900159"')}`,
    );
    expect((byExternal.body.Resources as Json[])[0]?.members).toHaveLength(1);
    const onlyMembers = await call("GET", `/Groups/${id}?attributes=members`);
    expect(Object.keys(onlyMembers.body).sort()).toEqual(["id", "members", "schemas"]);
    const noMembers = await call("GET", `/Groups/${id}?attributes=displayName`);
    expect(noMembers.body).not.toHaveProperty("members");
    // The user is in the OpenHoard group.
    const principal = await db.withTenant(t.tenantId, (tx) =>
      resolvePrincipal(tx, t.tenantId, a.id as string),
    );
    expect(principal?.groupIds).toContain(id);
    // Duplicates: 409.
    expectError(
      await call("POST", "/Groups", { schemas: [GROUP], displayName: "Finance" }),
      409,
      "uniqueness",
    );
    expectError(
      await call("POST", "/Groups", {
        schemas: [GROUP],
        displayName: "Other",
        externalId: "8aa1a0c0-c4c3-4bc0-b4a5-2ef676900159",
      }),
      409,
      "uniqueness",
    );
  });

  it("adds and removes members as Entra sends them, and renames", async () => {
    const a = await createUser();
    const b = await createUser();
    const c = await createUser();
    const g = (await call("POST", "/Groups", { schemas: [GROUP], displayName: `Team ${n}` })).body;
    const id = g.id as string;
    const patch = (Operations: Json[]) =>
      call("PATCH", `/Groups/${id}`, { schemas: [PATCH], Operations });
    const members = async () =>
      ((await call("GET", `/Groups/${id}`)).body.members as Json[] | undefined)
        ?.map((m) => m.value)
        .sort() ?? [];
    const add = await patch([
      { op: "Add", path: "members", value: [{ $ref: null, value: a.id }, { value: b.id }] },
    ]);
    expect(add.status).toBe(204);
    expect(await members()).toEqual([a.id, b.id].sort());
    // Adding again is fine.
    expect((await patch([{ op: "Add", path: "members", value: [{ value: a.id }] }])).status).toBe(
      204,
    );
    // Without the flag: the value list; with it: a filtered path.
    expect(
      (await patch([{ op: "Remove", path: "members", value: [{ $ref: null, value: a.id }] }]))
        .status,
    ).toBe(204);
    expect(await members()).toEqual([b.id]);
    await patch([{ op: "add", path: "members", value: [{ value: c.id }] }]);
    expect(
      (await patch([{ op: "remove", path: `members[value eq "${String(b.id)}"]` }])).status,
    ).toBe(204);
    expect(await members()).toEqual([c.id]);
    // Removing someone who isn't a member, or isn't anyone, changes nothing.
    expect((await patch([{ op: "remove", path: 'members[value eq "nobody"]' }])).status).toBe(204);
    // Replace: exactly these.
    await patch([{ op: "replace", path: "members", value: [{ value: a.id }, { value: b.id }] }]);
    expect(await members()).toEqual([a.id, b.id].sort());
    // Operations apply in order.
    await patch([
      { op: "remove", path: "members" },
      { op: "add", path: "members", value: [{ value: c.id }] },
    ]);
    expect(await members()).toEqual([c.id]);
    // Rename, with a path and without one.
    expect(
      (await patch([{ op: "Replace", path: "displayName", value: `Renamed ${n}` }])).status,
    ).toBe(204);
    await patch([
      {
        op: "replace",
        value: { displayName: `Again ${n}`, externalId: "g-ext", members: [{ value: a.id }] },
      },
    ]);
    const got = await call("GET", `/Groups/${id}`);
    expect(got.body).toMatchObject({ displayName: `Again ${n}`, externalId: "g-ext" });
    expect(await members()).toEqual([a.id]);
    // A removed member's principal no longer has the group.
    const principal = await db.withTenant(t.tenantId, (tx) =>
      resolvePrincipal(tx, t.tenantId, c.id as string),
    );
    expect(principal?.groupIds).not.toContain(id);
  });

  it("refuses nested groups, service accounts, unknown users and too many members", async () => {
    const g = (await call("POST", "/Groups", { schemas: [GROUP], displayName: `Refusals ${n}` }))
      .body;
    const inner = (await call("POST", "/Groups", { schemas: [GROUP], displayName: `Inner ${n}` }))
      .body;
    const id = g.id as string;
    const patch = (Operations: Json[]) =>
      call("PATCH", `/Groups/${id}`, { schemas: [PATCH], Operations });
    const nested = await patch([{ op: "add", path: "members", value: [{ value: inner.id }] }]);
    expectError(nested, 400, "invalidValue");
    expect(nested.body.detail).toMatch(/nested groups/);
    const bot = await db.withTenant(t.tenantId, (tx) =>
      createServiceAccount(tx, t.tenantId, { displayName: "Bot", by: "user:admin" }),
    );
    expectError(
      await patch([{ op: "add", path: "members", value: [{ value: bot.id }] }]),
      400,
      "invalidValue",
    );
    expectError(
      await patch([{ op: "add", path: "members", value: [{ value: `usr_${"0".repeat(26)}` }] }]),
      400,
      "invalidValue",
    );
    expectError(
      await patch([{ op: "add", path: "members", value: [{ value: "bob" }] }]),
      400,
      "invalidValue",
    );
    expectError(await patch([{ op: "add", path: "members", value: ["bob"] }]), 400, "invalidValue");
    expectError(
      await patch([{ op: "add", path: "members", value: [{ display: "x" }] }]),
      400,
      "invalidValue",
    );
    const many = Array.from({ length: 1001 }, () => ({ value: `usr_${"1".repeat(26)}` }));
    expectError(await patch([{ op: "add", path: "members", value: many }]), 400, "invalidValue");
    expectError(
      await patch([{ op: "add", path: 'members[value eq "x"]', value: [] }]),
      400,
      "invalidPath",
    );
    expectError(await patch([{ op: "remove", path: "members.display" }]), 400, "invalidPath");
    expectError(
      await patch([{ op: "remove", path: 'members[display eq "x"]' }]),
      400,
      "invalidFilter",
    );
    expectError(await patch([{ op: "remove", path: "displayName" }]), 400, "invalidValue");
    expectError(await patch([{ op: "remove" }]), 400, "noTarget");
    expectError(await patch([{ op: "add", value: [] }]), 400, "invalidValue");
    expectError(await patch([{ op: "replace", path: "id", value: "x" }]), 400, "mutability");
    // Renaming onto another group's name.
    expectError(
      await patch([{ op: "replace", path: "displayName", value: `Inner ${n}` }]),
      409,
      "uniqueness",
    );
    // Enterprise extension and unknown attributes are dropped, not refused.
    expect(
      (
        await patch([
          { op: "add", path: `${ENTERPRISE}:x`, value: 1 },
          { op: "add", path: "notes", value: "x" },
        ])
      ).status,
    ).toBe(204);
    expect((await patch([{ op: "add", value: { [ENTERPRISE]: {} } }])).status).toBe(204);
  });

  it("replaces a group with PUT, deletes it, and hides local groups", async () => {
    const a = await createUser();
    const g = (
      await call("POST", "/Groups", {
        schemas: [GROUP],
        displayName: `Put ${n}`,
        externalId: `put-${n}`,
        members: [{ value: a.id }],
      })
    ).body;
    const id = g.id as string;
    const put = await call("PUT", `/Groups/${id}`, { schemas: [GROUP], displayName: `Put2 ${n}` });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toMatchObject({ displayName: `Put2 ${n}`, members: [] });
    expect(put.body).not.toHaveProperty("externalId");
    expectError(await call("PUT", `/Groups/${id}`, { schemas: [GROUP] }), 400, "invalidValue");
    expect((await call("DELETE", `/Groups/${id}`)).status).toBe(204);
    expectError(await call("GET", `/Groups/${id}`), 404);
    expectError(await call("DELETE", `/Groups/${id}`), 404);
    expectError(await call("GET", `/Groups/${t.groupId}`), 404);
    expectError(await call("GET", "/Groups/nope"), 404);
    const listed = await call("GET", "/Groups?count=200");
    expect((listed.body.Resources as Json[]).map((r) => r.id)).not.toContain(t.groupId);
  });

  it("lists groups with filters, and refuses the ones it can't answer", async () => {
    const res = await call("GET", "/Groups?startIndex=1&count=1");
    expect(res.body).toMatchObject({ schemas: [LIST], startIndex: 1, itemsPerPage: 1 });
    for (const filter of [
      'members.display eq "x"',
      'displayName co "x"',
      "displayName eq 1",
      `${ENTERPRISE}:x eq "y"`,
      'emails[type eq "work"]',
      'members[display eq "x"]',
      'members[value eq "a"] and members[value eq "b" or value eq "c"]',
      'displayName eq "a" or displayName eq "b"',
    ]) {
      expectError(
        await call("GET", `/Groups?filter=${encodeURIComponent(filter)}`),
        400,
        "invalidFilter",
      );
    }
    const none = await call(
      "GET",
      `/Groups?filter=${encodeURIComponent('id eq "a" and id eq "b"')}`,
    );
    expect(none.body.totalResults).toBe(0);
  });

  it("finds the groups a user is in, as a membership check asks", async () => {
    const a = await createUser();
    const b = await createUser();
    const g = (
      await call("POST", "/Groups", {
        schemas: [GROUP],
        displayName: `Members ${n}`,
        members: [{ value: a.id }],
      })
    ).body;
    const ids = async (filter: string) =>
      (
        (
          await call(
            "GET",
            `/Groups?excludedAttributes=members&filter=${encodeURIComponent(filter)}`,
          )
        ).body.Resources as Json[]
      ).map((r) => r.id);
    expect(await ids(`id eq "${String(g.id)}" and members[value eq "${String(a.id)}"]`)).toEqual([
      g.id,
    ]);
    expect(await ids(`id eq "${String(g.id)}" and members[value eq "${String(b.id)}"]`)).toEqual(
      [],
    );
    expect(await ids(`members.value eq "${String(a.id)}"`)).toEqual([g.id]);
    expect(await ids(`(members[value eq "${String(a.id)}"])`)).toEqual([g.id]);
    expect(await ids(`members eq "${String(b.id)}"`)).toEqual([]);
    // A bare word as a value, as one of Microsoft's examples writes it.
    expect(await ids(`id eq ${String(g.id)}`)).toEqual([g.id]);
  });
});

describe("SCIM discovery and protocol", () => {
  it("serves ServiceProviderConfig, ResourceTypes and Schemas", async () => {
    const spc = await call("GET", "/ServiceProviderConfig");
    expect(spc.status).toBe(200);
    expect(spc.body).toMatchObject({
      patch: { supported: true },
      bulk: { supported: false },
      filter: { supported: true, maxResults: 200 },
      authenticationSchemes: [{ type: "oauthbearertoken", primary: true }],
    });
    const types = await call("GET", "/ResourceTypes");
    expect((types.body.Resources as Json[]).map((r) => r.id)).toEqual(["User", "Group"]);
    expect((await call("GET", "/ResourceTypes/User")).body.endpoint).toBe("/Users");
    expectError(await call("GET", "/ResourceTypes/Device"), 404);
    const schemas = await call("GET", "/Schemas");
    expect((schemas.body.Resources as Json[]).map((r) => r.id)).toEqual([USER, GROUP]);
    expect((await call("GET", `/Schemas/${USER}`)).body.name).toBe("User");
    expectError(await call("GET", "/Schemas/urn:nope"), 404);
  });

  it("answers unknown paths with SCIM errors, and Bulk as unsupported", async () => {
    expectError(await call("GET", "/Devices"), 404);
    expectError(await call("POST", "/Bulk", {}), 501);
    const res = await app.request(`${ORIGIN}/scim/v2`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it("refuses bodies over the limit: 413", async () => {
    const small = createApp(config(), undefined, { db, scim: { maxBodyBytes: 100 } });
    const res = await call("POST", "/Users", entraUser(), {}, small);
    expectError(res, 413);
  });
});

describe("SCIM authentication", () => {
  it("wants a bearer token: 401 with WWW-Authenticate, in SCIM's error format", async () => {
    const none = await app.request(`${BASE}/Users`);
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe('Bearer realm="OpenHoard SCIM"');
    expect(await none.json()).toEqual({
      schemas: [ERROR],
      status: "401",
      detail: "authentication failed",
    });
    for (const header of [
      "Basic abc",
      `Bearer ${token.replace("ohscim", "ohk")}`,
      "Bearer",
      `Bearer ${token} extra`,
    ]) {
      const res = await app.request(`${BASE}/Users`, { headers: { authorization: header } });
      expect(res.status, header).toBe(401);
    }
    const junk = await call("GET", "/Users", undefined, { authorization: "Bearer junk" });
    expect(junk.headers.get("www-authenticate")).toBe(
      'Bearer realm="OpenHoard SCIM", error="invalid_token"',
    );
  });

  it("refuses a wrong secret, a revoked, expired or other tenant's token, and audits why", async () => {
    const issued = await issue();
    const [, tenant, id] = issued.token.split(".") as [string, string, string];
    const as = (tok: string) =>
      call("GET", "/Users?count=0", undefined, { authorization: `Bearer ${tok}` });
    expect((await as(issued.token)).status).toBe(200);

    expectError(await as(`ohscim.${tenant}.${id}.${"A".repeat(43)}`), 401);
    // Another tenant's name on the token: nothing there by that id.
    expectError(await as(issued.token.replace(t.tenantId, other.tenantId)), 401);
    // A tenant that doesn't exist.
    expectError(await as(issued.token.replace(t.tenantId, newId("tenant"))), 401);

    await db.withTenant(t.tenantId, (tx) =>
      revokeScimToken(tx, t.tenantId, issued.id, "user:admin"),
    );
    expectError(await as(issued.token), 401);

    const old = await issue(t.tenantId, 1500);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expectError(await as(old.token), 401);

    const refusals = (await auditEvents()).filter((e) => e.action === "scim.auth");
    expect(refusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: `scim:${issued.id}`,
          decision: "deny",
          detail: { reason: "wrong-secret", request: "scim.user.list" },
        }),
        expect.objectContaining({
          actor: `scim:${issued.id}`,
          decision: "deny",
          detail: { reason: "revoked", request: "scim.user.list" },
        }),
        expect.objectContaining({
          actor: `scim:${old.id}`,
          decision: "deny",
          detail: { reason: "expired", request: "scim.user.list" },
        }),
      ]),
    );
    const elsewhere = (await auditEvents(other.tenantId)).filter((e) => e.action === "scim.auth");
    expect(elsewhere).toEqual([
      expect.objectContaining({
        actor: "scim:unknown-token",
        decision: "deny",
        detail: { reason: "unknown-token", request: "scim.user.list" },
      }),
    ]);
  });

  it("audits every allowed use and every refusal, as scim:<token id>", async () => {
    const u = await createUser();
    await call("GET", `/Users/${String(u.id)}`);
    await call("POST", "/Users", entraUser({ userName: u.userName }));
    const mine = (await auditEvents()).filter((e) => e.actor === `scim:${tokenId}`);
    expect(mine).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "scim.user.create",
          decision: "allow",
          detail: { status: 201, user: u.id },
        }),
        expect.objectContaining({
          action: "scim.user.read",
          decision: "allow",
          detail: { status: 200, target: u.id },
        }),
        expect.objectContaining({
          action: "scim.user.create",
          decision: "deny",
          detail: { status: 409, reason: "uniqueness" },
        }),
      ]),
    );
    // No personal data in the audit detail: ids only.
    expect(JSON.stringify(mine)).not.toContain(String(u.userName));
    // The token's last use is recorded.
    const listed = await db.withTenant(t.tenantId, (tx) => listScimTokens(tx, t.tenantId));
    expect(listed.find((k) => k.id === tokenId)?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("turns away a client after too many failed authentications: 429", async () => {
    const limited = createApp(config(), undefined, {
      db,
      scim: { maxFailures: 3, failureWindowMs: 60_000 },
    });
    const bad = `Bearer ${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    for (let i = 0; i < 3; i++) {
      expect((await call("GET", "/Users", undefined, { authorization: bad }, limited)).status).toBe(
        401,
      );
    }
    const blocked = await call("GET", "/Users", undefined, {}, limited);
    expectError(blocked, 429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("counts failures per key in fixed windows", () => {
    let now = 0;
    const limiter = new FailureLimiter(2, 1000, () => now);
    expect(limiter.blockedFor("a")).toBe(0);
    limiter.fail("a", "b");
    expect(limiter.blockedFor("a")).toBe(0);
    limiter.fail("a");
    expect(limiter.blockedFor("a")).toBe(1000);
    expect(limiter.blockedFor("b")).toBe(0);
    now = 1000;
    expect(limiter.blockedFor("a")).toBe(0);
    limiter.fail("a");
    expect(limiter.blockedFor("a")).toBe(0);
    expect(limiter.size).toBe(2);
    expect(() => new FailureLimiter(0, 1)).toThrow(RangeError);
    expect(() => new FailureLimiter(1, 0)).toThrow(RangeError);
  });

  it("is off when configured off", async () => {
    const off = createApp(
      ConfigSchema.parse({ dataDir: "/tmp/unused", scim: { enabled: false } }),
      undefined,
      { db },
    );
    expect((await off.request(`${BASE}/Users`)).status).toBe(404);
  });

  it("serves the whole tenant, never another's users", async () => {
    const theirs = await issue(other.tenantId);
    const u = await createUser();
    const res = await call("GET", `/Users/${String(u.id)}`, undefined, {
      authorization: `Bearer ${theirs.token}`,
    });
    expectError(res, 404);
    const list = await call("GET", "/Users", undefined, {
      authorization: `Bearer ${theirs.token}`,
    });
    expect(list.body.totalResults).toBe(0);
  });
});
