// Spike S2 (T-021): do the same schema, migrations and queries behave identically on PGlite
// (dev, tests, single-node trials) and native Postgres (production)?
//   pnpm --filter @openhoard/spike-s2-pglite-parity spike -- [postgres://… …]
// Each URL is a native server the spike may create and drop a `spike_parity` database on.
// Throwaway code: see docs/spikes/s2-pglite-parity.md for the write-up.
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import pg from "pg";

interface Db {
  name: string;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  /** Subscribes, sends one NOTIFY, returns what arrived. */
  notifyRoundTrip(channel: string, payload: string): Promise<string | undefined>;
  close(): Promise<void>;
}

async function pglite(): Promise<Db> {
  const db = await PGlite.create({ extensions: { vector } });
  const v = (await db.query<{ v: string }>("select version() v")).rows[0]?.v ?? "";
  return {
    name: `PGlite ${/PGlite ([\d.]+)/.exec(v)?.[1]} (PostgreSQL ${/PostgreSQL ([\d.]+)/.exec(v)?.[1]})`,
    query: async (sql, params) => (await db.query(sql, params)).rows as never,
    exec: async (sql) => void (await db.exec(sql)),
    notifyRoundTrip: async (channel, payload) => {
      let got: string | undefined;
      const unlisten = await db.listen(channel, (p) => (got = p));
      await db.query(`select pg_notify($1, $2)`, [channel, payload]);
      await new Promise((r) => setTimeout(r, 50));
      await unlisten();
      return got;
    },
    close: () => db.close(),
  };
}

async function native(url: string): Promise<Db> {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query("drop database if exists spike_parity");
  await admin.query("create database spike_parity");
  await admin.end();
  const target = new URL(url);
  target.pathname = "/spike_parity";
  const client = new pg.Client({ connectionString: target.toString() });
  await client.connect();
  const v = (await client.query<{ v: string }>("select version() v")).rows[0]?.v ?? "";
  // Roles are cluster-wide: tolerate one left over from an earlier run.
  await client.query(
    "do $$ begin drop role if exists app; exception when others then null; end $$",
  );
  return {
    name: `native PostgreSQL ${/PostgreSQL ([\d.]+)/.exec(v)?.[1]}`,
    query: async (sql, params) => (await client.query(sql, params as unknown[])).rows as never,
    exec: async (sql) => void (await client.query(sql)),
    notifyRoundTrip: async (channel, payload) => {
      const listener = new pg.Client({ connectionString: target.toString() });
      await listener.connect();
      let got: string | undefined;
      listener.on("notification", (n) => (got = n.payload));
      await listener.query(`listen ${channel}`);
      await client.query(`select pg_notify($1, $2)`, [channel, payload]);
      await new Promise((r) => setTimeout(r, 100));
      await listener.end();
      return got;
    },
    close: async () => {
      await client
        .query("reassign owned by app to current_user; drop owned by app; drop role app")
        .catch(() => undefined);
      await client.end();
    },
  };
}

// ── Deterministic seed data ─────────────────────────────────────────────────────────────────
let state = 42;
const rand = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const WORDS = [
  "invoice",
  "contract",
  "acme",
  "bluefin",
  "forecast",
  "minutes",
  "budget",
  "review",
  "Zeta",
  "alpha",
  "Émile",
  "ångström",
  "_draft",
  "Q3",
  "q4",
];
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)] as T;
const vec = () => `[${Array.from({ length: 8 }, () => (rand() * 2 - 1).toFixed(4)).join(",")}]`;
const docs = Array.from({ length: 400 }, (_, i) => ({
  tenant: i % 2 ? "t2" : "t1",
  id: `o-${String(i).padStart(4, "0")}`,
  title: `${pick(WORDS)} ${pick(WORDS)} ${i}`,
  content: Array.from({ length: 12 }, () => pick(WORDS)).join(" "),
  visibleTo: [`group:g${i % 7}`, ...(i % 5 === 0 ? ["user:u1"] : [])],
  embedding: vec(),
  tags: [`type:${pick(["invoice", "contract", "report"])}`, `client:${pick(["acme", "bluefin"])}`],
}));
const queryVec = vec();

