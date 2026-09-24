import {
  facets,
  facetValues,
  newId,
  objects,
  objectTags,
  tenants,
  versions,
  type Database,
  type Tx,
} from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { Authorizer, createCedarEngine, type AuthzPrincipal } from "@openhoard/core-policy";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { proposeTag } from "./tagging.js";
import {
  GENERIC_TITLE,
  levelsFor,
  markProcessed,
  nonReaderTitle,
  proposeDisplayTitle,
  setDisplayTitle,
  viewObjects,
  VIEW_TRANSACTION,
  type ObjectView,
} from "./visibility.js";

/* T-603: discoverable hits return title-only cards; hidden files never appear. */

let authz: Authorizer;
beforeAll(() => {
  authz = new Authorizer(createCedarEngine());
});

let db: Database;
let t: SeededTenant;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  await inTenant(async (tx) => {
    await tx.insert(facets).values([
      { tenantId: t.tenantId, key: "kind", label: "Kind", public: true },
      { tenantId: t.tenantId, key: "sensitivity", label: "Sensitivity" },
    ]);
    const value = (facet: string, v: string, more: object = {}) => ({
      tenantId: t.tenantId,
      facet,
      value: v,
      label: v,
      approved: true,
      ...more,
    });
    await tx.insert(facetValues).values([
      value("kind", "report"),
      value("sensitivity", "public", { visibility: "readable", exposure: "full" }),
      value("sensitivity", "internal", {
        visibility: "discoverable",
        exposure: "commercial-only",
      }),
      value("sensitivity", "restricted", { visibility: "hidden", exposure: "local-only" }),
    ]);
    await tx
      .update(tenants)
      .set({ defaultVisibility: "discoverable", defaultExposure: "full" })
      .where(eq(tenants.id, t.tenantId));
  });
});
afterEach(() => db?.close());

const inTenant = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work);
const levels = async (id = t.objectId) =>
  (await inTenant((tx) => levelsFor(tx, t.tenantId, [id]))).get(id);
const SEEDED_TITLE = "Report 1.docx";
const processed = (title = SEEDED_TITLE) =>
  inTenant((tx) => markProcessed(tx, t.tenantId, { versionId: t.versionId, title }));
const tag = (tagValue: string, objectId = t.objectId, source: "rule" | "model" = "rule") => {
  const [facet, value] = tagValue.split(":") as [string, string];
  return inTenant((tx) =>
    tx.insert(objectTags).values({
      tenantId: t.tenantId,
      objectId,
      facet,
      value,
      source,
      appliedBy: `${source}:test`,
      confidence: 1,
    }),
  );
};

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
const reader = () => person({ userId: "ana", tagGrants: [t.tag] });
const view = (principal: AuthzPrincipal, ids = [t.objectId]) =>
  db.withTenant(
    t.tenantId,
    (tx) =>
      viewObjects(
        tx,
        t.tenantId,
        authz,
        { principal, client: { id: "openhoard-web", trust: "first-party" } },
        ids,
      ),
    VIEW_TRANSACTION,
  );
const hiddenByDefault = () =>
  inTenant((tx) =>
    tx
      .update(tenants)
      .set({ defaultVisibility: "hidden", defaultExposure: "metadata-only" })
      .where(eq(tenants.id, t.tenantId)),
  );
const proposeModelTag = (tagValue: string) =>
  inTenant((tx) =>
    proposeTag(tx, t.tenantId, {
      objectId: t.objectId,
      tag: tagValue,
      source: "model",
      appliedBy: "model:tagger",
      confidence: 0.95,
    }),
  );

