# connectors/

Connectors let OpenHoard reach bytes and permissions wherever they live.

**Interface (v1):** `crawl`, `delta`, `read`, `write`, `acl_import`, `redirect`.
**Runs in:** sandbox with a per-source network allowlist.

Planned first-party connectors: S3, Azure Blob, SharePoint/OneDrive (Microsoft Graph),
GitHub. Community wishlist: Google Drive, Dropbox, Box, SMB/NFS shares, GitLab.

See [`example/openhoard.plugin.json`](example/openhoard.plugin.json) for a manifest.
