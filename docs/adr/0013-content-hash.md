# ADR-0013: Content hash: BLAKE3

- Status: proposed
- Date: 2026-09-23
- Deciders: @RevBooyah
- Related: T-203

## Context

From the OpenHoard Dev Plan (stack decisions). Fast; used by Spacedrive; streaming support.

## Decision

BLAKE3 for blob identity (prefixed b3:), SHA-256 kept for interop and the audit chain.

## Options considered

- **Chosen:** BLAKE3
- SHA-256 only

## Consequences

Ids are prefixed so the algorithm can change later.
