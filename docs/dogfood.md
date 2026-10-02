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
  process may open the data directory at a time, so **stop the server before every `init`,
  `connect` or `admin` command**, and start it again after.
- An Anthropic API key, for summaries.
- A folder kept on this device. Avoid OneDrive "files on demand" folders (Documents often is
  one): reading a cloud-only file downloads it. Use a folder outside OneDrive, or mark it
  "Always keep on this device".

In the steps below, `oh` runs the server (or one of its commands) with its data in
`%LOCALAPPDATA%\OpenHoard`. Define it in each PowerShell window (adjust the clone's path):

```powershell
function oh { node C:\Users\Steve\git\openhoard\apps\server\dist\main.js --data-dir "$env:LOCALAPPDATA\OpenHoard" @args }
```

(Set up before `init --solo` existed, with the data in `%USERPROFILE%\OpenHoard`? Keep that path
in `oh`: nothing moved. Don't run `init --solo` without `--folder` then, since its default folder
is that same path.)

Keep the data directory outside every folder you index (the config refuses it inside one). It
holds the config, the database, the connectors' state and the tenant's blob key (`keys\`): back
it up as a whole.

## Quick setup

1. **Set up yourself, a tenant and your folder** (from the clone's folder):

   ```powershell
   oh init --solo --folder C:\Users\Steve\Notes --name "Steve Cook" --email steve@example.com
   ```

   `--folder` can be repeated; without it, `%USERPROFILE%\OpenHoard` is made and used. Without
   `--email` you get `owner@solo.openhoard.invalid`, which receives nothing. `--no-extract` indexes
   names and metadata only. Each folder is pinned to Quick Access, so it shows in every app's
   Save As dialog: save a file there and Claude can find it seconds later (`--no-pin` skips
   this; unpin it in Explorer like any folder). It creates the tenant and you (its admin), applies the starter pack,
   and writes `config.json`: see [what it does](#what-init---solo-does) below. It prints every
   change the starter pack made, each loosening marked `!`. Write paths out in full: a `~` in
   quotes isn't your home folder.

   Then put the API key in the environment only, never in the file:

   ```powershell
   [Environment]::SetEnvironmentVariable("OPENHOARD_MODEL_CLAUDE_API_KEY", "<your key>", "User")
   # then open a new PowerShell window (and define `oh` again)
   ```

   Without it the server still starts, with a warning: no summaries, and search by keywords only.

2. **Connect Claude Desktop:**

   ```powershell
   oh connect claude-desktop
   ```

   It adds OpenHoard to `%APPDATA%\Claude\claude_desktop_config.json` (keeping your other servers,
   and the file as it first was as `.bak`), approves Claude Desktop's bridge for your tenant in
   `config.json` (audited), and prints a one-time sign-in link, good for one sign-in within the
   hour. If a step fails, both files are put back as they were.

3. **Start the server**, then finish in the browser and in Claude Desktop:

   ```powershell
   oh
   ```

   It logs `source ready`, `listening`, then `sync ended` for each folder. Open the link from
   step 2 and press **Sign in**; restart Claude Desktop (quit it fully); a browser tab opens
   OpenHoard's consent page ("Allow mcp-remote…", with a warning that a program on this computer
   is asking, which is expected): **Allow**.

   **This trusts every program on this PC**: any local program can register the way Claude
   Desktop's bridge does and, once you press Allow on its consent page, read your files as you.
   Allow only when you just started Claude Desktop.

4. **Use it.** Ask Claude things like "find my notes about the gym schedule" or "open the
   sparring plan". The tools are `find`, `describe`, `open`, `recent` (files you yourself
   viewed or opened), `explain` (who can see a file) and `tag` (proposals only). Grants last 30
   days; Claude refreshes its token without asking you again until then.

Check <http://127.0.0.1:7420/auth/me> (you, `admin: true`) and
<http://127.0.0.1:7420/api/admin/sources> (each folder's last run) in the signed-in browser. The
session lasts 12 hours unused, 7 days at most; after that, stop the server and get another link
(`oh connect claude-desktop` again, or `oh admin user sign-in-link` below).

### What `init --solo` does

- It refuses if `config.json` exists in the data directory: add folders by hand (below), or use
  another `--data-dir` for a fresh start. It uses the embedded database only (it refuses
  `OPENHOARD_DATABASE_URL`), and the port and host the server will use (`OPENHOARD_PORT`,
  `OPENHOARD_HOST`; 7420 on 127.0.0.1 by default).
- In one database transaction: the tenant (named after you), you (a local person), your admin
  role, and the starter pack (`packs\general-business`). A new tenant is fail-closed (hidden,
  metadata-only): the pack makes untagged files `discoverable` and `commercial-only` (content may
  reach commercial AI such as Claude and Haiku, never consumer apps), plus its tags and rules.
  Running the command is your consent to it.
- Then `config.json`, the same file the manual setup below writes, with one source per folder
  (`fs-<folder name>`, its zone the folder's name, you its owner) and Claude with a daily budget of
  2,000,000 tokens. It is written last, never over a file made meanwhile, and loaded as the
  server loads it before the command succeeds.
- If it fails after the database work (it says so, with the tenant id), fix the cause and run the
  same command again: it picks up that tenant when it can tell it is the one it made (the only
  one, with your name, and nobody else in it). Otherwise it refuses, and you use the manual
  setup, or another data directory.
- Everything is audited as `system:admin-cli`, as the admin commands are.

## Manual setup

What the two commands do, step by step, for when you want to see or change each part (another
tenant name, several people, your own pack). Stop the server first.

1. **Make your tenant and yourself** (you are its admin):

   ```powershell
   $t = oh admin tenant create --name "Steve"
   oh admin user create --tenant $t --email steve@example.com --name "Steve Cook"
   oh admin user grant-admin --tenant $t --user steve@example.com
   ```

2. **Apply the starter pack, before the first sync**, from the clone's folder:

   ```powershell
   oh admin pack plan --tenant $t --file packs\general-business\pack.json
   # review the changes ("!" marks a loosening), then, with the hash it printed:
   oh admin pack apply --tenant $t --file packs\general-business\pack.json --plan-hash <hash>
   ```

   Files already processed before this keep no summary until they change (see "Not there yet").

3. **Write `config.json`** in the data directory (the tenant id from step 1; backslashes doubled
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
     `dailyTokenBudget` caps what summaries may spend per day (tokens, all files together). The
     key: `OPENHOARD_MODEL_CLAUDE_API_KEY`, in the environment (quick setup, step 1).
   - `auth.clients` approves Claude Desktop's bridge in advance, as `commercial`: what Claude
     reads goes to Anthropic. **This trusts every program on this PC**: the entry names a client
     by where its answer goes, `http://127.0.0.1/oauth/callback` on any port (loopback ports
     aren't fixed, RFC 8252), and `mcp-remote`'s callback path can't be changed, so any local
     program can register the same way and, once you click Allow on its consent page, read your
     files as you. The consent page always says when a program on this computer is asking: allow
     only when you just started Claude Desktop. Without this entry, each new client waits for
     your approval instead (step 5).
   - Turning `extract` off later isn't retroactive: text and summaries already stored stay, and
     Claude still searches and opens them; only new versions go unread.

4. **Get a sign-in link** (the server still stopped). Whoever can run admin commands can sign in as
   anyone this way, bypassing any identity provider and its MFA: keep the data directory yours.

   ```powershell
   oh admin user sign-in-link --tenant $t --user steve@example.com --minutes 60
   ```

   Start the server (`oh`), open the link and press **Sign in**.

5. **Connect Claude Desktop.** Its own "custom connector" screen connects from Anthropic's cloud,
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

   Restart Claude Desktop and press **Allow** on the consent page. If it says the client "isn't
   approved yet" instead, its redirect URI isn't the one in `auth.clients`: open
   <http://127.0.0.1:7420/api/admin/clients> in the signed-in browser, copy its `redirectUris`
   into the config and restart, or approve it from that tab's developer console:

   ```js
   fetch("/api/admin/clients/<clientKey>/approve", {
     method: "POST",
     headers: { "content-type": "application/json" },
     body: JSON.stringify({ trust: "commercial" }),
   }).then((r) => r.json());
   ```

   (Approving needs a sign-in within the last 15 minutes.)

## Search without an embeddings model

Anthropic has no embeddings API, so with the config above search is keyword only (`searchedBy:
["keywords"]`): full-text over titles, trusted tags, extracted text and summaries, with the
permission filter inside the query. That finds most things by their words. For meaning-based
search, add a local Ollama later (`{ "id": "ollama", "kind": "local", "adapter": "ollama",
"chatModel": "llama3.2", "embedModel": "nomic-embed-text" }`): new and changed files get
vectors, and queries are embedded locally only. The `stub` adapter is for tests: its hashed-word
vectors add noise, not meaning.

## Day to day

Admin commands need the server stopped (PGlite). `$t` is your tenant id (`init --solo` printed
it; `oh admin tenant list` shows it):

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
- **Adding a folder**: a new entry in `config.json`'s `sources` (copy the first one, with a new
  `id`, `root` and `zone`), then restart. Moving a source to another zone is refused: give it a
  new `id` instead.
- **Adding a file that isn't in a folder**: open `<the server's address>/app/` and pick or drop
  it; OpenHoard keeps it (in `<data>/blobs`: back that up too). Installed from there (https
  only, so through `oh tunnel` on a phone), OpenHoard is in the share menu of Android and
  Windows. A setup made before this needs `"uploads": {}` added to config.json (apps/server
  README, "Adding files").
- **Mailing something in**: with a mailbox configured (`mailIn`, apps/server README,
  "Email-in"), forward a message to it and its text and attachments are files within a few
  minutes.
- **Stopping**: Ctrl+C. Running jobs get a few seconds, and resume on the next start.

## Not there yet

- **Files processed before the pack was applied** (or before `extract` was on) keep no summary
  until they change: there is no command yet to re-enqueue files whose model steps were
  withheld (`resummarize` only covers skipped summaries). Re-save such a file, or start with a
  fresh data directory. (`init --solo` applies the pack before the first sync, so this is only
  for the manual setup.)
- **One server per data directory.** Tenant blob keys live in the data directory; several servers
  sharing a PostgreSQL database would need to share them (a KMS-backed store is for later).
- **claude.ai (web) and the Claude Desktop connector screen** need a public https address (a
  tunnel such as `cloudflared tunnel --url http://127.0.0.1:7420`, then that URL as
  `auth.publicUrl`). **Sign-in links don't work through a tunnel** (the config and the server
  refuse them). Through a tunnel, sign in with a **passkey** instead: `oh tunnel` runs
  cloudflared and the server together and prints an invite link that makes one (apps/server
  README, "Reaching it from outside"). A passkey belongs to the public host: a quick tunnel's
  address changes on every run, so it needs a new invite, passkey and client connection each
  time; a **named tunnel on your own domain** keeps them. Or use a real identity provider: Entra with SCIM
  (apps/server README, "Testing with a new Entra tenant").
- **No web UI** for sign-in links, sources or approvals yet: the commands above and the admin API
  (T-901..T-905).
- **An `openhoard` command**: for now the commands run through `node …\apps\server\dist\main.js`
  (the `oh` function).
- **Opening files in their Windows app** (`open` with mode native) waits for the local agent
  (FR-20, M2); for a local file `open` returns its text (it has no web link).