describe("levelsFor", () => {
  it("treats an unprocessed object as hidden and metadata-only, whatever its tags", async () => {
    await tag("sensitivity:public");
    expect(await levels()).toEqual({
      visibility: "hidden",
      exposure: "metadata-only",
      processed: false,
    });
    expect(await processed()).toBe(true);
    expect(await processed()).toBe(false);
    expect(await levels()).toEqual({ visibility: "readable", exposure: "full", processed: true });
  });

  it("uses the tenant default without level tags, and the tenant's fail-closed default", async () => {
    await processed();
    expect(await levels()).toMatchObject({ visibility: "discoverable", exposure: "full" });
    const other = await seedTenant(db, 2);
    await db.withTenant(other.tenantId, (tx) =>
      markProcessed(tx, other.tenantId, { versionId: other.versionId, title: "Report 2.docx" }),
    );
    const fresh = await db.withTenant(other.tenantId, (tx) =>
      levelsFor(tx, other.tenantId, [other.objectId]),
    );
    expect(fresh.get(other.objectId)).toMatchObject({
      visibility: "hidden",
      exposure: "metadata-only",
    });
  });

  it("lets the most restrictive tag win, unreviewed model tags included", async () => {
    await processed();
    await tag("sensitivity:public");
    await tag("sensitivity:internal", t.objectId, "model");
    expect(await levels()).toMatchObject({
      visibility: "discoverable",
      exposure: "commercial-only",
    });
  });

  it("applies the levels of a model tag waiting in review", async () => {
    await processed();
    expect(await proposeModelTag("sensitivity:restricted")).toMatchObject({
      applied: false,
      reason: "sensitive",
    });
    expect(await levels()).toMatchObject({ visibility: "hidden", exposure: "local-only" });
  });

  it("never loosens past the default on a model's word: pending or unreviewed", async () => {
    await processed();
    await hiddenByDefault();
    expect(await proposeModelTag("sensitivity:public")).toMatchObject({ reason: "sensitive" });
    expect(await levels()).toMatchObject({ visibility: "hidden", exposure: "metadata-only" });
    await tag("sensitivity:public", t.objectId, "model");
    expect(await levels()).toMatchObject({ visibility: "hidden", exposure: "metadata-only" });
    // Once a person reviews the model's tag, it counts like any other.
    await inTenant((tx) =>
      tx.update(objectTags).set({ reviewed: true }).where(eq(objectTags.value, "public")),
    );
    expect(await levels()).toMatchObject({ visibility: "readable", exposure: "full" });
  });

  it("lets a value nobody approved tighten but never loosen", async () => {
    await processed();
    await inTenant((tx) =>
      tx.insert(facetValues).values([
        {
          tenantId: t.tenantId,
          facet: "sensitivity",
          value: "secret",
          label: "Secret",
          visibility: "hidden",
        },
        {
          tenantId: t.tenantId,
          facet: "sensitivity",
          value: "open",
          label: "Open",
          visibility: "readable",
          exposure: "full",
        },
      ]),
    );
    await hiddenByDefault();
    await tag("sensitivity:open");
    expect(await levels()).toMatchObject({ visibility: "hidden", exposure: "metadata-only" });
    await inTenant((tx) =>
      tx
        .update(tenants)
        .set({ defaultVisibility: "readable", defaultExposure: "full" })
        .where(eq(tenants.id, t.tenantId)),
    );
    await tag("sensitivity:secret");
    expect(await levels()).toMatchObject({ visibility: "hidden", exposure: "full" });
  });

  it("starts a new version unprocessed", async () => {
    await processed();
    await inTenant((tx) =>
      tx.insert(versions).values({
        tenantId: t.tenantId,
        id: newId("version"),
        objectId: t.objectId,
        seq: 2,
        blobId: t.blobId,
        mime: "text/plain",
      }),
    );
    expect(await levels()).toMatchObject({ visibility: "hidden", processed: false });
  });

  it("leaves out unknown ids", async () => {
    const got = await inTenant((tx) => levelsFor(tx, t.tenantId, [newId("object"), t.objectId]));
    expect([...got.keys()]).toEqual([t.objectId]);
    expect((await inTenant((tx) => levelsFor(tx, t.tenantId, []))).size).toBe(0);
  });
});

