# Architecture decision records

One file per decision, [MADR](https://adr.github.io/madr/)-style. Copy `0000-template.md`. ADRs move from **proposed** to **accepted** once the related spike passes (T-029).

| ADR                                 | Title                                                      | Status   |
| ----------------------------------- | ---------------------------------------------------------- | -------- |
| [0001](0001-language.md)            | Language: TypeScript on Node 24 LTS                        | proposed |
| [0002](0002-monorepo.md)            | Monorepo: pnpm workspaces + Turborepo                      | proposed |
| [0003](0003-testing.md)             | Testing: Vitest + Playwright                               | proposed |
| [0004](0004-database.md)            | Database: Postgres + pgvector, PGlite for dev and tests    | proposed |
| [0005](0005-search-v1.md)           | Search v1: Postgres full-text + pgvector with RRF          | proposed |
| [0006](0006-storage-abstraction.md) | Storage abstraction: Apache OpenDAL                        | proposed |
| [0007](0007-policy-engine.md)       | Policy engine: Cedar                                       | proposed |
| [0008](0008-job-queue.md)           | Job queue: Postgres-backed (pg-boss)                       | proposed |
| [0009](0009-http-and-mcp.md)        | HTTP and MCP: Hono + official MCP TypeScript SDK           | proposed |
| [0010](0010-web-app.md)             | Web app: React + Vite PWA                                  | proposed |
| [0011](0011-desktop.md)             | Desktop: Tauri 2 + Rust native pieces                      | proposed |
| [0012](0012-plugin-sandbox.md)      | Plugin sandbox: WASM and isolated processes, no containers | proposed |
| [0013](0013-content-hash.md)        | Content hash: BLAKE3                                       | proposed |
| [0014](0014-license.md)             | License: Apache-2.0                                        | proposed |
