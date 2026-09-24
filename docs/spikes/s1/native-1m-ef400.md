# Spike S1 on native PostgreSQL 18.3, 1,000,000 rows

size: table 1302 MB, indexes 950 MB

unfiltered vector recall@10 (ef_search 400): 87.3%

| Access profile              | Share of rows | Keyword top 10                          | Keyword count (≤10k)                    | Vector HNSW, no iterative scan      | Recall | HNSW, iterative (relaxed)               | Recall | Exact on filtered rows                   | Hybrid RRF                              |
| --------------------------- | ------------- | --------------------------------------- | --------------------------------------- | ----------------------------------- | ------ | --------------------------------------- | ------ | ---------------------------------------- | --------------------------------------- |
| broad (everyone + 3 groups) | 24.84%        | p50 61.0 ms, p95 338.2 ms, max 396.4 ms | p50 46.7 ms, p95 132.2 ms, max 142.8 ms | p50 5.8 ms, p95 8.3 ms, max 8.9 ms  | 86%    | p50 3.7 ms, p95 4.6 ms, max 7.7 ms      | 86%    | p50 535.4 ms, p95 652.9 ms, max 662.8 ms | p50 67.2 ms, p95 331.8 ms, max 370.9 ms |
| department (1 group)        | 1.98%         | p50 4.5 ms, p95 60.5 ms, max 82.4 ms    | p50 4.1 ms, p95 55.1 ms, max 56.7 ms    | p50 6.4 ms, p95 7.3 ms, max 11.0 ms | 6%     | p50 79.2 ms, p95 100.1 ms, max 122.9 ms | 12%    | p50 8.7 ms, p95 14.6 ms, max 21.0 ms     | p50 91.4 ms, p95 149.2 ms, max 163.2 ms |
| tiny (1 user share)         | 0.10%         | p50 2.2 ms, p95 30.9 ms, max 36.7 ms    | p50 1.7 ms, p95 26.8 ms, max 29.4 ms    | p50 1.3 ms, p95 2.1 ms, max 2.6 ms  | 100%   | p50 1.2 ms, p95 1.4 ms, max 1.5 ms      | 100%   | p50 1.3 ms, p95 1.7 ms, max 2.5 ms       | p50 3.4 ms, p95 33.7 ms, max 40.2 ms    |

HNSW with iterative scan only: worst p95 338.2 ms; worst recall gap vs unfiltered 75.0 points; PASS false
with "exact when the filtered set is small": vector broad (everyone + 3 groups) → HNSW; department (1 group) → exact; tiny (1 user share) → exact
PASS (strategy): worst p95 338.2 ms, worst recall gap 1.0 points → true
