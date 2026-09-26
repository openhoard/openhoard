import {
  facets,
  facetValues,
  newId,
  objects,
  objectTags,
  queryRows,
  searchDocuments,
  sqlState,
  tenants,
  versionEmbeddings,
  versions,
  type Database,
  type Tx,
} from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import {
  Authorizer,
  createCedarEngine,
  type AuthzClient,
  type AuthzPrincipal,
} from "@openhoard/core-policy";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addDoc, hashedEmbedding } from "./search.fixtures.js";
import {
  bestModel,
  SEARCH_CANDIDATES,
  searchObjects,
  suggestTitles,
  withHnswSettings,
  type SearchQuery,
  type SearchTuning,
} from "./search.js";
import { VIEW_TRANSACTION } from "./visibility.js";

/*
 * Search review findings (T-502, T-503): vectors checked against their provider's kind, the
 * shared HNSW index's scan bound and exact fallback, the settings' restore after a failure,
 * per-model explanations, and regressions: a pack-forbidden grant holder near the candidate
 * cap, purges, and prefixes that look like regular expressions.
 */

const MODEL = "fixture/hash";
const ME = "bo";
const FIRST_PARTY: AuthzClient = { id: "openhoard-web", trust: "first-party" };
const authz = new Authorizer(createCedarEngine());

let db: Database;
let t: SeededTenant;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  await defaults(t);
});
afterEach(() => db?.close());

const defaults = (s: SeededTenant, visibility: "discoverable" | "hidden" = "discoverable") =>
  db.withTenant(s.tenantId, (tx) =>
    tx
      .update(tenants)
      .set({ defaultVisibility: visibility, defaultExposure: "full" })
      .where(eq(tenants.id, s.tenantId)),
  );
const person = (more: Partial<AuthzPrincipal> = {}): AuthzPrincipal => ({
  userId: ME,
  groupIds: [],
  tagGrants: [],
  tagWriteGrants: [],
  objectGrants: [],
  objectWriteGrants: [],
  guest: false,
  active: true,
  ...more,
});
const search = (
  query: SearchQuery,
  options: { principal?: AuthzPrincipal; tuning?: SearchTuning; gate?: Authorizer } = {},
) =>
  db.withTenant(
    t.tenantId,
    (tx) =>
      searchObjects(
        tx,
        t.tenantId,
        options.gate ?? authz,
        { principal: options.principal ?? person(), client: FIRST_PARTY },
        query,
        options.tuning,
      ),
    VIEW_TRANSACTION,
  );
const write = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work);
const vectors = (meaning: string, dimensions = 64) => [
  { model: MODEL, vector: hashedEmbedding(meaning, dimensions) },
];

async function localOnlyLevel() {
  await write(async (tx) => {
    await tx.insert(facets).values({ tenantId: t.tenantId, key: "level", label: "Level" });
    await tx.insert(facetValues).values({
      tenantId: t.tenantId,
      facet: "level",
      value: "local",
      label: "Local",
      approved: true,
      exposure: "local-only",
    });
  });
}

describe("vectors and their provider's kind", () => {
  it("doesn't match a file by vectors a provider made that its exposure no longer allows", async () => {
    await localOnlyLevel();
    const commercial = await addDoc(db, t, {
      title: "Plan A",
      owner: `user:${ME}`,
      tags: ["level:local"],
      text: "zebra giraffe savanna",
      embed: { model: MODEL, kind: "commercial", dimensions: 384 },
    });
    const local = await addDoc(db, t, {
      title: "Plan B",
      owner: `user:${ME}`,
      tags: ["level:local"],
      text: "zebra giraffe lions",
      embed: { model: MODEL, kind: "local", dimensions: 384 },
    });
    const q = { query: "safari", vectors: vectors("zebra giraffe", 384) };
    // Exact and HNSW alike, even through OpenHoard's own app: the vectors are the provider's
    // reading of the content, which a local-only file no longer lets it have.
    for (const tuning of [{}, { exactLimit: 0, neighbours: 1 }]) {
      const ids = (await search(q, { tuning })).hits.map((h) => h.id);
      expect(ids, JSON.stringify(tuning)).toEqual([local.objectId]);
    }
    // Its words still match: extracted text was never sent anywhere.
    expect((await search({ query: "savanna" })).hits.map((h) => h.id)).toEqual([
      commercial.objectId,
    ]);
  });
});

