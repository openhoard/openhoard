import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { exportAudit } from "@openhoard/core-audit";
import type { IngestResult } from "@openhoard/core-catalog";
import { blobs, newId, objects, users, versions, zones, type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import {
  createUser,
  decideClient,
  issueCode,
  noteClient,
  redeemCode,
  startSession,
  type OAuthScope,
  type User,
} from "@openhoard/core-identity";
import { BlobStore } from "@openhoard/core-storage";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { AuthEnv } from "./auth.js";
import { ConfigSchema } from "./config.js";
import { SOURCE_HEADER, sourceUrl, UPLOAD_SOURCE, uploadTitle } from "./uploads.js";
import { APP_SCRIPT, iconPng, SERVICE_WORKER } from "./web-app.js";

/*
 * T-1206: a signed-in member's file goes into a managed zone, theirs alone, and the installable
 * page that shares into it. "Done when: a file shared from Android or Windows appears in
 * OpenHoard": what the system's share does (the service worker, then this API) is what is
 * tested here; the system's side needs a phone.
 */

const PUBLIC = "https://files.example.com";
const KEY = new Uint8Array(32).fill(7);

let db: Database;
let t: SeededTenant;
let ana: User;
let ben: User;
let dir: string;
let store: BlobStore;
let enqueued: { tenantId: string; result: IngestResult }[];
let app: Hono<AuthEnv>;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  const person = (email: string, kind: "member" | "guest" = "member") =>
    db.withTenant(t.tenantId, (tx) =>
      createUser(tx, t.tenantId, { email, displayName: email, source: "local", kind }),
    );
  ana = await person("ana@example.com");
  ben = await person("ben@example.com");
  dir = mkdtempSync(join(tmpdir(), "oh-uploads-"));
  store = BlobStore.open({ kind: "fs", root: dir });
  enqueued = [];
  app = build();
});
afterEach(async () => {
  await db?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function build(uploads: Record<string, unknown> = {}, enqueue = true): Hono<AuthEnv> {
  const config = ConfigSchema.parse({
    dataDir: "/tmp/unused",
    auth: { publicUrl: PUBLIC, cookieKey: "k".repeat(43), passkeys: true },
    uploads,
  });
  return createApp(config, undefined, {
    db,
    uploads: {
      store,
      tenantKey: () => Promise.resolve(KEY),
      ...(enqueue
        ? {
            enqueue: (tenantId, result) => {
              enqueued.push({ tenantId, result });
              return Promise.resolve(true);
            },
          }
        : {}),
    },
  });
}

/** The session cookie of someone signed in. */
async function cookieOf(user: User, tenantId = t.tenantId): Promise<string> {
  const session = await db.withTenant(tenantId, (tx) =>
    startSession(tx, tenantId, {
      userId: user.id,
      provider: "dev",
      issuer: "https://idp.example",
      subject: user.id,
    }),
  );
  return `__Host-oh_session=${session.token}`;
}

interface Sent {
  object: string;
  version: string;
  title: string;
  size: number;
  created: boolean;
}

async function upload(
  cookie: string | null,
  name: string | null,
  body: string | ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
) {
  return app.request(`/api/uploads${name === null ? "" : `?name=${encodeURIComponent(name)}`}`, {
    method: "POST",
    headers: {
      origin: PUBLIC,
      "content-type": "text/plain",
      ...(cookie === null ? {} : { cookie }),
      ...headers,
    },
    body,
    // A streamed body, as a browser sends a file.
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

async function audit(action: string, tenantId = t.tenantId) {
  const lines: string[] = [];
  await exportAudit(db, tenantId, {}, "ndjson", (s: string) => void lines.push(s));
  return lines
    .join("")
    .split("\n")
    .filter(Boolean)
    .map(
      (l) => JSON.parse(l) as { actor: string; action: string; decision: string; detail: unknown },
    )
    .filter((r) => r.action === action);
}

/** What uploads made (the seeded tenant has files of its own, in other zones). */
const stored = () =>
  db.withTenant(t.tenantId, (tx) =>
    tx
      .select({
        id: objects.id,
        title: objects.title,
        owner: objects.ownerId,
        zone: zones.name,
        kind: zones.kind,
        deletedAt: objects.deletedAt,
      })
      .from(objects)
      .innerJoin(zones, and(eq(zones.tenantId, objects.tenantId), eq(zones.id, objects.zoneId)))
      .where(and(eq(objects.tenantId, t.tenantId), eq(zones.kind, "managed"))),
  );

/** How many files the store holds for the tenant (what was kept, recorded or not). */
function blobCount(): number {
  const under = join(dir, t.tenantId);
  if (!existsSync(under)) return 0;
  return (readdirSync(under, { recursive: true, withFileTypes: true }) as Dirent[]).filter((e) =>
    e.isFile(),
  ).length;
}

describe("POST /api/uploads", () => {
  it("keeps the file: in a managed zone, the uploader's, its bytes in the store", async () => {
    const cookie = await cookieOf(ana);
    const res = await upload(cookie, "Notes from site.txt", "hello hoard");
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const sent = (await res.json()) as Sent;
    expect(sent).toMatchObject({ title: "Notes from site.txt", size: 11, created: true });

    expect(await stored()).toEqual([
      {
        id: sent.object,
        title: "Notes from site.txt",
        owner: `user:${ana.id}`,
        zone: "Uploads",
        kind: "managed",
        deletedAt: null,
      },
    ]);
    const [version] = await db.withTenant(t.tenantId, (tx) =>
      tx
        .select({ blobId: versions.blobId, mime: versions.mime, location: blobs.location })
        .from(versions)
        .innerJoin(blobs, and(eq(blobs.tenantId, versions.tenantId), eq(blobs.id, versions.blobId)))
        .where(eq(versions.id, sent.version)),
    );
    expect(version).toMatchObject({ mime: "text/plain" });
    expect(version?.location).toMatch(new RegExp(`^${t.tenantId}/`));
    const bytes = await store.read(t.tenantId, version?.blobId as string);
    expect(Buffer.from(bytes).toString()).toBe("hello hoard");
    expect(await store.verify({ id: t.tenantId, key: KEY }, version?.blobId as string)).toBe(true);

    // Audited, with the zone's making; enrichment queued after the commit.
    expect((await audit("zone.create")).map((r) => [r.actor, r.detail])).toEqual([
      ["system:uploads", expect.objectContaining({ kind: "managed", name: "Uploads" })],
    ]);
    expect((await audit("object.upload")).map((r) => [r.actor, r.decision, r.detail])).toEqual([
      [
        `user:${ana.id}`,
        "allow",
        expect.objectContaining({ object: sent.object, size: 11, created: true }),
      ],
    ]);
    expect(enqueued).toEqual([
      { tenantId: t.tenantId, result: expect.objectContaining({ objectId: sent.object }) },
    ]);
  });

  it("takes a streamed body, an empty file, and a file with no name", async () => {
    const cookie = await cookieOf(ana);
    const chunks = ["a".repeat(70_000), "b".repeat(70_000)];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(next));
      },
    });
    const big = await upload(cookie, "big.bin", stream, {
      "content-type": "application/octet-stream",
    });
    expect([big.status, ((await big.json()) as Sent).size]).toEqual([201, 140_000]);
    const empty = await upload(cookie, "empty.txt", "");
    expect([empty.status, ((await empty.json()) as Sent).size]).toEqual([201, 0]);
    const unnamed = await upload(cookie, null, "x");
    expect(((await unnamed.json()) as Sent).title).toBe("Untitled");
  });

  it("answers the same file from the same person with the one there is", async () => {
    const cookie = await cookieOf(ana);
    const first = (await (await upload(cookie, "a.txt", "same")).json()) as Sent;
    const again = await upload(cookie, "a.txt", "same");
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({
      object: first.object,
      version: first.version,
      created: false,
    });
    // The same bytes under another name are another file.
    const copy = (await (await upload(cookie, "copy of a.txt", "same")).json()) as Sent;
    expect([copy.created, copy.object === first.object]).toEqual([true, false]);
    expect((await stored()).map((o) => o.title).sort()).toEqual(["a.txt", "copy of a.txt"]);
    // Another type for the same file is a new version of it, and the audit says so.
    const typed = await upload(cookie, "a.txt", "same", { "content-type": "text/markdown" });
    expect(await typed.json()).toMatchObject({ object: first.object, created: false });
    expect((await audit("object.upload")).map((r) => r.detail)).toEqual([
      expect.objectContaining({ created: true }),
      expect.objectContaining({ created: false, newVersion: false }),
      expect.objectContaining({ created: true }),
      expect.objectContaining({ created: false, newVersion: true }),
    ]);
    // Someone else's same bytes are their own file (one blob in the tenant).
    const theirs = (await (await upload(await cookieOf(ben), "a.txt", "same")).json()) as Sent;
    expect(theirs.object).not.toBe(first.object);
    expect(theirs.created).toBe(true);
    const ids = await db.withTenant(t.tenantId, (tx) =>
      tx
        .select({ id: versions.id, blobId: versions.blobId })
        .from(versions)
        .where(eq(versions.tenantId, t.tenantId)),
    );
    const blob = (v: string) => ids.find((r) => r.id === v)?.blobId;
    expect(blob(theirs.version)).toBe(blob(first.version));
  });

  it("brings back a file that was removed when its bytes come again", async () => {
    const cookie = await cookieOf(ana);
    const first = (await (await upload(cookie, "a.txt", "back")).json()) as Sent;
    await db.withTenant(t.tenantId, (tx) =>
      tx.update(objects).set({ deletedAt: new Date() }).where(eq(objects.id, first.object)),
    );
    const again = (await (await upload(cookie, "a.txt", "back")).json()) as Sent;
    expect(again.object).toBe(first.object);
    expect((await stored())[0]?.deletedAt).toBeNull();
    expect((await audit("object.upload")).at(-1)?.detail).toMatchObject({ restored: true });
  });

  it("leaves alone a file that has become someone else's", async () => {
    const cookie = await cookieOf(ana);
    const first = (await (await upload(cookie, "a.txt", "handed over")).json()) as Sent;
    await db.withTenant(t.tenantId, (tx) =>
      tx
        .update(objects)
        .set({ ownerId: `user:${ben.id}`, deletedAt: new Date() })
        .where(eq(objects.id, first.object)),
    );
    const again = (await (await upload(cookie, "a.txt", "handed over")).json()) as Sent;
    expect([again.created, again.object === first.object]).toEqual([true, false]);
    const all = await stored();
    expect(all.find((o) => o.id === first.object)).toMatchObject({ owner: `user:${ben.id}` });
    expect(all.find((o) => o.id === first.object)?.deletedAt).not.toBeNull();
    expect(all.find((o) => o.id === again.object)).toMatchObject({ owner: `user:${ana.id}` });
  });

  it("refuses someone locked since they signed in, before keeping a byte", async () => {
    const cookie = await cookieOf(ana);
    // Their session's snapshot still says active: the check in the request's own transaction.
    expect((await upload(cookie, "warm.txt", "warm")).status).toBe(201);
    await db.withTenant(t.tenantId, (tx) =>
      tx
        .update(users)
        .set({ lockedAt: new Date(), lockedBy: "system:test" })
        .where(eq(users.id, ana.id)),
    );
    const res = await upload(cookie, "late.txt", "never kept");
    expect([401, 403]).toContain(res.status);
    expect((await stored()).map((o) => o.title)).toEqual(["warm.txt"]);
    expect(await blobCount()).toBe(1);
  });

  it("refuses anyone who isn't a signed-in member, from this origin", async () => {
    expect((await upload(null, "a.txt", "x")).status).toBe(401);
    const cookie = await cookieOf(ana);
    // Another site's page, with the person's cookie.
    const crossSite = await upload(cookie, "a.txt", "x", { origin: "https://evil.example" });
    expect(crossSite.status).toBe(403);
    const guest = await db.withTenant(t.tenantId, (tx) =>
      createUser(tx, t.tenantId, {
        email: "guest@example.com",
        displayName: "Guest",
        source: "local",
        kind: "guest",
      }),
    );
    const asGuest = await cookieOf(guest);
    expect((await upload(asGuest, "a.txt", "x")).status).toBe(403);
    expect((await app.request("/api/uploads", { headers: { cookie: asGuest } })).status).toBe(403);
    expect(await stored()).toEqual([]);
    expect((await audit("object.upload")).map((r) => [r.actor, r.decision, r.detail])).toEqual([
      [`user:${guest.id}`, "deny", { reason: "not-member" }],
    ]);
    expect(enqueued).toEqual([]);
  });

  it("refuses a file over the limit, declared or not, and keeps nothing of it", async () => {
    app = build({ maxBytes: 1000 });
    const cookie = await cookieOf(ana);
    const declared = await upload(cookie, "big.txt", "x".repeat(1001));
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ error: "too large", maxBytes: 1000 });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600));
        controller.enqueue(new Uint8Array(600));
        controller.close();
      },
    });
    expect((await upload(cookie, "big.bin", stream)).status).toBe(413);
    expect((await upload(cookie, "fits.txt", "x".repeat(1000))).status).toBe(201);
    expect((await stored()).map((o) => o.title)).toEqual(["fits.txt"]);
    expect(await store.sweepIncoming(t.tenantId, 0)).toBe(0);
  });

  it("refuses a form: the body is the file", async () => {
    const cookie = await cookieOf(ana);
    for (const type of [
      "multipart/form-data; boundary=x",
      "application/x-www-form-urlencoded",
      "",
    ]) {
      const res = await upload(cookie, "a.txt", "a=b", { "content-type": type });
      expect([type, res.status]).toEqual([type, 415]);
    }
    expect(await stored()).toEqual([]);
  });

  it("refuses when the zone's name is taken by a zone that isn't managed", async () => {
    await db.withTenant(t.tenantId, (tx) =>
      tx
        .insert(zones)
        .values({ tenantId: t.tenantId, id: newId("zone"), kind: "indexed", name: "Uploads" }),
    );
    const cookie = await cookieOf(ana);
    const res = await upload(cookie, "a.txt", "x");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("uploads.zone");
    expect((await audit("object.upload")).map((r) => [r.decision, r.detail])).toEqual([
      ["deny", { reason: "zone-kind" }],
    ]);
    expect((await app.request("/api/uploads", { headers: { cookie } })).status).toBe(200);
    // Refused before its bytes were kept.
    expect(await blobCount()).toBe(0);
  });

  it("makes the zone once when a tenant's first uploads come together", async () => {
    const [a, b] = [await cookieOf(ana), await cookieOf(ben)];
    const both = await Promise.all([upload(a, "a.txt", "one"), upload(b, "b.txt", "two")]);
    expect(both.map((r) => r.status)).toEqual([201, 201]);
    expect(await audit("zone.create")).toHaveLength(1);
    expect(new Set((await stored()).map((o) => o.zone))).toEqual(new Set(["Uploads"]));
  });

  it("uses the configured zone, and still answers when nothing queues enrichment", async () => {
    app = build({ zone: "Inbox" }, false);
    const res = await upload(await cookieOf(ana), "a.txt", "x");
    expect(res.status).toBe(201);
    expect((await stored())[0]).toMatchObject({ zone: "Inbox", kind: "managed" });
  });

  it("keeps tenants apart: the zone, the file and the list are each tenant's own", async () => {
    const other = await seedTenant(db, 2);
    const eve = await db.withTenant(other.tenantId, (tx) =>
      createUser(tx, other.tenantId, {
        email: "eve@x.example",
        displayName: "Eve",
        source: "local",
      }),
    );
    const mine = (await (await upload(await cookieOf(ana), "mine.txt", "same")).json()) as Sent;
    const eves = await cookieOf(eve, other.tenantId);
    const theirs = (await (await upload(eves, "theirs.txt", "same")).json()) as Sent;
    expect(theirs.created).toBe(true);
    expect(theirs.object).not.toBe(mine.object);
    const list = await app.request("/api/uploads", { headers: { cookie: eves } });
    expect(((await list.json()) as { uploads: { title: string }[] }).uploads).toEqual([
      expect.objectContaining({ object: theirs.object, title: "theirs.txt" }),
    ]);
  });
});

