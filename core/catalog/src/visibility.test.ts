import {
  facets,
  facetValues,
  newId,
  objects,
  objectTags,
  queryRows,
  tenants,
  versions,
  type Database,
  type Tx,
} from "@openhoard/core-db";
import {
  openTestDatabase,
  seedTenant,
  TEST_POSTGRES_ENV,
  type SeededTenant,
} from "@openhoard/core-db/testing";
import { Authorizer, createCedarEngine, type AuthzPrincipal } from "@openhoard/core-policy";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ingest, removeFromSource } from "./ingest.js";
import { proposeTag } from "./tagging.js";
import {
  explainLevels,
  GENERIC_TITLE,
  levelsFor,
  lockCurrentVersion,
  markProcessed,
  markSuperseded,
  MAX_OBJECT_IDS,
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
const inSnapshot = <T>(work: (tx: Tx) => Promise<T>, tenantId = t.tenantId) =>
  db.withTenant(tenantId, work, VIEW_TRANSACTION);
const levels = async (id = t.objectId) =>
  (await inSnapshot((tx) => levelsFor(tx, t.tenantId, [id]))).get(id);
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

  it("marks only the current version processed; a replaced one only as superseded", async () => {
    const v2 = newId("version");
    await inTenant((tx) =>
      tx.insert(versions).values({
        tenantId: t.tenantId,
        id: v2,
        objectId: t.objectId,
        seq: 2,
        blobId: t.blobId,
        mime: "text/plain",
      }),
    );
    const standing = (versionId: string, title = SEEDED_TITLE) =>
      inTenant((tx) => lockCurrentVersion(tx, t.tenantId, { versionId, title }));
    expect(await standing(t.versionId)).toBe("superseded");
    // Superseded before renamed: a replaced version is done under any title.
    expect(await standing(t.versionId, "Other.docx")).toBe("superseded");
    expect(await standing(v2)).toBe("current");
    expect(await standing(v2, "Other.docx")).toBe("renamed");
    expect(await standing(newId("version"))).toBe("gone");
    // A job that read version 1 can't make the object visible once version 2 exists.
    expect(await processed()).toBe(false);
    expect(await levels()).toMatchObject({ processed: false, visibility: "hidden" });
    const superseded = (versionId: string) =>
      inTenant((tx) => markSuperseded(tx, t.tenantId, versionId));
    expect(await superseded(v2)).toBe(false);
    expect(await superseded(t.versionId)).toBe(true);
    expect(await superseded(t.versionId)).toBe(false);
    // Given up on, not processed: it says so, and changes nothing the current one allows.
    const [old] = await inTenant((tx) =>
      tx
        .select({ processedAt: versions.processedAt, supersededAt: versions.supersededAt })
        .from(versions)
        .where(eq(versions.id, t.versionId)),
    );
    expect(old).toEqual({ processedAt: null, supersededAt: expect.any(Date) });
    expect(await levels()).toMatchObject({ processed: false, visibility: "hidden" });
    expect(
      await inTenant((tx) => markProcessed(tx, t.tenantId, { versionId: v2, title: SEEDED_TITLE })),
    ).toBe(true);
    expect(await levels()).toMatchObject({ processed: true, visibility: "discoverable" });
  });

  it("uses the tenant default without level tags, and the tenant's fail-closed default", async () => {
    await processed();
    expect(await levels()).toMatchObject({ visibility: "discoverable", exposure: "full" });
    const other = await seedTenant(db, 2);
    await db.withTenant(other.tenantId, (tx) =>
      markProcessed(tx, other.tenantId, { versionId: other.versionId, title: "Report 2.docx" }),
    );
    const fresh = await inSnapshot(
      (tx) => levelsFor(tx, other.tenantId, [other.objectId]),
      other.tenantId,
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
    const got = await inSnapshot((tx) => levelsFor(tx, t.tenantId, [newId("object"), t.objectId]));
    expect([...got.keys()]).toEqual([t.objectId]);
    expect((await inSnapshot((tx) => levelsFor(tx, t.tenantId, []))).size).toBe(0);
  });

  it("refuses to read outside one snapshot, where a review could slip between its reads", async () => {
    await expect(inTenant((tx) => levelsFor(tx, t.tenantId, [t.objectId]))).rejects.toThrow(
      "levelsFor needs a repeatable read transaction",
    );
    await expect(inTenant((tx) => explainLevels(tx, t.tenantId, t.objectId))).rejects.toThrow(
      "explainLevels needs a repeatable read transaction",
    );
    const serializable = await db.withTenant(
      t.tenantId,
      (tx) => explainLevels(tx, t.tenantId, t.objectId),
      { isolationLevel: "serializable" },
    );
    expect(serializable).toMatchObject({ processed: false });
  });

  it("takes at most MAX_OBJECT_IDS distinct ids: page your ids", async () => {
    const many = Array.from({ length: MAX_OBJECT_IDS - 1 }, () => newId("object"));
    // Repeats don't count: this is exactly MAX_OBJECT_IDS.
    const got = await inSnapshot((tx) => levelsFor(tx, t.tenantId, [...many, ...many, t.objectId]));
    expect([...got.keys()]).toEqual([t.objectId]);
    expect(await view(reader(), [...many, t.objectId])).toMatchObject([{ id: t.objectId }]);
    await expect(
      inSnapshot((tx) => levelsFor(tx, t.tenantId, [...many, newId("object"), newId("object")])),
    ).rejects.toThrow(RangeError);
    await expect(view(person(), [...many, newId("object"), newId("object")])).rejects.toThrow(
      "page your ids",
    );
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
        primaryTag: null,
      },
    ]);
  });

  it("shows the home to a reader, and to others only when it is a tag they see", async () => {
    await inTenant((tx) =>
      tx
        .update(objectTags)
        .set({ primaryBy: "user:owner-1" })
        .where(eq(objectTags.value, "report")),
    );
    await tag("sensitivity:internal");
    expect(await view(reader())).toMatchObject([{ primaryTag: "kind:report" }]);
    expect(await view(person())).toMatchObject([
      { shape: "title-only", primaryTag: "kind:report" },
    ]);
    // A home that isn't a public tag stays with readers.
    await inTenant(async (tx) => {
      await tx.update(objectTags).set({ primaryBy: null });
      await tx
        .update(objectTags)
        .set({ primaryBy: "user:owner-1" })
        .where(eq(objectTags.value, t.tag.split(":")[1] ?? ""));
    });
    expect(await view(reader())).toMatchObject([{ primaryTag: t.tag }]);
    expect(await view(person())).toMatchObject([{ primaryTag: null }]);
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
        primaryTag: null,
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

  it("lets a pack's forbid see a model's unreviewed guess", async () => {
    const strict = new Authorizer(
      createCedarEngine({
        "pack/no-restricted": `forbid (principal, action, resource)
          when { resource.allTags.contains("sensitivity:restricted") };`,
      }),
    );
    await tag("sensitivity:restricted", t.objectId, "model");
    const got = await db.withTenant(
      t.tenantId,
      (tx) =>
        viewObjects(
          tx,
          t.tenantId,
          strict,
          { principal: reader(), client: { id: "openhoard-web", trust: "first-party" } },
          [t.objectId],
        ),
      VIEW_TRANSACTION,
    );
    // The reader's grant no longer reads it, and the guess hides it from non-readers.
    expect(got).toEqual([]);
  });

  it("shows non-readers only trusted public tags, never a model's unreviewed guess", async () => {
    await tag("sensitivity:internal");
    await inTenant((tx) =>
      tx.insert(facetValues).values({
        tenantId: t.tenantId,
        facet: "kind",
        value: "memo",
        label: "Memo",
        approved: true,
      }),
    );
    await tag("kind:memo", t.objectId, "model");
    expect(await view(person())).toMatchObject([{ shape: "title-only", tags: ["kind:report"] }]);
    expect((await view(reader()))[0]?.tags).toContain("kind:memo");
    await inTenant((tx) =>
      tx.update(objectTags).set({ reviewed: true }).where(eq(objectTags.value, "memo")),
    );
    expect(await view(person())).toMatchObject([{ tags: ["kind:memo", "kind:report"] }]);
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

describe.runIf(process.env[TEST_POSTGRES_ENV])("under concurrency (PostgreSQL)", () => {
  const RENAMED = "Termination - J Smith.docx";
  /** Waits until another session of this database waits on a lock. */
  const someoneWaits = async () => {
    for (let i = 0; i < 500; i++) {
      const [row] = await inTenant((tx) =>
        queryRows<{ n: number }>(
          tx,
          sql`select count(*)::int as n from pg_locks l join pg_stat_activity a on a.pid = l.pid
            where not l.granted and a.datname = current_database()`,
        ),
      );
      if ((row?.n ?? 0) > 0) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("no session started waiting");
  };
  /** An ingest renaming the seeded object, its transaction held open until released. */
  const renameAndHold = () => {
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    let signal = () => {};
    const renamed = new Promise<void>((r) => (signal = r));
    const committed = inTenant(async (tx) => {
      const r = await ingest(tx, t.tenantId, {
        source: "sharepoint",
        externalId: t.externalId,
        zoneId: t.zoneId,
        title: RENAMED,
        ownerId: `user:${t.userId}`,
        content: { blobId: t.blobId, size: 1234 },
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
      expect(r).toMatchObject({ renamed: true, created: { version: false } });
      signal();
      await held;
    });
    return { renamed, release, committed };
  };

  it("doesn't mark processed under the old title when a rename commits while it waits", async () => {
    const rename = renameAndHold();
    await rename.renamed;
    const marking = processed(SEEDED_TITLE);
    await someoneWaits();
    rename.release();
    await rename.committed;
    expect(await marking).toBe(false);
    expect(await levels()).toMatchObject({ processed: false, visibility: "hidden" });
    expect(await processed(RENAMED)).toBe(true);
  });

  it("takes the object's lock before its row for display titles, so ingest can't deadlock", async () => {
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    let signal = () => {};
    const decided = new Promise<void>((r) => (signal = r));
    const owner = inTenant(async (tx) => {
      const set = await setDisplayTitle(tx, t.tenantId, {
        objectId: t.objectId,
        title: "HR document",
        by: "user:owner-1",
        forTitle: SEEDED_TITLE,
      });
      signal();
      await held;
      // Tagging in the same transaction takes the object's lock again: it is already ours.
      const tagged = await proposeTag(tx, t.tenantId, {
        objectId: t.objectId,
        tag: "kind:report",
        source: "user",
        appliedBy: "user:owner-1",
        confidence: 1,
      });
      return { set, tagged };
    });
    await decided;
    const rename = renameAndHold();
    await someoneWaits();
    release();
    expect(await owner).toMatchObject({ set: true, tagged: { applied: true } });
    await rename.renamed;
    rename.release();
    await rename.committed;
  });

  it("takes the object's lock before its row when a source removes it, so marking can't deadlock", async () => {
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    let signal = () => {};
    const removed = new Promise<void>((r) => (signal = r));
    const remover = inTenant(async (tx) => {
      const id = await removeFromSource(tx, t.tenantId, "sharepoint", t.externalId);
      signal();
      await held;
      const tagged = await proposeTag(tx, t.tenantId, {
        objectId: t.objectId,
        tag: "kind:report",
        source: "user",
        appliedBy: "user:owner-1",
        confidence: 1,
      });
      return { id, tagged };
    });
    await removed;
    const marking = processed(SEEDED_TITLE);
    await someoneWaits();
    release();
    expect(await remover).toMatchObject({ id: t.objectId, tagged: { applied: true } });
    await marking;
  });
});
