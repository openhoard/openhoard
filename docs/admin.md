# Running OpenHoard for a team: the admin guide

This page is for the admin of a team's server, after [the pilot runbook](pilot.md) has set it
up: day to day, what changes when people come and go, and what to watch. Each section links to
the reference that has the detail.

Below, `oh` is `node <clone>/apps/cli/dist/bin.js --data-dir <data dir>`, as in pilot.md. Most
admin commands take `--tenant <ten_…>`: the id `init --team` printed, or `oh admin tenant list`.

## Where things are

| What                                                   | Where                                                                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| The admin app                                          | `<publicUrl>/admin/`: Overview (the sources), Tags to review, AI clients, Vocabulary, File health, Storage, Audit log |
| Admin commands                                         | `oh admin …` (`oh admin --help`)                                                                                      |
| The configuration                                      | `<data dir>/config.json`; a change takes effect when the server starts again                                          |
| Secrets (sign-in app secret, model keys, database URL) | Environment variables, or `<data dir>/service.env` when it runs as a service                                          |
| Everything else the server keeps                       | The data directory: the embedded database (`pgdata`), keys (`keys/`), connectors' state, kept files (`blobs/`)        |

**On the embedded database, admin commands run with the server stopped**: `service stop`, the
command, `service start` (with sudo, or in an elevated PowerShell). That includes the emergency
lock below. The admin app works while it runs. With PostgreSQL both run together.

**A recent sign-in.** Approving or relabelling an AI client, changing who is an admin,
downloading the audit log or the health sheet, clearing a flagged file and changing storage
each ask for a sign-in within the last 15 minutes (`auth.adminSignInMinutes`).

## People

People come from Entra, never from OpenHoard.

- **Someone joins:** assign them (or a group they are in) to the sign-in app in Entra.
  Provisioning makes their account within its cycle (about 40 minutes), or at once with
  **Provision on demand**.
  - What reaches them through a group OpenHoard already has (an Entra or Microsoft 365 group
    assigned to the sign-in app) counts as soon as they are provisioned.
  - What is shared with them by name, or through a SharePoint group, counts when each file is
    next recorded: changed files at the next sync, every file at the next full crawl
    (`recrawlAfterDays`, 7 by default).
- **Someone leaves:** `oh admin user lock --tenant <ten_…> --user <email>`. Their sessions and AI
  connections end at once, on every server. On the embedded database, stop the server for it
  (the app has no lock button). Then remove them in Entra. Removing them in Entra alone cuts
  them off too, but only when provisioning next runs. Entra enabling the account again doesn't
  lift a lock: `user unlock` does.
