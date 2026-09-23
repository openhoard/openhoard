# ADR-0007: Policy engine: Cedar

- Status: proposed
- Date: 2026-09-23
- Deciders: @RevBooyah
- Related: T-022

## Context

From the OpenHoard Dev Plan (stack decisions). Attribute-based, analyzable policies; runs in-process.

## Decision

Cedar via @cedar-policy/cedar-wasm, wrapped behind our own authorize() interface.

## Options considered

- **Chosen:** Cedar
- OpenFGA (relationship-based)
- hand-written rules

## Consequences

Spike S3 confirms Node 24 ESM import and < 1 ms decisions; OpenFGA remains the fallback.
