import {
  blobs,
  newId,
  objects,
  sourceRefs,
  users,
  versions,
  zones,
  type Database,
  type Tx,
} from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentHash, scopedBlobId } from "./hash.js";
import {
  blobIdOf,
  ingest,
  IngestError,
  normalizeMime,
  removeFromSource,
  sourceItemState,
  type IngestInput,
} from "./ingest.js";

/* T-204: same content twice → one blob, two refs; unchanged items add no versions. */

const KEY = new Uint8Array(32).fill(7);
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const enc = (s: string) => new TextEncoder().encode(s);
const content = async (text: string) => blobIdOf(KEY, enc(text));

let db: Database;
let t: SeededTenant;
/** The seeded user, Ana, who owns what the tests ingest. */
let owner: string;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  owner = `user:${t.userId}`;
});
afterEach(() => db?.close());

const inTenant = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work);
/** Ingests `text` as item `externalId`, as a .docx unless told; `mime: undefined` sends none. */
const item = async (
  externalId: string,
  text: string,
  more: Partial<Omit<IngestInput, "mime">> & { mime?: string | undefined } = {},
) => {
  const { mime, ...rest } = more;
  const input: IngestInput = {
    source: "sharepoint",
    externalId,
    zoneId: t.zoneId,
    title: "Plan.docx",
    ownerId: owner,
    content: await content(text),
    ...rest,
  };
  if (!("mime" in more)) input.mime = DOCX;
  else if (mime !== undefined) input.mime = mime;
  return inTenant((tx) => ingest(tx, t.tenantId, input));
};
const versionsOf = (objectId: string) =>
  inTenant((tx) =>
    tx.select().from(versions).where(eq(versions.objectId, objectId)).orderBy(asc(versions.seq)),
  );
const objectRow = async (objectId: string) =>
  (await inTenant((tx) => tx.select().from(objects).where(eq(objects.id, objectId))))[0];
const refRow = async (externalId: string) =>
  (
    await inTenant((tx) =>
      tx
        .select()
        .from(sourceRefs)
        .where(and(eq(sourceRefs.source, "sharepoint"), eq(sourceRefs.externalId, externalId))),
    )
  )[0];

