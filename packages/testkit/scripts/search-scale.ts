// T-507: OpenHoard's own search (core/catalog searchObjects) at scale, against a real database.
//   pnpm --filter @openhoard/testkit bench:search -- --url postgres://user:pw@host:5432/postgres \
//     [--rows 1000000] [--queries 30] [--out search.json] [--baseline prev.json] [--threshold 0.2]
// `--url` is a server an ordinary role with CREATEDB reaches, with the test template (core/db
// testing-postgres.ts) or pgvector available; the database is created and dropped. Without
// `--url` it runs on PGlite, for trying it at small sizes.
//
// The data is spike S1's shape, in the real schema: titles and 30-word bodies drawn from 5,000
// terms with a steep skew (the commonest terms match most files), a 384-dimension vector per
// file (one of 200 topics plus noise), tags a quarter of files carry. Callers see 2% of the
// files (a tag grant), 25% (another), or all (their owner). Per caller, it times keyword
// searches across the frequency range and hybrid ones (the same words and a vector), and
// reports p95. Output is the nightly benchmark's (scripts/bench.ts): a Markdown table, the
// JSON, and exit 1 on a regression against the baseline or a p95 over the 800 ms target.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { parseArgs } from "node:util";
import { searchObjects, VIEW_TRANSACTION } from "@openhoard/core-catalog";
import { facets, facetValues, queryRows, tenants, type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, TEST_POSTGRES_ENV } from "@openhoard/core-db/testing";
import { Authorizer, createCedarEngine, type AuthzPrincipal } from "@openhoard/core-policy";
import { eq, sql, type SQL } from "drizzle-orm";
import {
  compareResults,
  formatBench,
  percentile,
  type BenchResults,
  type Metric,
} from "../src/index.js";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    url: { type: "string" },
    rows: { type: "string", default: "1000000" },
    queries: { type: "string", default: "30" },
    out: { type: "string" },
    baseline: { type: "string" },
    threshold: { type: "string", default: "0.2" },
  },
});
if (values.url) process.env[TEST_POSTGRES_ENV] = values.url;
const ROWS = Number(values.rows);
const QUERIES = Number(values.queries);
const TARGET_MS = 800;
const DIMS = 384;
const TOPICS = 200;
const TERMS = 5_000;
const MODEL = "bench/synthetic";
const BATCH = 10_000;

/** A topic's centroid, as the SQL below computes it: no table, the same numbers in both. */
const centroid = (topic: number) =>
  Array.from({ length: DIMS }, (_, i) => Math.sin(topic * 7919 + (i + 1) * 104.729));
