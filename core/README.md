# core/

The trusted core. Small, heavily reviewed, and the only place that makes access decisions.
Changes here need **core review** (two maintainers) and an RFC if a contract changes.

The sandbox today admits plugins: a manifest that validates, and an admin's approval that can
only narrow its declared capabilities (`admitPlugin()`, `hasCapability()`). Running plugins is
not implemented yet. Per [ADR-0012](../docs/adr/0012-plugin-sandbox.md) it will be WASM
(Extism/Wasmtime) or isolated OS processes with CPU, memory, time and network limits, and no
containers. Package signing is also still to come.

| Module                     | Responsibility                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| [`identity/`](identity/)   | Users, groups (SCIM), sessions, OAuth 2.1 for MCP, AI-client allowlist + trust labels          |
| [`policy/`](policy/)       | Grants, visibility and exposure levels, policy evaluation (Cedar/OpenFGA), confirmation tokens |
| [`catalog/`](catalog/)     | Objects, versions, blobs, tags, zones; permission-aware hybrid search; file cards              |
| [`summarize/`](summarize/) | File-card schema, summaries, model routing by exposure level                                   |
| [`jobs/`](jobs/)           | Background jobs on pg-boss: the enrichment pipeline per version, scheduled maintenance         |
| [`audit/`](audit/)         | Append-only hash-chained log, WORM anchors, export, undo                                       |
| [`db/`](db/)               | Drizzle schema, migrations, forced tenant row-level security, PGlite and Postgres drivers      |
| [`storage/`](storage/)     | Content-addressed, tenant-scoped blobs on disk, S3 or Azure Blob (OpenDAL)                     |
| [`sandbox/`](sandbox/)     | Plugin manifests and capability approval; WASM/process isolation and signing to come           |