- **Someone moves teams:** change their groups in Entra.
  - Microsoft 365 and Entra groups follow through provisioning, for groups assigned to the
    sign-in app.
  - A SharePoint group (a site's Members, say) follows from the site's next sync, every 15
    minutes by default, as a change of membership makes the site crawl again. On a large site
    that crawl takes several runs. This needs the reader app's certificate: with a client
    secret, SharePoint groups give nobody anything.
- **More admins:** `oh admin user grant-admin --tenant <ten_…> --user <email>` (the app has no
  page for it yet).
  - `oh admin user list-admins` shows who counts now.
  - Taking the role from the last admin is refused. Locking or deprovisioning them isn't, and
    `grant-admin` makes a new one then.
- **An admin group**, to let Entra decide who is an admin: `auth.adminGroups` in config.json,
  `[{ "tenantId": "ten_…", "groupId": "grp_…" }]`.
  - It is named by OpenHoard's id for the group, which `oh admin group list` prints, never by
    its Entra id.
  - It must be a group provisioned over SCIM, so assign it to the sign-in app.
  - The server reads it when it starts.
  - Its members leave it in Entra, not in the app.

What each step ends, and when: [core/identity](../core/identity/README.md).

## AI clients

Each client (Claude on the web, Claude Code, …) is approved once per tenant, as one of three
kinds: **Organization AI** (`commercial`), **Personal AI** (`consumer`) or **Stays on our
computers** (`local`). [clients.md](clients.md) has the steps for each client and what the
kinds mean.

- **AI clients** in the app lists every client that tried, approved or not, with how many people
  use it and when it was last used.
- **Revoke** ends a client's tokens on their next request, for everyone, and it stays refused
  until an admin approves it again. It never asks you to sign in again first, so it is the
  emergency stop. **Refuse** turns away one still waiting.
- A client the config lists (`auth.clients`) can only be changed in the config.

Reference: apps/server, ["MCP clients: OAuth 2.1"](../apps/server/README.md#mcp-clients-oauth-21-t-105)
and ["Tenant admins and the admin API"](../apps/server/README.md#tenant-admins-and-the-admin-api-t-106).

## What AI may see

SharePoint decides **who** may open a file. OpenHoard adds two levels per file, set by tags:

- **visibility:** whether people who can't open a file see that it exists (hidden,
  discoverable, readable). People who can open a file always see it.
- **exposure:** how much of its content reaches which kind of AI client (metadata only, local
  clients only, organization AI, any).

A new tenant shows people only the files they may open, and AI clients names and metadata
only. A **pack** changes that. The starter pack, `packs/general-business`:

- makes files discoverable, and lets their content reach Organization AI;
- adds `sensitivity` values for files that must stay out: `confidential` is hidden and goes to
  local clients only, and `restricted` is hidden and metadata only;
- tags files under `HR` and `Confidential` folders as confidential;
- never lets guests reach HR or legal files, and never lets Personal AI read confidential or
  restricted ones.

To change what applies:

- `oh admin pack plan --tenant <ten_…> --file <pack.json>` lists every change; `!` marks a
  loosening. `pack apply … --plan-hash <hash>` applies exactly that plan.
- To keep a folder's files from AI, tag them with a stricter value. A pack rule by folder tags
  them for you; [packs/README.md](../packs/README.md) shows how to write one.
- **Flagged files.** A file the detector flags as possibly carrying instructions for an AI
  (`risk:injection`) has no name, no link and no content to AI clients. If it is harmless,
  press **Not an injection** on File health's flagged finding, or run
  `oh admin injection dismiss --tenant <ten_…> --user <an admin> --id <obj_…>`.

Exposure and the kinds of client: [core/policy](../core/policy/README.md#exposure-t-604).

## The SharePoint site

**Overview** in the app, or `oh admin source status --tenant <ten_…>`, shows each sync, marked
OK, Working or Needs attention, with when it last ran, how it went and what it left out.
Changes reach OpenHoard every 15 minutes by default. With `"notifications": true` on the source
they arrive sooner, if Graph can reach `publicUrl`.

| The app says                                  | What it means, and what to do                                                                                                                                                                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files "are no longer at the source" (held)    | A full crawl would remove a large part of the site (over 25%, and over 50 files). Until you decide, the source takes no changes at all. Check the site, then `source confirm-reconcile` (remove them) or `discard-reconcile` (keep them, crawl again) |
| "Reading this source stopped after a failure" | A run failed for good; the code says why (a permission taken away, a certificate expired). Fix it, then `source resume`                                                                                                                               |
| "Waiting for its owner"                       | The site's `owner` account isn't provisioned yet: assign it to the sign-in app in Entra                                                                                                                                                               |
| What was left out                             | Files not indexed, and why: `source skips`                                                                                                                                                                                                            |

`source run-now` asks for a run straight away. Every `source` command takes
`--tenant <ten_…> --source <name>` (`sp-<site>`, which `source list` shows). Reference:
[connectors/sharepoint](../connectors/sharepoint/README.md) and apps/server,
["Admin commands"](../apps/server/README.md#admin-commands-t-103-t-106-t-104).

## Tags to review

AI clients (Claude's `tag`) only propose tags. A model applies a tag itself only when it is
confident and the tag changes nobody's access; anything else waits. A person decides, in **Tags
to review** in the app, or with `oh admin review list | approve | reject | merge --tenant <ten_…>
--user <who decides>`. People decide for files they may tag. A new vocabulary value, or taking a
restriction off, takes an admin.

## The audit log

Every AI read, tool call, sign-in decision and admin change is in a hash-chained log.

- **Audit log** in the app finds events by Who (`user:usr_…`), what the action starts with, the
  outcome, the file and the time. **Download CSV** and **Download NDJSON** take what was found.
  The command line filters by client too (`oh admin audit export --client …`).
- **Check the log** in the app (or `oh admin audit verify --tenant <ten_…>`) says whether any
  event was changed, removed or inserted. Now and then, run the command and copy the head hash
  it prints somewhere the database's owner can't write. A log cut short at its end still checks
  out, and only a head kept elsewhere shows it.
- `oh admin audit export` writes the log for an auditor or another system.

## The File Health Report

**File health** in the app, or `oh admin health report --tenant <ten_…> --user <an admin>`,
lists what to look at among the site's files: restricted files shared widely, links anyone can
open, sharing with outsiders or people who left, flagged files, stale and duplicate files. Each
finding says why it matters and what to do, with the files and who can open each. It names
files by their real titles, so it is for admins only, and each read of it is audited.

## Keeping it running

- **As a service:** `service install` (apps/server, "Running it as a service") starts it at
  boot. It copies the `OPENHOARD_` variables set in that shell, so set the secrets on the same
  command line, as pilot.md shows.
- **Backups:** back up the whole data directory, with the server stopped for the embedded
  database. On PostgreSQL, back up the database and the data directory's `keys/` together:
  without its keys a tenant's files can't be checked, and kept storage keys can't be read.
- **Upgrades:** stop the server, `git pull`, `pnpm install --frozen-lockfile`, `pnpm build`, and
  start it. It applies any new database migration as it starts.
- **Dates to put in a calendar.** None of these renews itself:
  - the SCIM token (365 days): `oh admin scim-token issue --tenant <ten_…> --name "Entra provisioning"`,
    paste it into Entra's provisioning, then `scim-token revoke --tenant <ten_…> --id <sct_…>`
    the old one (`scim-token list` shows ids);
  - the sign-in app's client secret (as Entra set it, at most 24 months): make a new one, put it
    in `service.env`, stop and start;
  - the reader app's certificate (as you made it): upload a new one in Entra, replace the files
    `config.json` names, stop and start.
- **Logs:** run as a service, `journalctl -u openhoard` on Linux, `<data dir>/logs/server.log` on
  macOS and Windows; run by hand, the terminal. JSON, one event a line, secrets redacted. Audit
  events are in the audit log, not here.

## When something is wrong

| Symptom                                    | Look at                                                                                                                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nobody can sign in                         | The sign-in app's secret (expired?), `publicUrl`, and that the redirect URI in Entra is `<publicUrl>/auth/callback/entra`                                               |
| Someone's sign-in ends on "sign-in failed" | They aren't provisioned, or are locked: the audit log's `auth.sign-in` event says which                                                                                 |
| New people don't appear                    | Entra's provisioning logs; the SCIM token (expired or revoked?)                                                                                                         |
| Claude can't connect                       | [clients.md](clients.md), "When it doesn't connect"                                                                                                                     |
| Files are missing or out of date           | **Overview**: held, stopped or left out; when the last run was                                                                                                          |
| Someone sees a file they shouldn't         | File health (who can open each file it lists), then the file's sharing in SharePoint. Claude's `explain` answers only the file's owner: for a site, its `owner` account |
| The server won't start                     | The log's last lines. On the embedded database, another OpenHoard process may hold the data directory                                                                   |
