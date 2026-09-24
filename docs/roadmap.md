# Roadmap

Durations assume a small team building with AI coding tools. Dates will be set as work starts.

| Milestone                   | Scope                                                                                                                                                                                                                                                                              | Exit criteria                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **M0 Validate**             | 10–15 interviews; 5 design partners                                                                                                                                                                                                                                                | At least 5 partners committed                      |
| **M1 Read-only pilot**      | SSO + SCIM; SharePoint connector (index in place, import ACLs); enrichment pipeline; tag vocabulary + review; permission-aware search; MCP server (`find`, `recent`, `describe`, `open`, `tag`); policy engine + exposure levels; audit log; visibility levels; File Health Report | Partners find files through their agent every week |
| **M2 Governance**           | Governed share/revoke; access reviews; web app + phone PWA; tray + quick search; localhost MCP                                                                                                                                                                                     | IT approves for production                         |
| **M2+ Apps**                | Single-page app hosting ([RFC-0001](rfc/0001-app-hosting.md)): publish from any agent (`publish_app`) or the CLI, versioned with instant rollback, private and group access on each app's own origin; then per-app data. Public apps and custom domains follow with M3             | A team runs an internal tool from OpenHoard        |
| **M3 Bucket + Code**        | S3 / Azure Blob; index/copy/move ingest; guest large-file exchange; GitHub linking; local models; Company Files drive; MDM packages + silent SSO                                                                                                                                   | First paid pilot                                   |
| **M4 Desktop + Compliance** | Virtual drive everywhere; HIPAA / SOC 2 / legal hold packs; Drive, Dropbox, SMB/NFS connectors; Office add-in, Teams bot                                                                                                                                                           | First regulated customer                           |

## Big bets (post-M2)

Files as data (extracted fields) · plain-English policy · living project memory ·
canonical-version detection · semantic diffs · offboarding handoff packs ·
least-privilege sharing assistant · company time machine.