describe("viewObjects", () => {
  beforeEach(async () => {
    await processed();
    await tag("kind:report");
  });

  it("gives a reader the card with every tag", async () => {
    await tag("sensitivity:restricted");
    expect(await view(reader())).toEqual<ObjectView[]>([
      {
        id: t.objectId,
        shape: "card",
        title: "Report 1.docx",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ownerId: "user:owner-1",
        tags: [t.tag, "kind:report", "sensitivity:restricted"],
        readable: true,
        updatedAt: expect.any(Date),
      },
    ]);
  });

  it("gives a non-reader a title-only card for a discoverable file: public tags only", async () => {
    await tag("sensitivity:internal");
    expect(await view(person())).toEqual<ObjectView[]>([
      {
        id: t.objectId,
        shape: "title-only",
        title: "Report 1.docx",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ownerId: "user:owner-1",
        tags: ["kind:report"],
        requestAccess: true,
      },
    ]);
  });

  it("never shows a hidden file to a non-reader", async () => {
    await tag("sensitivity:restricted");
    expect(await view(person())).toEqual([]);
  });

  it("gives a non-reader the card of a readable file, marked unreadable, public tags only", async () => {
    await tag("sensitivity:public");
    expect(await view(person())).toMatchObject([
      { shape: "card", readable: false, tags: ["kind:report"], title: "Report 1.docx" },
    ]);
  });

  it("shows nothing to non-readers before the current version is processed", async () => {
    await inTenant((tx) =>
      tx.update(versions).set({ processedAt: null }).where(eq(versions.id, t.versionId)),
    );
    expect(await view(person())).toEqual([]);
    expect(await view(reader())).toMatchObject([{ shape: "card", readable: true }]);
  });

  it("lets only active members discover: guests and deprovisioned users see what they read", async () => {
    expect(await view(person({ guest: true }))).toEqual([]);
    expect(await view(person({ active: false }))).toEqual([]);
    expect(await view(reader())).toHaveLength(1);
    expect(await view({ ...reader(), guest: true })).toMatchObject([{ readable: true }]);
    expect(await view({ ...reader(), active: false })).toEqual([]);
  });

  it("widens nothing through an unreviewed model tag", async () => {
    await inTenant((tx) => tx.delete(objectTags).where(eq(objectTags.objectId, t.objectId)));
    await tag(t.tag, t.objectId, "model");
    await tag("sensitivity:restricted");
    expect(await view(reader())).toEqual([]);
  });

  it("keeps the order asked, drops duplicates, deleted objects and unknown ids", async () => {
    const second = newId("object");
    await inTenant(async (tx) => {
      await tx.insert(objects).values({
        tenantId: t.tenantId,
        id: second,
        zoneId: t.zoneId,
        title: "Second.txt",
        ownerId: "user:ana",
      });
      const versionId = newId("version");
      await tx.insert(versions).values({
        tenantId: t.tenantId,
        id: versionId,
        objectId: second,
        seq: 1,
        blobId: t.blobId,
        mime: "text/plain",
      });
      await markProcessed(tx, t.tenantId, { versionId, title: "Second.txt" });
    });
    const got = await view(reader(), [second, newId("object"), t.objectId, second]);
    expect(got.map((v) => v.id)).toEqual([second, t.objectId]);
    expect(got[0]).toMatchObject({ shape: "card", readable: true, title: "Second.txt" });
    await inTenant((tx) =>
      tx.update(objects).set({ deletedAt: new Date() }).where(eq(objects.id, second)),
    );
    expect((await view(reader(), [second])).length).toBe(0);
    expect(await view(reader(), [])).toEqual([]);
  });
});

