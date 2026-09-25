import {
  facets,
  facetValues,
  newId,
  objects,
  objectTags,
  tagReviews,
  tenants,
  versions,
  type Database,
  type Tx,
} from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import {
  Authorizer,
  createCedarEngine,
  type AuthzPrincipal,
  type Visibility,
} from "@openhoard/core-policy";
import { and, eq } from "drizzle-orm";
import fc from "fast-check";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SEARCH_CANDIDATES, searchObjects, type SearchQuery } from "./search.js";
import {
  proposeDisplayTitle,
  setDisplayTitle,
  VIEW_TRANSACTION,
  viewObjects,
  type ViewRequest,
} from "./visibility.js";

/* T-504: search behind policy, the access filter inside the query and the gate after it. */

let authz: Authorizer;
beforeAll(() => {
  authz = new Authorizer(createCedarEngine());
});

let db: Database;
let t: SeededTenant;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  await write(async (tx) => {
    await tx.insert(facets).values([
      { tenantId: t.tenantId, key: "sensitivity", label: "S" },
      { tenantId: t.tenantId, key: "kind", label: "Kind", public: true },
    ]);
    const level = (value: string, visibility: Visibility | null, approved = true) => ({
      tenantId: t.tenantId,
      facet: "sensitivity",
      value,
      label: value,
      approved,
      visibility,
      exposure: visibility === null ? null : ("full" as const),
    });
    await tx
      .insert(facetValues)
      .values([
        level("public", "readable"),
        level("internal", "discoverable"),
        level("restricted", "hidden"),
        level("proposed", "hidden", false),
        { tenantId: t.tenantId, facet: "kind", value: "report", label: "Report", approved: true },
      ]);
    await tx
      .update(tenants)
      .set({ defaultVisibility: "discoverable", defaultExposure: "full" })
      .where(eq(tenants.id, t.tenantId));
    await tx.update(versions).set({ processedAt: new Date() });
  });
});
afterEach(() => db?.close());

const write = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work);
const setDefault = (visibility: Visibility) =>
  db.withTenant(t.tenantId, (tx) =>
    tx
      .update(tenants)
      .set({ defaultVisibility: visibility, defaultExposure: "full" })
      .where(eq(tenants.id, t.tenantId)),
  );
const person = (more: Partial<AuthzPrincipal> = {}): AuthzPrincipal => ({
  userId: "bo",
  groupIds: [],
  tagGrants: [],
  tagWriteGrants: [],
  objectGrants: [],
  objectWriteGrants: [],
  guest: false,
  active: true,
  ...more,
});
const request = (principal: AuthzPrincipal): ViewRequest => ({
  principal,
  client: { id: "openhoard-web", trust: "first-party" },
});
const search = (principal: AuthzPrincipal, query: string | SearchQuery = "", gate = authz) =>
  db.withTenant(
    t.tenantId,
    (tx) =>
      searchObjects(
        tx,
        t.tenantId,
        gate,
        request(principal),
        typeof query === "string" ? { query } : query,
      ),
    VIEW_TRANSACTION,
  );
const ids = async (principal: AuthzPrincipal, query: string | SearchQuery = "") =>
  (await search(principal, query)).hits.map((h) => h.id);
const tag = (value: string, more: Partial<typeof objectTags.$inferInsert> = {}) =>
  write((tx) =>
    tx.insert(objectTags).values({
      tenantId: t.tenantId,
      objectId: t.objectId,
      facet: value.split(":")[0] ?? "",
      value: value.split(":")[1] ?? "",
      source: "rule",
      appliedBy: "rule:x",
      confidence: 1,
      ...more,
    }),
  );