async function seed(db: Db): Promise<void> {
  await db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  await db.query("insert into tenants values ('t1', 'Tenant one'), ('t2', 'Tenant two')");
  for (const d of docs) {
    await db.query(
      "insert into objects (tenant_id, id, title, zone, owner_id, meta) values ($1, $2, $3, 'managed', 'u1', $4)",
      [d.tenant, d.id, d.title, JSON.stringify({ n: Number(d.id.slice(2)), tags: d.tags })],
    );
    await db.query(
      "insert into search_docs (tenant_id, object_id, title, content, visible_to, embedding) values ($1, $2, $3, $4, $5, $6)",
      [d.tenant, d.id, d.title, d.content, d.visibleTo, d.embedding],
    );
    for (const tag of d.tags)
      await db.query("insert into object_tags values ($1, $2, $3, 'rule', 0.9)", [
        d.tenant,
        d.id,
        tag,
      ]);
  }
  await db.query(
    "insert into jobs (queue, payload) select 'ingest', jsonb_build_object('n', g) from generate_series(1, 5) g",
  );
}

/** SQLSTATE of a failing statement, or "ok". */
async function sqlstate(db: Db, sql: string, params?: unknown[]): Promise<string> {
  try {
    await db.query(sql, params);
    return "ok";
  } catch (e) {
    return (e as { code?: string }).code ?? "error";
  }
}
const round = (x: unknown) => Math.round(Number(x) * 1e5) / 1e5;