describe("display titles", () => {
  let seen = SEEDED_TITLE;
  beforeEach(async () => {
    seen = SEEDED_TITLE;
    await processed();
    await tag("sensitivity:internal");
  });
  const titleSeen = async () => ((await view(person()))[0] as { title: string }).title;

  const propose = (title: string, forTitle = seen) =>
    inTenant((tx) =>
      proposeDisplayTitle(tx, t.tenantId, {
        objectId: t.objectId,
        title,
        by: "model:titler",
        forTitle,
      }),
    );
  const decide = (title: string | null, forTitle = seen) =>
    inTenant((tx) =>
      setDisplayTitle(tx, t.tenantId, {
        objectId: t.objectId,
        title,
        by: "user:owner-1",
        forTitle,
      }),
    );
  const rename = async (title: string) => {
    await inTenant((tx) => tx.update(objects).set({ title }).where(eq(objects.id, t.objectId)));
    seen = title;
  };

  it("shows non-readers the generic title while a model's proposal waits for the owner", async () => {
    expect(await propose("HR document")).toBe(true);
    expect(await titleSeen()).toBe(GENERIC_TITLE);
    expect(await view(reader())).toMatchObject([{ title: "Report 1.docx" }]);
    await decide("HR document");
    expect(await titleSeen()).toBe("HR document");
  });

  it("lets the owner's decision stand over later proposals, including a clear", async () => {
    await propose("Document");
    expect(await propose("HR document")).toBe(true);
    await decide("Case file");
    expect(await propose("Other")).toBe(false);
    expect(await titleSeen()).toBe("Case file");
    await decide(null);
    expect(await propose("Other")).toBe(false);
    expect(await titleSeen()).toBe("Report 1.docx");
  });

  it("lets models propose again after a rename, even over the owner's clear", async () => {
    await decide(null);
    await rename("Termination - J Smith.docx");
    expect(await propose("HR document")).toBe(true);
    expect(await titleSeen()).toBe(GENERIC_TITLE);
  });

  it("drops decisions made while looking at a title the object no longer has", async () => {
    await rename("Termination - J Smith.docx");
    expect(await decide(null, SEEDED_TITLE)).toBe(false);
    expect(await propose("Other", SEEDED_TITLE)).toBe(false);
    expect(await propose("HR document")).toBe(true);
    expect(await decide("HR document")).toBe(true);
    expect(await titleSeen()).toBe("HR document");
  });

  it("doesn't mark a renamed object processed on behalf of a run that saw the old title", async () => {
    await inTenant((tx) =>
      tx.update(versions).set({ processedAt: null }).where(eq(versions.id, t.versionId)),
    );
    await rename("Termination - J Smith.docx");
    expect(await processed(SEEDED_TITLE)).toBe(false);
    expect(await view(person())).toEqual([]);
    expect(await processed("Termination - J Smith.docx")).toBe(true);
    expect(await titleSeen()).toBe("Termination - J Smith.docx");
  });

  it("uses the owner's display title on a non-reader's card of a readable file too", async () => {
    await tag("sensitivity:public");
    await inTenant((tx) => tx.delete(objectTags).where(eq(objectTags.value, "internal")));
    await decide("Handbook");
    expect(await view(person())).toMatchObject([{ shape: "card", title: "Handbook" }]);
    expect(await view(reader())).toMatchObject([{ shape: "card", title: "Report 1.docx" }]);
  });

  it("decides a non-reader's title from who flagged it", () => {
    const base = { title: "Real.docx", displayTitle: null, displayTitleBy: null };
    expect(nonReaderTitle(base)).toBe("Real.docx");
    expect(nonReaderTitle({ ...base, displayTitle: "HR", displayTitleBy: "model:x" })).toBe(
      GENERIC_TITLE,
    );
    expect(nonReaderTitle({ ...base, displayTitle: "HR", displayTitleBy: "user:o" })).toBe("HR");
    expect(nonReaderTitle({ ...base, displayTitleBy: "user:o" })).toBe("Real.docx");
    expect(nonReaderTitle({ ...base, displayTitleBy: "pack:x" })).toBe(GENERIC_TITLE);
  });

  it("refuses to read outside one snapshot", async () => {
    await expect(
      inTenant((tx) =>
        viewObjects(
          tx,
          t.tenantId,
          authz,
          { principal: person(), client: { id: "openhoard-web", trust: "first-party" } },
          [t.objectId],
        ),
      ),
    ).rejects.toThrow("repeatable read");
  });

  it("refuses blank or long titles and the wrong kind of author", async () => {
    const run = (title: string | null, by: string, model = false) =>
      inTenant((tx) =>
        model
          ? proposeDisplayTitle(tx, t.tenantId, {
              objectId: t.objectId,
              title: title as string,
              by,
              forTitle: SEEDED_TITLE,
            })
          : setDisplayTitle(tx, t.tenantId, {
              objectId: t.objectId,
              title,
              by,
              forTitle: SEEDED_TITLE,
            }),
      );
    await expect(run("  ", "user:owner-1")).rejects.toThrow("not blank");
    await expect(run("x".repeat(1025), "user:owner-1")).rejects.toThrow("1 to 1024");
    await expect(run("HR", "model:titler")).rejects.toThrow("user: principal");
    await expect(run("HR", "user:owner-1", true)).rejects.toThrow("model: principal");
    expect(
      await inTenant((tx) =>
        setDisplayTitle(tx, t.tenantId, {
          objectId: newId("object"),
          title: "x",
          by: "user:a",
          forTitle: "x",
        }),
      ),
    ).toBe(false);
  });
});
