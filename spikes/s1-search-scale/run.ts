// Spike S1 (T-020): permission-aware hybrid search at scale on Postgres (ADR-0005).
// Pass: p95 < 800 ms, and filtered vector recall@10 within 5 points of unfiltered.
//   pnpm --filter @openhoard/spike-s1-search-scale spike -- --url postgres://… --rows 1000000
//   pnpm --filter @openhoard/spike-s1-search-scale spike -- --pglite --rows 100000
// Throwaway code: see docs/spikes/s1-search-scale.md for the write-up.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import pg from "pg";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    url: { type: "string" },
    pglite: { type: "boolean", default: false },
    rows: { type: "string", default: "100000" },
    reuse: { type: "boolean", default: false },
    queries: { type: "string", default: "30" },
    ef: { type: "string", default: "100" },
  },
});
const rows = Number(values.rows);
const nQueries = Number(values.queries);

interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

async function open(): Promise<{ db: Db; name: string }> {
  if (values.pglite) {
    const lite = await PGlite.create({ extensions: { vector } });
    const db: Db = {
      query: async (sql, params) => (await lite.query(sql, params)).rows as never,
      exec: async (sql) => void (await lite.exec(sql)),
      close: () => lite.close(),
    };
    return { db, name: "PGlite 0.5.8 (in memory)" };
  }
  if (!values.url) throw new Error("pass --url postgres://… or --pglite");
  const client = new pg.Client({ connectionString: values.url });
  await client.connect();
  const db: Db = {
    query: async (sql, params) => (await client.query(sql, params as unknown[])).rows as never,
    exec: async (sql) => void (await client.query(sql)),
    close: () => client.end(),
  };
  const v = (await db.query<{ v: string }>("select version() v"))[0]?.v ?? "";
  return { db, name: `native ${/PostgreSQL [\d.]+/.exec(v)?.[0]}` };
}

const time = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
  const t = performance.now();
  const r = await fn();
  return [r, performance.now() - t];
};
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? Number.NaN;
};
const fmt = (xs: number[]) =>
  `p50 ${pct(xs, 0.5).toFixed(1)} ms, p95 ${pct(xs, 0.95).toFixed(1)} ms, max ${Math.max(...xs).toFixed(1)} ms`;

const { db, name } = await open();
const log = (s: string) => console.log(s);
log(`# Spike S1 on ${name}, ${rows.toLocaleString("en-US")} rows`);

// ── Build ───────────────────────────────────────────────────────────────────────────────────
if (!values.reuse) {
  await db.exec("create extension if not exists vector");
  const script = readFileSync(new URL("./generate.sql", import.meta.url), "utf8").replaceAll(
    ":rows",
    String(rows),
  );
  const [, genMs] = await time(() => db.exec(script));
  log(`generate: ${(genMs / 1000).toFixed(0)} s`);
  const [, ginMs] = await time(() =>
    db.exec(
      "create index docs_body on docs using gin (body); create index docs_visible on docs using gin (visible_to)",
    ),
  );
  log(`GIN indexes (body, visible_to): ${(ginMs / 1000).toFixed(0)} s`);
  const [, hnswMs] = await time(() =>
    db.exec(
      "create index docs_embedding on docs using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64)",
    ),
  );
  log(`HNSW index (m 16, ef_construction 64): ${(hnswMs / 1000).toFixed(0)} s`);
  await db.exec("analyze docs");
}
const size = await db.query<{ t: string; i: string }>(
  "select pg_size_pretty(pg_table_size('docs')) t, pg_size_pretty(pg_indexes_size('docs')) i",
);
log(`size: table ${size[0]?.t}, indexes ${size[0]?.i}`);

