# ADR-0012: Plugin sandbox: WASM and isolated processes, no containers

- Status: proposed
- Date: 2026-09-23
- Deciders: @RevBooyah
- Related: T-005

## Context

From the OpenHoard Dev Plan (stack decisions). Fits the no-Docker rule; any language compiles to WASM.

## Decision

Code plugins run as WASM (Extism/Wasmtime) or as isolated OS processes with declared capabilities, CPU/memory/time limits and a network allowlist.

## Options considered

- **Chosen:** WASM and isolated processes, no containers
- Containers (ruled out)
- in-process JS plugins (no isolation)

## Consequences

Manifest runtime values: wasm, process, declarative, agent.