describe("a client's token (T-1207)", () => {
  const CLIENT = "https://extension.example/oauth/client.json";
  const REDIRECT = "https://abcdefghijklmnop.chromiumapp.org/";
  const RESOURCE = `${PUBLIC}/mcp`;
  let clientKey: string;
  beforeEach(async () => {
    clientKey = await db.withTenant(t.tenantId, async (tx) => {
      const noted = await noteClient(
        tx,
        t.tenantId,
        { kind: "cimd", clientRef: CLIENT, name: "Extension", redirectUris: [REDIRECT] },
        `user:${ana.id}`,
      );
      const key = noted?.clientKey as string;
      await decideClient(tx, t.tenantId, key, { approve: true, trust: "consumer" }, "system:test");
      return key;
    });
  });

  /** An access token for a person through the approved client, as the token endpoint issues it. */
  async function tokenOf(user: User, scopes: OAuthScope[]) {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return db.withTenant(t.tenantId, async (tx) => {
      const code = await issueCode(tx, t.tenantId, {
        userId: user.id,
        clientKey,
        redirectUri: REDIRECT,
        codeChallenge: challenge,
        scopes,
        resource: RESOURCE,
      });
      const set = await redeemCode(tx, t.tenantId, code, {
        clientKey,
        redirectUri: REDIRECT,
        codeVerifier: verifier,
        resource: RESOURCE,
      });
      if (!set.ok) throw new Error(set.reason);
      return set.accessToken;
    });
  }

  /** As the extension sends it: the token, no cookie, its own origin. */
  const send = (token: string, name: string, body: string, from?: string) =>
    app.request(`/api/uploads?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "text/markdown",
        origin: "chrome-extension://abcdefghijklmnop",
        ...(from === undefined ? {} : { [SOURCE_HEADER]: from }),
      },
      body,
    });

  it("adds a file for the person who allowed it, with where it is from", async () => {
    const token = await tokenOf(ana, ["files:add"]);
    const from = "https://example.com/article?id=7&ref=x";
    const res = await send(
      token,
      "An article.md",
      "# An article",
      // (Its fragment isn't kept: a place in the page, or a token a sign-in left there.)
      `${from}#access_token=s3cret`,
    );
    expect(res.status).toBe(201);
    const sent = (await res.json()) as Sent;
    expect((await stored())[0]).toMatchObject({ id: sent.object, owner: `user:${ana.id}` });
    expect((await audit("object.upload")).at(-1)).toMatchObject({
      actor: `user:${ana.id}`,
      decision: "allow",
      detail: { object: sent.object, client: expect.any(String), grant: expect.any(String) },
    });
    expect(JSON.stringify(await audit("object.upload"))).not.toMatch(/token|oat_/);
    // The person's own list links back to it.
    const list = await app.request("/api/uploads", { headers: { cookie: await cookieOf(ana) } });
    expect(((await list.json()) as { uploads: unknown[] }).uploads).toEqual([
      expect.objectContaining({ object: sent.object, title: "An article.md", url: from }),
    ]);
  });

  it("makes a page saved again a new version of the same file", async () => {
    const token = await tokenOf(ana, ["files:add"]);
    const query = "https://example.com/news";
    const first = (await (await send(token, "News.md", "Monday", query)).json()) as Sent;
    const again = await send(token, "News.md", "Tuesday", query);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({
      object: first.object,
      created: false,
      newVersion: true,
    });
    const same = await send(token, "News.md", "Tuesday", query);
    expect(await same.json()).toMatchObject({ object: first.object, newVersion: false });
    // Another page with the same name is another file; so is the same text with no address.
    const other = await send(token, "News.md", "Tuesday", "https://other.example/");
    expect(((await other.json()) as Sent).object).not.toBe(first.object);
    expect(((await (await send(token, "News.md", "Tuesday")).json()) as Sent).object).not.toBe(
      first.object,
    );
    expect(await stored()).toHaveLength(3);
    // An address too long to file a page under is kept, and the file goes by its content.
    const long = `https://example.com/${"p".repeat(2000)}`;
    const filed = await send(token, "Long.md", "long", long);
    expect(filed.status).toBe(201);
  });

  it("refuses an address that isn't a web one", async () => {
    const token = await tokenOf(ana, ["files:add"]);
    for (const bad of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://me:pw@example.com/",
      "nope",
    ]) {
      const res = await send(token, "x.md", "x", bad);
      expect([bad, res.status]).toEqual([bad, 400]);
    }
    expect(await stored()).toEqual([]);
    expect(sourceUrl("https://example.com/a b")).toBe("https://example.com/a%20b");
    expect(sourceUrl(`https://example.com/${"x".repeat(5000)}`)).toBeNull();
    expect(sourceUrl(undefined)).toBeNull();
    expect(sourceUrl("https://example.com/a?b=1#frag")).toBe("https://example.com/a?b=1");
  });

  it("takes only a token that may add, for adding only", async () => {
    const reading = await tokenOf(ana, ["files:read", "files:tag"]);
    const refused = await send(reading, "x.md", "x");
    expect(refused.status).toBe(403);
    expect(refused.headers.get("www-authenticate")).toContain("insufficient_scope");
    expect((await send("ohat.nope", "x.md", "x")).status).toBe(401);
    const adding = await tokenOf(ana, ["files:add"]);
    // Not the list (that is the person's own page's), and not the MCP server.
    const list = await app.request("/api/uploads", {
      headers: { authorization: `Bearer ${adding}` },
    });
    expect(list.status).toBe(401);
    const mcp = await app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${adding}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.status).toBe(403);
    expect(await stored()).toEqual([]);
  });

  it("stops when the client is revoked, and never takes a guest's token", async () => {
    const token = await tokenOf(ana, ["files:add"]);
    expect((await send(token, "before.md", "x")).status).toBe(201);
    await db.withTenant(t.tenantId, (tx) =>
      decideClient(tx, t.tenantId, clientKey, { approve: false }, "system:test"),
    );
    expect((await send(token, "after.md", "y")).status).toBe(401);
    await db.withTenant(t.tenantId, (tx) =>
      decideClient(tx, t.tenantId, clientKey, { approve: true, trust: "consumer" }, "system:test"),
    );
    const guest = await db.withTenant(t.tenantId, (tx) =>
      createUser(tx, t.tenantId, {
        email: "g@example.com",
        displayName: "G",
        source: "local",
        kind: "guest",
      }),
    );
    const guests = await tokenOf(guest, ["files:add"]);
    expect((await send(guests, "guest.md", "z")).status).toBe(403);
    expect((await stored()).map((o) => o.title)).toEqual(["before.md"]);
    expect((await audit("object.upload")).at(-1)).toMatchObject({
      actor: `user:${guest.id}`,
      decision: "deny",
      detail: { reason: "not-member", client: expect.any(String) },
    });
  });

  it("checks the grant again when the file is recorded, not only when it began to arrive", async () => {
    const token = await tokenOf(ana, ["files:add"]);
    // The body arrives slowly; the client is revoked before it ends.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let reading: () => void = () => {};
    const started = new Promise<void>((r) => (reading = r));
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // The server reads the body only once the token was accepted.
        reading();
        await gate;
        controller.enqueue(new TextEncoder().encode("late"));
        controller.close();
      },
    });
    const pending = app.request("/api/uploads?name=late.md", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "text/markdown" },
      body,
      duplex: "half",
    } as RequestInit);
    await started;
    await db.withTenant(t.tenantId, (tx) =>
      decideClient(tx, t.tenantId, clientKey, { approve: false }, "system:test"),
    );
    release();
    expect((await pending).status).toBe(403);
    expect(await stored()).toEqual([]);
    expect((await audit("object.upload")).at(-1)).toMatchObject({
      decision: "deny",
      detail: { reason: "grant-ended" },
    });
  });

  it("lets the session decide when a request carries both it and a token", async () => {
    const token = await tokenOf(ana, ["files:read"]);
    const res = await app.request("/api/uploads?name=both.md", {
      method: "POST",
      headers: {
        cookie: await cookieOf(ben),
        origin: PUBLIC,
        authorization: `Bearer ${token}`,
        "content-type": "text/markdown",
      },
      body: "x",
    });
    expect(res.status).toBe(201);
    expect((await stored())[0]).toMatchObject({ owner: `user:${ben.id}` });
  });

  it("offers the scope only where files can be added", async () => {
    const meta = async (a: Hono<AuthEnv>) =>
      (
        (await (await a.request("/.well-known/oauth-authorization-server")).json()) as {
          scopes_supported: string[];
        }
      ).scopes_supported;
    expect(await meta(app)).toEqual(["files:read", "files:tag", "files:add"]);
    const off = createApp(
      ConfigSchema.parse({
        dataDir: "/tmp/unused",
        auth: { publicUrl: PUBLIC, cookieKey: "k".repeat(43), passkeys: true },
      }),
      undefined,
      { db },
    );
    expect(await meta(off)).toEqual(["files:read", "files:tag"]);
  });
});