describe("searchObjects", () => {
  it("finds what the caller can read: by an object grant, a tag grant, or as the owner", async () => {
    await setDefault("hidden");
    expect(await ids(person())).toEqual([]);
    expect(await ids(person({ objectGrants: [t.objectId] }))).toEqual([t.objectId]);
    expect(await ids(person({ tagGrants: [t.tag] }))).toEqual([t.objectId]);
    expect(await ids(person({ userId: "owner-1" }))).toEqual([t.objectId]);
  });

  it("lets no model guess widen access, as grants don't", async () => {
    await setDefault("hidden");
    await tag("kind:report", { source: "model", appliedBy: "model:m", confidence: 0.9 });
    expect(await ids(person({ tagGrants: ["kind:report"] }))).toEqual([]);
  });

  it("matches words in the title, and ranks by them", async () => {
    const reader = person({ tagGrants: [t.tag] });
    expect(await ids(reader, "report")).toEqual([t.objectId]);
    expect(await ids(reader, "invoice")).toEqual([]);
    expect(await search(reader, "report")).toMatchObject({ total: 1, totalIsLowerBound: false });
    // Words next to an extension, an underscore or a path separator still match on their own.
    await write((tx) => tx.update(objects).set({ title: "Q3_forecast/final canary-1a2b.xlsx" }));
    for (const query of [
      "forecast",
      "final",
      "xlsx",
      "canary-1a2b",
      "canary-1a2b.xlsx",
      "q3_forecast",
    ]) {
      expect(await ids(reader, query), query).toEqual([t.objectId]);
    }
    expect(await ids(reader, "forecast.pdf")).toEqual([]);
  });

  it("matches a non-reader only against what they are shown", async () => {
    // A model's display title waits: non-readers see "Document" and match nothing else.
    await write((tx) =>
      proposeDisplayTitle(tx, t.tenantId, {
        objectId: t.objectId,
        title: "Quarterly figures",
        by: "model:m",
        forTitle: "Report 1.docx",
      }),
    );
    expect(await ids(person(), "report")).toEqual([]);
    expect(await ids(person(), "document")).toEqual([t.objectId]);
    // The owner's display title is what they see and match.
    await write((tx) =>
      setDisplayTitle(tx, t.tenantId, {
        objectId: t.objectId,
        title: "Quarterly figures",
        by: "user:owner-1",
        forTitle: "Report 1.docx",
      }),
    );
    expect(await ids(person(), "quarterly")).toEqual([t.objectId]);
    expect(await ids(person(), "report")).toEqual([]);
    // A reader matches the real title.
    expect(await ids(person({ tagGrants: [t.tag] }), "report")).toEqual([t.objectId]);
  });

  it("lets tag terms match only tags the caller is shown", async () => {
    await tag("kind:report");
    await tag("sensitivity:internal");
    // A non-reader sees trusted tags of public facets only.
    expect(await ids(person(), "kind:report")).toEqual([t.objectId]);
    expect(await ids(person(), "sensitivity:internal")).toEqual([]);
    expect(await ids(person(), t.tag)).toEqual([]);
    const reader = person({ tagGrants: [t.tag] });
    expect(await ids(reader, "sensitivity:internal")).toEqual([t.objectId]);
    expect(await ids(reader, `${t.tag} report`)).toEqual([t.objectId]);
  });

  it("lets members discover by level, and never guests, service accounts or the inactive", async () => {
    expect(await ids(person())).toEqual([t.objectId]);
    for (const who of [
      person({ guest: true }),
      person({ service: true }),
      person({ active: false }),
    ]) {
      expect(await ids(who)).toEqual([]);
    }
    await tag("sensitivity:restricted");
    expect(await ids(person())).toEqual([]);
    expect(await ids(person({ tagGrants: [t.tag] }))).toEqual([t.objectId]);
  });

  it("counts and shows only what the gate allows: a pack's forbid is never counted", async () => {
    const forbid = (action: string) =>
      new Authorizer(
        createCedarEngine({
          "pack/no-acme": `forbid (principal, ${action}, resource) when { resource.allTags.contains("${t.tag}") };`,
        }),
      );
    const noRead = forbid(`action == OpenHoard::Action::"read"`);
    await setDefault("hidden");
    const reader = person({ tagGrants: [t.tag] });
    expect(await search(reader, "", noRead)).toEqual({
      hits: [],
      total: 0,
      totalIsLowerBound: false,
    });
    // A forbid on read makes the caller a non-reader: a discoverable file still lists, title only.
    await setDefault("discoverable");
    expect((await search(reader, "", noRead)).hits).toMatchObject([
      { id: t.objectId, shape: "title-only" },
    ]);
    // A forbid on search (or on everything) takes it out of search, for readers and members.
    for (const gate of [forbid(`action == OpenHoard::Action::"search"`), forbid("action")]) {
      expect(await search(reader, "", gate)).toMatchObject({ hits: [], total: 0 });
      expect(await search(person(), "", gate)).toMatchObject({ hits: [], total: 0 });
    }
  });

  it("matches a caller a pack forbids only against what they are then shown", async () => {
    const noRead = new Authorizer(
      createCedarEngine({
        "pack/no-acme": `forbid (principal, action == OpenHoard::Action::"read", resource) when { resource.allTags.contains("${t.tag}") };`,
      }),
    );
    await write((tx) =>
      setDisplayTitle(tx, t.tenantId, {
        objectId: t.objectId,
        title: "Quarterly figures",
        by: "user:owner-1",
        forTitle: "Report 1.docx",
      }),
    );
    await tag("sensitivity:internal");
    await tag("kind:report");
    const reader = person({ tagGrants: [t.tag] });
    const found = async (query: string) =>
      (await search(reader, query, noRead)).hits.map((h) => h.id);
    // The grant holder is a non-reader here: the real title and hidden tags match nothing.
    for (const query of ["report", "sensitivity:internal", t.tag]) {
      expect(await found(query), query).toEqual([]);
      expect((await search(reader, query, noRead)).total, query).toBe(0);
    }
    expect(await found("quarterly")).toEqual([t.objectId]);
    expect(await found("kind:report")).toEqual([t.objectId]);
    // Without the forbid, the same caller reads it and matches the real title and every tag.
    expect(await ids(reader, "report")).toEqual([t.objectId]);
    expect(await ids(reader, "sensitivity:internal")).toEqual([t.objectId]);
  });

  it("orders title-only views without their update time, which they don't show", async () => {
    const other = await write(async (tx) => {
      const id = newId("object");
      await tx.insert(objects).values({
        tenantId: t.tenantId,
        id,
        zoneId: t.zoneId,
        title: "Other.txt",
        ownerId: "user:bo",
      });
      await tx.insert(versions).values({
        tenantId: t.tenantId,
        id: newId("version"),
        objectId: id,
        seq: 1,
        blobId: t.blobId,
        mime: "text/plain",
        processedAt: new Date(),
      });
      return id;
    });
    const order = async () => (await search(person(), "")).hits.map((h) => h.id);
    const before = await order();
    expect(before).toHaveLength(2);
    for (const id of [t.objectId, other]) {
      await write((tx) =>
        tx
          .update(objects)
          .set({ updatedAt: new Date(Date.now() + 60_000) })
          .where(eq(objects.id, id)),
      );
      expect(await order()).toEqual(before);
    }
    // A reader's cards do show it, newest first.
    const both = person({ userId: "owner-1", objectGrants: [other] });
    await write((tx) =>
      tx
        .update(objects)
        .set({ updatedAt: new Date(Date.now() + 120_000) })
        .where(eq(objects.id, other)),
    );
    expect(await ids(both)).toEqual([other, t.objectId]);
  });

  it("doesn't find a file readable only through a pack permit (option 1; see search.ts)", async () => {
    await setDefault("hidden");
    const open = new Authorizer(
      createCedarEngine({ "pack/all-read": "permit (principal, action, resource);" }),
    );
    expect((await search(person(), "", open)).hits).toEqual([]);
    // The gate would allow it by id.
    const [view] = await db.withTenant(
      t.tenantId,
      (tx) => viewObjects(tx, t.tenantId, open, request(person()), [t.objectId]),
      VIEW_TRANSACTION,
    );
    expect(view).toMatchObject({ shape: "card", readable: true });
    // Discoverable, it is found as anyone would find it (the display title), and shown in full.
    await setDefault("discoverable");
    await write((tx) =>
      setDisplayTitle(tx, t.tenantId, {
        objectId: t.objectId,
        title: "Quarterly figures",
        by: "user:owner-1",
        forTitle: "Report 1.docx",
      }),
    );
    expect((await search(person(), "quarterly", open)).hits).toMatchObject([
      { id: t.objectId, shape: "card", readable: true, title: "Report 1.docx" },
    ]);
    expect((await search(person(), "report", open)).hits).toEqual([]);
  });

  it("keeps a key's search within its scope", async () => {
    const bot = (zones: string[], zoneIds?: string[]) =>
      person({
        service: true,
        objectGrants: [t.objectId],
        scope: { actions: ["read", "search"], zones, ...(zoneIds ? { zoneIds } : {}) },
      });
    expect(await ids(bot(["indexed"]))).toEqual([t.objectId]);
    expect(await ids(bot(["managed"]))).toEqual([]);
    expect(await ids(bot(["indexed"], ["zon_00000000000000000000000000"]))).toEqual([]);
    expect(await ids(bot(["indexed"], [t.zoneId]))).toEqual([t.objectId]);
    expect(
      await ids(
        person({
          service: true,
          objectGrants: [t.objectId],
          scope: { actions: ["open"], zones: ["indexed"] },
        }),
      ),
    ).toEqual([]);
    // Reading isn't searching: a key needs both.
    for (const actions of [["read"], ["search"]] as const) {
      expect(
        await ids(
          person({
            service: true,
            objectGrants: [t.objectId],
            scope: { actions: [...actions], zones: ["indexed"] },
          }),
        ),
      ).toEqual([]);
    }
  });

  it("returns nothing for odd queries rather than failing, and refuses a bad limit", async () => {
    for (const q of ["\0", "x".repeat(2000), "   ", "!!! & | :*"]) {
      await expect(search(person({ tagGrants: [t.tag] }), q)).resolves.toBeDefined();
    }
    await expect(search(person(), { query: "", limit: 0 })).rejects.toThrow(RangeError);
    await expect(search(person(), { query: "", limit: 101 })).rejects.toThrow(RangeError);
    await expect(
      db.withTenant(t.tenantId, (tx) =>
        searchObjects(tx, t.tenantId, authz, request(person()), { query: "" }),
      ),
    ).rejects.toThrow("repeatable read");
  });

  it("reports a lower bound past the candidates it checks", async () => {
    await write(async (tx) => {
      const rows = Array.from({ length: SEARCH_CANDIDATES + 5 }, (_, i) => ({
        tenantId: t.tenantId,
        id: newId("object"),
        zoneId: t.zoneId,
        title: `Bulk ${i}.txt`,
        ownerId: "user:bo",
      }));
      await tx.insert(objects).values(rows);
      await tx.insert(versions).values(
        rows.map((r) => ({
          tenantId: t.tenantId,
          id: newId("version"),
          objectId: r.id,
          seq: 1,
          blobId: t.blobId,
          mime: "text/plain",
          processedAt: new Date(),
        })),
      );
    });
    const r = await search(person(), { query: "bulk", limit: 5 });
    expect(r).toMatchObject({ total: SEARCH_CANDIDATES, totalIsLowerBound: true });
    expect(r.hits).toHaveLength(5);
  });

  it("finds exactly what the gate shows, over levels, trust, reviews and processing (property)", async () => {
    type LevelTag = { value: string; source: "rule" | "model"; reviewed: boolean };
    const values = ["public", "internal", "restricted", "proposed"];
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<Visibility>("hidden", "discoverable", "readable"),
        fc.boolean(),
        fc.subarray(values).chain((vs) =>
          fc.tuple(
            ...vs.map((value) =>
              fc.record({
                value: fc.constant(value),
                source: fc.constantFrom("rule" as const, "model" as const),
                reviewed: fc.boolean(),
              }),
            ),
          ),
        ),
        fc.subarray(values, { maxLength: 2 }),
        fc.boolean(),
        async (fallback, processed, levelTags: LevelTag[], pending, reader) => {
          await setDefault(fallback);
          await write(async (tx) => {
            await tx
              .delete(objectTags)
              .where(and(eq(objectTags.objectId, t.objectId), eq(objectTags.facet, "sensitivity")));
            await tx.delete(tagReviews);
            await tx.update(versions).set({ processedAt: processed ? new Date() : null });
            for (const l of levelTags) {
              // The database keeps unapproved values out of object tags; they live in review.
              if (l.value === "proposed") continue;
              await tx.insert(objectTags).values({
                tenantId: t.tenantId,
                objectId: t.objectId,
                facet: "sensitivity",
                value: l.value,
                source: l.source,
                appliedBy: `${l.source}:x`,
                confidence: 0.9,
                reviewed: l.reviewed,
              });
            }
            for (const value of pending) {
              if (levelTags.some((l) => l.value === value && l.value !== "proposed")) continue;
              await tx.insert(tagReviews).values({
                tenantId: t.tenantId,
                id: newId("review"),
                objectId: t.objectId,
                facet: "sensitivity",
                value,
                reason: "sensitive",
                source: "model",
                appliedBy: "model:x",
                confidence: 0.9,
              });
            }
          });
          const who = reader ? person({ tagGrants: [t.tag] }) : person();
          const found = await ids(who);
          const shown = await db.withTenant(
            t.tenantId,
            (tx) => viewObjects(tx, t.tenantId, authz, request(who), [t.objectId]),
            VIEW_TRANSACTION,
          );
          expect(found).toEqual(shown.map((v) => v.id));
        },
      ),
      { numRuns: 60 },
    );
  });
});
