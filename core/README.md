# core/

The trusted core. Small, heavily reviewed, and the only place that makes access decisions.
Changes here need **core review** (two maintainers) and an RFC if a contract changes.

| Module                     | Responsibility                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| [`identity/`](identity/)   | Users, groups (SCIM), sessions, OAuth 2.1 for MCP, AI-client allowlist + trust labels          |
| [`policy/`](policy/)       | Grants, visibility and exposure levels, policy evaluation (Cedar/OpenFGA), confirmation tokens |
| [`catalog/`](catalog/)     | Objects, versions, blobs, tags, zones; permission-aware hybrid search; file cards              |
| [`summarize/`](summarize/) | Enrichment orchestration, file-card schema, model routing by exposure level                    |
| [`audit/`](audit/)         | Append-only hash-chained log, WORM anchors, export, undo                                       |
| [`db/`](db/)               | Drizzle schema, migrations, forced tenant row-level security, PGlite and Postgres drivers      |
| [`storage/`](storage/)     | Content-addressed, tenant-scoped blobs on disk, S3 or Azure Blob (OpenDAL)                     |
| [`sandbox/`](sandbox/)     | Plugin manifests, capability enforcement, WASM/container isolation, signing                    |
