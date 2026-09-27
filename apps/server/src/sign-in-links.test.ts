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

const post = (token: string, headers: Record<string, string> = { origin: PUBLIC }) =>
  app.request("/auth/link", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ token }).toString(),
  });

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
    const page = await app.request(`/auth/link?token=${encodeURIComponent(token)}`);
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
    expect((await app.request("/auth/link?token=nope")).status).toBe(400);
    const forged = `${token.slice(0, token.lastIndexOf(".") + 1)}${"A".repeat(43)}`;
    expect((await post(forged)).status).toBe(401);
    // The genuine one still works: a refused attempt doesn't use it up.
    expect((await post(token)).status).toBe(200);

    app = build(false);
    expect((await app.request(`/auth/link?token=${encodeURIComponent(token)}`)).status).toBe(404);
    const page = await app.request("/auth/sign-in");
    expect(await page.text()).toContain("No sign-in is configured.");
    app = build(true);
    expect(await (await app.request("/auth/sign-in")).text()).toContain("admin user sign-in-link");
  });

  it("is refused by the config unless the server listens on this machine only", () => {
    const parse = (host: string) =>
      ConfigSchema.safeParse({ host, auth: { publicUrl: PUBLIC, signInLinks: true } });
    expect(parse("127.0.0.1").success).toBe(true);
    expect(parse("::1").success).toBe(true);
    const open = parse("0.0.0.0");
    expect(open.success).toBe(false);
    expect(JSON.stringify(open.error?.issues)).toContain("listens on this machine only");
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
