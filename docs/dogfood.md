# Dogfooding OpenHoard on your own folders (Windows 11)

This is the shortest path, as of M1, to indexing folders on your own PC and using them from Claude
over MCP: one person, one machine, no identity provider, no Docker. It is a trial setup: the
server listens on `127.0.0.1` only, and you sign in with one-time links instead of Entra. Sign-in
links work only when the server is reached directly on `127.0.0.1`: never through a tunnel or a
proxy, which the server refuses for them.

What you get: each folder is synced within seconds of a file being saved into it (and every 15
minutes anyway, to catch what watching missed); its files' text is extracted, summarized by Claude
Haiku and made searchable; Claude finds, describes and opens them through OpenHoard's MCP
tools, as you, and every AI read is audited.

## What you need

- Node 24 and the repository cloned and built (from the clone, in PowerShell):

  ```powershell
  corepack pnpm install --frozen-lockfile
  corepack pnpm turbo run build
  ```

- **The database: the embedded one (PGlite), the default.** It needs nothing installed, and it
  includes pgvector, which OpenHoard requires. Native PostgreSQL 17+ works too, but it needs
  pgvector 0.8+, which has no Windows installer: not worth it for a trial. With PGlite only one
  process may open the data directory at a time, so **stop the server before every `admin`
  command** below, and start it again after.
- An Anthropic API key, for summaries.
- A folder kept on this device. Avoid OneDrive "files on demand" folders (Documents often is
  one): reading a cloud-only file downloads it. Use a folder outside OneDrive, or mark it
  "Always keep on this device".

In the steps below, `oh` runs the server (or an admin command) with its data in
`%USERPROFILE%\OpenHoard`. Define it in each PowerShell window (adjust the clone's path):

```powershell
function oh { node C:\Users\Steve\git\openhoard\apps\server\dist\main.js --data-dir "$env:USERPROFILE\OpenHoard" @args }
```

Keep the data directory outside every folder you index (the config refuses it inside one). It
holds the database, the connectors' state and the tenant's blob key (`keys\`): back it up as a
whole.

## Steps

1. **Make your tenant and yourself** (you are its admin):

   ```powershell
   $t = oh admin tenant create --name "Steve"
   oh admin user create --tenant $t --email steve@example.com --name "Steve Cook"
   oh admin user grant-admin --tenant $t --user steve@example.com
   ```

2. **Apply the starter pack, before the first sync.** A new tenant is fail-closed (hidden,
   metadata-only): AI clients would see file names and nothing else, and no summary would run.
   From the clone's folder (the path is relative to it), the starter pack makes untagged files `discoverable` and `commercial-only` (content may reach
   commercial AI such as Claude and Haiku, never consumer apps), plus its tags and rules.

   ```powershell
   oh admin pack plan --tenant $t --file packs\general-business\pack.json
   # review the changes ("!" marks a loosening), then, with the hash it printed:
   oh admin pack apply --tenant $t --file packs\general-business\pack.json --plan-hash <hash>
   ```

   Files already processed before this keep no summary until they change (see "Not there yet").

3. **Write `%USERPROFILE%\OpenHoard\config.json`** (the tenant id from step 1; backslashes doubled
   in JSON):

   ```json
   {
     "auth": {
       "publicUrl": "http://127.0.0.1:7420",
       "signInLinks": true,
       "clients": [
         {
           "tenantId": "ten_…",
           "redirectUris": ["http://127.0.0.1/oauth/callback"],
           "trust": "commercial",
           "note": "Claude Desktop through mcp-remote"
         }
       ]
     },
     "sources": [
       {
         "id": "fs-notes",
         "connector": "fs",
         "tenantId": "ten_…",
         "root": "C:\\Users\\Steve\\Notes",
         "zone": "Steve's notes",
         "owner": "steve@example.com",
         "extract": true
       }
     ],
     "models": {
       "providers": [{ "id": "claude", "kind": "commercial", "adapter": "anthropic" }],
       "dailyTokenBudget": 2000000
     }
   }
   ```

   - `sources`: one entry per folder. The server watches each folder and syncs it a few seconds
     after something in it changes (`"watch": false` turns that off). `schedule` (cron, UTC) still
     syncs it every 15 minutes by default, as a safety net: changes on a mapped network drive,
     or made while the server was stopped, aren't always seen by watching. The fs connector
     compares the whole folder each time, so deletions are seen too. `extract: true`
     lets the server read the files' text (without it, names and metadata only). The owner owns,
     and so reads, everything synced; nobody else does.
   - `models`: the `anthropic` adapter defaults to Claude Haiku (`claude-haiku-4-5`).
     `dailyTokenBudget` caps what summaries may spend per day (tokens, all files together).
   - `auth.clients` approves Claude Desktop's bridge (step 6) in advance, as `commercial`: what
     Claude reads goes to Anthropic. **This trusts every program on this PC**: the entry names a
     client by where its answer goes, `http://127.0.0.1/oauth/callback` on any port (loopback
     ports aren't fixed, RFC 8252), and `mcp-remote`'s callback path can't be changed, so any
     local program can register the same way and, once you click Allow on its consent page, read
     your files as you. The consent page always says when a program on this computer is asking:
     allow only when you just started Claude Desktop. Without this entry, each new client waits
     for your approval instead (step 6).
   - Turning `extract` off later isn't retroactive: text and summaries already stored stay, and
     Claude still searches and opens them; only new versions go unread.

   The API key goes in the environment only, never in the file:

   ```powershell
   [Environment]::SetEnvironmentVariable("OPENHOARD_MODEL_CLAUDE_API_KEY", "<your key>", "User")
   # then open a new PowerShell window (and define `oh` again)
   ```

4. **Get a sign-in link** (the server still stopped). Whoever can run admin commands can sign in as
   anyone this way, bypassing any identity provider and its MFA: keep the data directory yours.

   ```powershell
   oh admin user sign-in-link --tenant $t --user steve@example.com --minutes 60
   ```

   It prints a link, once, good for one sign-in within the hour.

5. **Start the server** and sign in:

   ```powershell
   oh
   ```

   It logs `source ready`, `listening`, then `sync ended` for each folder as it runs them all once
   at start; enrichment follows file by file. Open the link from step 4 in your browser and press
   **Sign in**. Check <http://127.0.0.1:7420/auth/me> (you, `admin: true`) and
   <http://127.0.0.1:7420/api/admin/sources> (each folder's last run). The session lasts 12 hours
   unused, 7 days at most; after that, stop the server and get another link.

6. **Connect Claude Desktop.** Its own "custom connector" screen connects from Anthropic's cloud,
   which can't reach `127.0.0.1`; the `mcp-remote` bridge runs on your PC instead. In
   `%APPDATA%\Claude\claude_desktop_config.json`:

   ```json
   {
     "mcpServers": {
       "openhoard": {
         "command": "npx",
         "args": [
           "-y",
           "mcp-remote",
           "http://127.0.0.1:7420/mcp",
           "33418",
           "--host",
           "127.0.0.1",
           "--allow-http"
         ]
       }
     }
   }
   ```

   Restart Claude Desktop. A browser tab opens OpenHoard's consent page ("Allow mcp-remote…";
   it warns that a program on this computer is asking, which is expected): **Allow**. If it says
   the client "isn't approved yet" instead, its redirect URI isn't the one in `auth.clients`:
   open <http://127.0.0.1:7420/api/admin/clients> in the signed-in browser, copy its
   `redirectUris` into the config and restart, or approve it from that tab's developer console:

   ```js
   fetch("/api/admin/clients/<clientKey>/approve", {
     method: "POST",
     headers: { "content-type": "application/json" },
     body: JSON.stringify({ trust: "commercial" }),
   }).then((r) => r.json());
   ```

   (Approving needs a sign-in within the last 15 minutes.)

7. **Use it.** Ask Claude things like "find my notes about the gym schedule" or "open the
   sparring plan". The tools are `find`, `describe`, `open`, `recent` (files you yourself
   viewed or opened), `explain` (who can see a file) and `tag` (proposals only). Grants last 30
   days; Claude refreshes its token without asking you again until then.

