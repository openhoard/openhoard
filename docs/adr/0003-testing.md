# ADR-0003: Testing: Vitest + Playwright

- Status: proposed
- Date: 2026-09-23
- Deciders: @RevBooyah
- Related: T-003

## Context

From the OpenHoard Dev Plan (stack decisions). Fast, TypeScript-native; OpenClaw uses Vitest.

## Decision

Vitest for unit/integration/contract tests with v8 coverage floors; Playwright for web e2e.

## Options considered

- **Chosen:** Vitest + Playwright
- Jest
- node:test

## Consequences

Coverage floors enforced per package (core 85%, plugins 70%).
