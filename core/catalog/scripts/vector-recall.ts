// T-502's recall benchmark at scale, against native PostgreSQL (the CI-sized one is
// src/vector-recall.test.ts):
//   pnpm --filter @openhoard/core-catalog bench:recall -- --url postgres://user:pw@host:5432/postgres \
//     [--rows 100000] [--queries 30] [--dims 384] [--topics 200] [--noise 0.35]
// `--url` is a server an ordinary role with CREATEDB reaches, with the test template (core/db
// testing-postgres.ts TEST_TEMPLATE) or pgvector otherwise available; the database is created
// and dropped. Prints a Markdown table: recall@10 of the production plan (spike S1's rule) and
// of HNSW forced (iterative scan, ef_search 200) for callers who see 2%, 25% and 100% of the
// files, against exact search on the same visible set, with the production plan's latency.
import { parseArgs } from "node:util";
import { facets, facetValues, tenants, versionEmbeddings, type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, TEST_POSTGRES_ENV } from "@openhoard/core-db/testing";
import { Authorizer, createCedarEngine, type AuthzPrincipal } from "@openhoard/core-policy";
import { eq, sql } from "drizzle-orm";
import { searchObjects, VIEW_TRANSACTION, type SearchTuning } from "../src/index.js";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    url: { type: "string" },
    rows: { type: "string", default: "100000" },
    queries: { type: "string", default: "30" },
    dims: { type: "string", default: "384" },
    topics: { type: "string", default: "200" },
    noise: { type: "string", default: "0.35" },
  },
});
if (!values.url) throw new Error("pass --url postgres://… (a server, not PGlite)");
process.env[TEST_POSTGRES_ENV] = values.url;
const ROWS = Number(values.rows);
const QUERIES = Number(values.queries);
const DIMS = Number(values.dims);
const TOPICS = Number(values.topics);
const NOISE = Number(values.noise);
const K = 10;
const MODEL = "bench/synthetic";

let s = 7;
const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const unit = (v: number[]) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
const centroids = Array.from({ length: TOPICS }, () =>
  unit(Array.from({ length: DIMS }, () => rnd() * 2 - 1)),
);
const near = (c: number[], noise: number) => unit(c.map((x) => x + (rnd() * 2 - 1) * noise));
const hex = (n: number) => n.toString(16).padStart(26, "0");