// ── Workload ────────────────────────────────────────────────────────────────────────────────
let seed = 7;
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const PROFILES: Record<string, string[]> = {
  "broad (everyone + 3 groups)": ["group:everyone", "group:g1", "group:g2", "group:g3"],
  "department (1 group)": ["group:g7"],
  "tiny (1 user share)": ["user:u42"],
};
const shares: Record<string, number> = {};
for (const [p, principals] of Object.entries(PROFILES)) {
  const r = await db.query<{ n: string }>(
    "select count(*)::text n from docs where visible_to && $1::text[]",
    [principals],
  );
  shares[p] = Number(r[0]?.n) / rows;
}
const terms = Array.from({ length: nQueries }, (_, i) => {
  const band = i % 3 === 0 ? [1, 20] : i % 3 === 1 ? [100, 600] : [2000, 5000];
  const w = () => `w${band[0] + Math.floor(rnd() * ((band[1] as number) - (band[0] as number)))}`;
  return i % 4 === 3 ? `${w()} ${w()}` : w();
});
const centroids = await db.query<{ c: number[] }>("select c from centroids order by t");
const qvecs = Array.from({ length: nQueries }, () => {
  const c = centroids[Math.floor(rnd() * centroids.length)]?.c ?? [];
  const v = c.map((x) => x + (rnd() * 0.4 - 0.2));
  const norm = Math.hypot(...v);
  return `[${v.map((x) => (x / norm).toFixed(5)).join(",")}]`;
});

const FTS = `select id from docs, websearch_to_tsquery('simple', $1) q
             where body @@ q and visible_to && $2::text[]
             order by ts_rank_cd(body, q) desc, id limit 10`;
const COUNT = `select count(*)::int n from (select 1 from docs where body @@ websearch_to_tsquery('simple', $1)
               and visible_to && $2::text[] limit 10001) x`;
const VEC = `select id from docs where visible_to && $2::text[] order by embedding <=> $1::vector limit 10`;
const VEC_ALL = `select id from docs order by embedding <=> $1::vector limit 10`;
const HYBRID = `with kw as (select id, row_number() over (order by ts_rank_cd(body, q) desc, id) r
                            from docs, websearch_to_tsquery('simple', $1) q
                            where body @@ q and visible_to && $3::text[]
                            order by ts_rank_cd(body, q) desc, id limit 50),
                     vs as (select id, row_number() over (order by embedding <=> $2::vector, id) r
                            from (select id, embedding from docs where visible_to && $3::text[]
                                  order by embedding <=> $2::vector limit 50) t)
                select id, sum(1.0 / (60 + r)) s from (select * from kw union all select * from vs) u
                group by id order by s desc, id limit 10`;

async function exact(sql: string, params: unknown[]): Promise<string[]> {
  await db.exec("set enable_indexscan = off; set enable_bitmapscan = off");
  const r = await db.query<{ id: string }>(sql, params);
  await db.exec("reset enable_indexscan; reset enable_bitmapscan");
  return r.map((x) => String(x.id));
}
const recall = (got: string[], truth: string[]) =>
  truth.length === 0 ? 1 : got.filter((g) => truth.includes(g)).length / Math.min(10, truth.length);

// Warm up caches once so p95 reflects a running service, not a cold start.
for (const t of terms.slice(0, 5))
  await db.query(FTS, [t, PROFILES["broad (everyone + 3 groups)"]]);

const ef = Number(values.ef);
await db.exec(`set hnsw.ef_search = ${ef}`);
const truthAll: string[][] = [];
for (const q of qvecs) truthAll.push(await exact(VEC_ALL, [q]));
const unfiltered: number[] = [];
for (const [i, q] of qvecs.entries())
  unfiltered.push(
    recall(
      (await db.query<{ id: string }>(VEC_ALL, [q])).map((x) => String(x.id)),
      truthAll[i] ?? [],
    ),
  );
const baseRecall = unfiltered.reduce((a, b) => a + b, 0) / unfiltered.length;
log(`\nunfiltered vector recall@10 (ef_search ${ef}): ${(baseRecall * 100).toFixed(1)}%`);

