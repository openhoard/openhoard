# Roadmap

Durations assume a small team building with AI coding tools. Dates will be set as work starts.

**Where we are (2026-10-23).** M0 (spikes S1–S3, ADRs, repo foundations) is done; S4–S8 are
partial or not run, waiting on a real tenant. M1 is in progress: core, search, policy, audit,
identity and the MCP server are built, and the SharePoint connector crawls, follows changes
(delta, and, with `notifications` on, Graph's change notifications when the server's publicUrl
is reachable from the internet over https), imports permissions as grants (the site's SharePoint
groups resolved to their members when the app signs in with a certificate) and paces itself to
Graph's limits, all through the server's own config, against a simulated tenant. PRD scenario 1
and the read side of scenario 4 run end to end from such a site. The review inbox, audit verify
and export, the File Health Report and the admin web app have their doors. What is left for M1
needs the real world: one real SharePoint site, live runs with real AI clients, and three people
using it. **M1 exits when one real SharePoint site is indexed in place (crawl, delta, permission
import), three named people find files through Claude weekly for two weeks without being
prompted, and PRD scenarios 1, 2, 4 and 7 pass end to end.** The solo install (`init --solo`, a local folder, Claude
Desktop) is a stepping stone (the dogfood path and the open-source on-ramp) and is frozen at
what is merged until then. Website, launch and M2+ work wait for M1 exit. The order of work is
in [CLAUDE.md](../CLAUDE.md).

| Milestone                   | Scope                                                                                                                                                                                                                                                                              | Exit criteria                                                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M0 Foundations**          | Repo and tooling; quality gates; spikes S1–S8; ADR-001..014. Customer validation (5 conversations) runs in parallel with M1, not before it                                                                                                                                         | Monorepo builds and tests on 3 OSes; ADRs accepted; spike reports merged                                                                                                        |
| **M1 Read-only pilot**      | SSO + SCIM; SharePoint connector (index in place, import ACLs); enrichment pipeline; tag vocabulary + review; permission-aware search; MCP server (`find`, `recent`, `describe`, `open`, `tag`); policy engine + exposure levels; audit log; visibility levels; File Health Report | One real SharePoint site indexed in place (crawl, delta, permission import); three named people find files through Claude weekly for 2 weeks; PRD scenarios 1, 2, 4, 7 pass e2e |
| **M2 Governance**           | Governed share/revoke; access reviews; web app + phone PWA; tray + quick search; localhost MCP                                                                                                                                                                                     | IT approves for production                                                                                                                                                      |
| **M2+ Apps**                | Single-page app hosting ([RFC-0001](rfc/0001-app-hosting.md)): publish from any agent (`publish_app`) or the CLI, versioned with instant rollback, private and group access on each app's own origin; then per-app data. Public apps and custom domains follow with M3             | A team runs an internal tool from OpenHoard                                                                                                                                     |
| **M3 Bucket + Code**        | S3 / Azure Blob; index/copy/move ingest; guest large-file exchange; GitHub linking; local models; Company Files drive; MDM packages + silent SSO                                                                                                                                   | First paid pilot                                                                                                                                                                |
| **M4 Desktop + Compliance** | Virtual drive everywhere; HIPAA / SOC 2 / legal hold packs; Drive, Dropbox, SMB/NFS connectors; Office add-in, Teams bot                                                                                                                                                           | First regulated customer                                                                                                                                                        |

## Big bets (post-M2)

Files as data (extracted fields) · plain-English policy · living project memory ·
canonical-version detection · semantic diffs · offboarding handoff packs ·
least-privilege sharing assistant · company time machine.