describe("ingest", () => {
  it("creates an object, its first version, the blob and the source reference", async () => {
    const r = await item("a", "hello", { url: "https://x/a", etag: "e1", sourceVersion: "c1" });
    expect(r).toMatchObject({
      seq: 1,
      created: { object: true, version: true, blob: true },
      restored: false,
    });
    expect(await objectRow(r.objectId)).toMatchObject({
      zoneId: t.zoneId,
      title: "Plan.docx",
      ownerId: owner,
      deletedAt: null,
    });
    expect(await versionsOf(r.objectId)).toMatchObject([
      { id: r.versionId, seq: 1, blobId: (await content("hello")).blobId, sourceVersion: "c1" },
    ]);
    expect(await refRow("a")).toMatchObject({
      objectId: r.objectId,
      url: "https://x/a",
      etag: "e1",
    });
  });

  it("stores the same content once: two items, one blob, two references", async () => {
    const a = await item("a", "same bytes");
    const b = await item("b", "same bytes");
    expect(a.created.blob).toBe(true);
    expect(b.created).toEqual({ object: true, version: true, blob: false });
    expect(a.objectId).not.toBe(b.objectId);
    const { blobId } = await content("same bytes");
    const rows = await inTenant((tx) => tx.select().from(blobs).where(eq(blobs.id, blobId)));
    expect(rows).toHaveLength(1);
    const refs = await inTenant((tx) =>
      tx.select().from(versions).where(eq(versions.blobId, blobId)),
    );
    expect(refs.map((v) => v.objectId).sort()).toEqual([a.objectId, b.objectId].sort());
  });

  it("adds no version for unchanged content, but refreshes title and reference", async () => {
    const first = await item("a", "v1", { etag: "e1" });
    const again = await item("a", "v1", { etag: "e2", title: "Plan (final).docx" });
    expect(again).toEqual({
      objectId: first.objectId,
      versionId: first.versionId,
      seq: 1,
      created: { object: false, version: false, blob: false },
      restored: false,
      renamed: true,
    });
    expect((await objectRow(first.objectId))?.title).toBe("Plan (final).docx");
    expect((await refRow("a"))?.etag).toBe("e2");
    expect(await versionsOf(first.objectId)).toHaveLength(1);
  });

  it("sends a renamed object back through enrichment, and only a renamed one", async () => {
    const r = await item("a", "v1");
    const processedAt = async () => (await versionsOf(r.objectId))[0]?.processedAt ?? null;
    await inTenant((tx) =>
      tx.update(versions).set({ processedAt: new Date() }).where(eq(versions.id, r.versionId)),
    );
    expect(await item("a", "v1", { etag: "e9" })).toMatchObject({ renamed: false });
    expect(await processedAt()).toBeInstanceOf(Date);
    expect(await item("a", "v1", { title: "Termination - J Smith.docx" })).toMatchObject({
      renamed: true,
      created: { version: false },
    });
    expect(await processedAt()).toBeNull();
  });

  it("adds a version when the content changes, and numbers versions in order", async () => {
    const one = await item("a", "v1");
    const two = await item("a", "v2", { authorId: "user:bo" });
    const back = await item("a", "v1");
    expect([one.seq, two.seq, back.seq]).toEqual([1, 2, 3]);
    expect(two.created).toEqual({ object: false, version: true, blob: true });
    expect(back.created.blob).toBe(false);
    const all = await versionsOf(one.objectId);
    expect(all.map((v) => v.authorId)).toEqual([null, "user:bo", null]);
    expect(all[0]?.blobId).toBe(all[2]?.blobId);
  });

  it("adds a version when only the media type changes", async () => {
    await item("a", "# notes", { mime: "text/plain" });
    const r = await item("a", "# notes", { mime: "text/markdown" });
    expect(r).toMatchObject({ seq: 2, created: { version: true, blob: false } });
  });

  it("keeps the media type when an update doesn't say, and refreshes the source marker", async () => {
    const r = await item("a", "x", { mime: "text/plain", sourceVersion: "c1" });
    const again = await item("a", "x", { mime: undefined, sourceVersion: "c2" });
    expect(again).toMatchObject({ versionId: r.versionId, created: { version: false } });
    const state = await inTenant((tx) => sourceItemState(tx, t.tenantId, "sharepoint", "a"));
    expect(state?.current?.sourceVersion).toBe("c2");
    expect((await versionsOf(r.objectId)).map((v) => v.mime)).toEqual(["text/plain"]);
    // A new object with no media type gets the generic one.
    const b = await item("b", "y", { mime: undefined });
    expect((await versionsOf(b.objectId))[0]?.mime).toBe("application/octet-stream");
  });

  it("keeps owner and zone: a crawl can't hand an object over or move it", async () => {
    const r = await item("a", "x");
    await item("a", "y", { ownerId: `user:${newId("user")}` });
    expect((await objectRow(r.objectId))?.ownerId).toBe(owner);
    const other = newId("zone");
    await inTenant((tx) =>
      tx.insert(zones).values({ tenantId: t.tenantId, id: other, kind: "indexed", name: "Other" }),
    );
    await expect(item("a", "y", { zoneId: other })).rejects.toMatchObject({
      code: "zone-mismatch",
      message: expect.stringContaining(`belongs to zone ${t.zoneId}`),
    });
  });

  it("refuses unknown and foreign zones", async () => {
    await expect(item("a", "x", { zoneId: newId("zone") })).rejects.toMatchObject({
      code: "unknown-zone",
    });
    const other = await seedTenant(db, 2);
    await expect(item("a", "x", { zoneId: other.zoneId })).rejects.toThrow(
      `no zone ${other.zoneId}`,
    );
  });

  it("needs the bytes stored first for a managed zone, and records where", async () => {
    const managed = newId("zone");
    await inTenant((tx) =>
      tx
        .insert(zones)
        .values({ tenantId: t.tenantId, id: managed, kind: "managed", name: "Hoard" }),
    );
    await expect(item("m", "kept", { zoneId: managed })).rejects.toMatchObject({
      code: "needs-location",
    });
    // The same bytes, first indexed elsewhere, gain a location once they are stored.
    const { blobId } = await content("kept");
    await item("i", "kept");
    const loc = `${t.tenantId}/ab/cd/${blobId.slice(4)}`;
    const r = await inTenant(async (tx) =>
      ingest(tx, t.tenantId, {
        source: "upload",
        externalId: "m",
        zoneId: managed,
        title: "Kept.txt",
        ownerId: owner,
        content: { ...(await content("kept")), location: loc },
      }),
    );
    expect(r.created.blob).toBe(false);
    const [row] = await inTenant((tx) => tx.select().from(blobs).where(eq(blobs.id, blobId)));
    expect(row?.location).toBe(loc);
  });

  it("refuses a blob id whose recorded size differs", async () => {
    await item("a", "12345");
    const wrong = { ...(await content("12345")), size: 4 };
    await expect(item("b", "12345", { content: wrong })).rejects.toMatchObject({
      code: "blob-mismatch",
      message: expect.stringContaining("is 5 bytes, not 4"),
    });
  });

  it.each<[string, (i: IngestInput) => IngestInput]>([
    ["a source that isn't a slug", (i) => ({ ...i, source: "Share Point" })],
    ["an empty external id", (i) => ({ ...i, externalId: "" })],
    ["a zone id of another kind", (i) => ({ ...i, zoneId: t.objectId })],
    ["an empty title", (i) => ({ ...i, title: "" })],
    ["a title over 1024 characters", (i) => ({ ...i, title: "é".repeat(1025) })],
    ["an owner that isn't a principal", (i) => ({ ...i, ownerId: "ana" })],
    ["an owner that isn't a user id", (i) => ({ ...i, ownerId: "user:ana" })],
    ["a group as the owner", (i) => ({ ...i, ownerId: `group:${t.groupId}` })],
    ["an owner nobody knows", (i) => ({ ...i, ownerId: `user:${newId("user")}` })],
    ["an author that isn't a principal", (i) => ({ ...i, authorId: "ana@example.com" })],
    ["a raw content hash", (i) => ({ ...i, content: { ...i.content, blobId: "b3:00" } })],
    ["a negative size", (i) => ({ ...i, content: { ...i.content, size: -1 } })],
    ["a fractional size", (i) => ({ ...i, content: { ...i.content, size: 1.5 } })],
    ["an empty location", (i) => ({ ...i, content: { ...i.content, location: "" } })],
    [
      "a location for a zone that isn't managed",
      (i) => ({ ...i, content: { ...i.content, location: "somewhere" } }),
    ],
    ["NUL in the title", (i) => ({ ...i, title: "Plan\0.docx" })],
    ["NUL in the external id", (i) => ({ ...i, externalId: "a\0b" })],
    ["NUL in the author", (i) => ({ ...i, authorId: "user:\0" })],
    ["NUL in the URL", (i) => ({ ...i, url: "https://x/\0" })],
    ["NUL in the eTag", (i) => ({ ...i, etag: "\0" })],
    ["NUL in the source marker", (i) => ({ ...i, sourceVersion: "c\0" })],
    ["NUL in the media type", (i) => ({ ...i, mime: "text/plain\0" })],
    ["an external id over 2048 characters", (i) => ({ ...i, externalId: "x".repeat(2049) })],
    ["a URL over 4096 characters", (i) => ({ ...i, url: `https://x/${"a".repeat(4096)}` })],
    ["an eTag over 1024 characters", (i) => ({ ...i, etag: "e".repeat(1025) })],
    ["a source marker over 1024 characters", (i) => ({ ...i, sourceVersion: "c".repeat(1025) })],
    ["a media type over 1024 characters", (i) => ({ ...i, mime: `text/${"x".repeat(1020)}` })],
  ])("refuses %s before writing anything, and the transaction goes on", async (_, change) => {
    const base: IngestInput = {
      source: "sharepoint",
      externalId: "a",
      zoneId: t.zoneId,
      title: "Plan.docx",
      ownerId: owner,
      content: await content("x"),
    };
    const after = await inTenant(async (tx) => {
      const refused = await ingest(tx, t.tenantId, change(base)).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(IngestError);
      expect(refused).toMatchObject({ code: "invalid" });
      const blobRows = await tx.select().from(blobs).where(eq(blobs.id, base.content.blobId));
      expect(blobRows).toHaveLength(0);
      return ingest(tx, t.tenantId, { ...base, externalId: "next" });
    });
    expect(after.created.object).toBe(true);
  });

  it("gives a new object only to a current user, and lets a retired owner's files sync on", async () => {
    const r = await item("a", "x");
    await inTenant((tx) =>
      tx
        .update(users)
        .set({ retiredAt: new Date(), retiredBy: "system:test" })
        .where(eq(users.id, t.userId)),
    );
    await expect(item("b", "y")).rejects.toMatchObject({
      code: "invalid",
      message: expect.stringContaining("retired"),
    });
    // The existing object keeps its owner, retired or not: offboarding hands files over.
    expect(await item("a", "x2")).toMatchObject({ objectId: r.objectId, seq: 2 });
    expect((await objectRow(r.objectId))?.ownerId).toBe(owner);
  });

  it("refuses a location that differs from the blob's recorded one", async () => {
    const managed = newId("zone");
    await inTenant((tx) =>
      tx
        .insert(zones)
        .values({ tenantId: t.tenantId, id: managed, kind: "managed", name: "Hoard" }),
    );
    const bytes = await content("stored");
    const at = (externalId: string, location: string) =>
      inTenant((tx) =>
        ingest(tx, t.tenantId, {
          source: "upload",
          externalId,
          zoneId: managed,
          title: "Stored.txt",
          ownerId: owner,
          content: { ...bytes, location },
        }),
      );
    await at("m1", "here");
    expect((await at("m2", "here")).created.blob).toBe(false);
    await expect(at("m3", "elsewhere")).rejects.toMatchObject({
      code: "blob-mismatch",
      message: expect.stringContaining("another location"),
    });
    const [row] = await inTenant((tx) => tx.select().from(blobs).where(eq(blobs.id, bytes.blobId)));
    expect(row?.location).toBe("here");
  });

  it("writes nothing for an item refused after the checks, such as a zone mismatch", async () => {
    await item("a", "x");
    const other = newId("zone");
    await inTenant((tx) =>
      tx.insert(zones).values({ tenantId: t.tenantId, id: other, kind: "indexed", name: "Other" }),
    );
    const { blobId } = await content("new bytes");
    await inTenant(async (tx) => {
      await expect(
        ingest(tx, t.tenantId, {
          source: "sharepoint",
          externalId: "a",
          zoneId: other,
          title: "Plan.docx",
          ownerId: owner,
          content: await content("new bytes"),
        }),
      ).rejects.toMatchObject({ code: "zone-mismatch" });
      expect(await tx.select().from(blobs).where(eq(blobs.id, blobId))).toHaveLength(0);
    });
  });

  it("restores a removed item whose content changed while it was gone", async () => {
    const r = await item("a", "before");
    await inTenant((tx) => removeFromSource(tx, t.tenantId, "sharepoint", "a"));
    expect(await item("a", "after")).toMatchObject({
      objectId: r.objectId,
      seq: 2,
      restored: true,
      created: { version: true },
    });
  });

  it("makes one object when the same new item arrives twice at once", async () => {
    // Different bytes, so the blob insert doesn't happen to serialize the two.
    const [a, b] = await Promise.all([item("a", "race 1"), item("a", "race 2")]);
    expect(a.objectId).toBe(b.objectId);
    expect([a.created.object, b.created.object].sort()).toEqual([false, true]);
    expect([a.seq, b.seq].sort()).toEqual([1, 2]);
    expect(await versionsOf(a.objectId)).toHaveLength(2);
  });
});

