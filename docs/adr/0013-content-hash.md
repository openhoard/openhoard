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

Storage keys use a tenant-scoped id (`b3t:`, a keyed BLAKE3 of the content hash with a per-tenant secret) so de-duplication never reveals across tenants that two tenants hold the same file. Raw `b3:` hashes stay inside one tenant. The pure-JS implementation is benchmarked in spike S1 and replaced by a native binding if it can't keep up with large uploads.