type Check = (db: Db) => Promise<unknown>;
const CHECKS: Record<string, Check> = {
  "fts: ranked websearch query": async (db) =>
    (
      await db.query<{ object_id: string; r: number }>(
        "select object_id, ts_rank_cd(body, q) r from search_docs, websearch_to_tsquery('simple', 'invoice acme') q where body @@ q order by r desc, object_id limit 10",
      )
    ).map((r) => [r.object_id, round(r.r)]),
  "fts: english stemming": async (db) =>
    (await db.query("select to_tsvector('english', 'Running dogs were reviewed') v"))[0],
  "fts + access filter (GIN on text[])": async (db) =>
    (
      await db.query<{ object_id: string }>(
        "select object_id from search_docs where body @@ websearch_to_tsquery('simple', 'contract') and visible_to && $1::text[] order by object_id",
        [["group:g3", "user:u1"]],
      )
    ).map((r) => r.object_id),
  "vector: exact kNN": async (db) => {
    await db.exec("set enable_indexscan = off; set enable_bitmapscan = off");
    const rows = await db.query<{ object_id: string; d: number }>(
      "select object_id, embedding <=> $1 d from search_docs order by d, object_id limit 10",
      [queryVec],
    );
    await db.exec("reset enable_indexscan; reset enable_bitmapscan");
    return rows.map((r) => [r.object_id, round(r.d)]);
  },
  "vector: HNSW index is used": async (db) => {
    await db.exec("set enable_seqscan = off");
    const plan = await db.query<{ "QUERY PLAN": string }>(
      "explain select object_id from search_docs order by embedding <=> '[1,0,0,0,0,0,0,0]' limit 5",
    );
    await db.exec("reset enable_seqscan");
    return plan.some((p) => p["QUERY PLAN"].includes("search_docs_embedding"));
  },
  "vector: HNSW recall@10 vs exact": async (db) => {
    await db.exec("set enable_seqscan = off");
    const ann = (
      await db.query<{ object_id: string }>(
        "select object_id from search_docs order by embedding <=> $1 limit 10",
        [queryVec],
      )
    ).map((r) => r.object_id);
    await db.exec("reset enable_seqscan; set enable_indexscan = off; set enable_bitmapscan = off");
    const exact = (
      await db.query<{ object_id: string }>(
        "select object_id from search_docs order by embedding <=> $1 limit 10",
        [queryVec],
      )
    ).map((r) => r.object_id);
    await db.exec("reset enable_indexscan; reset enable_bitmapscan");
    return ann.filter((id) => exact.includes(id)).length / 10 >= 0.9;
  },
  "hybrid: RRF of keyword and vector in one query": async (db) =>
    (
      await db.query<{ object_id: string; score: number }>(
        `with kw as (select object_id, row_number() over (order by ts_rank_cd(body, q) desc, object_id) r
                   from search_docs, websearch_to_tsquery('simple', 'budget') q where body @@ q),
            vs as (select object_id, row_number() over (order by embedding <=> $1, object_id) r
                   from search_docs order by embedding <=> $1, object_id limit 50)
       select object_id, sum(1.0 / (60 + r)) score from (select * from kw union all select * from vs) x
       group by object_id order by score desc, object_id limit 10`,
        [queryVec],
      )
    ).map((r) => [r.object_id, round(r.score)]),
  "rls: tenant isolation, and fail closed without a tenant": async (db) => {
    await db.exec("set role app");
    const none = await db.query<{ n: string }>("select count(*)::text n from objects");
    await db.exec("set app.tenant_id = 't1'");
    const t1 = await db.query<{ n: string }>("select count(*)::text n from objects");
    const cross = await db.query<{ n: string }>(
      "select count(*)::text n from search_docs where tenant_id = 't2'",
    );
    await db.exec("reset app.tenant_id; reset role");
    return { withoutTenant: none[0]?.n, tenantOne: t1[0]?.n, crossTenantRows: cross[0]?.n };
  },
  "constraints: SQLSTATE codes": async (db) => ({
    check: await sqlstate(
      db,
      "insert into objects (tenant_id, id, title, zone, owner_id) values ('t1', 'x', 'x', 'bad', 'u1')",
    ),
    unique: await sqlstate(db, "insert into tenants values ('t1', 'dup')"),
    foreignKey: await sqlstate(
      db,
      "insert into versions values ('t1', 'v', 'missing', 'b', 1, 'text/plain')",
    ),
    tagFormat: await sqlstate(
      db,
      "insert into object_tags values ('t1', 'o-0000', 'Bad Tag', 'rule', 0.5)",
    ),
    generatedColumn: await sqlstate(
      db,
      "update search_docs set body = ''::tsvector where object_id = 'o-0000'",
    ),
  }),
  "cascade delete": async (db) => {
    await db.query("delete from objects where tenant_id = 't1' and id = 'o-0000'");
    return (
      await db.query(
        "select count(*)::int n from object_tags where object_id = 'o-0000' and tenant_id = 't1'",
      )
    )[0];
  },
  "trigger: updated_at": async (db) => {
    await db.query(
      "update objects set title = title || '!' where id = 'o-0002' and tenant_id = 't1'",
    );
    return (
      await db.query(
        "select updated_at >= created_at ok from objects where id = 'o-0002' and tenant_id = 't1'",
      )
    )[0];
  },
  "jsonb: containment and path": async (db) =>
    (
      await db.query<{ id: string }>(
        "select id from objects where meta @> '{\"tags\": [\"client:acme\"]}' and jsonb_path_exists(meta, '$.n ? (@ < 20)') order by tenant_id, id",
      )
    ).map((r) => r.id),
  "transactions: savepoint rollback": async (db) => {
    await db.exec("begin");
    await db.query("insert into jobs (queue, payload) values ('q', '{}')");
    await db.exec("savepoint s");
    const failed = await sqlstate(
      db,
      "insert into jobs (id, queue, payload) values (1, 'q', '{}')",
    );
    await db.exec("rollback to savepoint s");
    await db.exec("commit");
    return { failed, jobs: (await db.query("select count(*)::int n from jobs"))[0] };
  },
  "queue: FOR UPDATE SKIP LOCKED": async (db) => {
    await db.exec("begin");
    const row = await db.query(
      "select id from jobs where state = 'created' order by id for update skip locked limit 1",
    );
    await db.exec("commit");
    return row;
  },
  "advisory locks": async (db) =>
    (await db.query("select pg_try_advisory_lock(42) a, pg_advisory_unlock(42) b"))[0],
  "listen/notify": (db) => db.notifyRoundTrip("spike_channel", "hello"),
  "collation: default ORDER BY": async (db) =>
    (
      await db.query(
        "select array_agg(x order by x) a from unnest(array['b','B','a','_z','Z','ä','Émile']) x",
      )
    )[0],
  'collation: explicit COLLATE "C"': async (db) =>
    (
      await db.query(
        "select array_agg(x order by x collate \"C\") a from unnest(array['b','B','a','_z','Z','ä','Émile']) x",
      )
    )[0],
  "case mapping: lower/upper outside ASCII": async (db) =>
    (await db.query("select lower('ÄÖÜ Émile') l, upper('straße') u"))[0],
  "timezone: session default": async (db) => (await db.query("show timezone"))[0],
  "timezone: after SET TIME ZONE 'UTC'": async (db) => {
    await db.exec("set time zone 'UTC'");
    return (
      await db.query(
        "select to_char(timestamptz '2026-01-01 12:00:00+00', 'YYYY-MM-DD HH24:MI TZ') t",
      )
    )[0];
  },
  "numeric and bigint round-trip": async (db) =>
    (
      await db.query(
        "select 9007199254740993::bigint b, 0.1::numeric + 0.2::numeric n, 'NaN'::float8 f",
      )
    )[0],
  "extension versions": async (db) =>
    await db.query("select extname, extversion from pg_extension order by extname"),
};

