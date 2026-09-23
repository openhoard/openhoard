# ADR-0002: Monorepo: pnpm workspaces + Turborepo

- Status: proposed
- Date: 2026-09-23
- Deciders: @RevBooyah
- Related: T-001

## Context

From the OpenHoard Dev Plan (stack decisions). Industry standard; OpenClaw uses pnpm workspaces; strict dependency isolation.

## Decision

pnpm workspaces with Turborepo for task orchestration and caching.

## Options considered

- **Chosen:** pnpm workspaces + Turborepo
- Nx
- npm/yarn workspaces

## Consequences

Contributors need pnpm (via corepack or the installer).
