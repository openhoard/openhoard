# Spike S1: search at scale

- Task: T-020
- Time box: 3 days
- Result: **pass, with a selectivity-aware query plan**. Plain filtered HNSW fails.
- Confirms / changes: [ADR-0005](../adr/0005-search-v1.md), confirmed with an amendment on how vector queries are planned

## Question

With 1 million document versions in native Postgres, does permission-filtered hybrid search (full-text + pgvector + access list) meet the bar? The access filter is applied inside the query, as the architecture requires.

## Pass criteria

- p95 < 800 ms.
- Filtered vector recall@10 within 5 points of unfiltered recall.

Otherwise, revise ADR-0005.

## Method

- Code: [`spikes/s1-search-scale/`](../../spikes/s1-search-scale/). [`generate.sql`](../../spikes/s1-search-scale/generate.sql) builds the data inside Postgres, deterministically. [`run.ts`](../../spikes/s1-search-scale/run.ts) runs the workload. Run it with `pnpm --filter @openhoard/spike-s1-search-scale spike -- --url postgres://… --rows 1000000 --ef 200`, or `--pglite`.
- Engines:
  - native PostgreSQL 18.3 with pgvector 0.8.1, on 2 vCPU and 7 GB RAM (`shared_buffers` 1 GB, `maintenance_work_mem` 2 GB);
  - PGlite 0.5.8 at 100k rows.
- Data: 1,000,000 rows. Each has a 4-word title and 30 words of body drawn from 5,000 terms with a steep skew, so the top terms match most rows. Each also has a `text[]` access list and a 128-dimension embedding.
  - Access: 60 department groups. 20% of rows are also visible to `group:everyone`, and 0.1% are shared with one user.
  - Embeddings: each row is 1 of 200 topic centroids plus noise.
- Indexes: GIN on the `tsvector`, GIN on the access list, and HNSW (`m` 16, `ef_construction` 64, cosine).
- Build times: generation 68 s, GIN 13 s, HNSW 167 s. On disk: table 1.3 GB, indexes 0.95 GB.
- Workload per access profile: 30 keyword queries across the frequency range, a capped count ("10,000+"), 30 vector queries near a topic, and a hybrid RRF query. The results were compared with exact (sequential) search on the same filter to get recall@10.
- Access profiles:
  - broad: everyone plus 3 groups, 24.8% of rows;
  - department: 1 group, 2.0%;
  - tiny: 1 user share, 0.1%.

## Results: 1M rows, native, `hnsw.ef_search` 200

Full output for ef_search 100, 200 and 400 is in [`s1/`](s1/).

| Profile           | Keyword top 10 (p95) | Count ≤10k (p95) | HNSW + iterative scan: p95 / recall | Exact on the filtered rows: p95 / recall | Hybrid RRF (p95) |
| ----------------- | -------------------- | ---------------- | ----------------------------------- | ---------------------------------------- | ---------------- |
| broad (24.8%)     | 312 ms               | 125 ms           | **3.5 ms / 85%**                    | 634 ms / 100%                            | 310 ms           |
| department (2.0%) | 64 ms                | 54 ms            | 103 ms / **12%**                    | **15 ms / 100%**                         | 143 ms           |
| tiny (0.1%)       | 38 ms                | 38 ms            | 1.4 ms / 100%                       | **1.4 ms / 100%**                        | 38 ms            |

Unfiltered HNSW recall@10 is 87% at ef_search 100 and 87.3% at both 200 and 400. The synthetic clusters are dense and full of near-ties, which caps recall on this data; real embeddings usually do better. What matters here is the _gap_ between filtered and unfiltered recall.

- **Filtered HNSW collapses on selective filters.** Without iterative scans, a 2% filter gives 5–6% recall: HNSW finds 40 near neighbours, and almost none are visible. pgvector 0.8's iterative scan (`relaxed_order`) only reaches 12%, because it stops at `hnsw.max_scan_tuples` long before it collects 10 matches. On PGlite at 100k rows it reached 29%.
- **Exact search on the filtered rows** reads the GIN bitmap on the access list, then sorts by distance. It is fast while the filtered set is small (20k rows: 15 ms) and slow when it is large (250k rows: 634 ms).
- **So the planner cannot be trusted with this choice.** It picked HNSW for the department profile and returned 12% recall. The application has to choose the plan from the caller's visible-row count.
- **With that choice** (exact at or below about 50k visible rows, HNSW with iterative scan above), the worst p95 across all queries is 312 ms at ef_search 200 and 338 ms at ef_search 400. The worst recall gap is 2.3 points (ef_search 200) or 1.0 point (400), against 5.7 points at ef_search 100. **That passes.**
- **Keyword ranking is the main cost.** `ts_rank_cd` over hundreds of thousands of matches (common terms, broad users) reaches about 310–340 ms p95. The capped count stays under 135 ms.
- **PGlite at 100k rows** is comfortable for development: the worst p95 is 82 ms, and the same strategy passes.

## Decision

ADR-0005 stands (Postgres full-text + pgvector + RRF, with the access filter inside the query), with these rules:

1. **Selectivity-aware vector plan.**
   - Estimate the caller's visible rows. The estimate comes from a per-principal count table maintained at ingest; a `count(*)` per query is too slow.
   - At or below 50,000 visible rows: search exactly on the filtered rows (`enable_indexscan = off` for that statement, or a `MATERIALIZED` CTE over the access-list bitmap).
   - Above that: HNSW with `hnsw.iterative_scan = relaxed_order` and `hnsw.ef_search = 200`. The threshold is configurable, and the nightly benchmark (T-019) re-measures it.
2. **The hybrid query uses the same plan** for its vector half. It must not leave the choice to the planner.
3. **Counts are capped** ("10,000+ results"). Facets are computed over the capped, visible candidate set.
4. **Follow-up:** bound keyword ranking cost. Rank only the top N candidates by a cheaper signal, or move to BM25 (ParadeDB, or Meilisearch behind the same interface) if p95 grows with corpus size.
5. **Sizing:** about 2.3 GB per million versions at 128 dimensions. At 384 dimensions the vectors and the HNSW index grow about 3×, so plan roughly 5 GB per million versions.