async function run(db: Db): Promise<Record<string, unknown>> {
  const t0 = performance.now();
  await seed(db);
  const seedMs = performance.now() - t0;
  const out: Record<string, unknown> = {};
  for (const [name, check] of Object.entries(CHECKS)) {
    try {
      out[name] = await check(db);
    } catch (e) {
      out[name] = { error: (e as Error).message };
    }
  }
  const t1 = performance.now();
  for (let i = 0; i < 300; i++) {
    await db.query(
      "select object_id from search_docs where body @@ websearch_to_tsquery('simple', $1) and visible_to && $2::text[] order by object_id limit 10",
      [pick(WORDS), ["group:g1"]],
    );
  }
  out["timing (not compared)"] = {
    seedMs: Math.round(seedMs),
    queriesPerSecond: Math.round(300 / ((performance.now() - t1) / 1000)),
  };
  return out;
}

const urls = process.argv.slice(2).filter((a) => a !== "--");
const engines: Db[] = [await pglite(), ...(await Promise.all(urls.map(native)))];
const results: Record<string, unknown>[] = [];
for (const db of engines) {
  state = 42;
  results.push(await run(db));
  await db.close();
}

const names = engines.map((e) => e.name);
console.log(`| Check | ${names.join(" | ")} |`);
console.log(`| --- | ${names.map(() => "---").join(" | ")} |`);
let differences = 0;
for (const check of Object.keys(results[0] ?? {})) {
  const values = results.map((r) => r[check]);
  const same = values.every((v) => isDeepStrictEqual(v, values[0]));
  if (!same && !check.startsWith("timing") && check !== "extension versions") differences++;
  const show = (v: unknown) =>
    JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? `${x}n` : x));
  const cells = values.map((v) => `\`${show(v)?.slice(0, 90)}\``);
  console.log(`| ${check} ${same ? "" : "**(differs)**"} | ${cells.join(" | ")} |`);
}
console.log(
  `\n${differences} check(s) differ between engines (timing and extension versions excluded).`,
);
