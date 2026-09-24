# ADR-0005: Search v1: Postgres full-text + pgvector with RRF

- Status: proposed
- Date: 2026-09-23
- Deciders: @RevBooyah
- Related: T-020

## Context

From the OpenHoard Dev Plan (stack decisions). Runs in PGlite and plain Postgres with no extension installs; avoids ParadeDB's AGPL license.

## Decision

Keyword search via tsvector/GIN and semantic search via pgvector HNSW, fused with reciprocal rank fusion; access filter applied inside both queries.

## Options considered

- **Chosen:** Postgres full-text + pgvector with RRF
- ParadeDB pg_search
- Meilisearch
- OpenSearch

## Consequences

Ranking is weaker than BM25; ParadeDB or Meilisearch can replace it behind the same interface. Spike S1 sets the performance bar.

## Spike S1 result (T-020)

[Spike S1](../spikes/s1-search-scale.md) passed at 1M versions on PostgreSQL 18.3 with pgvector 0.8.1. The worst p95 across keyword, count, vector and hybrid queries was 312 ms, and the filtered recall gap was 2.3 points. That required one rule: **the application chooses the vector plan from the caller's visible-row count.**

- Filtered HNSW gives 12% recall at 2% selectivity, even with iterative scans.
- Exact search over a small filtered set takes 15 ms with 100% recall.
- Exact search over a 25% filtered set takes 634 ms, where HNSW takes 3.5 ms.

Plan: exact at or below about 50k visible rows, otherwise HNSW with `iterative_scan = relaxed_order` and `ef_search = 200`. Visible-row estimates come from a per-principal count table. Keyword ranking over large match sets is the next cost to bound.
