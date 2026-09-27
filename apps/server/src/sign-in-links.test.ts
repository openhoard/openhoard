import { exportAudit } from "@openhoard/core-audit";
import { newId, sourceSyncs, zones, type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { createUser, grantAdmin, issueSignInLink, type User } from "@openhoard/core-identity";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { AuthEnv } from "./auth.js";
import { ConfigSchema } from "./config.js";

/*
 * One-time sign-in links (dogfood without an identity provider): the page, the sign-in, what a
 * replay or another site gets, and the sign-in page sending a signed-in person back. And the
 * admin API's read-only list of connector syncs (T-303).
 */

const PUBLIC = "http://127.0.0.1:7420";

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
  app = build(true);
});
afterEach(() => db?.close());

function build(signInLinks: boolean): Hono<AuthEnv> {
  const config = ConfigSchema.parse({
    dataDir: "/tmp/unused",
    auth: { publicUrl: PUBLIC, cookieKey: "k".repeat(43), signInLinks },
  });
  return createApp(config, undefined, { db });
}

const link = async (userId = steve.id) =>
  (
    await db.withTenant(t.tenantId, (tx) =>
      issueSignInLink(tx, t.tenantId, { userId, by: "system:admin-cli" }),
    )
  ).token;

/** The node socket a request came in on: this machine's by default. */
const peer = (remoteAddress = "127.0.0.1") => ({ incoming: { socket: { remoteAddress } } });

/** A request as a browser on this machine sends it. */
const get = (path: string, init: RequestInit = {}, from = "127.0.0.1") =>
  app.request(path, init, peer(from));

const post = (
  token: string,
  headers: Record<string, string> = { origin: PUBLIC },
  from = "127.0.0.1",
) =>
  app.request(
    "/auth/link",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ token }).toString(),
    },
    peer(from),
  );

/** The session cookie a response set, as a Cookie header. */
const cookieOf = (res: Response) => {
  const set = res.headers.get("set-cookie") ?? "";
  return /oh_session=[^;]+/.exec(set)?.[0] ?? "";
};