describe("removeFromSource", () => {
  it("marks the object deleted once, keeps its rows, and a later ingest restores it", async () => {
    const r = await item("a", "x");
    const remove = () => inTenant((tx) => removeFromSource(tx, t.tenantId, "sharepoint", "a"));
    expect(await remove()).toBe(r.objectId);
    expect(await remove()).toBeNull();
    expect((await objectRow(r.objectId))?.deletedAt).toBeInstanceOf(Date);
    expect(await versionsOf(r.objectId)).toHaveLength(1);

    const back = await item("a", "x");
    expect(back).toMatchObject({ objectId: r.objectId, seq: 1, restored: true });
    expect((await objectRow(r.objectId))?.deletedAt).toBeNull();
  });

  it("knows nothing of unknown items", async () => {
    expect(await inTenant((tx) => removeFromSource(tx, t.tenantId, "sharepoint", "nope"))).toBe(
      null,
    );
  });
});

describe("sourceItemState", () => {
  it("tells a connector what it has, to skip unchanged items", async () => {
    const state = (id: string) =>
      inTenant((tx) => sourceItemState(tx, t.tenantId, "sharepoint", id));
    expect(await state("a")).toBeNull();
    const r = await item("a", "x", { etag: "e1", sourceVersion: "c7" });
    expect(await state("a")).toEqual({
      objectId: r.objectId,
      etag: "e1",
      deleted: false,
      current: { seq: 1, sourceVersion: "c7", blobId: (await content("x")).blobId },
    });
    await inTenant((tx) => removeFromSource(tx, t.tenantId, "sharepoint", "a"));
    expect((await state("a"))?.deleted).toBe(true);
  });
});

