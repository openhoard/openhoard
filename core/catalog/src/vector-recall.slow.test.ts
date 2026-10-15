import { writeFileSync } from "node:fs";
import { platform } from "node:os";
import {
  facets,
  facetValues,
  newId,
  objects,
  objectTags,
  tenants,
  versionEmbeddings,
  versions,
  type Database,
} from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { Authorizer, createCedarEngine, type AuthzPrincipal } from "@openhoard/core-policy";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchObjects, type SearchTuning } from "./search.js";
import { VIEW_TRANSACTION } from "./visibility.js";

/*
 * T-502's done-when, at a size CI can build: filtered vector recall@10 within 5 points of
 * unfiltered, on the HNSW path (the threshold forced down to 0, so the index serves every
 * query) and on the production plan (spike S1's rule, which searches this small a set exactly).
 * Truth is exact search over the same visible set. The data is spike S1's shape: every vector
 * one of a few topic centroids plus noise, 384 dimensions (an indexed size), a quarter of the
 * files readable by the filtered caller through a tag grant, all of them by their owner.
 * scripts/vector-recall.ts runs the same comparison at scale against native PostgreSQL.
 */

const FILES = Number(process.env.RECALL_FILES ?? 1_200);
const DIMENSIONS = 384;
const TOPICS = 40;
const QUERIES = Number(process.env.RECALL_QUERIES ?? 12);
const K = 10;
const MODEL = "bench/synthetic";

let db: Database;
let t: SeededTenant;
const authz = new Authorizer(createCedarEngine());

/** A deterministic generator (LCG), so every run builds the same data. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}
const rnd = random(7);
const unit = (v: number[]) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
const centroids = Array.from({ length: TOPICS }, () =>
  unit(Array.from({ length: DIMENSIONS }, () => rnd() * 2 - 1)),
);
const near = (c: number[], noise: number) => unit(c.map((x) => x + (rnd() * 2 - 1) * noise));

beforeAll(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  const { tenantId } = t;
  await db.withTenant(tenantId, async (tx) => {
    await tx
      .update(tenants)
      .set({ defaultVisibility: "hidden", defaultExposure: "full" })
      .where(eq(tenants.id, tenantId));
    await tx.insert(facets).values({ tenantId, key: "team", label: "Team" });
    await tx
      .insert(facetValues)
      .values({ tenantId, facet: "team", value: "blue", label: "Blue", approved: true });
  });
  for (let start = 0; start < FILES; start += 250) {
    const batch = Array.from({ length: Math.min(250, FILES - start) }, (_, i) => ({
      n: start + i,
      objectId: newId("object"),
      versionId: newId("version"),
      vector: near(centroids[Math.floor(rnd() * TOPICS)] as number[], 0.35),
    }));
    await db.withTenant(tenantId, async (tx) => {
      await tx.insert(objects).values(
        batch.map((b) => ({
          tenantId,
          id: b.objectId,
          zoneId: t.zoneId,
          title: `File ${b.n}`,
          ownerId: "user:boss",
        })),
      );
      await tx.insert(versions).values(
        batch.map((b) => ({
          tenantId,
          id: b.versionId,
          objectId: b.objectId,
          seq: 1,
          blobId: t.blobId,
          mime: "text/plain",
          processedAt: sql`now()`,
        })),
      );
      const blue = batch.filter((b) => b.n % 4 === 0);
      if (blue.length > 0) {
        await tx.insert(objectTags).values(
          blue.map((b) => ({
            tenantId,
            objectId: b.objectId,
            facet: "team",
            value: "blue",
            source: "rule" as const,
            appliedBy: "rule:bench",
            confidence: 1,
          })),
        );
      }
      await tx.insert(versionEmbeddings).values(
        batch.map((b) => ({
          tenantId,
          versionId: b.versionId,
          objectId: b.objectId,
          model: MODEL,
          part: "chunk" as const,
          seq: 0,
          dimensions: DIMENSIONS,
          providerKind: "local" as const,
          textHash: "0".repeat(64),
          embedding: b.vector,
        })),
      );
    });
  }
}, windowsTimeout(300_000));
afterAll(() => db?.close());

function windowsTimeout(ms: number) {
  // The Windows runner is several times slower (PGlite building an HNSW index row by row).
  return platform() === "win32" ? ms * 4 : ms;
}

const person = (userId: string, more: Partial<AuthzPrincipal> = {}): AuthzPrincipal => ({
  userId,
  groupIds: [],
  tagGrants: [],
  tagWriteGrants: [],
  objectGrants: [],
  objectWriteGrants: [],
  guest: false,
  active: true,
  ...more,
});
const nearest = async (principal: AuthzPrincipal, vector: number[], tuning: SearchTuning) => {
  const result = await db.withTenant(
    t.tenantId,
    (tx) =>
      searchObjects(
        tx,
        t.tenantId,
        authz,
        { principal, client: { id: "openhoard-web", trust: "first-party" } },
        { query: "nothing-matches-this", vectors: [{ model: MODEL, vector }], limit: 100 },
        { neighbours: K, minSimilarity: -1, ...tuning },
      ),
    VIEW_TRANSACTION,
  );
  return { ids: result.hits.map((h) => h.id), plan: result.vectorPlans[0]?.plan };
};
const recall = (got: readonly string[], truth: readonly string[]) =>
  truth.length === 0 ? 1 : got.filter((id) => truth.includes(id)).length / truth.length;

describe("filtered vector recall (T-502)", () => {
  it(
    "is within 5 points of unfiltered on the HNSW path, and exact under the production plan",
    async () => {
      const owner = person("boss");
      const filtered = person("bo", { tagGrants: ["team:blue"] });
      const exact: SearchTuning = { exactLimit: Number.MAX_SAFE_INTEGER };
      const hnsw: SearchTuning = { exactLimit: 0 };
      const scores = { all: [] as number[], filtered: [] as number[], production: [] as number[] };
      for (let q = 0; q < QUERIES; q++) {
        const vector = near(centroids[q % TOPICS] as number[], 0.3);
        const truthAll = await nearest(owner, vector, exact);
        const gotAll = await nearest(owner, vector, hnsw);
        const truth = await nearest(filtered, vector, exact);
        const got = await nearest(filtered, vector, hnsw);
        const production = await nearest(filtered, vector, {});
        expect([truthAll.plan, gotAll.plan, got.plan, production.plan]).toEqual([
          "exact",
          "hnsw",
          "hnsw",
          "exact",
        ]);
        expect(truth.ids).toHaveLength(K);
        scores.all.push(recall(gotAll.ids, truthAll.ids));
        scores.filtered.push(recall(got.ids, truth.ids));
        scores.production.push(recall(production.ids, truth.ids));
      }
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      const report = {
        unfiltered: mean(scores.all),
        filtered: mean(scores.filtered),
        production: mean(scores.production),
      };
      // RECALL_REPORT=<file> writes the numbers there (the done-when's evidence).
      const out = process.env.RECALL_REPORT;
      if (out)
        writeFileSync(out, JSON.stringify({ k: K, files: FILES, queries: QUERIES, ...report }));
      expect(report.filtered, JSON.stringify(report)).toBeGreaterThanOrEqual(
        report.unfiltered - 0.05,
      );
      expect(report.production, JSON.stringify(report)).toBe(1);
    },
    windowsTimeout(300_000),
  );
});
