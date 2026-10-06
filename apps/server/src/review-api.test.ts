import { exportAudit } from "@openhoard/core-audit";
import {
  markProcessed,
  proposeTag,
  searchObjects,
  VIEW_TRANSACTION,
  viewObjects,
} from "@openhoard/core-catalog";
import { addGrant, facets, facetValues, type Database, type Tx } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import {
  createUser,
  grantAdmin,
  issueSignInLink,
  resolvePrincipal,
  type User,
} from "@openhoard/core-identity";
import { Authorizer, createCedarEngine } from "@openhoard/core-policy";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { AuthEnv } from "./auth.js";
import { ConfigSchema } from "./config.js";

/*
 * T-903: the review inbox over HTTP, for the web app. "Done when: review round-trip updates
 * tags + search": an assistant's proposal, approved by the signed-in person over the API, is
 * on the file's card and finds the file by that tag.
 */

const PUBLIC = "http://127.0.0.1:7420";
const authz = new Authorizer(createCedarEngine());
const WEB = { id: "openhoard-web", trust: "first-party" } as const;

let db: Database;
let t: SeededTenant;
/** May tag the seeded file (a write grant on it). */
let editor: User;
/** Reads the seeded file through the seeded group, no more. */
let reader: string;
/** No access to the file at all. */
let outsider: User;
let app: Hono<AuthEnv>;

const inTenant = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work);
const person = (name: string) =>
  inTenant((tx) =>
    createUser(tx, t.tenantId, {
      email: `${name}@example.com`,
      displayName: name,
      source: "local",
      kind: "member",
    }),
  );

beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  editor = await person("ed");
  outsider = await person("oz");
  reader = t.userId;
  await inTenant(async (tx) => {
    await markProcessed(tx, t.tenantId, { versionId: t.versionId, title: "Report 1.docx" });
    await tx
      .insert(facets)
      .values({ tenantId: t.tenantId, key: "sensitivity", label: "Sensitivity", single: true });
    await tx.insert(facetValues).values(
      [
        ["client", "globex"],
        ["client", "initech"],
        ["sensitivity", "internal"],
        ["sensitivity", "public"],
      ].map(([facet, value]) => ({
        tenantId: t.tenantId,
        facet: facet as string,
        value: value as string,
        label: value as string,
        approved: true,
      })),
    );
    await addGrant(tx, t.tenantId, {
      principal: `user:${editor.id}`,
      role: "write",
      target: { objectId: t.objectId },
      grantedBy: "user:admin",
    });
  });
  const config = ConfigSchema.parse({
    dataDir: "/tmp/unused",
    auth: { publicUrl: PUBLIC, cookieKey: "k".repeat(43), signInLinks: true },
  });
  app = createApp(config, undefined, { db, adminUi: null });
});
afterEach(() => db?.close());

/** A session cookie for a person, by a one-time sign-in link. */
async function signedIn(userId: string): Promise<string> {
  const { token } = await inTenant((tx) =>
    issueSignInLink(tx, t.tenantId, { userId, by: "system:admin-cli" }),
  );
  const res = await app.request(
    "/auth/link",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: PUBLIC },
      body: new URLSearchParams({ token }).toString(),
    },
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
  );
  return /oh_session=[^;]+/.exec(res.headers.get("set-cookie") ?? "")?.[0] ?? "";
}

const list = async (cookie: string, query = "") =>
  app.request(`/api/review${query}`, { headers: { cookie } });