describe("GET /api/uploads", () => {
  it("lists the caller's own uploads, newest first, and nothing before the first", async () => {
    const cookie = await cookieOf(ana);
    const list = async (c: string) => {
      const res = await app.request("/api/uploads", { headers: { cookie: c } });
      expect(res.status).toBe(200);
      return ((await res.json()) as { uploads: { title: string }[] }).uploads.map((u) => u.title);
    };
    expect(await list(cookie)).toEqual([]);
    expect(await audit("zone.create")).toEqual([]);
    await upload(cookie, "one.txt", "1");
    await upload(cookie, "two.txt", "2");
    await upload(await cookieOf(ben), "bens.txt", "3");
    expect((await list(cookie)).sort()).toEqual(["one.txt", "two.txt"]);
    expect(await list(await cookieOf(ben))).toEqual(["bens.txt"]);
    expect((await app.request("/api/uploads")).status).toBe(401);
  });
});

describe("uploadTitle", () => {
  it("is the name's last segment, cleaned, never empty and never too long", () => {
    expect(uploadTitle("C:\\Users\\me\\Report final.pdf")).toBe("Report final.pdf");
    expect(uploadTitle("../../etc/passwd")).toBe("passwd");
    expect(uploadTitle("a\u0000b\tc\n.txt")).toBe("a b c .txt");
    // Nothing that hides or reorders what a person (or a model) reads.
    expect(uploadTitle("invoice\u202excod.exe")).toBe("invoicexcod.exe");
    expect(uploadTitle("a\u200b\u2028\u0085b.txt")).toBe("a b.txt");
    expect(uploadTitle("plan\u{e0041}\u{e0042}\u3164\u2065.md")).toBe("plan.md");
    // The joiners that scripts and emoji are written with stay.
    expect(uploadTitle("\u{1f468}\u200d\u{1f469}.png")).toBe("\u{1f468}\u200d\u{1f469}.png");
    for (const none of [undefined, "", "   ", "dir/", "..", "."]) {
      expect(uploadTitle(none)).toBe("Untitled");
    }
    const long = uploadTitle(`${"x".repeat(400)}.jpeg`);
    expect([[...long].length, long.endsWith(".jpeg")]).toEqual([255, true]);
    expect([...uploadTitle("y".repeat(400))].length).toBe(255);
    expect([...uploadTitle(`z.${"e".repeat(400)}`)].length).toBe(255);
    // Whole characters, not halves of one.
    expect(uploadTitle("\u{1f600}".repeat(300))).toBe("\u{1f600}".repeat(255));
  });
});