describe("blobIdOf", () => {
  it("is the tenant-scoped id of the bytes, streamed or whole", async () => {
    const whole = await blobIdOf(KEY, enc("hoard"));
    expect(whole).toEqual({ blobId: scopedBlobId(KEY, contentHash(enc("hoard"))), size: 5 });
    async function* chunks() {
      yield enc("ho");
      yield enc("");
      yield enc("ard");
    }
    expect(await blobIdOf(KEY, chunks())).toEqual(whole);
    expect((await blobIdOf(new Uint8Array(32).fill(8), enc("hoard"))).blobId).not.toBe(
      whole.blobId,
    );
  });

  it("refuses a short key and chunks that aren't bytes", async () => {
    await expect(blobIdOf(new Uint8Array(16), enc("x"))).rejects.toThrow("32 bytes");
    async function* strings() {
      yield "text" as unknown as Uint8Array;
    }
    await expect(blobIdOf(KEY, strings())).rejects.toThrow("must be bytes");
  });
});

describe("normalizeMime", () => {
  it.each([
    ["Text/CSV; charset=utf-8", "text/csv"],
    ["  application/PDF ", "application/pdf"],
    ["image/svg+xml", "image/svg+xml"],
    [undefined, "application/octet-stream"],
    ["", "application/octet-stream"],
    ["not a type", "application/octet-stream"],
    ["text/", "application/octet-stream"],
    [`text/${"x".repeat(300)}`, "application/octet-stream"],
  ])("%j → %s", (input, want) => {
    expect(normalizeMime(input)).toBe(want);
  });
});
