import { activityEvents, objects, users, type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVITY_PAGE,
  ActivityBuffer,
  listActivity,
  pruneActivity,
  writeActivity,
  type ActivityInput,
} from "./activity.js";
import { blobIdOf, ingest } from "./ingest.js";

/* T-205: the activity log. */

let db: Database;
let t: SeededTenant;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
});
afterEach(() => db?.close());

const ANA = "user:usr_01k5xr3c8v0q6m2d4n7p9s1t3w";
const BO = "user:usr_01k5xr3c8v0q6m2d4n7p9s1t3x";
const web = { id: "openhoard-web", trust: "first-party" } as const;
const claude = { id: "claude-desktop", trust: "commercial" } as const;
const view = (more: Partial<ActivityInput> = {}): ActivityInput => ({
  type: "view",
  actor: ANA,
  objectId: t.objectId,
  client: web,
  ...more,
});
const write = (events: ActivityInput[], tenantId = t.tenantId, repeatWindowMs?: number) =>
  db.withTenant(tenantId, (tx) =>
    writeActivity(tx, tenantId, events, repeatWindowMs === undefined ? {} : { repeatWindowMs }),
  );
const list = (filter: Parameters<typeof listActivity>[2] = {}, tenantId = t.tenantId) =>
  db.withTenant(tenantId, (tx) => listActivity(tx, tenantId, filter));
const at = (iso: string) => new Date(iso);

describe("writeActivity", () => {
  it("stores who did what to which file, through which client", async () => {
    expect(
      await write([view(), view({ type: "open", versionId: t.versionId, client: claude })]),
    ).toBe(2);
    const events = await list();
    expect(events).toHaveLength(2);
    expect(events.find((e) => e.type === "open")).toMatchObject({
      actor: ANA,
      objectId: t.objectId,
      versionId: t.versionId,
      client: claude,
      origin: "openhoard",
      externalId: null,
    });
    expect(events.find((e) => e.type === "view")?.versionId).toBeNull();
  });

  it("merges repeat views and opens within the window, never edits", async () => {
    expect(await write([view(), view(), view()])).toBe(1);
    expect(await write([view()])).toBe(1 - 1);
    // Another client, version, type or person is another event.
    expect(
      await write([
        view({ client: claude }),
        view({ actor: BO }),
        view({ type: "open", versionId: t.versionId }),
        view({ type: "open", versionId: t.versionId }),
      ]),
    ).toBe(3);
    const edit = view({ type: "edit", versionId: t.versionId, client: null });
    expect(await write([edit, edit])).toBe(2);
    // Past the window, a view counts again.
    const old = at("2026-01-01T10:00:00Z");
    expect(await write([view({ actor: BO, at: old })])).toBe(1);
    expect(await write([view({ actor: BO, at: at("2026-01-01T10:14:00Z") })])).toBe(0);
    expect(await write([view({ actor: BO, at: at("2026-01-01T10:16:00Z") })])).toBe(1);
    // A window of 0 merges nothing.
    expect(await write([view(), view()], t.tenantId, 0)).toBe(2);
  });

  it("adds an imported event once, by its id at the origin", async () => {
    const imported = view({
      type: "open",
      origin: "m365-audit",
      externalId: "evt-1",
      at: at("2026-09-01T09:00:00Z"),
    });
    expect(await write([imported])).toBe(1);
    expect(await write([imported, { ...imported, at: at("2026-09-02T09:00:00Z") }])).toBe(0);
    expect(await write([{ ...imported, origin: "other-feed" }])).toBe(1);
    const [first] = await list({
      from: at("2026-09-01T00:00:00Z"),
      to: at("2026-09-01T23:59:59Z"),
    });
    expect(first).toMatchObject({ externalId: "evt-1", at: at("2026-09-01T09:00:00Z") });
  });

  it("checks every event before writing any", async () => {
    const bad: [string, Partial<ActivityInput>][] = [
      ["type", { type: "delete" as never }],
      ["actor", { actor: "ana" }],
      ["actor", { actor: "user:a\0" }],
      ["objectId", { objectId: t.versionId }],
      ["versionId", { versionId: t.objectId }],
      ["client.id", { client: { id: "", trust: "local" } }],
      ["client.id", { client: { id: "x".repeat(257), trust: "local" } }],
      ["client.id", { client: { id: "a\uD800", trust: "local" } }],
      ["client.trust", { client: { id: "c", trust: "root" as never } }],
      ["origin", { origin: "M365" }],
      ["externalId", { externalId: "" }],
      ["at", { at: new Date(NaN) }],
      ["at", { at: new Date(Date.UTC(10000, 0, 1)) }],
    ];
    for (const [field, more] of bad) {
      await expect(write([view(), view(more)]), field).rejects.toThrow(
        new RegExp(`invalid ${field.replace(".", "\\.")}$`),
      );
    }
    expect(await list()).toEqual([]);
    await expect(write(Array.from({ length: ACTIVITY_PAGE + 1 }, () => view()))).rejects.toThrow(
      RangeError,
    );
  });

  it("refuses a version of another file", async () => {
    const other = await seedTenant(db, 2);
    await expect(write([view({ versionId: other.versionId })])).rejects.toThrow();
    // Same tenant, another object's version: the foreign key names the object's versions.
    const ownerId = await someUser();
    const content = await blobIdOf(new Uint8Array(32).fill(3), new TextEncoder().encode("x"));
    const second = await db.withTenant(t.tenantId, async (tx) => {
      const r = await ingest(tx, t.tenantId, {
        source: "sharepoint",
        externalId: "item-other",
        zoneId: t.zoneId,
        title: "Other.csv",
        ownerId,
        content,
      });
      return r.versionId;
    });
    await expect(write([view({ type: "open", versionId: second })])).rejects.toThrow();
  });

  it("keeps each tenant's activity to itself", async () => {
    const other = await seedTenant(db, 2);
    await write([view()]);
    expect(await list({}, other.tenantId)).toEqual([]);
    // Another tenant's file can't be named, even with a matching tenant id in the row.
    await expect(write([view()], other.tenantId)).rejects.toThrow();
  });
});