let s = 11;
const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const near = (c: number[]) => c.map((x) => x + (rnd() * 2 - 1) * 0.3);

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
  // The vector indexes are built once at the end, as a bulk load would, not row by row.
  const indexes = await db.withTenant(tenantId, (tx) =>
    queryRows<{ name: string; ddl: string }>(
      tx,
      sql`select indexname as name, indexdef as ddl from pg_indexes
           where tablename = 'version_embeddings' and indexdef like '%USING hnsw%'`,
    ),
  );
  for (const i of indexes) {
    await db.withTenant(tenantId, (tx) => tx.execute(sql.raw(`drop index ${i.name}`)));
  }
  // A term as the data has it: rank 1 is the commonest (power 3 skews the draw to low ranks).
  const term = sql.raw(`'t' || (floor(power(random(), 3) * ${TERMS})::int + 1)`);
  for (let start = 0; start < ROWS; start += BATCH) {
    const n = Math.min(BATCH, ROWS - start);
    await db.withTenant(tenantId, async (tx) => {
      await tx.execute(sql`set local statement_timeout = 0`);
      await tx.execute(sql`select setseed(${(start / ROWS) * 0.9})`);
      const range = sql`generate_series(${start + 1}::int, ${start + n}::int) g`;
      const id = (prefix: string) => sql.raw(`'${prefix}_' || lpad(to_hex(g), 26, '0')`);
      await tx.execute(sql`
        insert into objects (tenant_id, id, zone_id, title, owner_id)
          select ${tenantId}, ${id("obj")}, ${t.zoneId},
                 (select string_agg(${term}, ' ') from generate_series(1, 4 + 0 * g)), 'user:boss'
            from ${range}`);
      await tx.execute(sql`
        insert into versions (tenant_id, id, object_id, seq, blob_id, mime, processed_at)
          select ${tenantId}, ${id("ver")}, ${id("obj")}, 1, ${t.blobId}, 'text/plain', now()
            from ${range}`);
      await tx.execute(sql`
        insert into version_extracts (tenant_id, version_id, object_id, status, kind, text, extractor)
          select ${tenantId}, ${id("ver")}, ${id("obj")}, 'extracted', 'text',
                 (select string_agg(${term}, ' ') from generate_series(1, 30 + 0 * g)), 'bench'
            from ${range}`);
      await tx.execute(sql`
        insert into object_tags (tenant_id, object_id, facet, value, source, applied_by, confidence)
          select ${tenantId}, ${id("obj")}, 'team',
                 case when g % 50 = 0 then 'red' else 'blue' end, 'rule', 'rule:bench', 1
            from ${range} where g % 4 = 0 or g % 50 = 0`);
      await tx.execute(sql`
        insert into version_embeddings
               (tenant_id, version_id, object_id, model, part, seq, dimensions, provider_kind,
                text_hash, embedding)
          select ${tenantId}, ${id("ver")}, ${id("obj")}, ${MODEL}, 'chunk', 0, ${DIMS}, 'local',
                 repeat('0', 64),
                 (select array_agg(sin((g % ${TOPICS}) * 7919 + d * 104.729) + (random() * 2 - 1) * 0.35
                                   order by d)::vector
                    from generate_series(1, ${DIMS}) d)
            from ${range}`);
    });
  }
  // A million rows' vector index takes minutes: past the driver's statement timeout.
  const untimed = (statement: SQL) =>
    db.withTenant(tenantId, async (tx) => {
      await tx.execute(sql`set local statement_timeout = 0`);
      await tx.execute(statement);
    });
  for (const i of indexes) await untimed(sql.raw(i.ddl));
  await untimed(sql`analyze`);
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
  const timed = async (principal: AuthzPrincipal, query: string, vector?: number[]) => {
    const began = performance.now();
    await db.withTenant(
      tenantId,
      (tx) =>
        searchObjects(
          tx,
          tenantId,
          authz,
          { principal, client: { id: "bench", trust: "first-party" } },
          { query, ...(vector ? { vectors: [{ model: MODEL, vector }] } : {}), limit: 10 },
        ),
      VIEW_TRANSACTION,
    );
    return performance.now() - began;
  };
  // Across the frequency range: the commonest terms (most files), the middle, the rare; one
  // word and two.
  const ranks = [1, 2, 3, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 4000];
  const queries = Array.from({ length: QUERIES }, (_, q) => {
    const a = ranks[q % ranks.length] as number;
    return q % 3 === 2 ? `t${a} t${ranks[(q + 5) % ranks.length] as number}` : `t${a}`;
  });
  const profiles: [string, AuthzPrincipal][] = [
    ["2pct", person("red", ["team:red"])],
    ["25pct", person("blue", ["team:blue"])],
    ["all", person("boss")],
  ];
  const metrics: Metric[] = [
    {
      name: `search.real.${ROWS}.load`,
      value: loadSeconds,
      unit: "s",
      better: "lower",
      noiseFloor: 60,
    },
  ];
  for (const [name, principal] of profiles) {
    for (const q of queries.slice(0, 3)) await timed(principal, q); // warm the caches
    const keyword: number[] = [];
    const hybrid: number[] = [];
    for (const [i, q] of queries.entries()) {
      keyword.push(await timed(principal, q));
      hybrid.push(await timed(principal, q, near(centroid((i * 7) % TOPICS))));
    }
    for (const [channel, ms] of [
      ["keyword", keyword],
      ["hybrid", hybrid],
    ] as const) {
      const sorted = [...ms].sort((a, b) => a - b);
      metrics.push({
        name: `search.real.${ROWS}.${channel}.${name}.p95`,
        value: percentile(sorted, 0.95),
        unit: "ms",
        better: "lower",
        noiseFloor: 25,
      });
    }
  }

  const results: BenchResults = {
    version: 1,
    date: new Date().toISOString(),
    node: process.version,
    platform: `${platform()}-${arch()}`,
    cpu: cpus()[0]?.model ?? "unknown",
    rounds: 1,
    metrics,
    peakRssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
  const threshold = Number(values.threshold);
  const baseline =
    values.baseline && existsSync(values.baseline)
      ? (JSON.parse(readFileSync(values.baseline, "utf8")) as BenchResults)
      : undefined;
  const comparable = baseline !== undefined && baseline.cpu === results.cpu;
  const regressions = comparable ? compareResults(results, baseline, threshold) : [];
  const over = metrics.filter((m) => m.unit === "ms" && m.value >= TARGET_MS);
  const engine = values.url ? "PostgreSQL" : "PGlite";
  const note = [
    `${ROWS.toLocaleString("en-US")} files on ${engine}, ${QUERIES} queries per caller and channel; load ${loadSeconds.toFixed(0)} s.`,
    over.length
      ? `**Over the ${TARGET_MS} ms target (T-507):** ${over.map((m) => m.name).join(", ")}.`
      : `Every p95 is under the ${TARGET_MS} ms target (T-507).`,
    ...(baseline && !comparable
      ? [`Baseline ran on "${baseline.cpu}": not compared. This run becomes the next baseline.`]
      : []),
  ].join(" ");
  const markdown = formatBench(results, comparable ? baseline : undefined, regressions, {
    threshold,
    note,
  });
  if (values.out) writeFileSync(values.out, `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  if (regressions.length > 0 || over.length > 0) process.exitCode = 1;
} finally {
  await db.close();
}
