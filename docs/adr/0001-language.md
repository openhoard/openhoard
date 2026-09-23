# ADR-0001: Language: TypeScript on Node 24 LTS

- Status: proposed
- Date: 2026-09-23
- Deciders: @RevBooyah
- Related: T-001

## Context

From the OpenHoard Dev Plan (stack decisions). Largest contributor pool; mature MCP TypeScript SDK; same choice as OpenClaw.

## Decision

TypeScript (strict) on Node 24 LTS for the core, server, CLI and plugins SDK.

## Options considered

- **Chosen:** TypeScript on Node 24 LTS
- Go (single binary, performance)
- Python (like Hermes; weaker typing across the core)

## Consequences

Rust only where native OS APIs require it (desktop drive and launch).