describe("the installable page", () => {
  it("is for someone signed in; anyone else signs in and comes back", async () => {
    const out = await app.request("/app/");
    expect([out.status, out.headers.get("location")]).toEqual([
      302,
      "/auth/sign-in?return_to=%2Fapp%2F",
    ]);
    expect((await app.request("/app")).headers.get("location")).toBe("/app/");
    const res = await app.request("/app/", { headers: { cookie: await cookieOf(ana) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<link rel="manifest" href="/app/manifest.webmanifest">');
    expect(html).toContain("Up to 100 MB each");
    expect(html).toContain('data-max="104857600"');
    // What was shared is shown, and saved on a click: never sent on arrival.
    expect(html).toContain('<div id="oh-shared" hidden>');
    const csp = res.headers.get("content-security-policy") as string;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("serves a manifest that shares files into the page's scope", async () => {
    const res = await app.request("/app/manifest.webmanifest");
    expect(res.headers.get("content-type")).toBe("application/manifest+json");
    const manifest = (await res.json()) as {
      scope: string;
      start_url: string;
      icons: { src: string; sizes: string }[];
      share_target: { action: string; method: string; enctype: string; params: unknown };
    };
    expect(manifest).toMatchObject({ scope: "/app/", start_url: "/app/", display: "standalone" });
    expect(manifest.share_target).toEqual({
      action: "/app/share",
      method: "POST",
      enctype: "multipart/form-data",
      params: {
        title: "title",
        text: "text",
        url: "url",
        files: [{ name: "files", accept: ["*/*"] }],
      },
    });
    for (const icon of manifest.icons) {
      const png = await app.request(icon.src);
      expect([icon.src, png.status, png.headers.get("content-type")]).toEqual([
        icon.src,
        200,
        "image/png",
      ]);
    }
  });

  it("draws its icon as a real PNG of the size asked", () => {
    const png = Buffer.from(iconPng(192));
    expect(png.subarray(0, 8).toString("latin1")).toBe("\u0089PNG\r\n\u001a\n");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([192, 192]);
    const length = png.readUInt32BE(33);
    expect(png.subarray(37, 41).toString("latin1")).toBe("IDAT");
    const raw = inflateSync(png.subarray(41, 41 + length));
    expect(raw.length).toBe(192 * (1 + 192 * 3));
    // The corner is the brand's amber, the ring is white, the middle amber again.
    const at = (x: number, y: number) => [
      ...raw.subarray(y * 577 + 1 + x * 3, y * 577 + 4 + x * 3),
    ];
    expect(at(0, 0)).toEqual([0x8a, 0x5a, 0]);
    expect(at(96 + 45, 96)).toEqual([255, 255, 255]);
    expect(at(96, 96)).toEqual([0x8a, 0x5a, 0]);
  });

  it("serves the script and the service worker, which agree on where a share waits", async () => {
    const js = await app.request("/app/app.js");
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await js.text()).toBe(APP_SCRIPT);
    const sw = await app.request("/app/sw.js");
    expect(await sw.text()).toBe(SERVICE_WORKER);
    for (const script of [APP_SCRIPT, SERVICE_WORKER]) {
      expect(script).toContain('"oh-shared-v1"');
      expect(script).toContain("x-oh-name");
      // Both parse.
      expect(() => new Function(script)).not.toThrow();
    }
  });

  it("sends a share the service worker didn't take to the page, saying so", async () => {
    // As the system sends it: the person's cookie, and no Origin of this server's.
    for (const headers of [
      {},
      { cookie: await cookieOf(ana) },
      { cookie: await cookieOf(ana), origin: "null" },
    ] as Record<string, string>[]) {
      const res = await app.request("/app/share", { method: "POST", body: "x", headers });
      expect([res.status, res.headers.get("location")]).toEqual([303, "/app/?shared=missed"]);
    }
    expect(await stored()).toEqual([]);
    expect((await app.request("/app/share")).headers.get("location")).toBe("/app/");
  });
});

describe("configuration", () => {
  const base = { dataDir: "/tmp/unused" };
  const auth = { publicUrl: PUBLIC, cookieKey: "k".repeat(43), passkeys: true };
  const source = {
    id: "docs",
    connector: "fs",
    tenantId: `ten_${"0".repeat(26)}`,
    root: process.platform === "win32" ? "C:\\docs" : "/docs",
    zone: "Docs",
    owner: "a@b.example",
  };
  const problems = (config: unknown) => {
    const parsed = ConfigSchema.safeParse(config);
    return parsed.success ? [] : parsed.error.issues.map((i) => i.path.join("."));
  };

  it("is off unless asked for, and needs sign-in", async () => {
    const off = createApp(ConfigSchema.parse({ ...base, auth }), undefined, { db });
    expect((await off.request("/api/uploads")).status).toBe(404);
    expect((await off.request("/app/")).status).toBe(404);
    expect(problems({ ...base, uploads: {} })).toEqual(["uploads"]);
    expect(ConfigSchema.parse({ ...base, auth, uploads: {} }).uploads).toEqual({
      zone: "Uploads",
      maxBytes: 100 * 1024 * 1024,
    });
    expect(() =>
      createApp(ConfigSchema.parse({ ...base, auth, uploads: {} }), undefined, { db }),
    ).toThrow("uploads need the blob store");
  });

  it("keeps folders out of the uploads' zone and source", () => {
    const named = { ...source, id: UPLOAD_SOURCE };
    expect(problems({ ...base, auth, uploads: {}, sources: [named] })).toEqual(["sources.0.id"]);
    // Only with uploads on: a setup that had such a source keeps starting.
    expect(problems({ ...base, auth, sources: [named] })).toEqual([]);
    expect(
      problems({ ...base, auth, uploads: {}, sources: [{ ...source, zone: "Uploads" }] }),
    ).toEqual(["sources.0.zone"]);
    expect(problems({ ...base, auth, uploads: { zone: "Inbox" }, sources: [source] })).toEqual([]);
  });
});