async function someUser(): Promise<string> {
  const id = "usr_01k5xr3c8v0q6m2d4n7p9s1t3y";
  await db.withTenant(t.tenantId, (tx) =>
    tx
      .insert(users)
      .values({
        tenantId: t.tenantId,
        id,
        email: "ana@example.com",
        emailKey: "ana@example.com",
        displayName: "Ana",
        source: "local",
      })
      .onConflictDoNothing(),
  );
  return `user:${id}`;
}

describe("listActivity", () => {
  it("filters by actor, type, file and time, newest first", async () => {
    await write([
      view({ at: at("2026-09-20T10:00:00Z") }),
      view({ type: "open", versionId: t.versionId, at: at("2026-09-21T10:00:00Z") }),
      view({ actor: BO, at: at("2026-09-22T10:00:00Z") }),
    ]);
    expect((await list()).map((e) => e.at.toISOString().slice(0, 10))).toEqual([
      "2026-09-22",
      "2026-09-21",
      "2026-09-20",
    ]);
    expect((await list({ actor: ANA })).map((e) => e.type)).toEqual(["open", "view"]);
    expect((await list({ actor: ANA, types: ["open"] })).length).toBe(1);
    expect(await list({ types: [] })).toEqual([]);
    expect((await list({ from: at("2026-09-21T00:00:00Z") })).length).toBe(2);
    expect((await list({ to: at("2026-09-21T10:00:00Z") })).length).toBe(1);
    expect((await list({ objectId: t.objectId, limit: 1 })).length).toBe(1);
    await expect(list({ limit: 0 })).rejects.toThrow(RangeError);
    await expect(list({ after: { at: new Date(), id: "nope" } })).rejects.toThrow(RangeError);
    await expect(list({ limit: ACTIVITY_PAGE + 1 })).rejects.toThrow(RangeError);
  });
});

