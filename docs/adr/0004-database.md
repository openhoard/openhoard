# ADR-0004: Database: Postgres + pgvector, PGlite for dev and tests

- Status: proposed
- Date: 2026-09-23
- Deciders: @RevBooyah
- Related: T-021

## Context

From the OpenHoard Dev Plan (stack decisions). No Docker; the same SQL and migrations everywhere.

## Decision

Postgres 16+ with pgvector in production; PGlite (Postgres compiled to WASM, pgvector included) for development, tests and single-node trials.

## Options considered

- **Chosen:** Postgres + pgvector, PGlite for dev and tests
- SQLite (different SQL dialect)
- Postgres in Docker (ruled out)

## Consequences

Spike S2 must prove parity; nightly job runs against native Postgres.
