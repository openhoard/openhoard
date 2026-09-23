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

## Spike S2 result (T-021)

[Spike S2](../spikes/s2-pglite-parity.md) passed. The same schema and 18 of 22 behavioural checks gave identical results on PGlite 0.5.8 (PostgreSQL 18.3, pgvector 0.8.1) and on native PostgreSQL 18.3 and 16.13. The rest were driver or environment differences, which set these rules:

- Production: PostgreSQL 17+ (18 recommended) with pgvector 0.8+. That matches PGlite's major version and has the iterative index scans filtered vector search needs.
- Every connection runs `SET TIME ZONE 'UTC'`.
- Databases use the builtin `C.UTF-8` locale, so `ORDER BY` matches PGlite.
- `int8` gets an explicit driver mapping.
- Nothing relies on database case mapping outside ASCII.