describe("listActivity paging and clients", () => {
  it("pages events that share a time without skipping or repeating any", async () => {
    // One batch: every event at the transaction's now().
    await write(
      Array.from({ length: 7 }, (_, i) =>
        view({ actor: `user:usr_01k5xr3c8v0q6m2d4n7p9s1t${"0123456"[i]}0` }),
      ),
    );
    const seen: string[] = [];
    let after: { at: Date; id: string } | undefined;
    for (;;) {
      const page = await list(after === undefined ? { limit: 3 } : { limit: 3, after });
      seen.push(...page.map((e) => e.id));
      const last = page.at(-1);
      if (page.length < 3 || last === undefined) break;
      after = { at: last.at, id: last.id };
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it("keeps times to whole milliseconds, so a cursor from a row finds its place", async () => {
    await write([view()]);
    const [row] = await db
      .withTenant(t.tenantId, (tx) =>
        tx.execute(
          sql`select (extract(microseconds from at)::bigint % 1000)::int as us from activity_events`,
        ),
      )
      .then((r) => (r as unknown as { rows: { us: number }[] }).rows);
    expect(row?.us).toBe(0);
    await expect(
      db.withTenant(t.tenantId, (tx) =>
        tx.execute(sql`update activity_events set at = at + interval '1 microsecond'`),
      ),
    ).rejects.toThrow();
  });

  it("lists AI reads by client trust", async () => {
    await write([
      view(),
      view({ actor: BO, client: claude }),
      view({ type: "edit", client: null }),
    ]);
    expect(
      (await list({ clientTrusts: ["local", "commercial", "consumer"] })).map((e) => e.actor),
    ).toEqual([BO]);
    expect(await list({ clientTrusts: [] })).toEqual([]);
  });
});

describe("pruneActivity", () => {
  it("removes events from before a time, and nothing else", async () => {
    await write([
      view({ at: at("2026-01-01T00:00:00Z") }),
      view({ actor: BO, at: at("2026-06-01T00:00:00Z") }),
    ]);
    const pruned = await db.withTenant(t.tenantId, (tx) =>
      pruneActivity(tx, t.tenantId, at("2026-03-01T00:00:00Z")),
    );
    expect(pruned).toBe(1);
    expect((await list()).map((e) => e.actor)).toEqual([BO]);
  });

  it("prunes in bounded batches, oldest first", async () => {
    await write(["01", "02", "03"].map((d) => view({ at: at(`2026-01-${d}T00:00:00Z`) })));
    const prune = () =>
      db.withTenant(t.tenantId, (tx) =>
        pruneActivity(tx, t.tenantId, at("2026-02-01T00:00:00Z"), 2),
      );
    expect(await prune()).toBe(2);
    expect((await list()).map((e) => e.at.toISOString().slice(0, 10))).toEqual(["2026-01-03"]);
    expect(await prune()).toBe(1);
    expect(await prune()).toBe(0);
    await expect(
      db.withTenant(t.tenantId, (tx) => pruneActivity(tx, t.tenantId, new Date(), 0)),
    ).rejects.toThrow(RangeError);
  });

  it("goes with its file when the file is purged", async () => {
    await write([view()]);
    await db.withTenant(t.tenantId, (tx) => tx.delete(objects).where(eq(objects.id, t.objectId)));
    const [row] = await db.withTenant(t.tenantId, (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(activityEvents),
    );
    expect(row?.n).toBe(0);
  });
});

describe("ingest", () => {
  const save = async (text: string, authorId?: string, modifiedAt?: Date) => {
    const content = await blobIdOf(new Uint8Array(32).fill(7), new TextEncoder().encode(text));
    const owner = await someUser();
    return db.withTenant(t.tenantId, (tx) =>
      ingest(tx, t.tenantId, {
        source: "sharepoint-main",
        externalId: "item-9",
        zoneId: t.zoneId,
        title: "Budget.csv",
        ownerId: owner,
        content,
        mime: "text/csv",
        ...(authorId === undefined ? {} : { authorId }),
        ...(modifiedAt === undefined ? {} : { modifiedAt }),
      }),
    );
  };

  it("records an edit by the author for every new version, when the source saved it", async () => {
    const saved = at("2026-09-20T08:00:00Z");
    const v1 = await save("a", ANA, saved);
    const unchanged = await save("a", ANA, saved);
    const v2 = await save("b", BO, at("2026-09-21T08:00:00Z"));
    expect(unchanged.created.version).toBe(false);
    // Without the time, or with an author who isn't a user, nothing: a first crawl of years of
    // files isn't today's work, and `recent` looks people up by user.
    await save("c", ANA);
    await save("d", "user:bo@example.com", saved);
    await save("e", undefined, saved);
    const edits = await list({ types: ["edit"] });
    expect(edits.map((e) => [e.actor, e.versionId, e.origin, e.client, e.at])).toEqual([
      [BO, v2.versionId, "sharepoint-main", null, at("2026-09-21T08:00:00Z")],
      [ANA, v1.versionId, "sharepoint-main", null, saved],
    ]);
  });

  it("refuses a modifiedAt it can't store, as invalid input", async () => {
    for (const bad of [new Date(NaN), new Date(Date.UTC(10000, 0, 1)), "2026-01-01" as never]) {
      await expect(save("f", ANA, bad)).rejects.toMatchObject({ code: "invalid" });
    }
  });

  it("writes nothing when it fails", async () => {
    await expect(
      db.withTenant(t.tenantId, async (tx) => {
        await ingest(tx, t.tenantId, {
          source: "sharepoint-main",
          externalId: "item-9",
          zoneId: t.zoneId,
          title: "Budget.csv",
          ownerId: await someUserIn(tx),
          content: await blobIdOf(new Uint8Array(32).fill(7), new TextEncoder().encode("z")),
          authorId: ANA,
          modifiedAt: at("2026-09-20T08:00:00Z"),
        });
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(await list()).toEqual([]);
  });
});

async function someUserIn(tx: Parameters<Parameters<Database["withTenant"]>[1]>[0]) {
  const id = "usr_01k5xr3c8v0q6m2d4n7p9s1t3z";
  await tx.insert(users).values({
    tenantId: t.tenantId,
    id,
    email: "cy@example.com",
    emailKey: "cy@example.com",
    displayName: "Cy",
    source: "local",
  });
  return `user:${id}`;
}

describe("ActivityBuffer", () => {
  it("hands over what it holds once, oldest first, as recorded", () => {
    const buffer = new ActivityBuffer();
    const event = view();
    buffer.record(event);
    buffer.record(view({ actor: BO }));
    (event as { actor: string }).actor = "user:changed";
    expect(buffer.size).toBe(2);
    expect(buffer.take().map((e) => e.actor)).toEqual([ANA, BO]);
    expect(buffer.take()).toEqual([]);
  });
});
