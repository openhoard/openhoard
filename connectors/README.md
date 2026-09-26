# connectors/

Connectors let OpenHoard reach bytes and permissions wherever they live.

**Interface (v1):** `describe`, `crawl`, `delta`, `read`, `aclImport`, `redirect`, defined and
documented in [@openhoard/sdk](../packages/sdk/README.md). Writing back to a source (`write`,
`source:write`) comes in a later version.
**Runs in:** sandbox with a per-source network allowlist. Inside the server, core/jobs' sync
runner drives it (see [core/jobs](../core/jobs/README.md#connector-sync)).
**Tested by:** the contract kit (`@openhoard/sdk/testing`), which every connector runs against a
source it can change.

| Connector   | Serves                                 | Status                        |
| ----------- | -------------------------------------- | ----------------------------- |
| [`fs`](fs/) | a local folder, indexed in place       | passes the contract kit       |
| SharePoint  | sites and OneDrive, through Graph (S4) | planned (T-302 and following) |

Planned first-party connectors: S3, Azure Blob, SharePoint/OneDrive (Microsoft Graph),
GitHub. Community wishlist: Google Drive, Dropbox, Box, SMB/NFS shares, GitLab.

See [`example/openhoard.plugin.json`](example/openhoard.plugin.json) for a manifest.
