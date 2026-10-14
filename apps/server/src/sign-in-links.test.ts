import { exportAudit } from "@openhoard/core-audit";
import { newId, sourceSyncs, users, zones, type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { createUser, grantAdmin, issueSignInLink, type User } from "@openhoard/core-identity";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keepSkips } from "@openhoard/core-jobs";
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
          standing: { is: "current" },
          scheduled: true,
          lastStatus: "done",
          lastCounts: { files: 2 },
          stoppedAt: null,
        },
      ],
    });
  });

  it("says when a source has gone stale, and lists one the server couldn't start", async () => {
    const DAY = 24 * 3_600_000;
    await db.withTenant(t.tenantId, async (tx) => {
      const zoneId = newId("zone");
      await tx
        .insert(zones)
        .values({ tenantId: t.tenantId, id: zoneId, kind: "indexed", name: "D" });
      const sync = (source: string, lastCurrentAt: Date) => ({
        tenantId: t.tenantId,
        source,
        zoneId,
        connector: "connector-fs",
        phase: "delta" as const,
        token: "fs1.x",
        lastRunAt: lastCurrentAt,
        lastStatus: "done" as const,
        lastCurrentAt,
      });
      await tx
        .insert(sourceSyncs)
        .values([
          sync("fs-fresh", new Date(Date.now() - DAY / 2)),
          sync("fs-old", new Date(Date.now() - 3 * DAY)),
          sync("sp-down", new Date()),
        ]);
      await grantAdmin(tx, t.tenantId, steve.id, "system:admin-cli");
    });
    const config = ConfigSchema.parse({
      dataDir: "/tmp/unused",
      auth: { publicUrl: PUBLIC, cookieKey: "k".repeat(43), signInLinks: true },
    });
    const down = (source: string) =>
      ({
        tenantId: t.tenantId,
        source,
        connector: "connector-sharepoint",
        code: "no-credential",
      }) as const;
    app = createApp(config, undefined, {
      db,
      unavailableSources: [
        down("sp-down"),
        down("sp-never"),
        { ...down("sp-elsewhere"), tenantId: "ten_00000000000000000000000000" },
      ],
    });
    const cookie = cookieOf(await post(await link()));
    const res = await app.request("/api/admin/sources", { headers: { cookie } });
    const { sources } = (await res.json()) as {
      sources: { source: string; standing: { is: string }; scheduled: boolean }[];
    };
    const by = new Map(sources.map((x) => [x.source, x]));
    expect(by.get("fs-fresh")?.standing).toEqual({ is: "current" });
    expect(by.get("fs-old")?.standing).toMatchObject({ is: "stale", code: null });
    // Up to date when last read, but the server can't read it now: said, not "current".
    expect(by.get("sp-down")).toMatchObject({
      standing: { is: "unavailable", code: "no-credential" },
      scheduled: false,
    });
    // Never ran: listed all the same.
    expect(by.get("sp-never")).toMatchObject({
      standing: { is: "unavailable", code: "no-credential" },
      scheduled: false,
      lastRunAt: null,
    });
    // Another tenant's unavailable source isn't listed here.
    expect(sources).toHaveLength(4);
  });

  it("lists what a source's syncs left out, for admins only", async () => {
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
      });
      await keepSkips(tx, t.tenantId, "fs-docs", {
        skipped: new Map([
          ["a", { reason: "too-large", path: ["Video.mp4"] }],
          ["b", { reason: "invalid-acl" }],
        ]),
        cleared: new Set(),
      });
    });
    const url = "/api/admin/sources/fs-docs/skips";
    const member = cookieOf(await post(await link()));
    expect((await app.request(url, { headers: { cookie: member } })).status).toBe(403);
    await db.withTenant(t.tenantId, (tx) =>
      grantAdmin(tx, t.tenantId, steve.id, "system:admin-cli"),
    );
    const cookie = cookieOf(await post(await link()));
    const res = await app.request(url, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      total: number;
      byReason: Record<string, number>;
      skips: { externalId: string; reason: string; path: string[] | null }[];
    };
    expect(body.total).toBe(2);
    expect(body.byReason).toEqual({ "too-large": 1, "invalid-acl": 1 });
    expect(body.skips.map((x) => [x.externalId, x.reason, x.path]).sort()).toEqual([
      ["a", "too-large", ["Video.mp4"]],
      ["b", "invalid-acl", null],
    ]);
    const one = (await (
      await app.request(`${url}?reason=too-large`, { headers: { cookie } })
    ).json()) as { skips: unknown[] };
    expect(one.skips).toHaveLength(1);
    for (const bad of ["?limit=0", "?limit=x", "?reason=Bad%20Code"]) {
      expect((await app.request(url + bad, { headers: { cookie } })).status, bad).toBe(400);
    }
    expect(
      (await app.request("/api/admin/sources/nope/skips", { headers: { cookie } })).status,
    ).toBe(404);
  });
});