## Search without an embeddings model

Anthropic has no embeddings API, so with the config above search is keyword only (`searchedBy:
["keywords"]`): full-text over titles, trusted tags, extracted text and summaries, with the
permission filter inside the query. That finds most things by their words. For meaning-based
search, add a local Ollama later (`{ "id": "ollama", "kind": "local", "adapter": "ollama",
"chatModel": "llama3.2", "embedModel": "nomic-embed-text" }`): new and changed files get
vectors, and queries are embedded locally only. The `stub` adapter is for tests: its hashed-word
vectors add noise, not meaning.

## Day to day

Admin commands need the server stopped (PGlite):

```powershell
oh admin source status --tenant $t                    # each folder: state, last run, counts
oh admin source run-now --tenant $t --source fs-notes # queued; runs when the server starts
oh admin source resume --tenant $t --source fs-notes  # after fixing what stopped it
```

- **A folder stops syncing** when a run fails for good (the folder vanished or became another
  disk, it can't be read, a run would delete more than a quarter of it): `source status` says
  `STOPPED` and why, and the audit log has `source.sync-stopped`. Fix the cause, then `source
resume`; for a held deletion use `source confirm-reconcile` or `discard-reconcile`, for another
  disk at the path `source accept-identity`.
- **Adding a folder**: a new entry in `sources`, then restart. Moving a source to another zone is
  refused: give it a new `id` instead.
- **Stopping**: Ctrl+C. Running jobs get a few seconds, and resume on the next start.

## Not there yet

- **Files processed before the pack was applied** (or before `extract` was on) keep no summary
  until they change: there is no command yet to re-enqueue files whose model steps were
  withheld (`resummarize` only covers skipped summaries). Re-save such a file, or start with a
  fresh data directory.
- **One server per data directory.** Tenant blob keys live in the data directory; several servers
  sharing a PostgreSQL database would need to share them (a KMS-backed store is for later).
- **claude.ai (web) and the Claude Desktop connector screen** need a public https address (a
  tunnel such as `cloudflared tunnel --url http://127.0.0.1:7420`, then that URL as
  `auth.publicUrl`). **Sign-in links don't work through a tunnel** (the config and the server
  refuse them), so this needs a real identity provider: Entra with SCIM (apps/server README,
  "Testing with a new Entra tenant"), or a generic OIDC provider matched to a SCIM user. There is
  no other way to sign in through a tunnel yet (built-in accounts are T-108). A quick tunnel's URL
  also changes on every run, which ends every grant.
- **No web UI** for sign-in links, sources or approvals yet: the admin CLI and the admin API
  (T-901..T-905).
- **Opening files in their Windows app** (`open` with mode native) waits for the local agent
  (FR-20, M2); for a local file `open` returns its text (it has no web link).
