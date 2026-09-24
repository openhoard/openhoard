# Spike S5: MCP OAuth 2.1 and write confirmation with real clients

- Task: T-024
- Time box: 2 days
- Result: **not run yet**. It is blocked on the MCP server (M1) and on accounts for three clients.
- Confirms / changes: [ADR-0009](../adr/0009-http-and-mcp.md) and the threat model's write-confirmation rule

## Question

Can Claude, ChatGPT and Microsoft Copilot all connect to an OpenHoard MCP server with OAuth 2.1, use the read tools, and be stopped from writing without a confirmation token issued by an OpenHoard client?

## Pass criteria

- Reads (`find`, `describe`, `open`) work in all three clients.
- Every write (`tag`, `share`) without a valid confirmation token is refused and audited.

## What is ready

- **Authorization server:** the dev OIDC provider (T-016, `startDevOidc`). It does authorization code with PKCE, refresh tokens, and seeded users with groups.
- **Data:** the fake tenant and the permission-leak harness (T-014, T-018) for the read side.
- **Attack files:** the injection corpus (T-017) for the write-refusal side (S8).

## What is needed first

1. **An MCP server with the Streamable HTTP transport** (the MCP TypeScript SDK) that exposes read tools and one write tool. It must publish OAuth protected-resource metadata (RFC 9728) pointing at the authorization server, and validate access tokens (audience, scopes).
2. **A public HTTPS URL.** Hosted clients cannot reach 127.0.0.1, so use a tunnel for the spike.
3. **Accounts:** Claude (custom connector), ChatGPT (connectors / developer mode) and Microsoft Copilot Studio (MCP). Plans differ in what they allow.

## Method (planned)

For each client:

1. Add the server, complete the OAuth flow, and record which OAuth features it needed: dynamic client registration, resource indicators, PKCE.
2. Run five scripted read prompts and check that the answers are drawn only from files the signed-in user may read (canary tokens).
3. Ask for a share. The server must refuse without a confirmation token and write a `deny` audit event.
4. Record the transcripts in `docs/spikes/s5/`.

## Decision

Pending. Unblocked by the MCP server epic.
