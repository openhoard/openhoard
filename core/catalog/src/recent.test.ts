import { newId, objects, versions, type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { Authorizer, createCedarEngine, type AuthzPrincipal } from "@openhoard/core-policy";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeActivity, type ActivityInput } from "./activity.js";
import { recentObjects, type RecentQuery } from "./recent.js";
import { VIEW_TRANSACTION } from "./visibility.js";

/* T-506: `recent` from the activity log, by the caller, action, time range and media type. */

const authz = new Authorizer(createCedarEngine());
const ANA = "usr_01k5xr3c8v0q6m2d4n7p9s1t3w";
const BO = "usr_01k5xr3c8v0q6m2d4n7p9s1t3x";
const CSV = "text/csv";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const claude = { id: "claude", trust: "commercial" } as const;

let db: Database;
let t: SeededTenant;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
});
afterEach(() => db?.close());

const principal = (userId: string): AuthzPrincipal => ({
  userId,
  groupIds: [],
  tagGrants: [],
  tagWriteGrants: [],
  objectGrants: [],
  objectWriteGrants: [],
  guest: false,
  active: true,
});

/** A processed file, owned by `owner` (a user id). */
async function file(title: string, mime: string, owner = ANA): Promise<string> {
  const objectId = newId("object");
  await db.withTenant(t.tenantId, async (tx) => {
    await tx.insert(objects).values({
      tenantId: t.tenantId,
      id: objectId,
      zoneId: t.zoneId,
      title,
      ownerId: `user:${owner}`,
    });
    await tx.insert(versions).values({
      tenantId: t.tenantId,
      id: newId("version"),
      objectId,
      seq: 1,
      blobId: t.blobId,
      mime,
      processedAt: sql`now()`,
    });
  });
  return objectId;
}

const events = (list: ActivityInput[]) =>
  db.withTenant(t.tenantId, (tx) => writeActivity(tx, t.tenantId, list));
const recent = (query: RecentQuery = {}, userId = ANA) =>
  db.withTenant(
    t.tenantId,
    (tx) =>
      recentObjects(tx, t.tenantId, authz, { principal: principal(userId), client: claude }, query),
    VIEW_TRANSACTION,
  );
const ev = (
  type: "view" | "open" | "edit",
  objectId: string,
  at: string,
  actor = ANA,
): ActivityInput => ({ type, actor: `user:${actor}`, objectId, at: new Date(at), client: claude });

describe("recentObjects", () => {
  it('answers "CSV files I opened yesterday" from the caller\'s own opens', async () => {
    const opened = await file("Vendors.csv", CSV);
    const viewed = await file("Prices.csv", CSV);
    const sheet = await file("Budget.xlsx", XLSX);
    const today = await file("Today.csv", CSV);
    const before = await file("Older.csv", CSV);
    const bos = await file("Bo's export.csv", CSV, BO);
    await events([
      ev("open", opened, "2026-09-25T10:00:00Z"),
      ev("view", viewed, "2026-09-25T11:00:00Z"),
      ev("open", sheet, "2026-09-25T12:00:00Z"),
      ev("open", today, "2026-09-26T09:00:00Z"),
      ev("open", before, "2026-09-24T23:59:59Z"),
      // Bo's opens are Bo's: never in Ana's answer.
      ev("open", bos, "2026-09-25T13:00:00Z", BO),
    ]);
    const yesterday = { from: new Date("2026-09-25T00:00:00Z"), to: new Date("2026-09-26T00:00Z") };
    const got = await recent({ types: ["open"], mimes: [CSV], ...yesterday });
    expect(got.items.map((i) => i.view.title)).toEqual(["Vendors.csv"]);
    expect(got).toMatchObject({ total: 1, historyTruncated: false });
    expect(got.items[0]).toMatchObject({ lastType: "open", events: 1 });
    expect(got.items[0]?.lastAt.toISOString()).toBe("2026-09-25T10:00:00.000Z");
    // Viewed or opened, any type: newest first.
    const all = await recent(yesterday);
    expect(all.items.map((i) => i.view.title)).toEqual([
      "Budget.xlsx",
      "Prices.csv",
      "Vendors.csv",
    ]);
    // Bo sees only his own.
    expect((await recent(yesterday, BO)).items.map((i) => i.view.id)).toEqual([bos]);
  });

  it("shows every file only as the gate does: lost, hidden and deleted files drop out", async () => {
    const mine = await file("Mine.csv", CSV);
    // Ana opened Bo's file once (a grant since revoked, say): hidden to her now.
    const lost = await file("Bo's secret.csv", CSV, BO);
    const gone = await file("Gone.csv", CSV);
    await events([
      ev("open", mine, "2026-09-25T10:00:00Z"),
      ev("open", lost, "2026-09-25T11:00:00Z"),
      ev("open", gone, "2026-09-25T12:00:00Z"),
    ]);
    await db.withTenant(t.tenantId, (tx) =>
      tx
        .update(objects)
        .set({ deletedAt: sql`now()` })
        .where(and(eq(objects.tenantId, t.tenantId), eq(objects.id, gone))),
    );
    const got = await recent();
    expect(got.items.map((i) => i.view.id)).toEqual([mine]);
    expect(got.total).toBe(1);
  });

  it("groups a file's events, and pages with an offset", async () => {
    const a = await file("A.csv", CSV);
    const b = await file("B.csv", CSV);
    const c = await file("C.csv", CSV);
    await events([
      ev("view", a, "2026-09-20T10:00:00Z"),
      ev("edit", a, "2026-09-21T10:00:00Z"),
      ev("open", b, "2026-09-22T10:00:00Z"),
      ev("open", c, "2026-09-23T10:00:00Z"),
      ev("view", a, "2026-09-24T10:00:00Z"),
    ]);
    const first = await recent({ limit: 2 });
    expect(first.items.map((i) => [i.view.title, i.lastType, i.events])).toEqual([
      ["A.csv", "view", 3],
      ["C.csv", "open", 1],
    ]);
    expect(first.total).toBe(3);
    expect((await recent({ limit: 2, offset: 2 })).items.map((i) => i.view.title)).toEqual([
      "B.csv",
    ]);
    expect((await recent({ types: ["edit"] })).items.map((i) => i.view.title)).toEqual(["A.csv"]);
  });

  it("answers nothing for an empty or backwards range, and refuses bad input", async () => {
    const a = await file("A.csv", CSV);
    await events([ev("open", a, "2026-09-25T10:00:00Z")]);
    expect(await recent({ types: [] })).toEqual({ items: [], total: 0, historyTruncated: false });
    expect((await recent({ mimes: [] })).total).toBe(0);
    const at = new Date("2026-09-25T00:00:00Z");
    expect((await recent({ from: at, to: at })).total).toBe(0);
    for (const bad of [
      { limit: 0 },
      { limit: 101 },
      { offset: -1 },
      { offset: 1000 },
      { from: new Date(NaN) },
      { types: ["share"] as unknown as ["view"] },
    ]) {
      await expect(recent(bad), JSON.stringify(bad)).rejects.toThrow(RangeError);
    }
    // Outside a snapshot it fails before reading anything.
    await expect(
      db.withTenant(t.tenantId, (tx) =>
        recentObjects(tx, t.tenantId, authz, { principal: principal(ANA), client: claude }),
      ),
    ).rejects.toThrow(/VIEW_TRANSACTION/);
  });
});
