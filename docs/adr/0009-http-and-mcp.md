# ADR-0009: HTTP and MCP: Hono + official MCP TypeScript SDK

- Status: proposed
- Date: 2026-09-23
- Deciders: @RevBooyah
- Related: T-024

## Context

From the OpenHoard Dev Plan (stack decisions). Small, fast, standards-based; works on Node.

## Decision

Hono for HTTP; the official MCP TypeScript SDK over Streamable HTTP with OAuth 2.1 per-user auth.

## Options considered

- **Chosen:** Hono + official MCP TypeScript SDK
- Fastify
- Express

## Consequences

Spike S5 confirms client support for auth and write confirmation.
