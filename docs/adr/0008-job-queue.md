# ADR-0008: Job queue: Postgres-backed (pg-boss)

- Status: proposed
- Date: 2026-09-23
- Deciders: @RevBooyah
- Related: T-401

## Context

From the OpenHoard Dev Plan (stack decisions). No extra infrastructure; transactional with the catalog.

## Decision

pg-boss on Postgres/PGlite for enrichment and sync jobs.

## Options considered

- **Chosen:** Postgres-backed (pg-boss)
- Redis + BullMQ
- SQS

## Consequences

Revisit if throughput exceeds what Postgres handles comfortably.