log(
  `\n| Access profile | Share of rows | Keyword top 10 | Keyword count (≤10k) | Vector HNSW, no iterative scan | Recall | HNSW, iterative (relaxed) | Recall | Exact on filtered rows | Hybrid RRF |`,
);
log(`| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
const bestOf: {
  profile: string;
  share: number;
  hnsw: number;
  hnswRecall: number;
  exact: number;
  text: number;
}[] = [];
let worstP95 = 0;
let worstRecallGap = 0;
for (const [profile, principals] of Object.entries(PROFILES)) {
  const fts: number[] = [];
  const counts: number[] = [];
  for (const t of terms) {
    fts.push((await time(() => db.query(FTS, [t, principals])))[1]);
    counts.push((await time(() => db.query(COUNT, [t, principals])))[1]);
  }
  const truths: string[][] = [];
  for (const q of qvecs) truths.push(await exact(VEC, [q, principals]));
  const measure = async (mode: string) => {
    if (mode === "exact")
      await db.exec("set enable_indexscan = off"); // bitmap on visible_to, then exact sort
    else await db.exec(`set hnsw.iterative_scan = ${mode}`);
    const ms: number[] = [];
    const rec: number[] = [];
    for (const [i, q] of qvecs.entries()) {
      const [r, t] = await time(() => db.query<{ id: string }>(VEC, [q, principals]));
      ms.push(t);
      rec.push(
        recall(
          r.map((x) => String(x.id)),
          truths[i] ?? [],
        ),
      );
    }
    await db.exec("reset enable_indexscan");
    return { ms, recall: rec.reduce((a, b) => a + b, 0) / rec.length };
  };
  const off = await measure("off");
  const relaxed = await measure("relaxed_order");
  const prefilter = await measure("exact");
  const hybrid: number[] = [];
  for (const [i, t] of terms.entries())
    hybrid.push((await time(() => db.query(HYBRID, [t, qvecs[i], principals])))[1]);
  await db.exec("reset hnsw.iterative_scan");
  worstP95 = Math.max(
    worstP95,
    pct(fts, 0.95),
    pct(relaxed.ms, 0.95),
    pct(hybrid, 0.95),
    pct(counts, 0.95),
  );
  worstRecallGap = Math.max(worstRecallGap, baseRecall - relaxed.recall);
  log(
    `| ${profile} | ${((shares[profile] ?? 0) * 100).toFixed(2)}% | ${fmt(fts)} | ${fmt(counts)} | ${fmt(off.ms)} | ${(off.recall * 100).toFixed(0)}% | ${fmt(relaxed.ms)} | ${(relaxed.recall * 100).toFixed(0)}% | ${fmt(prefilter.ms)} | ${fmt(hybrid)} |`,
  );
  bestOf.push({
    profile,
    share: shares[profile] ?? 0,
    hnsw: pct(relaxed.ms, 0.95),
    hnswRecall: relaxed.recall,
    exact: pct(prefilter.ms, 0.95),
    text: Math.max(pct(fts, 0.95), pct(counts, 0.95), pct(hybrid, 0.95)),
  });
}
log(
  `\nHNSW with iterative scan only: worst p95 ${worstP95.toFixed(1)} ms; worst recall gap vs unfiltered ${(worstRecallGap * 100).toFixed(1)} points; PASS ${worstP95 < 800 && worstRecallGap <= 0.05}`,
);
// Strategy: exact search on the filtered rows when it is fast enough (always recall 100%),
// otherwise HNSW with an iterative scan.
const strategy = bestOf.map((b) =>
  b.exact <= Math.max(50, b.hnsw)
    ? { ...b, p95: b.exact, recall: 1 }
    : { ...b, p95: b.hnsw, recall: b.hnswRecall },
);
const sp95 = Math.max(...strategy.map((s) => Math.max(s.p95, s.text)));
const sgap = Math.max(...strategy.map((s) => baseRecall - s.recall));
log(
  `with "exact when the filtered set is small": vector ${strategy.map((s) => `${s.profile} → ${s.recall === 1 ? "exact" : "HNSW"}`).join("; ")}`,
);
log(
  `PASS (strategy): worst p95 ${sp95.toFixed(1)} ms, worst recall gap ${(sgap * 100).toFixed(1)} points → ${sp95 < 800 && sgap <= 0.05}`,
);
await db.close();