const db: Database = await openTestDatabase();
try {
  const t = await seedTenant(db, 1);
  const { tenantId } = t;
  const started = performance.now();
  await db.withTenant(tenantId, async (tx) => {
    await tx
      .update(tenants)
      .set({ defaultVisibility: "hidden", defaultExposure: "full" })
      .where(eq(tenants.id, tenantId));
    await tx.insert(facets).values({ tenantId, key: "team", label: "Team" });
    await tx.insert(facetValues).values(
      ["red", "blue"].map((value) => ({
        tenantId,
        facet: "team",
        value,
        label: value,
        approved: true,
      })),
    );
  });
  for (let start = 0; start < ROWS; start += 1_000) {
    const n = Math.min(1_000, ROWS - start);
    await db.withTenant(tenantId, async (tx) => {
      // Objects, versions and tags in SQL; vectors from here (the same generator as the test).
      const range = sql`generate_series(${start + 1}::int, ${start + n}::int) g`;
      await tx.execute(sql`
        insert into objects (tenant_id, id, zone_id, title, owner_id)
          select ${tenantId}, 'obj_' || lpad(to_hex(g), 26, '0'), ${t.zoneId}, 'File ' || g, 'user:boss'
            from ${range}`);
      await tx.execute(sql`
        insert into versions (tenant_id, id, object_id, seq, blob_id, mime, processed_at)
          select ${tenantId}, 'ver_' || lpad(to_hex(g), 26, '0'), 'obj_' || lpad(to_hex(g), 26, '0'),
                 1, ${t.blobId}, 'text/plain', now()
            from ${range}`);
      await tx.execute(sql`
        insert into object_tags (tenant_id, object_id, facet, value, source, applied_by, confidence)
          select ${tenantId}, 'obj_' || lpad(to_hex(g), 26, '0'), 'team',
                 case when g % 50 = 0 then 'red' else 'blue' end, 'rule', 'rule:bench', 1
            from generate_series(${start + 1}::int, ${start + n}::int) g
           where g % 4 = 0 or g % 50 = 0`);
      await tx.insert(versionEmbeddings).values(
        Array.from({ length: n }, (_, i) => {
          const g = start + i + 1;
          return {
            tenantId,
            versionId: `ver_${hex(g)}`,
            objectId: `obj_${hex(g)}`,
            model: MODEL,
            part: "chunk" as const,
            seq: 0,
            dimensions: DIMS,
            providerKind: "local" as const,
            textHash: "0".repeat(64),
            embedding: near(centroids[g % TOPICS] as number[], NOISE),
          };
        }),
      );
    });
  }
  await db.withTenant(tenantId, (tx) => tx.execute(sql`analyze`));
  const loadSeconds = (performance.now() - started) / 1_000;

  const authz = new Authorizer(createCedarEngine());
  const person = (userId: string, tagGrants: string[] = []): AuthzPrincipal => ({
    userId,
    groupIds: [],
    tagGrants,
    tagWriteGrants: [],
    objectGrants: [],
    objectWriteGrants: [],
    guest: false,
    active: true,
  });
  const nearest = async (principal: AuthzPrincipal, vector: number[], tuning: SearchTuning) => {
    const began = performance.now();
    const r = await db.withTenant(
      tenantId,
      (tx) =>
        searchObjects(
          tx,
          tenantId,
          authz,
          { principal, client: { id: "bench", trust: "first-party" } },
          { query: "nothing-matches-this", vectors: [{ model: MODEL, vector }], limit: 100 },
          { neighbours: K, minSimilarity: -1, ...tuning },
        ),
      VIEW_TRANSACTION,
    );
    return {
      ids: r.hits.map((h) => h.id),
      plan: r.vectorPlans[0]?.plan,
      ms: performance.now() - began,
    };
  };
  const recall = (got: string[], truth: string[]) =>
    truth.length === 0 ? 1 : got.filter((id) => truth.includes(id)).length / truth.length;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(0.95 * xs.length) - 1] ?? 0;

  const profiles: [string, AuthzPrincipal][] = [
    ["2% (team:red)", person("red", ["team:red"])],
    ["25% (team:blue)", person("blue", ["team:blue"])],
    ["100% (owner)", person("boss")],
  ];
  const lines = [
    `# Vector recall@${K}: ${ROWS.toLocaleString("en-US")} files, ${DIMS} dimensions, noise ${NOISE}, ${QUERIES} queries (load ${loadSeconds.toFixed(0)} s)`,
    "",
    "| Caller sees | Production plan | Recall (production) | p95 (production) | Recall (HNSW forced) |",
    "| --- | --- | --- | --- | --- |",
  ];
  const forced: Record<string, number> = {};
  for (const [name, principal] of profiles) {
    const prod: number[] = [];
    const hnsw: number[] = [];
    const ms: number[] = [];
    let plan = "";
    for (let q = 0; q < QUERIES; q++) {
      const vector = near(centroids[(q * 7) % TOPICS] as number[], 0.3);
      const truth = await nearest(principal, vector, { exactLimit: Number.MAX_SAFE_INTEGER });
      const production = await nearest(principal, vector, {});
      const index = await nearest(principal, vector, { exactLimit: 0 });
      plan = production.plan ?? "";
      prod.push(recall(production.ids, truth.ids));
      hnsw.push(recall(index.ids, truth.ids));
      ms.push(production.ms);
    }
    forced[name] = mean(hnsw);
    lines.push(
      `| ${name} | ${plan} | ${(mean(prod) * 100).toFixed(1)}% | ${p95(ms).toFixed(0)} ms | ${(mean(hnsw) * 100).toFixed(1)}% |`,
    );
  }
  lines.push(
    "",
    `Filtered HNSW (25%) vs unfiltered: ${(((forced["25% (team:blue)"] ?? 0) - (forced["100% (owner)"] ?? 0)) * 100).toFixed(1)} points.`,
  );
  process.stdout.write(`${lines.join("\n")}\n`);
} finally {
  await db.close();
}
