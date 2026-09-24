# Spike S1 on native PostgreSQL 18.3, 1,000,000 rows

size: table 1302 MB, indexes 950 MB

unfiltered vector recall@10 (ef_search 200): 87.3%

| Access profile              | Share of rows | Keyword top 10                          | Keyword count (≤10k)                    | Vector HNSW, no iterative scan     | Recall | HNSW, iterative (relaxed)               | Recall | Exact on filtered rows                   | Hybrid RRF                              |
| --------------------------- | ------------- | --------------------------------------- | --------------------------------------- | ---------------------------------- | ------ | --------------------------------------- | ------ | ---------------------------------------- | --------------------------------------- |
| broad (everyone + 3 groups) | 24.84%        | p50 60.4 ms, p95 312.0 ms, max 428.6 ms | p50 49.5 ms, p95 124.8 ms, max 150.9 ms | p50 5.5 ms, p95 8.2 ms, max 8.4 ms | 85%    | p50 2.8 ms, p95 3.5 ms, max 3.7 ms      | 85%    | p50 547.9 ms, p95 633.7 ms, max 652.4 ms | p50 66.8 ms, p95 310.3 ms, max 355.1 ms |
| department (1 group)        | 1.98%         | p50 4.8 ms, p95 64.2 ms, max 65.6 ms    | p50 3.6 ms, p95 53.6 ms, max 54.7 ms    | p50 5.3 ms, p95 7.3 ms, max 7.8 ms | 6%     | p50 81.4 ms, p95 102.5 ms, max 107.2 ms | 12%    | p50 8.7 ms, p95 15.2 ms, max 22.1 ms     | p50 96.1 ms, p95 142.7 ms, max 166.7 ms |
| tiny (1 user share)         | 0.10%         | p50 2.6 ms, p95 38.1 ms, max 38.5 ms    | p50 1.8 ms, p95 38.4 ms, max 42.6 ms    | p50 1.2 ms, p95 2.2 ms, max 2.7 ms | 100%   | p50 1.2 ms, p95 1.4 ms, max 1.8 ms      | 100%   | p50 1.2 ms, p95 1.4 ms, max 2.7 ms       | p50 3.3 ms, p95 37.6 ms, max 38.8 ms    |

HNSW with iterative scan only: worst p95 312.0 ms; worst recall gap vs unfiltered 75.7 points; PASS false
with "exact when the filtered set is small": vector broad (everyone + 3 groups) → HNSW; department (1 group) → exact; tiny (1 user share) → exact
PASS (strategy): worst p95 312.0 ms, worst recall gap 2.3 points → true