const decide = (
  cookie: string,
  id: string,
  decision: string,
  body: unknown = {},
  headers: Record<string, string> = {},
) =>
  app.request(`/api/review/${id}/${decision}`, {
    method: "POST",
    headers: { cookie, origin: PUBLIC, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

/** An assistant proposes a tag on the seeded file, as the `tag` tool does. */
async function proposed(tag: string): Promise<string> {
  const out = await inTenant((tx) =>
    proposeTag(
      tx,
      t.tenantId,
      {
        objectId: t.objectId,
        tag,
        source: "model",
        appliedBy: "model:agent/cli_x",
        confidence: 1,
      },
      { review: "agent" },
    ),
  );
  if (out.applied) throw new Error("applied, not sent to review");
  return out.reviewId;
}

/** What the person finds by a tag, and the tags on the file's card as they see it. */
async function seen(userId: string, tag: string) {
  return db.withTenant(
    t.tenantId,
    async (tx) => {
      const principal = await resolvePrincipal(tx, t.tenantId, userId);
      if (!principal) throw new Error("no such person");
      const request = { principal, client: WEB };
      const found = await searchObjects(tx, t.tenantId, authz, request, { query: tag });
      const [card] = await viewObjects(tx, t.tenantId, authz, request, [t.objectId]);
      return {
        found: found.hits.map((h) => h.id),
        // (The seeded file's own tag aside.)
        tags: card?.shape === "card" ? card.tags.filter((x) => x !== "client:acme-1") : [],
      };
    },
    VIEW_TRANSACTION,
  );
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
          object?: string;
          detail?: Record<string, unknown>;
        },
    )
    .filter((e) => e.action === "tag.review");
}

describe("the review inbox over HTTP (T-903)", () => {
  it("the done-when: an approval there is on the file's tags and in search", async () => {
    const id = await proposed("client:globex");
    const cookie = await signedIn(editor.id);
    expect(await seen(editor.id, "client:globex")).toEqual({ found: [], tags: [] });

    const inbox = await list(cookie);
    expect(inbox.status).toBe(200);
    expect(inbox.headers.get("cache-control")).toBe("no-store");
    expect(await inbox.json()).toEqual({
      items: [
        {
          id,
          objectId: t.objectId,
          title: "Report 1.docx",
          tag: "client:globex",
          reason: "agent",
          source: "model",
          appliedBy: "model:agent/cli_x",
          confidence: 1,
          createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
          admin: false,
        },
      ],
      more: false,
      capped: false,
    });

    const approved = await decide(cookie, id, "approve");
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({
      decided: {
        id,
        objectId: t.objectId,
        title: "Report 1.docx",
        tag: "client:globex",
        applied: "client:globex",
        replaced: [],
        alsoClosed: 0,
      },
    });
    expect(await seen(editor.id, "client:globex")).toEqual({
      found: [t.objectId],
      tags: ["client:globex"],
    });
    expect(await (await list(cookie)).json()).toMatchObject({ items: [] });
    // Decided once: it is no longer an open item, for anyone; asking again is no refusal.
    expect((await decide(cookie, id, "approve")).status).toBe(404);
    expect((await audit()).map((e) => [e.actor, e.decision, e.detail?.refusal])).toEqual([
      [`user:${editor.id}`, "allow", undefined],
    ]);
  });

  it("is each person's own: what they may tag, and nothing of the rest", async () => {
    const id = await proposed("client:globex");
    // No access: nothing listed, and the item isn't there for them.
    const none = await signedIn(outsider.id);
    expect(await (await list(none)).json()).toEqual({ items: [], more: false, capped: false });
    const hidden = await decide(none, id, "approve");
    expect([hidden.status, await hidden.json()]).toEqual([
      404,
      { error: "no such open review item" },
    ]);
    // An unknown id reads the same.
    const unknown = await decide(none, "rev_00000000000000000000000000", "approve");
    expect([unknown.status, await unknown.json()]).toEqual([
      404,
      { error: "no such open review item" },
    ]);
    // Reads the file, may not tag it: not listed, and refused as such.
    const reads = await signedIn(reader);
    expect(await (await list(reads)).json()).toMatchObject({ items: [] });
    const refused = await decide(reads, id, "reject");
    expect([refused.status, ((await refused.json()) as { code: string }).code]).toEqual([
      403,
      "refused",
    ]);
    // An admin as such sees nothing more: they read only what grants allow.
    await inTenant((tx) => grantAdmin(tx, t.tenantId, outsider.id, "system:admin-cli"));
    const boss = await signedIn(outsider.id);
    expect(await (await list(boss)).json()).toMatchObject({ items: [] });
    expect((await decide(boss, id, "approve")).status).toBe(404);

    expect(await seen(editor.id, "client:globex")).toMatchObject({ tags: [] });
    expect((await audit()).map((e) => [e.decision, e.detail?.refusal, e.object])).toEqual([
      ["deny", "not-found", t.objectId],
      ["deny", "refused", t.objectId],
      ["deny", "not-found", t.objectId],
    ]);
  });

  it("leaves new vocabulary to an admin who may tag the file, and merging to anyone who may", async () => {
    const newValue = (tag: string, label: string) =>
      inTenant(async (tx) => {
        const out = await proposeTag(tx, t.tenantId, {
          objectId: t.objectId,
          tag,
          label,
          source: "model",
          appliedBy: "model:test/m",
          confidence: 0.9,
        });
        if (out.applied) throw new Error("applied, not sent to review");
        return out.reviewId;
      });
    const id = await newValue("client:globex-inc", "Globex Inc");
    const cookie = await signedIn(editor.id);
    expect(await (await list(cookie)).json()).toMatchObject({
      items: [{ id, tag: "client:globex-inc", admin: true }],
    });
    const notYet = await decide(cookie, id, "approve");
    expect([notYet.status, ((await notYet.json()) as { code: string }).code]).toEqual([
      403,
      "not-admin",
    ]);
    // Merged into an approved value: tagging the file, which they may.
    const merged = await decide(cookie, id, "merge", { into: "globex" });
    expect(merged.status).toBe(200);
    expect(await merged.json()).toMatchObject({
      decided: { tag: "client:globex-inc", applied: "client:globex" },
    });
    expect(await seen(editor.id, "client:globex")).toEqual({
      found: [t.objectId],
      tags: ["client:globex"],
    });
    // As an admin, the same person approves a new value.
    await inTenant((tx) => grantAdmin(tx, t.tenantId, editor.id, "system:admin-cli"));
    const boss = await signedIn(editor.id);
    const second = await newValue("client:umbrella", "Umbrella");
    expect((await decide(boss, second, "approve")).status).toBe(200);
    expect((await seen(editor.id, "client:umbrella")).found).toEqual([t.objectId]);
  });

  it("asks before replacing a single-value facet's value", async () => {
    await inTenant((tx) =>
      proposeTag(tx, t.tenantId, {
        objectId: t.objectId,
        tag: "sensitivity:internal",
        source: "user",
        appliedBy: `user:${editor.id}`,
        confidence: 1,
      }),
    );
    const id = await proposed("sensitivity:public");
    await inTenant((tx) => grantAdmin(tx, t.tenantId, editor.id, "system:admin-cli"));
    const cookie = await signedIn(editor.id);
    const asked = await decide(cookie, id, "approve");
    // The question names what would come off, and asking it is no refusal to audit.
    expect([asked.status, await asked.json()]).toEqual([
      409,
      {
        error: expect.stringContaining("replace"),
        code: "conflict",
        replaces: ["sensitivity:internal"],
      },
    ]);
    expect(await audit()).toEqual([]);
    const replaced = await decide(cookie, id, "approve", { replace: true });
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toMatchObject({
      decided: { applied: "sensitivity:public", replaced: ["sensitivity:internal"] },
    });
  });

  it("leaves taking a waiting restriction off a file to an admin, however it is done", async () => {
    await inTenant((tx) =>
      tx.insert(facetValues).values({
        tenantId: t.tenantId,
        facet: "sensitivity",
        value: "restricted",
        label: "Restricted",
        approved: true,
        visibility: "hidden",
      }),
    );
    // A model's restriction, waiting: the file is hidden meanwhile.
    const id = await proposed("sensitivity:restricted");
    const cookie = await signedIn(editor.id);
    expect(await (await list(cookie)).json()).toMatchObject({ items: [{ id, admin: true }] });
    for (const [decision, body] of [
      ["reject", {}],
      ["merge", { into: "public" }],
      ["merge", { into: "internal" }],
    ] as const) {
      const res = await decide(cookie, id, decision, body);
      expect([res.status, ((await res.json()) as { code: string }).code], decision).toEqual([
        403,
        "not-admin",
      ]);
    }
    expect(await (await list(cookie)).json()).toMatchObject({ items: [{ id }] });
    // Rejected by an admin who may tag the file, it is gone from the file and from search.
    await inTenant((tx) => grantAdmin(tx, t.tenantId, editor.id, "system:admin-cli"));
    expect((await decide(await signedIn(editor.id), id, "reject")).status).toBe(200);
    expect(await seen(editor.id, "sensitivity:restricted")).toEqual({ found: [], tags: [] });
  });

  it("checks the request: a session, this origin, JSON, a limit, a value", async () => {
    const id = await proposed("client:globex");
    expect((await app.request("/api/review")).status).toBe(401);
    expect(
      (
        await app.request(`/api/review/${id}/approve`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: PUBLIC },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    const cookie = await signedIn(editor.id);
    // Another site's request can't decide for the person.
    expect(
      (await decide(cookie, id, "approve", {}, { origin: "https://evil.example" })).status,
    ).toBe(403);
    expect((await decide(cookie, id, "approve", {}, { "content-type": "text/plain" })).status).toBe(
      415,
    );
    for (const query of ["?limit=0", "?limit=501", "?limit=x"]) {
      expect((await list(cookie, query)).status, query).toBe(400);
    }
    expect((await list(cookie, "?limit=1")).status).toBe(200);
    for (const into of [undefined, "", "Not A Slug", "a".repeat(129), 7]) {
      expect((await decide(cookie, id, "merge", { into })).status, String(into)).toBe(400);
    }
    // Text that could be a value, and isn't an approved one of the facet: core's to refuse.
    for (const into of ["nope", "acme.co_1", "a".repeat(128)]) {
      const res = await decide(cookie, id, "merge", { into });
      expect([res.status, ((await res.json()) as { code: string }).code], into).toEqual([
        409,
        "invalid",
      ]);
    }
    expect(
      (
        await app.request(`/api/review/${id}/approve`, {
          method: "POST",
          headers: { cookie, origin: PUBLIC, "content-type": "application/json" },
          body: "not json",
        })
      ).status,
    ).toBe(400);
    expect((await decide(cookie, "not-an-id", "approve")).status).toBe(404);
    expect((await decide(cookie, id, "delete")).status).toBe(404);
    // Nothing was decided by any of it.
    expect(await (await list(cookie)).json()).toMatchObject({ items: [{ id }] });
  });
});

describe("GET /api/admin/vocabulary (T-903)", () => {
  it("gives a tenant admin every facet and value, and what waits; nobody else", async () => {
    await proposed("client:globex");
    expect(
      (
        await app.request("/api/admin/vocabulary", {
          headers: { cookie: await signedIn(editor.id) },
        })
      ).status,
    ).toBe(403);
    await inTenant((tx) => grantAdmin(tx, t.tenantId, editor.id, "system:admin-cli"));
    const res = await app.request("/api/admin/vocabulary", {
      headers: { cookie: await signedIn(editor.id) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cut: boolean;
      facets: { key: string; single: boolean; values: { tag: string; waiting: number }[] }[];
    };
    expect(body.cut).toBe(false);
    expect(body.facets.find((f) => f.key === "sensitivity")).toMatchObject({ single: true });
    expect(
      body.facets.find((f) => f.key === "client")?.values.find((v) => v.tag === "client:globex"),
    ).toMatchObject({ approved: true, waiting: 1 });
    expect(JSON.stringify(body)).not.toContain(t.objectId);
  });
});