describe("the audit log over the admin API (T-905)", () => {
  async function adminCookie() {
    await db.withTenant(t.tenantId, (tx) =>
      grantAdmin(tx, t.tenantId, steve.id, "system:admin-cli"),
    );
    return cookieOf(await post(await link()));
  }
  const takeExport = (cookie: string, body: object = {}, origin = PUBLIC) =>
    app.request("/api/admin/audit/export", {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("pages the log newest first, filtered, for admins only", async () => {
    const member = cookieOf(await post(await link()));
    expect((await app.request("/api/admin/audit", { headers: { cookie: member } })).status).toBe(
      403,
    );
    const cookie = await adminCookie();
    const get = (q = "") => app.request(`/api/admin/audit${q}`, { headers: { cookie } });
    const all = (await (await get()).json()) as {
      events: { seq: number; action: string; actor: string }[];
      next: number | null;
    };
    expect(all.events.length).toBeGreaterThan(2);
    const seqs = all.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
    // One at a time, following `next`.
    const one = (await (await get("?limit=1")).json()) as typeof all;
    expect(one.events).toHaveLength(1);
    const two = (await (await get(`?limit=1&before=${one.next}`)).json()) as typeof all;
    expect(two.events[0]?.seq).toBe(all.events[1]?.seq);
    // Filters, as the CLI's.
    const granted = (await (await get("?actionPrefix=admin.")).json()) as typeof all;
    expect(granted.events.length).toBeGreaterThan(0);
    expect(granted.events.every((e) => e.action.startsWith("admin."))).toBe(true);
    for (const bad of [
      "?limit=0",
      "?limit=201",
      "?before=x",
      "?decision=maybe",
      "?from=2026-02-30",
      "?from=2026-10-02&to=2026-10-01",
    ]) {
      expect((await get(bad)).status, bad).toBe(400);
    }
  });

  it("exports what was asked as a file and records it, after a recent sign-in", async () => {
    const cookie = await adminCookie();
    const res = await takeExport(cookie, { format: "csv", from: "2000-01-01" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="audit-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const lines = (await res.text()).trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "seq,at,actor,action,decision,client,object,version,detail,prev_hash,hash",
    );
    expect(lines.length).toBeGreaterThan(1);
    // Recorded after it, with who, through which app, and what was asked.
    const listed = (await (
      await app.request("/api/admin/audit?action=audit.export", { headers: { cookie } })
    ).json()) as { events: { actor: string; client: string; detail: object }[] };
    expect(listed.events).toMatchObject([
      {
        actor: `user:${steve.id}`,
        client: "openhoard",
        detail: { format: "csv", events: lines.length - 1, from: "2000-01-01T00:00:00.000Z" },
      },
    ]);
    for (const bad of [{ format: "xml" }, { actor: 7 }, { to: "soon" }]) {
      expect((await takeExport(cookie, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    // Not from another site (the session cookie goes with a cross-site form), and not as a GET.
    expect((await takeExport(cookie, {}, "https://evil.example")).status).toBe(403);
    expect((await app.request("/api/admin/audit/export", { headers: { cookie } })).status).not.toBe(
      200,
    );
  });

  it("asks the database, not the session, whether the reader is still an admin", async () => {
    const cookie = await adminCookie();
    // The role taken away behind the session's back (no new principal epoch).
    await db.withTenant(t.tenantId, (tx) =>
      tx.update(users).set({ adminAt: null, adminBy: null }).where(eq(users.id, steve.id)),
    );
    expect((await app.request("/api/admin/audit", { headers: { cookie } })).status).toBe(403);
    const res = await takeExport(cookie);
    expect([res.status, await res.json()]).toEqual([403, { error: "forbidden" }]);
  });

  it("refuses an export to a sign-in that isn't recent", async () => {
    const cookie = await adminCookie();
    const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60 * 60_000);
    try {
      const res = await takeExport(cookie);
      expect([res.status, await res.json()]).toEqual([
        403,
        { error: "sign in again to do this", signIn: "/auth/sign-in" },
      ]);
    } finally {
      later.mockRestore();
    }
    // And recorded: who tried to take the log.
    const denied = (await (
      await app.request("/api/admin/audit?action=audit.export&decision=deny", {
        headers: { cookie: await adminCookie() },
      })
    ).json()) as { events: { detail: object }[] };
    expect(denied.events[0]?.detail).toMatchObject({ reason: "sign-in-again" });
  });

  it("checks the whole chain on demand", async () => {
    const cookie = await adminCookie();
    const res = await app.request("/api/admin/audit/verify", {
      method: "POST",
      headers: { cookie, origin: PUBLIC, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      head: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});