async function audit() {
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

describe("sign-in links", () => {
  it("shows a button, signs in once, and a replay ends that session", async () => {
    const token = await link();
    const page = await get(`/auth/link?token=${encodeURIComponent(token)}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(await page.text()).toContain('action="/auth/link"');

    const used = await post(token);
    expect(used.status).toBe(200);
    const cookie = cookieOf(used);
    expect(cookie).not.toBe("");
    const me = await app.request("/auth/me", { headers: { cookie } });
    expect(await me.json()).toMatchObject({ user: { id: steve.id }, tenantId: t.tenantId });

    // Signed in: the sign-in page sends the browser straight back.
    const back = await app.request("/auth/sign-in?return_to=/oauth/authorize%3Fx%3D1", {
      headers: { cookie },
    });
    expect([back.status, back.headers.get("location")]).toEqual([302, "/oauth/authorize?x=1"]);

    // The same link again: refused, and the session it started ends.
    expect((await post(token)).status).toBe(401);
    expect((await app.request("/auth/me", { headers: { cookie } })).status).toBe(401);
    const events = (await audit()).filter((e) => e.action === "auth.sign-in");
    expect(events.map((e) => [e.decision, e.detail?.provider, e.detail?.reason])).toEqual([
      ["allow", "sign-in-link", undefined],
      ["deny", "sign-in-link", "used"],
    ]);
  });

  it("refuses another site, a bad token, and a server that doesn't offer them", async () => {
    const token = await link();
    expect((await post(token, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(token, {})).status).toBe(403);
    expect((await post("ohl.nope")).status).toBe(400);
    expect((await get("/auth/link?token=nope")).status).toBe(400);
    const forged = `${token.slice(0, token.lastIndexOf(".") + 1)}${"A".repeat(43)}`;
    expect((await post(forged)).status).toBe(401);
    // The genuine one still works: a refused attempt doesn't use it up.
    expect((await post(token)).status).toBe(200);

    app = build(false);
    expect((await get(`/auth/link?token=${encodeURIComponent(token)}`)).status).toBe(404);
    const page = await app.request("/auth/sign-in");
    expect(await page.text()).toContain("No sign-in is configured.");
    app = build(true);
    expect(await (await app.request("/auth/sign-in")).text()).toContain("admin user sign-in-link");
  });

  it("answers a double submit by the browser it signed in as done, not as a replay", async () => {
    const token = await link();
    const first = await post(token);
    const cookie = cookieOf(first);
    expect(first.status).toBe(200);
    const again = await post(token, { origin: PUBLIC, cookie });
    expect(again.status).toBe(200);
    expect(cookieOf(again)).toBe("");
    expect((await app.request("/auth/me", { headers: { cookie } })).status).toBe(200);
    // Anyone else presenting it is a replay: refused, and the session ends.
    expect((await post(token)).status).toBe(401);
    expect((await app.request("/auth/me", { headers: { cookie } })).status).toBe(401);
  });

  it("refuses a request that didn't come straight from this machine", async () => {
    const token = await link();
    const url = `/auth/link?token=${encodeURIComponent(token)}`;
    expect((await get(url, {}, "192.0.2.7")).status).toBe(403);
    expect((await app.request(url)).status).toBe(403); // no socket: fail closed
    for (const header of [
      "x-forwarded-for",
      "forwarded",
      "x-forwarded-host",
      "x-real-ip",
      "cf-connecting-ip",
    ]) {
      expect((await get(url, { headers: { [header]: "198.51.100.1" } })).status, header).toBe(403);
      expect((await post(token, { origin: PUBLIC, [header]: "198.51.100.1" })).status).toBe(403);
    }
    expect((await post(token, { origin: PUBLIC }, "10.0.0.2")).status).toBe(403);
    // IPv6 loopback and the IPv4-mapped form are this machine.
    expect((await get(url, {}, "::1")).status).toBe(200);
    expect((await get(url, {}, "::ffff:127.0.0.1")).status).toBe(200);
    // Nothing was used up.
    expect((await post(token)).status).toBe(200);
  });

  it("is refused by the config unless both host and publicUrl are this machine", () => {
    const parse = (host: string, publicUrl = PUBLIC) =>
      ConfigSchema.safeParse({ host, auth: { publicUrl, signInLinks: true } });
    expect(parse("127.0.0.1").success).toBe(true);
    expect(parse("::1").success).toBe(true);
    expect(parse("127.0.0.1", "http://localhost:7420").success).toBe(true);
    const open = parse("0.0.0.0");
    expect(open.success).toBe(false);
    expect(JSON.stringify(open.error?.issues)).toContain("on this machine only");
    // A tunnel in front: refused.
    expect(parse("127.0.0.1", "https://words.trycloudflare.com").success).toBe(false);
  });
});

describe("GET /api/admin/sources", () => {
  it("lists each connector sync and its last run, for admins only", async () => {
    await db.withTenant(t.tenantId, async (tx) => {
      const zoneId = newId("zone");
      await tx
        .insert(zones)
        .values({ tenantId: t.tenantId, id: zoneId, kind: "indexed", name: "D" });
      await tx.insert(sourceSyncs).values({
        tenantId: t.tenantId,
        source: "fs-docs",
        zoneId,
        connector: "connector-fs",
        phase: "delta",
        token: "fs1.x",
        lastRunAt: new Date(),
        lastStatus: "done",
        lastCounts: { files: 2 },
      });
    });
    const cookie = cookieOf(await post(await link()));
    expect((await app.request("/api/admin/sources", { headers: { cookie } })).status).toBe(403);
    await db.withTenant(t.tenantId, (tx) =>
      grantAdmin(tx, t.tenantId, steve.id, "system:admin-cli"),
    );
    const again = cookieOf(await post(await link()));
    const res = await app.request("/api/admin/sources", { headers: { cookie: again } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      sources: [
        {
          source: "fs-docs",
          scheduled: true,
          lastStatus: "done",
          lastCounts: { files: 2 },
          stoppedAt: null,
        },
      ],
    });
  });
});
