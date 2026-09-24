# Spike S1 on native PostgreSQL 18.3, 1,000,000 rows

generate: 68 s
GIN indexes (body, visible_to): 13 s
HNSW index (m 16, ef_construction 64): 167 s
size: table 1302 MB, indexes 950 MB

unfiltered vector recall@10 (ef_search 100): 87.0%

| Access profile              | Share of rows | Keyword top 10                          | Keyword count (≤10k)                   | Vector HNSW, no iterative scan     | Recall | HNSW, iterative (relaxed)                | Recall | Exact on filtered rows                   | Hybrid RRF                              |
| --------------------------- | ------------- | --------------------------------------- | -------------------------------------- | ---------------------------------- | ------ | ---------------------------------------- | ------ | ---------------------------------------- | --------------------------------------- |
| broad (everyone + 3 groups) | 24.84%        | p50 42.5 ms, p95 288.9 ms, max 345.5 ms | p50 37.4 ms, p95 82.7 ms, max 131.3 ms | p50 4.3 ms, p95 6.1 ms, max 6.4 ms | 81%    | p50 1.9 ms, p95 2.7 ms, max 2.9 ms       | 81%    | p50 611.7 ms, p95 811.6 ms, max 842.6 ms | p50 55.5 ms, p95 305.6 ms, max 442.3 ms |
| department (1 group)        | 1.98%         | p50 4.8 ms, p95 56.2 ms, max 61.1 ms    | p50 3.7 ms, p95 45.9 ms, max 49.8 ms   | p50 4.4 ms, p95 6.4 ms, max 9.4 ms | 5%     | p50 109.8 ms, p95 144.0 ms, max 144.2 ms | 10%    | p50 10.0 ms, p95 15.8 ms, max 22.7 ms    | p50 94.5 ms, p95 153.8 ms, max 160.8 ms |
| tiny (1 user share)         | 0.10%         | p50 2.1 ms, p95 32.3 ms, max 36.6 ms    | p50 1.8 ms, p95 25.9 ms, max 28.1 ms   | p50 1.4 ms, p95 4.0 ms, max 4.7 ms | 100%   | p50 1.4 ms, p95 2.6 ms, max 2.6 ms       | 100%   | p50 1.2 ms, p95 1.7 ms, max 2.9 ms       | p50 3.3 ms, p95 29.5 ms, max 31.4 ms    |

HNSW with iterative scan only: worst p95 305.6 ms; worst recall gap vs unfiltered 76.7 points; PASS false
with "exact when the filtered set is small": vector broad (everyone + 3 groups) → HNSW; department (1 group) → exact; tiny (1 user share) → exact
PASS (strategy): worst p95 305.6 ms, worst recall gap 5.7 points → false
