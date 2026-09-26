import { blobs, objects, versionExtracts, type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentRef, readExtract, saveExtract, type VersionExtract } from "./extracts.js";

/* T-402: one stored extraction per version, rewritten by every run, under row-level security. */

let db: Database;
let t: SeededTenant;
let other: SeededTenant;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  other = await seedTenant(db, 2);
});
afterEach(() => db?.close());

const extracted = (text: string): VersionExtract => ({
  status: "extracted",
  kind: "docx",
  text,
  truncated: false,
  metadata: { title: "Report", pages: 2 },
  signals: [{ kind: "hidden-text", count: 1, sample: "psst" }],
  warnings: ["type-mismatch"],
  failure: null,
  extractor: "openhoard-extract/1",
});

const save = (e: VersionExtract, s = t) =>
  db.withTenant(s.tenantId, (tx) =>
    saveExtract(tx, s.tenantId, { objectId: s.objectId, versionId: s.versionId, ...e }),
  );
const read = (s = t, versionId = s.versionId) =>
  db.withTenant(s.tenantId, (tx) => readExtract(tx, s.tenantId, versionId));

describe("version extracts", () => {
  it("stores one row per version and rewrites it on every save", async () => {
    await save(extracted("first"));
    const first = await read();
    expect(first).toMatchObject({ ...extracted("first"), objectId: t.objectId });
    await save(extracted("second"));
    await save({
      status: "failed",
      kind: null,
      text: "",
      truncated: false,
      metadata: {},
      signals: [],
      warnings: [],
      failure: "timeout",
      extractor: "openhoard-extract/1",
    });
    const rows = await db.withTenant(t.tenantId, (tx) =>
      tx.select().from(versionExtracts).where(eq(versionExtracts.versionId, t.versionId)),
    );
    expect(rows).toHaveLength(1);
    expect(await read()).toMatchObject({ status: "failed", failure: "timeout", text: "" });
    expect((await read())?.extractedAt.getTime()).toBeGreaterThanOrEqual(
      first?.extractedAt.getTime() ?? 0,
    );
  });

  it("keeps each tenant's extractions to itself", async () => {
    await save(extracted("mine"));
    expect(await read(other, t.versionId)).toBe(null);
    await expect(
      db.withTenant(other.tenantId, (tx) =>
        saveExtract(tx, other.tenantId, {
          objectId: t.objectId,
          versionId: t.versionId,
          ...extracted("theirs"),
        }),
      ),
    ).rejects.toThrow();
    expect((await read())?.text).toBe("mine");
  });

  it("goes with its version when the object is purged", async () => {
    await save(extracted("gone soon"));
    await db.withTenant(t.tenantId, (tx) => tx.delete(objects).where(eq(objects.id, t.objectId)));
    expect(await read()).toBe(null);
  });

  it("answers null for no extraction or a malformed id", async () => {
    expect(await read()).toBe(null);
    expect(await read(t, "not-a-version")).toBe(null);
  });

  it("refuses a malformed extraction before writing", async () => {
    const bad: [string, Partial<VersionExtract> & { objectId?: string }][] = [
      ["status", { status: "done" as never }],
      ["extractor", { extractor: "Bad Name" }],
      ["kind", { kind: null }],
      ["kind", { kind: "PDF" }],
      ["failure", { failure: "timeout" }],
      ["failure", { status: "failed", kind: null, text: "", failure: null }],
      ["text without an extraction", { status: "unsupported", kind: null, text: "x" }],
      ["text too large", { text: "x".repeat(4 * 1024 * 1024 + 1) }],
      ["NUL in text", { text: `a${String.fromCharCode(0)}` }],
      ["json", { metadata: [] as never }],
      ["json", { signals: {} as never }],
      ["warnings", { warnings: [1] as never }],
      ["NUL in JSON", { metadata: { title: `a${String.fromCharCode(0)}` } }],
      ["ids", { objectId: "obj_nope" }],
    ];
    for (const [what, change] of bad) {
      await expect(
        db.withTenant(t.tenantId, (tx) =>
          saveExtract(tx, t.tenantId, {
            objectId: t.objectId,
            versionId: t.versionId,
            ...extracted("x"),
            ...change,
          }),
        ),
        what,
      ).rejects.toThrow(`invalid extraction: ${what}`);
    }
    expect(await read()).toBe(null);
  });

  it("is checked by the database too", async () => {
    const insert = (values: Record<string, unknown>) =>
      db.withTenant(t.tenantId, (tx) =>
        tx.insert(versionExtracts).values({
          tenantId: t.tenantId,
          versionId: t.versionId,
          objectId: t.objectId,
          status: "extracted",
          kind: "pdf",
          extractor: "x",
          ...values,
        }),
      );
    await expect(insert({ status: "unsupported" })).rejects.toThrow();
    await expect(insert({ status: "failed", kind: null })).rejects.toThrow();
    await expect(insert({ metadata: sql`'[]'::jsonb` })).rejects.toThrow();
    await expect(insert({ text: "x".repeat(4 * 1024 * 1024 + 1) })).rejects.toThrow();
    await insert({});
  });
});

describe("content references", () => {
  it("say where a version's bytes are", async () => {
    await db.withTenant(t.tenantId, (tx) =>
      tx.update(blobs).set({ location: "managed/key" }).where(eq(blobs.id, t.blobId)),
    );
    expect(
      await db.withTenant(t.tenantId, (tx) => contentRef(tx, t.tenantId, t.versionId)),
    ).toEqual({
      tenantId: t.tenantId,
      objectId: t.objectId,
      versionId: t.versionId,
      blobId: t.blobId,
      location: "managed/key",
      size: 1234,
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  });

  it("are null for another tenant's version, or a malformed id", async () => {
    expect(
      await db.withTenant(other.tenantId, (tx) => contentRef(tx, other.tenantId, t.versionId)),
    ).toBe(null);
    expect(await db.withTenant(t.tenantId, (tx) => contentRef(tx, t.tenantId, "v1"))).toBe(null);
  });
});