describe("the shared HNSW index", () => {
  it("falls back to exact search when a scan bound stops among another tenant's vectors", async () => {
    const dims = 384;
    const target = hashedEmbedding("zebra giraffe", dims);
    // Another tenant's dense cluster, nearer to the query than anything of ours.
    const other = await seedTenant(db, 2);
    const rows = Array.from({ length: 400 }, (_, i) => ({
      objectId: newId("object"),
      versionId: newId("version"),
      vector: target.map((x, j) => x + (j === i % dims ? 0.001 : 0)),
    }));
    await db.withTenant(other.tenantId, async (tx) => {
      await tx.insert(objects).values(
        rows.map((r, i) => ({
          tenantId: other.tenantId,
          id: r.objectId,
          zoneId: other.zoneId,
          title: `Other ${i}`,
          ownerId: "user:x",
        })),
      );
      await tx.insert(versions).values(
        rows.map((r) => ({
          tenantId: other.tenantId,
          id: r.versionId,
          objectId: r.objectId,
          seq: 1,
          blobId: other.blobId,
          mime: "text/plain",
        })),
      );
      await tx.insert(versionEmbeddings).values(
        rows.map((r) => ({
          tenantId: other.tenantId,
          versionId: r.versionId,
          objectId: r.objectId,
          model: MODEL,
          part: "chunk" as const,
          seq: 0,
          dimensions: dims,
          providerKind: "local" as const,
          textHash: "0".repeat(64),
          embedding: r.vector,
        })),
      );
    });
    const ours = await addDoc(db, t, {
      title: "Field notes",
      owner: `user:${ME}`,
      text: "zebra giraffe savanna lions",
      embed: { model: MODEL, dimensions: dims },
    });
    const q = { query: "safari", vectors: [{ model: MODEL, vector: target }] };
    // Forced onto the index with a tiny scan bound, the scan meets the other tenant's cluster
    // first. Whether it reached our file or not, the answer is right.
    const bounded = await search(q, {
      tuning: { exactLimit: 0, neighbours: 1, maxScanTuples: 10 },
    });
    expect(bounded.hits.map((h) => h.id)).toEqual([ours.objectId]);
    // Asked for more neighbours than the index scan brings back (we have one file), the search
    // falls back to exact, and the plan reported is the one that answered.
    const short = await search(q, { tuning: { exactLimit: 0, neighbours: 3, maxScanTuples: 10 } });
    expect(short.hits.map((h) => h.id)).toEqual([ours.objectId]);
    expect(short.vectorPlans).toEqual([{ model: MODEL, plan: "exact" }]);
  });

  it("puts the settings back after a failure without hiding the failure", async () => {
    const e = await db
      .withTenant(
        t.tenantId,
        (tx) =>
          withHnswSettings(tx, async () => {
            await queryRows(tx, sql`select 1 / 0`);
          }),
        VIEW_TRANSACTION,
      )
      .catch((err: unknown) => err);
    expect(sqlState(e)).toBe("22012");
    await expect(
      db.withTenant(t.tenantId, (tx) => withHnswSettings(tx, async () => 1, 0)),
    ).rejects.toThrow(RangeError);
  });
});

describe("explanations with several models", () => {
  it("pairs each hit's vector rank with the similarity of the same model", async () => {
    expect(
      bestModel(
        [
          { model: "a/x", similarity: 0.9 },
          { model: "b/y", similarity: 0.5 },
        ],
        { "vector:a/x": 2, "vector:b/y": 1 },
      ),
    ).toEqual({ rank: 2, similarity: 0.9, model: "a/x" });
    expect(bestModel([{ model: "a/x", similarity: 0.9 }], {})).toBeUndefined();
    const id = await addDoc(db, t, {
      title: "Notes",
      owner: `user:${ME}`,
      text: "zebra giraffe",
      embed: { model: MODEL },
    });
    const result = await search({
      query: "safari",
      vectors: [...vectors("zebra giraffe"), { model: "other/model", vector: [1, 0, 0] }],
    });
    expect(result.hits.map((h) => h.id)).toEqual([id.objectId]);
    expect(result.explanations[0]?.channels.vector).toMatchObject({ model: MODEL, rank: 1 });
  });
});

