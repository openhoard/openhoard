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
