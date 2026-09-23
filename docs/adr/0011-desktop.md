# ADR-0011: Desktop: Tauri 2 + Rust native pieces

- Status: proposed
- Date: 2026-09-23
- Deciders: @RevBooyah
- Related: M2

## Context

From the OpenHoard Dev Plan (stack decisions). Small footprint; native OS APIs require native code anyway.

## Decision

Tauri 2 shell; Rust crates for Windows Cloud Files and macOS File Provider, and native launch.

## Options considered

- **Chosen:** Tauri 2 + Rust native pieces
- Electron

## Consequences

Rust kept to the smallest surface; UI stays TypeScript.