describe("regressions", () => {
  it("counts nothing for a grant holder a pack forbids, past the candidate cap: only the one bit", async () => {
    await defaults(t, "hidden");
    const ids = Array.from({ length: SEARCH_CANDIDATES + 5 }, () => ({
      objectId: newId("object"),
      versionId: newId("version"),
    }));
    await write(async (tx) => {
      for (let i = 0; i < ids.length; i += 500) {
        const batch = ids.slice(i, i + 500);
        await tx.insert(objects).values(
          batch.map((b, n) => ({
            tenantId: t.tenantId,
            id: b.objectId,
            zoneId: t.zoneId,
            title: `Quarterly ${i + n}`,
            ownerId: "user:x",
          })),
        );
        await tx.insert(versions).values(
          batch.map((b) => ({
            tenantId: t.tenantId,
            id: b.versionId,
            objectId: b.objectId,
            seq: 1,
            blobId: t.blobId,
            mime: "text/plain",
            processedAt: sql`now()`,
          })),
        );
        await tx.insert(objectTags).values(
          batch.map((b) => ({
            tenantId: t.tenantId,
            objectId: b.objectId,
            facet: "client",
            value: "acme-1",
            source: "rule" as const,
            appliedBy: "rule:x",
            confidence: 1,
          })),
        );
      }
    });
    const forbid = new Authorizer(
      createCedarEngine({
        "pack/no-acme": `forbid (principal, action == OpenHoard::Action::"read", resource) when { resource.allTags.contains("client:acme-1") };`,
      }),
    );
    const result = await search(
      { query: "quarterly" },
      { principal: person({ tagGrants: [t.tag] }), gate: forbid },
    );
    expect(result).toMatchObject({ hits: [], total: 0, facets: {}, totalIsLowerBound: true });
  }, 120_000);

  it("leaves no search document or vector behind when an object is purged", async () => {
    const { objectId } = await addDoc(db, t, {
      title: "Gone soon",
      owner: `user:${ME}`,
      text: "words",
      embed: { model: MODEL },
    });
    const count = () =>
      write(async (tx) => [
        (await tx.select().from(searchDocuments).where(eq(searchDocuments.objectId, objectId)))
          .length,
        (await tx.select().from(versionEmbeddings).where(eq(versionEmbeddings.objectId, objectId)))
          .length,
      ]);
    expect(await count()).toEqual([1, 1]);
    await write((tx) =>
      tx.delete(objects).where(and(eq(objects.tenantId, t.tenantId), eq(objects.id, objectId))),
    );
    expect(await count()).toEqual([0, 0]);
  });

  it("suggests titles for prefixes that look like regular expressions, literally", async () => {
    const titles = [
      "a.b plan",
      "(x) memo",
      "[draft] notes",
      "a*b list",
      "back\\slash",
      "$cash",
      "c++ guide",
    ];
    for (const title of titles) await addDoc(db, t, { title, owner: `user:${ME}` });
    const suggest = (prefix: string) =>
      db.withTenant(
        t.tenantId,
        (tx) =>
          suggestTitles(
            tx,
            t.tenantId,
            authz,
            { principal: person(), client: FIRST_PARTY },
            {
              prefix,
            },
          ),
        VIEW_TRANSACTION,
      );
    expect(await suggest("a.b")).toEqual(["a.b plan"]);
    expect(await suggest("a.")).toEqual(["a.b plan"]);
    expect(await suggest("(x")).toEqual(["(x) memo"]);
    expect(await suggest("[draft")).toEqual(["[draft] notes"]);
    expect(await suggest("a*")).toEqual(["a*b list"]);
    expect(await suggest("back\\")).toEqual(["back\\slash"]);
    expect(await suggest("$c")).toEqual(["$cash"]);
    expect(await suggest("c++")).toEqual(["c++ guide"]);
    for (const odd of ["(", "[", "\\", "*", "+", "?", "^", "{1}", "|"]) {
      await expect(suggest(odd), odd).resolves.toBeInstanceOf(Array);
    }
  });
});
