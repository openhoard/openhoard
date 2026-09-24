# Spike S1 on PGlite 0.5.8 (in memory), 100,000 rows

generate: 11 s
GIN indexes (body, visible_to): 2 s
HNSW index (m 16, ef_construction 64): 67 s
size: table 130 MB, indexes 95 MB

unfiltered vector recall@10 (ef_search 200): 89.5%

| Access profile              | Share of rows | Keyword top 10                       | Keyword count (≤10k)                 | Vector HNSW, no iterative scan     | Recall | HNSW, iterative (relaxed)             | Recall | Exact on filtered rows                  | Hybrid RRF                            |
| --------------------------- | ------------- | ------------------------------------ | ------------------------------------ | ---------------------------------- | ------ | ------------------------------------- | ------ | --------------------------------------- | ------------------------------------- |
| broad (everyone + 3 groups) | 24.83%        | p50 5.2 ms, p95 32.4 ms, max 52.7 ms | p50 4.6 ms, p95 16.9 ms, max 25.8 ms | p50 1.5 ms, p95 1.8 ms, max 2.2 ms | 94%    | p50 1.5 ms, p95 1.7 ms, max 1.9 ms    | 94%    | p50 73.4 ms, p95 103.4 ms, max 112.6 ms | p50 8.9 ms, p95 35.1 ms, max 38.3 ms  |
| department (1 group)        | 2.03%         | p50 1.2 ms, p95 6.7 ms, max 6.8 ms   | p50 1.2 ms, p95 6.3 ms, max 6.4 ms   | p50 1.8 ms, p95 2.3 ms, max 2.6 ms | 0%     | p50 57.4 ms, p95 76.3 ms, max 77.7 ms | 29%    | p50 2.3 ms, p95 3.9 ms, max 4.5 ms      | p50 71.6 ms, p95 82.4 ms, max 86.3 ms |
| tiny (1 user share)         | 0.10%         | p50 1.1 ms, p95 3.6 ms, max 4.8 ms   | p50 1.0 ms, p95 3.3 ms, max 4.7 ms   | p50 1.0 ms, p95 1.7 ms, max 1.8 ms | 100%   | p50 0.9 ms, p95 1.2 ms, max 1.4 ms    | 100%   | p50 1.0 ms, p95 1.2 ms, max 1.4 ms      | p50 1.9 ms, p95 4.0 ms, max 4.6 ms    |

HNSW with iterative scan only: worst p95 82.4 ms; worst recall gap vs unfiltered 60.5 points; PASS false
with "exact when the filtered set is small": vector broad (everyone + 3 groups) → HNSW; department (1 group) → exact; tiny (1 user share) → exact
PASS (strategy): worst p95 82.4 ms, worst recall gap -4.0 points → true
