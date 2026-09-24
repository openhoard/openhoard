import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromDriver, queryRows, type Database, type Driver, type Tx } from "./database.js";
import { facets, facetValues, objects, objectTags, tagOf } from "./schema.js";
import { openTestDriver, seedTenant, type SeededTenant } from "./testing.js";

/* The tag model (T-202): vocabulary, levels and tags on objects, and the constraints on them. */

async function sqlState(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    return err.cause?.code ?? err.code ?? `no SQLSTATE: ${String(e)}`;
  }
  return "no error";
}
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

let driver: Driver;
let db: Database;
let t: SeededTenant;
beforeEach(async () => {
  driver = await openTestDriver();
  db = fromDriver(driver);
  t = await seedTenant(db, 1);
});
afterEach(() => driver?.close());

const inTenant = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work);
const tag = (patch: Partial<typeof objectTags.$inferInsert> = {}) =>
  inTenant((tx) =>
    tx.insert(objectTags).values({
      tenantId: t.tenantId,
      objectId: t.objectId,
      facet: "client",
      value: "acme-1",
      source: "model",
      appliedBy: "model:small-tagger",
      confidence: 0.8,
      ...patch,
    }),
  );

describe("vocabulary", () => {
  it("starts values unapproved, with no levels of their own", async () => {
    await inTenant((tx) =>
      tx
        .insert(facetValues)
        .values({ tenantId: t.tenantId, facet: "client", value: "globex", label: "Globex" }),
    );
    const [v] = await inTenant((tx) =>
      tx.select().from(facetValues).where(eq(facetValues.value, "globex")),
    );
    expect(v).toMatchObject({ approved: false, visibility: null, exposure: null });
  });

  it("stores visibility and exposure levels on values", async () => {
    await inTenant(async (tx) => {
      await tx
        .insert(facets)
        .values({ tenantId: t.tenantId, key: "sensitivity", label: "Sensitivity" });
      await tx.insert(facetValues).values({
        tenantId: t.tenantId,
        facet: "sensitivity",
        value: "restricted",
        label: "Restricted",
        approved: true,
        visibility: "hidden",
        exposure: "local-only",
      });
    });
    const [v] = await inTenant((tx) =>
      tx.select().from(facetValues).where(eq(facetValues.facet, "sensitivity")),
    );
    expect(v).toMatchObject({ visibility: "hidden", exposure: "local-only" });
  });

  it.each([
    ["a facet key with a colon", () => ({ table: facets, row: { key: "client:x", label: "x" } })],
    ["an upper-case facet key", () => ({ table: facets, row: { key: "Client", label: "x" } })],
    ["an empty facet label", () => ({ table: facets, row: { key: "project", label: "" } })],
    [
      "a value with a colon",
      () => ({ table: facetValues, row: { facet: "client", value: "a:b", label: "x" } }),
    ],
    [
      "a value with a space",
      () => ({ table: facetValues, row: { facet: "client", value: "a b", label: "x" } }),
    ],
    [
      "an upper-case value",
      () => ({ table: facetValues, row: { facet: "client", value: "Acme", label: "x" } }),
    ],
    [
      "a non-ASCII value",
      () => ({ table: facetValues, row: { facet: "client", value: "straße", label: "x" } }),
    ],
    [
      "an unknown visibility",
      () => ({
        table: facetValues,
        row: { facet: "client", value: "v", label: "x", visibility: "secret" },
      }),
    ],
    [
      "an unknown exposure",
      () => ({
        table: facetValues,
        row: { facet: "client", value: "e", label: "x", exposure: "public" },
      }),
    ],
  ])("rejects %s", async (_, make) => {
    const { table, row } = make();
    const insert = inTenant((tx) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- one insert over two tables
      tx.insert(table as any).values({ tenantId: t.tenantId, ...row }),
    );
    expect(await sqlState(insert)).toBe(CHECK_VIOLATION);
  });

  it("needs the facet to exist before its values", async () => {
    const orphan = inTenant((tx) =>
      tx
        .insert(facetValues)
        .values({ tenantId: t.tenantId, facet: "project", value: "apollo", label: "Apollo" }),
    );
    expect(await sqlState(orphan)).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("will not delete a value that objects still carry", async () => {
    const remove = inTenant((tx) =>
      tx
        .delete(facetValues)
        .where(and(eq(facetValues.facet, "client"), eq(facetValues.value, "acme-1"))),
    );
    expect(await sqlState(remove)).toBe(FOREIGN_KEY_VIOLATION);
  });
});

describe("object tags", () => {
  it("records where a tag came from", async () => {
    const [row] = await inTenant((tx) => tx.select().from(objectTags));
    expect(row).toMatchObject({
      facet: "client",
      value: "acme-1",
      source: "rule",
      appliedBy: "rule:client-dictionary",
      confidence: 1,
      reviewed: false,
    });
    expect(tagOf(row?.facet ?? "", row?.value ?? "")).toBe(t.tag);
  });

  it("tags an object once per value", async () => {
    expect(await sqlState(tag())).toBe(UNIQUE_VIOLATION);
  });

  it("only uses values in the vocabulary", async () => {
    expect(await sqlState(tag({ value: "not-in-vocabulary" }))).toBe(FOREIGN_KEY_VIOLATION);
    expect(await sqlState(tag({ facet: "project" }))).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("cannot use another tenant's vocabulary or objects", async () => {
    const other = await seedTenant(db, 2);
    // Tenant 1 tags its object with tenant 2's value, then tags tenant 2's object.
    expect(await sqlState(tag({ value: "acme-2" }))).toBe(FOREIGN_KEY_VIOLATION);
    expect(await sqlState(tag({ objectId: other.objectId, value: "acme-1", source: "user" }))).toBe(
      FOREIGN_KEY_VIOLATION,
    );
  });

  it.each([
    ["a confidence above 1", { confidence: 1.01 }],
    ["a negative confidence", { confidence: -0.1 }],
    ["an unknown source", { source: "agent" as "model" }],
    ["an applier that is not a principal", { appliedBy: "small-tagger" }],
  ])("rejects %s", async (_, patch) => {
    await inTenant((tx) =>
      tx
        .insert(facetValues)
        .values({ tenantId: t.tenantId, facet: "client", value: "initech", label: "Initech" }),
    );
    expect(await sqlState(tag({ value: "initech", ...patch }))).toBe(CHECK_VIOLATION);
  });

  it("marks a tag reviewed", async () => {
    await inTenant((tx) =>
      tx.update(objectTags).set({ reviewed: true }).where(eq(objectTags.objectId, t.objectId)),
    );
    const [row] = await inTenant((tx) => tx.select().from(objectTags));
    expect(row?.reviewed).toBe(true);
  });

  it("go with their object", async () => {
    await inTenant((tx) => tx.delete(objects).where(eq(objects.id, t.objectId)));
    expect(await inTenant((tx) => tx.select().from(objectTags))).toEqual([]);
    // The vocabulary stays.
    expect(await inTenant((tx) => tx.select().from(facetValues))).toHaveLength(1);
  });

  it("finds objects by tag through the tag index", async () => {
    const plan = await inTenant(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      return queryRows(
        tx,
        sql`explain select object_id from object_tags
             where tenant_id = ${t.tenantId} and facet = 'client' and value = 'acme-1'`,
      );
    });
    expect(JSON.stringify(plan)).toMatch(/object_tags_tag_idx/);
  });
});
