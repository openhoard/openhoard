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

## Spike S3 result (T-022)

[Spike S3](../spikes/s3-cedar.md) confirmed Cedar in Node 24, with two conditions:

- **Grants are data.** Evaluating 1,000 tag-grant policies per request costs 3.4 ms at p95, because Cedar checks every policy. So "group G may read tag T" lives in a grant table and is checked by principal-set intersection (the same sets the search filter uses). Cedar evaluates only the rules: owner, `forbid`s and conditional permits. That takes 0.26 ms at p95, with decisions identical to a reference evaluator.
- **Import `@cedar-policy/cedar-wasm/nodejs`.** The root ESM export works but prints an experimental-WASM warning in Node 24.

The adapter preparses once per policy change, calls `statefulIsAuthorized`, and treats any `failure` as deny. OpenFGA stays the fallback if rule sets ever grow into the thousands.
