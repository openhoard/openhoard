# Spike S2: PGlite parity

- Task: T-021
- Time box: 1 day
- Result: **pass, with four rules for the data layer**
- Confirms / changes: [ADR-0004](../adr/0004-database.md) is confirmed; the minimum production version and connection settings are tightened

## Question

Do the same schema, migrations and queries behave the same on PGlite (development, tests, single-node trials) and on native Postgres (production)?

## Pass criteria

The same migration applies everywhere, and the integration checks return identical results on both.

## Method

- Code: [`spikes/s2-pglite-parity/`](../../spikes/s2-pglite-parity/). [`schema.sql`](../../spikes/s2-pglite-parity/schema.sql) is a candidate core schema, and [`run.ts`](../../spikes/s2-pglite-parity/run.ts) runs 22 behavioural checks (plus version and timing reports) on each engine and diffs the results. Run it with `pnpm --filter @openhoard/spike-s2-pglite-parity spike -- postgres://…`.
- Engines:
  - PGlite 0.5.8, which is PostgreSQL 18.3 (32-bit WASM), with `@electric-sql/pglite-pgvector` (pgvector 0.8.1);
  - native PostgreSQL 18.3 with pgvector 0.8.1, built from source;
  - native PostgreSQL 16.13 with pgvector 0.6.0, from the Ubuntu 24.04 packages.
- Machine: 2 vCPU, Linux x64, Node 24.21.
- Data: 400 deterministic documents in 2 tenants, with tags, access lists and 8-dimension embeddings.
- The schema uses:
  - composite tenant keys, checks, cascades, and a tag-format regex check;
  - a generated weighted `tsvector` with GIN, a `text[]` access list with GIN, and a pgvector HNSW index;
  - JSONB, a trigger, a `bigserial` job table, a non-superuser `app` role, and forced row-level security on `app.tenant_id`.

## Results

Full output: [`s2-output.md`](s2-output.md).

**18 of the 22 behavioural checks gave identical results on all three engines**:

- full-text ranking (`websearch_to_tsquery`, `ts_rank_cd`) and English stemming;
- full-text search combined with a `text[] && principals` access filter;
- exact kNN distances;
- use of the HNSW index, and its recall against exact search;
- a hybrid RRF query written in SQL;
- row-level security: tenant isolation, and zero rows when no tenant is set (fail closed);
- SQLSTATE codes for check, unique, foreign-key and generated-column violations;
- cascades, triggers, JSONB containment and `jsonb_path_exists`;
- savepoint rollback, `FOR UPDATE SKIP LOCKED` semantics, advisory locks, and LISTEN/NOTIFY;
- ordering under the C collation, and timestamps after `SET TIME ZONE 'UTC'`.

The four differences are all driver or environment settings, not SQL:

| Check                     | PGlite                      | Native                                                           | Consequence                                                                                                                                                                                                                                         |
| ------------------------- | --------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `int8`/`bigserial` values | number, or BigInt past 2^53 | string (node-postgres)                                           | The data layer must map `int8` explicitly (Drizzle `mode: "bigint"` or `"number"`)                                                                                                                                                                  |
| Session time zone         | `Etc/GMT+7` (from the host) | host or server setting                                           | Set `SET TIME ZONE 'UTC'` on every connection                                                                                                                                                                                                       |
| `upper('straße')`         | `STRAẞE`                    | `STRAßE` (libc and builtin C.UTF-8), `STRASSE` (PG_UNICODE_FAST) | Never rely on database case mapping outside ASCII. Normalize identifiers in the application                                                                                                                                                         |
| Default collation         | C (no ICU in PGlite)        | whatever the cluster was created with                            | Create production databases with `LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8'` (PG 17+), which sorts like PGlite. With an ICU `en-US` collation, the same `ORDER BY` returned `_z, a, ä, b, B, Émile, Z` instead of `B, Z, _z, a, b, Émile, ä` |

Other findings:

- **Version skew is the real risk.** PGlite 0.5.8 is PostgreSQL 18 with pgvector 0.8.1. Ubuntu 24.04 ships PostgreSQL 16 with pgvector 0.6.0, which has no iterative index scans (`hnsw.iterative_scan`). Filtered vector search depends on those (spike S1).
- **PGlite 0.5 moved pgvector** out of the core package into `@electric-sql/pglite-pgvector`. The old `@electric-sql/pglite/vector` import no longer exists.
- **Throughput (not compared):** PGlite ran about 1,400 filtered full-text queries per second, against 3,700–4,100 for native, on this data. That is fine for development and tests, and it is why production uses native Postgres.

## Decision

ADR-0004 stands: the same SQL and migrations run everywhere. The data layer (E3) adopts four rules, and production gets a minimum version:

1. **Postgres 17+ in production, 18 recommended, with pgvector 0.8+.** This matches PGlite's major version and has iterative index scans.
2. **Every connection sets `TIME ZONE 'UTC'`.** Timestamps are stored as `timestamptz`.
3. **Databases are created with the builtin `C.UTF-8` locale.** Anything user-facing that needs language-aware sorting uses an explicit collation in the query.
4. **`int8` columns get an explicit driver mapping**, and no code compares non-ASCII text after database-side `upper()`/`lower()`.

Follow-ups:

- The CI integration job runs the migration and query suite on PGlite, plus native Postgres 18 in the nightly job (per ADR-0004). It installs with the official packages and no Docker.
- Update ADR-0004 (done in this change).
