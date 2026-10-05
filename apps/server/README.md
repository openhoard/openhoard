# apps/server

The OpenHoard gateway: the HTTP API and the MCP server. See
[docs/architecture.md](../../docs/architecture.md).

```sh
pnpm --filter @openhoard/server dev    # watches src/, data in ../../.openhoard
```

## Configuration

Values are read from, in order: the environment (`OPENHOARD_*`), then
`<dataDir>/config.json`, then the defaults (`src/config.ts`). The schema is strict, so an unknown
key is an error. `OPENHOARD_TUNNEL_URL` (set by `openhoard tunnel`, below) makes one run public
at that address.

## Background jobs (T-401)

The server starts [core/jobs](../../core/jobs/README.md) on its database: pg-boss, the enrichment
pipeline and the hourly maintenance. `jobs.worker` (default `true`, or
`OPENHOARD_JOBS_WORKER=false`) decides whether this process works the queues and keeps the
schedule; every process can enqueue. A single node leaves it on.

```json
{ "jobs": { "worker": false } }
```

On SIGINT or SIGTERM the server stops listening and stops the job queue at the same time:
running jobs get 5 s to finish, then any still running are failed (retried later) and told to
stop, with up to 2 s more for their handlers to return. Then it closes the database, all within
the 10 s after which it forces an exit.

## Local folders on a schedule (T-303)

`sources` lists folders (and SharePoint sites, below) the server indexes in place (core/jobs
`sync` queue).
To try it on your own machine, follow [docs/dogfood.md](../../docs/dogfood.md).

```json
{
  "sources": [
    {
      "id": "fs-notes",
      "connector": "fs",
      "tenantId": "ten_…",
      "root": "C:\\Users\\Steve\\Documents\\Notes",
      "zone": "Steve's notes",
      "owner": "steve@example.com",
      "schedule": "*/15 * * * *",
      "extract": true
    }
  ]
}
```

| Field            | What                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`             | the connection's name, a lower-case slug: the `source` of its items, and what `admin source …` takes                                                                                                                                                                                                                                                                     |
| `connector`      | `fs`, or `sharepoint` ([below](#sharepoint-sites-on-a-schedule-t-303))                                                                                                                                                                                                                                                                                                   |
| `root`           | (`fs`) an absolute path on this machine: a local disk or a mapped drive. A network share or device path (`\\server\share`, `\\?\…`) is refused, and so is a root and data directory inside one another (links and junctions resolved)                                                                                                                                    |
| `zone`           | the zone's name: an indexed zone, made at start (audited `zone.create`) if the tenant has none of that name; a zone of that name of another kind is refused                                                                                                                                                                                                              |
| `owner`          | an email or a user id: the person who owns, and so reads, its files (the fs connector imports no permissions: owner-only). Until that person exists, runs wait (`unknown-owner`). The person it names on the first run is pinned: an email reused later by someone else never takes the source over, and a config naming someone else for the source is refused at start |
| `schedule`       | standard cron, in UTC; default every 15 minutes. The fs connector's delta compares the whole folder with its last snapshot, so deletions are seen too: no separate full crawl is needed                                                                                                                                                                                  |
| `extract`        | default false: names and metadata only. True: the server reads the files' content for text extraction, then summaries and embeddings as far as each file's exposure allows. Turning it off later isn't retroactive: text, summaries and vectors already stored stay, and `open`, search, `resummarize` and `reembed` still use them; only new versions are left unread   |
| `reconcileGuard` | `maxFraction`, `minItems`: when a reconcile is held for an admin (core/jobs)                                                                                                                                                                                                                                                                                             |

At start the server checks each source's tenant, finds or makes its zone, binds the source to it
(a source later pointed at another zone is refused: give it a new id), builds its connector (its
state in `<dataDir>/connectors/<tenant>/<source>`) and schedules it; any failure stops the server,
naming the source. A worker (`jobs.worker`) keeps one pg-boss schedule per source, runs each once
at start, and drops schedules of sources no longer listed (all of them when none is). Every node
sharing the database must have the same `sources`: a worker that doesn't know a source
completes its jobs without running them. A run that fails for good (refused
credentials, a held reconcile, another folder at the root) stops that source's runs, audited
(`source.sync-stopped`), until an admin acts (`admin source resume`, or the reconcile and
identity commands). `admin source status` and `GET /api/admin/sources` show how each source's
last run ended.

### SharePoint sites on a schedule (T-303)

A source may be a SharePoint site instead of a folder: its document libraries are indexed in
place through Microsoft Graph ([connectors/sharepoint](../../connectors/sharepoint/README.md)),
each library a folder at the top.

```json
{
  "sources": [
    {
      "id": "sp-finance",
      "connector": "sharepoint",
      "tenantId": "ten_…",
      "site": "contoso.sharepoint.com:/sites/finance",
      "directory": "contoso.onmicrosoft.com",
      "clientId": "11111111-2222-4333-8444-555555555555",
      "zone": "Finance",
      "owner": "steve@example.com"
    }
  ]
}
```

| Field                 | What                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site`                | the site, by host and path (`contoso.sharepoint.com:/sites/finance`) or by its id as Graph gives it. One source is one site                                               |
| `directory`           | the Entra directory (tenant) the app is registered in: its id, or a domain it has verified. Not OpenHoard's `tenantId`                                                    |
| `clientId`            | the app registration's client id. Give the app the application permission `Sites.Selected`, and grant it this site (the connector's README says how, and how to check it) |
| `certificate`         | `{ "certificateFile": …, "privateKeyFile": … }`: PEM files, absolute paths, readable by the server only. Preferred. Without it, the client secret below                   |
| `authority`, `graph`  | a national cloud's addresses (https origins). Default: the global cloud's                                                                                                 |
| `downloadHosts`       | hosts a file's bytes may be fetched from besides Graph. Default `[".sharepoint.com"]`                                                                                     |
| `recrawlAfterDays`    | how old a crawl may be before the site is crawled again instead of followed. Default 7; 0 never                                                                           |
| `importPermissions`   | whether SharePoint's permissions become grants here (below). Default true                                                                                                 |
| `graphUnitsPerMinute` | Graph's resource units a minute the app may spend (below). Default 800, 250 at least                                                                                      |

`id`, `tenantId`, `zone`, `owner`, `extract` and `reconcileGuard` are as for a folder.
`schedule` defaults to every fifteen minutes. The first sync crawls the site; those after ask
Graph what changed since (T-304: its list of libraries and one request per library when
nothing did) and record only that.
The site is crawled again when Graph can no longer say what changed, when a library is added or
removed, when one round of changes is more than a sync should take at once (a folder with
thousands of folders in it renamed), and every `recrawlAfterDays` (default 7; 0 never): a crawl records each file anew
(about two database transactions a file, no downloads) and removes what is no longer there,
which mends anything following changes missed. One worker runs one sync at a time, so a large
site's crawl holds up the other sources' syncs while it runs. There is no `watch`: changes are
found at the next sync, not as they happen.

To follow changes the connector keeps each library's folders (ids and names, no file's) in
`<dataDir>/connectors/<tenant>/<source>`; it stays there when the source is taken out of the
configuration. Lost, the site is crawled again. **With several nodes sharing the database,
that directory must be shared too** (or one node run the sources): with a directory per node
changes aren't followed and every sync is a crawl of the whole site, as it was before.

The first sync downloads every file, whatever `extract` says, as a folder's does: a file's
identity in the catalog is a hash of its bytes. `extract` decides whether text is taken from
them afterwards.

**The app's credential is never in config.json** (the schema refuses a secret there). A client
secret is read from the environment, from `OPENHOARD_SOURCE_<ID>_CLIENT_SECRET` (the id in upper
case, anything but letters and digits as `_`: `OPENHOARD_SOURCE_SP_FINANCE_CLIENT_SECRET`). A
source with neither a certificate nor its secret set is left out with an error in the log, and
the others start (what it indexed before stays, and goes stale); a certificate file that can't
be read, or a key that isn't the certificate's, stops the server, naming the source and the
file, never its contents. With both, the certificate signs in and the log says the secret is
unused. Every node sharing the database needs the same secret or files.

**Who can read a site's files (T-305).** Each time a sync records or revisits a file it asks
SharePoint who may see it, and makes that the file's grants here, by the source (`granted_by`
is `source:<id>`; `explain` shows them): added when SharePoint adds someone, revoked when it
takes them away, audited as `grant.import`. A grant a person made here is never touched. Read
at SharePoint is read here; edit and full control are a write grant (which here lets someone
tag the file; nothing is written back to SharePoint). Who a permission is for is matched to
someone the tenant already has, and to nobody otherwise:

- a **user** or **guest**: the SCIM user whose `externalId` is their Entra object id; failing
  that, a local user (`admin user create`) with the same email. A SCIM user is never matched by
  email;
- an **Entra group**: the SCIM group whose `externalId` is its object id, with the members SCIM
  gives it;
- **nobody**: a sharing link for anyone or for the organization, "Everyone", a **SharePoint
  group** (a site's Owners, Members, Visitors), and any permission that gives less than the
  file (view only, limited access, a link that blocks download or only takes uploads), and an
  invitation nobody has taken up. The people and groups a view or edit link was made for are
  named and matched like any other.

What this means for a pilot:

- **Provision first.** With SCIM from Entra, map `objectId` to `externalId` for groups **and
  for users** (Entra's default for users is another attribute). Without SCIM, only people
  named one by one at SharePoint can be matched, by email, to local users.
- **A team site grants mostly through its SharePoint groups**, which match nobody yet: expect
  few people besides `owner` to get access from such a site until that is resolved on a real
  tenant. Nobody gets more than SharePoint gives; many may get less.
- **What matched nobody** is in the run's counts (`unmappedUsers`, `unmappedGroups` in `admin
source status`, as of the last run: a crawl's run counts the whole site, a later one only
  what it revisited) and the groups' ids are in the log.
- **Provisioning later** takes effect when a file is next visited: at the latest the next
  crawl (`recrawlAfterDays`).
- **A permission removed at SharePoint may still read here until the file is next visited.**
  A sync visits what Graph's delta reports (a folder or library whose sharing changed has
  everything under it looked at again) and a crawl visits everything. Whether the delta
  reports sharing changes with this app's permissions is not yet verified on a real tenant:
  until it is, take `recrawlAfterDays` as the bound (the configuration refuses 0 while
  permissions are imported). A source that is
  stopped (`admin source status`) visits nothing: its grants stay as they were.
- **Cost.** One Graph request per file each time it is visited, five of Graph's units each: a
  crawl of 20,000 files is two hours of the default budget for permissions alone ("Pacing"
  below), over many runs. Every file is a grant per person or
  group named, and a person's grants are loaded when they search: this is sized for sites of
  some tens of thousands of files, not hundreds of thousands.
- `"importPermissions": false` leaves a site's files to `owner` alone: what an earlier import
  granted is taken back when the next sync starts.
- A file whose permissions SharePoint won't show (refused, or an answer that makes no sense) is
  not recorded (skipped as `permanent` or `invalid-acl`), and what it had been granted is
  withdrawn until the file is next visited. A site where every file is skipped that way is an
  app that can't read permissions: grant it, or turn the import off.

**Pacing (T-306).** Requests to Graph keep to `graphUnitsPerMinute` (default 800 of Graph's
resource units, under its smallest tenant's limits as Microsoft documents them), one budget for
every source signed in as the same app in the same directory (the configuration refuses two
that give different figures). Each node has its own: with several, divide it. When Graph says to slow down, the sync
waits in place, up to about a minute a request, and goes on; asked for more, it stops and comes back
after the wait, from its last checkpoint. Nothing is lost either way. A first crawl costs some
eight units a file, so 20,000 files take over three hours at the default: a tenant with more
licences has a higher limit, and raising the budget shortens crawls in proportion.

What it doesn't do yet: be told of changes as they happen (Graph's change notifications, the
rest of T-304), and resolve SharePoint groups. It hasn't been run against a real tenant yet.

Content is read through the source's connector, checked against the version's size and BLAKE3
blob id with the tenant's blob key. **Tenant blob keys** live in `<dataDir>/keys/<tenant>.blob-key`
(32 random bytes, made on first use, 0600; written whole, then linked into place; never made for
a tenant that has content already: a missing key there stops the server, pointing at the backup):
outside the database, so the database alone can't tell
two tenants hold the same file. Back them up with the database; losing one makes every blob id of
that tenant unverifiable. Servers sharing one database must share them (a KMS-backed store is for
later).

## Models (T-404, T-405)

Off by default: with no `models.providers`, enrichment runs no model. Each provider has an id, a
kind (`local`, `commercial`, `consumer`: which files' content it may have), an adapter
(`ollama`, `openai` for OpenAI, Azure OpenAI, LM Studio and vLLM, `anthropic`, or `stub`), a base
URL and models, and optional timeouts, retries, caps and concurrency. See
[core/models](../../core/models/README.md) for every setting and an example.

```json
{
  "models": {
    "providers": [
      { "id": "ollama", "kind": "local", "adapter": "ollama", "chatModel": "llama3.2" },
      { "id": "claude", "kind": "commercial", "adapter": "anthropic" }
    ],
    "dailyTokenBudget": 2000000
  }
}
```

API keys come only from the environment, `OPENHOARD_MODEL_<ID>_API_KEY` (here
`OPENHOARD_MODEL_CLAUDE_API_KEY`); the configuration file has no field for one. A provider whose
key is missing is left out with a warning naming the variable: the server starts, that provider
runs nothing (task orders skip it), and search still works by keywords; set the key and restart.
Any other problem with a provider still stops the server. Summaries run only where the server also reads
versions' bytes (a source with `extract: true`); local-only content only ever reaches a `local`
provider.

## Signing in (T-102)

People sign in with OpenID Connect, using the authorization code flow with PKCE, through the
providers in `auth.providers`. Each provider belongs to one tenant. Sign-in is off when `auth` is
absent.

```json
{
  "auth": {
    "publicUrl": "https://hoard.example.com",
    "providers": [
      {
        "id": "acme-entra",
        "label": "Acme (Microsoft)",
        "kind": "entra",
        "tenantId": "ten_…",
        "issuer": "https://login.microsoftonline.com/<directory id>/v2.0",
        "clientId": "<application id>"
      }
    ]
  }
}
```

**Client secret.** Put the secret in the environment, as
`OPENHOARD_AUTH_<ID>_CLIENT_SECRET`, where `<ID>` is the provider id upper-cased with `-` written
as `_` (for example `OPENHOARD_AUTH_ACME_ENTRA_CLIENT_SECRET`). A public client with no secret
works too.

**Redirect URI.** Register `<publicUrl>/auth/callback/<id>` with the provider.

**Discovery.** The server reads the provider's OpenID configuration on the first sign-in and keeps
it. A transient failure (the connection dropped or refused, no answer in 10 seconds, a 5xx) is
tried once more a moment later; if that fails too, or the answer is wrong (a 4xx, another
issuer), sign-in answers 503 "sign-in is unavailable", logs why, and tries again on the next one.

**Provider kinds:**

| Kind      | Issuer                                                                   | A first sign-in is matched by            |
| --------- | ------------------------------------------------------------------------ | ---------------------------------------- |
| `entra`   | `https://login.microsoftonline.com/<directory id>/v2.0` (never `common`) | `oid`, unless `matchExternalId: false`   |
| `google`  | `https://accounts.google.com`                                            | nothing (T-109, for invited people)      |
| `generic` | any issuer (https, or http on this machine only)                         | `sub`, only with `matchExternalId: true` |

- **Matching.** A first sign-in's claim is matched once to a SCIM user's external id, and after
  that only the linked (issuer, subject) counts. Sign-in never matches on email and never creates
  anyone (core/identity `signIn()`).
- **One matching provider per tenant.** A second one could claim the first one's people.
- **Entra.** Entra's default SCIM mapping sends `mailNickname` as `externalId`. Map `objectId`
  to `externalId` in the provisioning app's attribute mappings instead, or people won't be
  matched on their first sign-in.

**Sign-ins under way.** The PKCE verifier, nonce, state and return path go in an AES-256-GCM
sealed cookie of their own, one per sign-in. It is HttpOnly, limited to the callback path, and
lasts 10 minutes. Starting a sign-in writes nothing on the server. Each process makes its own
key. When several servers share one address, give them the same key: `auth.cookieKey` or
`OPENHOARD_AUTH_COOKIE_KEY`, 32 random bytes in base64url
(`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`).

**Sessions.** A session is a row in `sessions`, and the cookie holds an opaque token of which
only a hash is stored.

- The cookie is HttpOnly and SameSite=Lax. Over https it is also Secure and named
  `__Host-oh_session`.
- A session ends in any of these cases:
  - after `sessionIdleMinutes` unused (default 720, at least 5);
  - after `sessionMaxHours` (default 168, at most 720);
  - at sign-out, or when the browser signs in again;
  - when the person is locked, disabled or retired. Unlocking doesn't bring the session back.
- A state-changing request that carries the cookie must come from `publicUrl`'s origin (the
  Origin header), or it is refused (403).

**Routes:**

| Route                     | What it does                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET /auth/providers`     | The providers to offer on a sign-in page.                                                                        |
| `GET /auth/login/<id>`    | Starts sign-in. `?return_to=/path` sets where to come back to (a path on this server, at most 1,536 characters). |
| `GET /auth/callback/<id>` | The provider sends the browser back here.                                                                        |
| `GET /auth/me`            | Who is signed in (401 if nobody).                                                                                |
| `POST /auth/logout`       | Ends the session (204).                                                                                          |
| `GET /auth/link?token=…`  | A one-time sign-in link's page: a button (with `auth.signInLinks`).                                              |
| `POST /auth/link`         | Uses the link: starts a session. Must come from `publicUrl`'s origin.                                            |
| `GET /auth/invite`        | An invite's page: makes a passkey (with `auth.passkeys`, below).                                                 |
| `POST /auth/passkey…`     | The passkey ceremonies (below).                                                                                  |

**One-time sign-in links** are for a server with no identity provider, for one person trying
OpenHoard on their own machine ([docs/dogfood.md](../../docs/dogfood.md)). `auth.signInLinks: true`
turns them on, and the config refuses it unless both `host` and `publicUrl` are loopback
addresses: **no tunnel or proxy in front**. Each request to `/auth/link` must also come from a
loopback peer and carry no forwarding header (`Forwarded`, `X-Forwarded-For`,
`X-Forwarded-Host`, `X-Real-IP`, `CF-Connecting-IP`), or it is refused (403): a tunnel or proxy
running on this machine forwards requests from anywhere. An operator makes the person (`admin
user create`) and issues a link (`admin user sign-in-link`, 15 minutes by default, at most 60);
the link's page only shows a button, so a prefetch doesn't use it up, and the POST must come from
this origin. A link starts one session; the same link again is refused and ends that session,
unless the browser presenting it holds that very session (a double submit, answered as done).
The operator is trusted: a link can be issued for any current person, a SCIM-provisioned one
too, and signing in with it bypasses the identity provider and its MFA.
No identity is linked, so signing in again takes a new link. Every use is audited
(`auth.sign-in`, provider `sign-in-link`). `GET /auth/sign-in` sends a browser that is signed in
already straight back to `return_to` (an MCP client's authorization, after a link was used in
another tab).

Every sign-in is written to the audit log (`auth.sign-in`), whether it was allowed or refused, and
so is every sign-out (`auth.sign-out`). A refused person nobody provisioned is logged as
`oidc:<id>` with the subject the provider gave, so an admin can link them.

Later routes use `requireSignIn` and `c.get("auth")`: the tenant, the session and the
principal.

## Built-in accounts: invites and passkeys (T-108)

For a server **without an identity provider**: a team that has none, or one person reaching
their own server from outside (a tunnel, where sign-in links are refused). People are made
locally (`admin user create`) and sign in with a **passkey**: a key pair their phone, computer or
security key holds and unlocks with a fingerprint, face or PIN. There is no password, and the
server keeps only the public key.

```json
{ "auth": { "publicUrl": "https://files.example.com", "passkeys": true } }
```

1. `openhoard admin user create --tenant ten_… --email ana@example.com --name "Ana"`
2. `openhoard admin user invite --tenant ten_… --user ana@example.com` prints an invite link,
   `<publicUrl>/auth/invite#ohi.…`, once. Send it to the person over a channel you trust (there
   is no email delivery yet).
3. They open it, press **Create a passkey**, and are signed in. From then on the sign-in page's
   **Sign in with a passkey** signs them in, with no user name to type.

**Invites.** Good once, for 7 days by default (`--hours`, 1 to 168). Whoever opens the link makes
a passkey for that person, so treat it like a password until it is used. A newer invite replaces
the older one; a lock or retirement revokes it for good. The token rides in the link's
**fragment**, which browsers send to no server: it reaches this one only in a request body, so
it is in no URL, proxy log or tunnel log. A used, expired or replaced invite says so to its
holder; anything else is just refused.

**Passkeys.**

- **Local people only.** Someone provisioned over SCIM signs in through the identity provider:
  a passkey here would bypass its rules (MFA, conditional access), so invites and passkeys are
  refused for them.
- **The person is always verified** (fingerprint, face or PIN): a passkey replaces a password
  and a second factor at once. An authenticator that can't verify its user is refused.
- **They belong to `publicUrl`'s host**, the WebAuthn relying party id. It must be a host name
  (the config refuses an IP address; `http://localhost:…` works on this machine), and **passkeys
  stop working when the host changes**: invite people again after moving the server. A
  Cloudflare quick tunnel gets a new host on every run, so passkeys need a named tunnel or a
  real domain.
- **No attestation.** The server asks for none and verifies none: it learns that a key pair was
  made, not which make of authenticator made it. Accepted algorithms: ES256, EdDSA, RS256. A key
  must be exactly its algorithm's parameters; degenerate ones (an RSA exponent below 65,537, a
  small-order Ed25519 point) are refused.
- **Synced or not.** Passkeys that sync between a person's devices (iCloud Keychain, Google
  Password Manager, 1Password) and ones that don't (a security key) both work. Where the
  authenticator keeps a signature counter, one that doesn't advance is refused (a copied key).
- **Several per person** (at most 20). Signed in, a person adds another through
  `POST /auth/passkey/register/options` and `/register` with no invite; `GET /auth/passkeys`
  lists theirs and `DELETE /auth/passkeys/<id>` removes one. Adding and removing both need a
  sign-in within `adminSignInMinutes` (15 by default): a session left open, or stolen later than
  that, can neither add a way back in nor lock its person out. Within that window a session can
  do what its person can.
- **Removing a passkey** ends the sessions it signed in and the person's AI client grants. It
  doesn't end sessions another passkey signed in. An operator does the same with
  `admin user list-passkeys` and `admin user remove-passkey` (a lost phone).
- **A lost only passkey** is a new invite: `admin user invite` again.
- **If an account may be compromised:** `admin user lock` (every session, grant and unused
  invite ends at once), `admin user list-passkeys` and `remove-passkey` for each one the person
  doesn't recognise (or all of them), then `admin user unlock` and a new invite.

**Routes** (all only with `auth.passkeys`; every POST must come from `publicUrl`'s origin):

| Route                                 | What it does                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| `GET /auth/invite`                    | The invite page: a button, and the script. The same for everyone.               |
| `GET /auth/passkey.js`                | The one script the server serves: the two ceremonies, this origin only.         |
| `POST /auth/passkey/register/options` | `{invite}` or signed in: what to make a passkey with.                           |
| `POST /auth/passkey/register`         | `{invite?, name?, response}`: stores the passkey; an invite signs its person in |
| `POST /auth/passkey/options`          | What to sign in with (any passkey of this server).                              |
| `POST /auth/passkey`                  | `{response, return_to?}`: starts a session, answers `{returnTo}`.               |
| `GET /auth/passkeys`                  | The signed-in person's passkeys.                                                |
| `DELETE /auth/passkeys/<id>`          | Removes one of theirs.                                                          |

Each ceremony's challenge is in a sealed cookie of its own (as a sign-in under way is), bound to
the invite or session it was issued for and good for 5 minutes; asking for options writes
nothing on the server. A challenge is answered once: the first answer that names a real invite
or passkey records it (a hash, in `passkey_challenges`, for 15 minutes), right or wrong, so a
copied request (the cookie and the answer, from a proxy's log) signs nobody in again and adds
nothing to the audit log: each challenge is audited at most once. Audited: `invite.issue`, `passkey.register`, `passkey.remove`, and
`auth.sign-in` with provider `passkey` (refusals too, once a real invite or passkey is named).
The two pages that run a ceremony allow one script, this server's own
(`script-src 'self'`); every other page still allows none.

## MCP clients: OAuth 2.1 (T-105)

OpenHoard is its own OAuth 2.1 authorization server for MCP clients (Claude, ChatGPT, Copilot, the
MCP Inspector), following the MCP authorization spec. The MCP server is `<publicUrl>/mcp` (T-801),
and tokens are good for it and nothing else.

| Route                                           | What it does                                                   |
| ----------------------------------------------- | -------------------------------------------------------------- |
| `GET /.well-known/oauth-protected-resource/mcp` | RFC 9728: where to get tokens for `/mcp` (also without `/mcp`) |
| `GET /.well-known/oauth-authorization-server`   | RFC 8414 metadata                                              |
| `POST /oauth/register`                          | Dynamic client registration (RFC 7591), public clients only    |
| `GET /oauth/authorize`                          | Signs the person in (above), then asks for their consent       |
| `POST /oauth/token`                             | `authorization_code` and `refresh_token`                       |
| `POST /oauth/revoke`                            | RFC 7009                                                       |

**Clients** identify themselves in one of two ways:

- **Client ID Metadata Documents** (what the spec prefers): the client id is an https URL.
  OpenHoard fetches it with these limits:
  - public addresses only, checked on the address it actually connects to;
  - no redirects;
  - 5 seconds and 64 KB at most;
  - cached for up to an hour.
- **Dynamic registration** (older clients): registering stores nothing. The client id encodes the
  redirect URIs and the name.

**Admin approval.** A client gets tokens in a tenant only once an admin approved it with a trust
label (`local`, `commercial` or `consumer`). The label becomes the request's client trust, which
policy (`context.client.trust` in Cedar) and exposure (T-604) check on every request.

An admin approves a waiting client in one of three places: the config (`auth.clients`, below),
the admin API (T-106), or **the page itself**. When the person connecting a client that waits is
an admin, the "isn't approved yet" page shows them what the client calls itself, the addresses
its answers go to, the three trust labels (none chosen for them, least trusting first), and
Refuse and Approve (`POST /oauth/approve`). A client an admin refused can be approved there
after all, and so can one the config approved once and no longer lists. What the config lists,
the config decides: the page only lifts a refusal made in the app, with the config's label. The page says plainly that the name is the client's own claim and that anyone can
send an admin a link to it: approve only what you just started connecting yourself. It is the
admin API's decision by another door: checked again in its own transaction (still an admin),
only with a sign-in within `adminSignInMinutes` to approve, sealed to the session that saw the
form, audited `oauth-client.approve` or `oauth-client.refuse` with `via: "authorize"`. After
approving, the admin goes on to their own consent like anyone. Everyone else is told to wait.
This is how one person on their own server approves claude.ai: there is no one else to ask.

- Admins approve, refuse and revoke clients in the app, with the admin API (T-106, below).
- The config can approve clients too, as a bootstrap or an override (`auth.clients`):

  ```json
  {
    "auth": {
      "clients": [
        {
          "tenantId": "ten_…",
          "clientId": "https://claude.ai/oauth/mcp-client-metadata.json",
          "trust": "commercial"
        },
        {
          "tenantId": "ten_…",
          "redirectUris": ["http://127.0.0.1/callback"],
          "trust": "local"
        }
      ]
    }
  }
  ```

  A dynamically registered client is named by its exact redirect URIs. On the loopback address,
  any port counts (RFC 8252).

- A client nobody approved is recorded as pending in the tenant (`oauth_clients`), and the person
  is told it is waiting. It gets no code, no token, and no redirect.
- A refused or revoked client is turned away, its grants are revoked (its tokens fail from their
  next request) and codes it hasn't redeemed are used up.
- **Precedence** (src/oauth/allowlist.ts), most binding first:
  1. a refusal made in the app stands, whatever the config says (fail closed);
  2. a client the config lists is approved with the config's label, and the app can't refuse,
     revoke or relabel it (the admin API answers 409: change the config);
  3. a client approved through the config and then taken out of it is no longer approved (its
     tokens stop), until an admin approves it in the app;
  4. otherwise the app's decision.
- Pending clients are capped at 20 per person and 1,000 per tenant, and lapse after 30 days. A
  client the config approves is recorded whatever the counts.
- At most two client documents per person are fetched at a time (eight in all).
- A decided client's record isn't changed by what it later says about itself.

**The flow:**

- Authorization code with PKCE, S256 only.
- Tokens are for `resource` = `<publicUrl>/mcp` (RFC 8707).
- The authorization response carries `iss` (RFC 9207).
- `/oauth/authorize` does nothing for someone who isn't signed in except send them to sign in.
  It fetches no client document and redirects nowhere.
- Errors are shown on the page until the client, its redirect URI (which the request must name)
  and its approval check out. After that, protocol errors go back to the client with `state` and
  `iss`, so an unapproved client gets no redirect at all.
- Request bodies are limited to 64 KB, form-encoded (JSON for registration), and never multipart.
- Pages are served with `Referrer-Policy: same-origin`. Under `no-referrer`, browsers send
  `Origin: null` on the consent form's own post. A post whose Origin is `null` is accepted only
  when `Sec-Fetch-Site: same-origin` says it came from this server.
- The consent page names the client, where the answer goes, and what it may do. It warns when a
  program on the person's own computer is asking.
- The consent form is sealed to the session for 10 minutes.

**Tokens** are opaque, and only their hashes are stored:

- the code (60 s, used once, and a replay revokes what it made);
- access tokens (1 hour);
- refresh tokens, rotated on every use. The previous one presented again revokes the grant.
- A grant lasts `auth.grantDays` (default 30, at most 90).
- Locking, disabling or retiring a person revokes their grants, as it ends their sessions. So
  does unlinking any of their sign-in identities: they consent again.

**Scopes:** `files:read` (search, read, open), `files:tag` (propose tags) and, where `uploads` is
configured, `files:add` (add files as the person: the upload API, not the MCP server; it reads
nothing). They become the
request's credential scope, so policy refuses anything else. A token without the scope a route
needs gets 403 with `error="insufficient_scope"` and the scopes to ask for.

Every authorization and token decision is audited: `oauth.authorize`, `oauth.token` and
`oauth.refresh`.

## Tenant admins and the admin API (T-106)

A tenant's **admins** decide which AI clients its people may connect, and who else is an admin.
Admin is for administration only (tenant settings, clients, admins): it never lets anyone read a
file their grants don't. `authorize()` doesn't read it and Cedar never sees it.

Someone is an admin two ways:

- **The admin role**, held in OpenHoard. The first admin is made by the operator with the admin
  CLI (`admin user grant-admin`, below); admins make others in the app.
- **The tenant's admin group** (optional): one SCIM group per tenant, named in the config by its
  OpenHoard id (`grp_…`; `admin group list` prints each group's id, source, member count,
  external id and name). The provider decides who is in it, so the app can't remove its members:
  they leave the group upstream.

  ```json
  { "auth": { "adminGroups": [{ "tenantId": "ten_…", "groupId": "grp_…" }] } }
  ```

  - **Never by external id.** Whoever holds the SCIM token chooses external ids: naming the group
    by one would let the token create or rename a group of its own into the admin group.
    OpenHoard's ids aren't chosen by anyone.
  - **Fail closed.** A group that is missing, deleted, or not provisioned over SCIM makes nobody
    an admin (`GET /api/admin/admins` and `admin user list-admins` say so).
  - **Admin-grade.** With an admin group, the tenant's SCIM token and whoever manages that group
    in the identity provider decide who administers the tenant: guard them as you would an admin
    account.
  - **Audit.** A SCIM change to the admin group's members adds `admin.group.join` and
    `admin.group.leave` records (one per person, actor `scim:<token id>`) to the request's
    `scim.group.*` record. A person leaving it some other way (a SCIM user deleted, disabled or
    made a guest) shows in that request's `scim.user.*` record only.

Either way it counts only for an active member: locking, a provider disable or becoming a guest
suspends it, retirement removes the role, and a guest or a service account is never made one.
Removing the tenant's last admin who counts (group admins included) is refused, in the app and
in the CLI. Locks, disables and retirements aren't limited by it (the identity provider may do
all three), so a tenant can end up with no admin; the CLI makes a new one. Admin status is part of
the person's principal (`principal.admin`, `/auth/me` says `admin`), and a change reaches every
server on the next request (the principal epoch).

The **admin API** is JSON under `/api/admin`, for the admin UI to come and for scripts:

| Route                                  | What it does                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /api/admin/clients`               | Every client the tenant's people tried                                       |
| `POST /api/admin/clients/:key/approve` | `{"trust": "local"}` (or `commercial`, `consumer`); relabels an approved one |
| `POST /api/admin/clients/:key/refuse`  | A pending client                                                             |
| `POST /api/admin/clients/:key/revoke`  | An approved client: its grants and tokens end                                |
| `GET /api/admin/admins`                | The tenant's admins, how (`role`, `group`), and if they count now            |
| `POST /api/admin/admins`               | `{"userId": "usr_…"}`, or `{"email": …}`, or `{"userName": …}`               |
| `DELETE /api/admin/admins/:userId`     | Takes the role away                                                          |
| `GET /api/admin/sources`               | Each connector sync: phase, reconcile, last run (status, code, counts), stop |

- **Who.** A person signed in with the session cookie (above), who is an admin, through
  OpenHoard's own app (an AI client's token never administers). Anyone else gets 401 or 403, and
  a 403 is audited (`admin.access`). Each change checks again, in its own transaction.
- **CSRF.** Changes carry the session cookie, so their `Origin` must be `publicUrl`'s, and they
  take `application/json` only.
- **A recent sign-in.** Approving a client and changing who is an admin take a sign-in within
  `auth.adminSignInMinutes` (default 15): otherwise 403 with `"signIn": "/auth/sign-in"`.
  Refusing and revoking a client never do, so an emergency cut-off is never a sign-in away.
- **What identifies a client** is shown first: its metadata document URL (`clientId`), or for a
  dynamically registered client its `redirectUris` (where its codes go). The name it gives itself
  is `claimedName`: anyone can call themselves Claude. `managedBy` says whether the config
  decides it, `approved` and `trust` what it gets now.
- **Audit.** Every decision, allowed or refused: `oauth-client.approve`, `oauth-client.refuse`,
  `oauth-client.revoke` (with the label, the previous one, and the status it was in), and
  `admin.grant`, `admin.revoke`; refusals say why (`sign-in-again`, `config-managed`,
  `status-changed`, `last-admin`, `admin-group`, …).

## The MCP server (T-801)

`<publicUrl>/mcp` speaks MCP over Streamable HTTP, behind the tokens above.

- **Stateless.** Every request is a POST, and there is no `Mcp-Session-Id`: GET and DELETE get 405. Each request gets a fresh server, and its bearer token is checked against `oauth_tokens`
  first, so a revoked grant or a locked person is refused on the next request. Without a valid
  token the answer is 401, with `WWW-Authenticate` pointing at the RFC 9728 metadata.
- **One message per POST.** JSON-RPC batches (dropped from MCP in 2025-06-18) get 400: in one, a
  cancel or a repeated id could keep a tool running past its answer, and a hundred calls could
  hold every database connection. Bodies are limited to 256 KB.
- **Responses are JSON**, not an SSE stream. A request still running after 60 seconds gets 503,
  and its tools are aborted (`ctx.signal`), as they are when the client hangs up.
- **Origins.** A request carrying an `Origin` header (a browser) is refused with 403 unless it
  is `publicUrl`'s origin, this machine's (`localhost`, `127.0.0.1`, `[::1]`: the MCP
  Inspector), or listed in `auth.mcpOrigins`. That is the spec's defence against DNS rebinding.
  Only those origins get CORS headers. Hosted clients call from their servers, with no `Origin`.
- **Tools** (src/tools/, T-802..T-806). Each is an `McpTool`: it runs with the request's caller,
  its activity buffer and audit trail, the tenant's policies (its packs' Cedar rules, compiled
  once per policy set) and the model the call reports (`_meta`).
  - `whoami`: the person, the client's id and trust, the scopes granted.
  - `find` (query, tags, kind, media type, modified range, limit, cursor): a top match and
    alternatives as compact cards (id, title as shown, kind, modified, owner's name, tags,
    summary where the card allows, and which channels matched: never a text snippet). Queries
    are embedded by local providers only, when an embeddings model is configured.
  - `recent` (period or from/to in an IANA `timeZone`, actions, kind, media type): the files the
    person themself viewed, opened or edited, from the activity log (T-506). Reads no content.
  - `describe` (id): one card and, for a reader, its versions and, for a file saved from the
    web, the address it came from (`sourceUrl`).
  - `open` (id, `link` or `content`): the source's web link, checked as it leaves (https only,
    no credentials, canonical: @openhoard/sdk checkUrl/canonicalUrl), or the extracted text
    when exposure allows, cut to the budget and wrapped between `BEGIN-FILE-TEXT-<nonce>` and
    `END-FILE-TEXT-<nonce>` with a note that it is untrusted data. A link comes with a note that
    it is for the person to click, never for the agent to fetch; a `risk:injection` file gets
    no link (a browsing agent could fetch the payload the flag keeps from it).
  - `tag` (id, facet:value; needs `files:tag`): a proposal in the review inbox (reason `agent`),
    never applied; only approved values, never one that sets a visibility or exposure level or
    has a live grant; the person must be allowed to tag the file; 30 per hour per person and
    client, and 60 per hour per person across clients (counted per server process). An agent's write is thereby always a person's decision in
    OpenHoard's app (T-605, for tags).
  - `explain` (id, optional person): who has access and why, for the file's owner only. A named
    person is explained only if they own the file or a grant covers them; anyone else (or an
    unknown address) gets the same neutral answer, and a denial says only "blocked by policy".
- **Budget and shapes.** Every answer fits a token budget (2,000 by default, `maxTokens` 500 to
  8,000; estimated at a third of a token per ASCII character and two per other), and lists end
  with a cursor. Output schemas are pinned (`src/tools/__snapshots__`): a changed shape fails CI
  until the snapshot is updated on purpose.
- **Injection suite (T-805).** `src/tools/injection.test.ts` serves spike S8's corpus through
  find, describe and open to an agent that obeys every file, and checks OpenHoard's own state
  (tags, vocabulary, grants, review items, opens). It says nothing about agents with other
  tools (browsing, email, a shell): what such an agent does with text it read is the client's
  to contain.
- **Audit (T-704).** Every tool call is audited as `mcp.tool` (tool, outcome, file, client, trust,
  reported model; never its arguments). Every AI read is audited as `ai.read` with the client,
  the reported model (`_meta["openhoard/model"]`, `_meta.model` or `_meta.clientInfo.model`,
  else `unknown`), the file and the version: each content `open`, and each card with a summary.
  Tag proposals are `tag.propose`. All are written with the activity, before the answer leaves.
- **Activity (T-205).** Each request gets an `ActivityBuffer` that the tools' gated reads record
  into. It is written once the response is ready, and if that fails the answer is withheld (500):
  an AI read is never left unrecorded. Events keep the client's id and trust.
- **Exposure (T-604).** Tools build every catalog request with `readRequest(ctx)`: the person,
  through the client with the trust label its admin gave it. Where a file's exposure doesn't
  reach that label, cards are metadata only (`metadataOnly`: no summary or anything else derived
  from the content) and the content isn't opened; `local-only` content goes to `local` clients
  only, `metadata-only` content to none. A refused open is audited with the activity
  (`object.open`, denied, `reason: exposure`), once per file per request. OpenHoard's own apps
  aren't limited by exposure.
- A tool that fails answers `internal error`, never the thrown message, which could name a file.
  The SDK's own argument-validation errors do describe the schema (field paths, patterns), never
  the values sent.

### Trying it from a hosted client (testing only)

Claude, ChatGPT and other hosted clients need an https URL they can reach. For a test, a
[Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
gives one without an account:

```sh
cloudflared tunnel --url http://127.0.0.1:7420
# prints https://<random words>.trycloudflare.com
```

1. Set `auth.publicUrl` to the printed URL and restart the server. Register
   `<publicUrl>/auth/callback/<provider id>` as a redirect URI with the sign-in provider.
2. Add `<publicUrl>/mcp` to the client as a connector and sign in: the client waits for an
   admin. An admin connecting it approves it on that page; otherwise approve it with the admin
   API (`GET /api/admin/clients`, then `POST /api/admin/clients/<key>/approve`), or in
   `auth.clients` (above), and connect again.

Quick tunnels are for testing: the URL changes on every run, and there is no uptime guarantee.
OpenHoard depends on no domain of ours. A self-hoster serves it at their own `publicUrl`, behind
their own proxy or tunnel. For one person's server, `openhoard tunnel` (below, "Reaching it from
outside") does the steps above in one command, with a quick tunnel or the operator's own.

## Provisioning over SCIM (T-103)

The tenant's identity provider keeps OpenHoard's users and groups in step with its own, over
SCIM 2.0 (RFC 7643 and 7644), at one URL for every tenant:

```text
<publicUrl>/scim/v2    (the Tenant URL, for example https://hoard.example.com/scim/v2)
```

It is on by default (`"scim": { "enabled": false }` turns it off), and nothing gets in without a
token.

**Tokens.** Each tenant has its own SCIM bearer tokens, `ohscim.<tenant id>.<token id>.<secret>`.
They are not API keys: a token acts only as that tenant's identity provider, and its changes are
recorded as `scim:<token id>`.

- `openhoard admin scim-token issue` prints a token once; only a SHA-256 of its secret is kept.
- A token expires within a year (the default is a year). Before it does, issue a new one, paste
  it into the identity provider, then revoke the old one.
- A revoked or expired token fails on the next request.

**What is audited.** Every request is written to the audit log, allowed or refused, as
`scim.user.*`, `scim.group.*` or `scim.discovery.read`. The record holds ids, the status and the
reason for a refusal, and no personal data.

- **Refused tokens.** A refused token on a real token id is logged as `scim.auth` with why
  (`wrong-secret`, `revoked` or `expired`).
- **Guessed token ids.** Tenant ids aren't secret, so token ids a tenant doesn't have are counted
  in memory, not logged one by one. Each tenant gets at most one `scim.auth` record per minute
  (`unknown-token`, with the count), written after the responses went out. A tenant that doesn't
  exist gets the same answer after the same work, and nothing is logged. The caller only ever
  gets a 401.
- **Unexpected errors.** An unexpected error rolls its transaction back. The failure is then
  logged and audited in a transaction of its own (`internal-error`), and the 500 names a request
  id to find both by.
- **The body.** The token is checked before the body is read.

**Failed authentications.** Refused tokens that are well formed count as failures:

- against the client's address (IPv6 by /64);
- against the token id, except while that token is in use (it authenticated in the last 10
  minutes): a wrong secret for it is audited but not counted, so knowing a token's id isn't
  enough to lock it out;
- against the tenant, for token ids it doesn't have.

After 10 failures in a minute on any of these, requests with that address, token id or tenant are
blocked until the minute is over. A block never refuses a valid token on its own, since tenant
ids aren't secret and strangers may share the identity provider's address (behind a tunnel, say).
A blocked request gets a quiet check instead: one lookup, with nothing written and nothing
counted. A valid token goes on; anything else gets 429. So a block only stops guesses, and it
holds after a restart too.

A request with no token, or with something that isn't one, gets 401 without a database lookup
and isn't counted. The counts are kept in each process's memory.

Behind a reverse proxy or tunnel, every client has the proxy's address unless the proxy is
trusted. For requests from a trusted proxy, X-Forwarded-For is read from the right, skipping
trusted proxies, and the first other address is the client. Hops with a port (`192.0.2.1:5678`,
`[2001:db8::1]:443`, as Azure Application Gateway, Front Door and IIS ARR write them) count by
their address:

```json
{ "scim": { "trustedProxies": ["127.0.0.1", "::1"] } }
```

Trusted proxies are exact addresses, and none are trusted by default. Trust only the proxy that
sets the header: the client writes everything to its left.

**Endpoints.** `Users`, `Groups`, `ServiceProviderConfig`, `ResourceTypes` and `Schemas`. PATCH
is supported. Bulk, sorting, ETags and `/Me` are not. Filters support `eq`, joined by `and`:

- on users: `userName` (compared without regard to case), `externalId` (exact), `id`, `emails`
  (or `emails.value`, or `emails[type eq "work"].value`), `displayName` and `active`;
- on groups: `displayName` (exact), `externalId` and `id`.

Pages have at most 200 resources (`startIndex`, `count`). `attributes` and `excludedAttributes`
work on top-level attributes, and `excludedAttributes=members` skips loading members.

**Users.** A SCIM user is an OpenHoard user of source `scim`, and its SCIM `id` is the OpenHoard
id (`usr_…`).

| SCIM                                 | OpenHoard                                                                   |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `userName` (required)                | kept as sent; unique regardless of case                                     |
| `externalId`                         | matched once at sign-in (T-102): map Entra's **objectId** here              |
| `emails` (primary, else type `work`) | the email; with none, `userName` when it is an address, else refused        |
| `displayName`                        | as sent; else `name.formatted`, else given and family name, else `userName` |
| `name.givenName`, `name.familyName`  | kept                                                                        |
| `active`                             | the provider's switch; `false` ends sessions and OAuth grants at once       |
| `userType` (`Member`, `Guest`)       | the kind: a guest never discovers files; left out, the kind stays           |

- **Dropped attributes.** Anything else (title, phone numbers, addresses, other emails, the
  enterprise extension, a password) is accepted and dropped.
- **Entra's quirks.** Entra's PATCH quirks are handled: `op` in any case, `active` as `"True"` or
  `"False"`, `emails[type eq "work"].value`, `name.givenName`, and value objects without a path,
  including dotted keys (with or without `?aadOptscim062020`).
- **Soft delete.** `active: false` stops the user, ending their sessions and revoking their
  OAuth grants (T-105), as any stop does. They are still returned by GET and filters,
  and `active: true` lets them back in. `active` reports only the provider's own switch: an
  OpenHoard admin's lock is separate, isn't reported, and isn't lifted by `active: true`.
- **DELETE.** DELETE retires the user for good. They leave every group, their grants are
  revoked, and their email and userName are freed. A later POST creates a new user with a new
  id.
- **Local users.** A local user (invited, T-108) with the same email is a 409, never adopted.
  Adopting a local user into SCIM must be an explicit admin action (not built yet). Local users,
  service accounts and retired users don't exist here (404).
- **PUT.** A PUT replaces the attributes above; one it leaves out is removed, except `active` and
  `userType`, which stay as they are: a PUT never re-enables anyone, or makes a guest a member,
  by omission. A PATCH that removes `userType` changes nothing either; only `"Member"` makes a
  guest a member.
- **The resource's own id.** A PATCH value object may repeat the resource's own `id` (Okta's
  does); any other `id` is refused (`mutability`).

**Groups.** A SCIM group is an OpenHoard group of source `scim`, and its `id` is `grp_…`.

- `displayName` is unique among SCIM groups (409), compared exactly.
- Members are users, by their SCIM id. A group as a member is refused (400): membership in
  OpenHoard is direct, and Entra doesn't provision nested groups anyway.
- A service account, a local user (invited, or a break-glass admin), an unknown user or a
  retired user is refused (400). What the identity provider's groups hold goes only to the people
  it provisions, whom it can take it from again.
- Members are added and removed the way Entra sends them: `Add`/`Remove` with a value list, or
  `remove` with `members[value eq "usr_…"]`. `replace` sets the exact list.
- PATCH answers 204.
- DELETE removes the group and its memberships, and revokes its grants.

**Limits.**

- A request body is at most 1 MiB (413).
- A request may name at most 1,000 member values and 1,000 operations.
- A response returns at most 10,000 members (a 400 `tooMany` asks for
  `excludedAttributes=members`).

**Shutdown.** At shutdown the server writes the unknown-token summaries still pending, before the
database closes, and writes none after.

**Transactions.** Each request is one transaction, with its audit record written last. Writes to
one tenant run one at a time (the principal lock). A refused request (4xx) changes nothing.

## Admin commands (T-103, T-106, T-104)

Until there is an admin UI, the server's entry point has a few admin commands. They read the same
configuration as the server, and accept `--data-dir` as it does (before or after `admin`). They
never start the server or the job queue.

```sh
node apps/server/dist/main.js admin tenant create --name "Acme"            # prints ten_…
node apps/server/dist/main.js admin tenant list
node apps/server/dist/main.js admin scim-token issue --tenant ten_… --name "Entra provisioning" [--days 365]
node apps/server/dist/main.js admin scim-token list --tenant ten_…
node apps/server/dist/main.js admin scim-token revoke --tenant ten_… --id sct_…
node apps/server/dist/main.js admin user grant-admin --tenant ten_… --user <usr_… | email | userName>
node apps/server/dist/main.js admin user revoke-admin --tenant ten_… --user <usr_… | email | userName>
node apps/server/dist/main.js admin user list-admins --tenant ten_…
node apps/server/dist/main.js admin user lock --tenant ten_… --user <usr_… | email | userName>
node apps/server/dist/main.js admin user unlock --tenant ten_… --user <usr_… | email | userName>
node apps/server/dist/main.js admin user create --tenant ten_… --email <email> --name <name>
node apps/server/dist/main.js admin user sign-in-link --tenant ten_… --user <usr_… | email> [--minutes 15]
node apps/server/dist/main.js admin group list --tenant ten_…
node apps/server/dist/main.js admin pack plan --tenant ten_… --file packs/general-business/pack.json
node apps/server/dist/main.js admin pack apply --tenant ten_… --file packs/general-business/pack.json --plan-hash <hash>
node apps/server/dist/main.js admin source list --tenant ten_…
node apps/server/dist/main.js admin source status --tenant ten_… [--source <name>]
node apps/server/dist/main.js admin source run-now --tenant ten_… --source <name>
node apps/server/dist/main.js admin source resume --tenant ten_… --source <name>
node apps/server/dist/main.js admin source confirm-reconcile --tenant ten_… --source <name>
node apps/server/dist/main.js admin source discard-reconcile --tenant ten_… --source <name>
node apps/server/dist/main.js admin source accept-identity --tenant ten_… --source <name>
node apps/server/dist/main.js admin review list --tenant ten_… --user <usr_…|email|userName> [--limit 100]
node apps/server/dist/main.js admin review approve --tenant ten_… --user <usr_…|email|userName> --id rev_… [--replace]
node apps/server/dist/main.js admin review reject --tenant ten_… --user <usr_…|email|userName> --id rev_…
node apps/server/dist/main.js admin review merge --tenant ten_… --user <usr_…|email|userName> --id rev_… --into <value> [--replace]
node apps/server/dist/main.js admin audit verify --tenant ten_…
node apps/server/dist/main.js admin audit export --tenant ten_… [--format ndjson|csv] [--out <new file>] [--actor …] [--action …] [--decision allow|deny] [--client …] [--object …] [--from <time>] [--to <time>]
```

- **The audit log (T-702, T-703, T-1404).** `audit verify` checks a tenant's whole chain: every
  hash and link, and that the columns queries read say what the hashed events say. It prints
  `ok`, the number of events and the head hash (exit 0), or `failed`, how many events check
  out and the first that doesn't (exit 1): any row changed, removed from the middle, inserted
  or moved from another tenant fails it. It writes nothing, so the head stays the chain's until
  the next event. Keep that hash somewhere the database's owner can't write: a chain cut short
  at its end, or rewritten whole, still verifies, and only a head kept elsewhere shows it.
  `audit export` writes the tenant's events, filtered by actor, action, decision, client, object
  and time (`--from` included, `--to` not; a date, or a time with its zone), as NDJSON (each
  line the event exactly as hashed, with its hash) or CSV (for spreadsheets: text a spreadsheet
  would run as a formula gets a leading apostrophe), to standard output or to a new file
  (`--out`: never over an existing file, and its owner's alone where the system has file
  modes; on Windows it has its folder's permissions). An export is itself audited
  (`audit.export`: the filter, the format, how many events) once it ends, so the head moves by
  that one event: the last line's hash of an unfiltered NDJSON export is the head as exported.
  An export that fails, or whose reader goes away part way, is audited as `incomplete`, and its
  file is removed; one that can't be recorded fails, and its file is removed too.
- **The review inbox (T-1403).** Tags that models and AI assistants (the `tag` tool) proposed
  wait for a person. Until the app has an inbox, `review list` prints the open items on files
  one person may tag, an item a line (id, tag, reason, who proposed it, confidence, when,
  `admin` when some decision on it takes a tenant admin, the file's id and title), and
  `review approve`, `reject` and `merge` decide an item as that person. A decision is a person's, so
  `--user` is required (a `usr_…` id, an email or a userName), and that person sees and decides
  only items on files they may tag: they read the file, and own it or hold write access to it.
  Being the operator or a tenant admin gives no more. Two kinds of decision reach further than
  the file and take a tenant admin who may also tag it: approving or rejecting a value the
  vocabulary doesn't have yet (approving it approves it for every file; rejecting it closes
  every open item proposing it), and taking a restriction off the file (rejecting a value that
  sets a visibility or exposure level, or `--replace` of a tighter value). Anyone who may tag
  the file may `merge` a new value `--into` an approved one of the same facet. Approving applies
  the tag, and grants on that tag then count for the file; `--replace` confirms taking another
  value of a single-value facet off the file. Audited as `tag.review`, acted by
  `system:admin-cli` with the reviewer named; a refused decision is audited too (`refusal` says
  why). An item on a file no admin may tag waits until one is given access.

- **Admins.** `user grant-admin` makes the tenant's first admin (the person must exist: provisioned
  over SCIM, or invited), and is the way back in when a tenant has none left. `--user` takes an
  id, or an email or userName exactly one current person has. `list-admins` prints each admin's
  id, how they are one (`role`, `group`, `role+group`), whether it counts now, email and name.
  The admin group (config `auth.adminGroups`) is read from the same config, and `list-admins`
  warns when it makes nobody an admin. Removing the last admin is refused here too.
- **Locking someone out (T-104).** `user lock` is the emergency stop, for a person of either
  source or a service account: their sessions end and their AI clients' grants are revoked at
  once, and every server on the database refuses them from their next request; a service
  account's API keys stop until `user unlock`. Unlocking brings back none of what the lock ended
  (they sign in again; AI clients ask for consent again), and never lifts the identity
  provider's disable. The identity provider's syncs don't lift a lock either: to remove someone
  who left, lock them here and delete them in the identity provider. core/identity's README has
  what each deprovisioning step ends, and when.
- **Local people and sign-in links.** `user create` makes a local member (no identity
  provider), audited `user.create`; `user sign-in-link` prints a one-time link for them (on a
  server with `auth.signInLinks`), audited `sign-in-link.issue` without the token. It works for
  any current person, SCIM-provisioned ones included, and bypasses the identity provider (and its
  MFA): whoever runs admin commands is trusted with every account.
- **Invites and passkeys (T-108).** `user invite` prints an invite link for a local person (on
  a server with `auth.passkeys`), audited `invite.issue` without the token: whoever opens it
  makes a passkey for them and is signed in. Unlike a sign-in link it works through a tunnel or
  proxy, and it is refused for SCIM-provisioned people. `user list-passkeys` shows what a person
  holds; `user remove-passkey` removes one and ends the sessions it signed in.
- **Packs.** `pack plan` prints what applying a pack would change (`!` marks a loosening), its
  warnings and tests, and the plan's hash on standard output; `pack apply` with that hash applies
  exactly that plan (refused when anything changed since, or a test fails), audited `pack.apply`.
  A new tenant is hidden and metadata-only until a pack (the starter pack,
  `packs/general-business`) sets other defaults: until then AI clients get no content.
- **Groups.** `group list` prints each group's id, source, member count, external id and name,
  and marks the configured admin group: the id is what `auth.adminGroups` takes.
- **Connector syncs (T-301).** `source list` prints each source's connector, zone, phase, last
  change and reconcile state (held, deferred, running). A crawl from the beginning that would
  remove a large part of a source (over 25% of it and either over 50 items or half of it, by
  default; or anything when it found nothing) is held, and **while it is held the source doesn't
  sync at all**, deltas included. A delta that would remove as much (counted checkpoint by
  checkpoint) is held the same way (`delete-guard`), with nothing past its last checkpoint
  applied; confirm and discard work on it alike. After checking the source (is the drive mounted? the right
  folder?), either `source confirm-reconcile` (the next sync removes up to the count it held) or
  `source discard-reconcile` (nothing is removed; the source is crawled afresh, and that crawl's
  reconcile is guarded again). `discard-reconcile` also runs a reconcile deferred because a crawl
  met a place it couldn't read. A source whose connector now says it is another one (another
  disk at the folder's path) stops syncing until `source accept-identity`, which starts a crawl
  from the beginning (guarded the same way). All three are audited (`source.confirm-reconcile`,
  `source.discard-reconcile`, `source.accept-identity`), refusals too, and each also lifts a stop
  (below).
- **Scheduled syncs (T-303).** `source list` also says whether each source is scheduled, stopped
  (and why) or never run; `source status` prints each source (or one) in full: its state, last
  run, status and error code, counts and reconcile. A run that failed for good stops the source
  until `source resume` (audited `source.resume`). `source run-now` queues a run (audited
  `source.run-now`; refused for a stopped source): a running server picks it up within seconds,
  and on the embedded database, which the server holds while it runs, the queued run waits for
  the server's next start (which runs every source anyway).

- **Output.** The id or token goes to standard output, and messages go to standard error. The
  exit code is 0 for done, 1 for failed and 2 for misused.
- **Embedded database.** The embedded database (PGlite) belongs to one process at a time. While
  the server runs on it, these commands refuse and say so: stop the server, run the command, and
  start the server again. With PostgreSQL they run beside the server.
- **What a new tenant gets.** `tenant create` makes the tenant row, with the fail-closed
  defaults (hidden, metadata-only), and its principal epoch: nothing else.
- **Audit.** Creating a tenant, issuing or revoking a token, granting or removing an admin, and
  locking or unlocking someone (refusals too) are audited as `system:admin-cli`; a lock's record
  says what it ended.

## One person on one machine: `init --solo` (T-1201)

For a single person trying OpenHoard on their own folders (docs/dogfood.md), the entry point
sets everything up in one command, dispatched like `admin` (options may come before it):

```sh
node apps/server/dist/main.js init --solo [--folder <path>]… [--name <display name>] \
  [--email <email>] [--no-extract] [--no-pin] [--data-dir <dir>]
```

- **What it makes**, in one database transaction: a tenant named after the person, the person (a
  local member, `--name` or the OS user name), their admin role, and the starter pack
  (`packs/general-business` of the clone the server runs from). The pack is applied at once
  (running the command is the consent) and every change it made is printed, each loosening marked
  `!`. Then it creates `<dataDir>/config.json` (whole, owner-only where the OS has modes, and
  never over a file made meanwhile): `publicUrl` where the server will listen
  (`http://127.0.0.1:7420`, or `OPENHOARD_HOST` and `OPENHOARD_PORT`), `signInLinks`, one `fs`
  source per `--folder` (ids `fs-<folder name>`, made unique; zone the folder's name; owner the
  person; `extract` unless `--no-extract`; one folder named twice, through a link or junction
  too, is refused), and
  Claude (`anthropic`, commercial) for summaries with a daily budget of 2,000,000 tokens. The file
  is loaded as the server loads it before the command succeeds. All of it is audited as
  `system:admin-cli` (`tenant.create`, `user.create`, `admin.grant`, `pack.apply`).
- **Defaults.** `--folder`: `<home>/OpenHoard`, made if missing. `--email`:
  `owner@solo.openhoard.invalid`, under the reserved `.invalid` top-level domain (RFC 2606): it
  receives nothing, and core/identity accepts it. The data directory, without `--data-dir` or
  `OPENHOARD_DATA_DIR`: the OS's app-data folder (`%LOCALAPPDATA%\OpenHoard`,
  `~/Library/Application Support/OpenHoard`, `$XDG_DATA_HOME/openhoard` or
  `~/.local/share/openhoard`), never inside a folder it indexes. That default is only the solo
  commands'; the server itself still defaults to `.openhoard` in its working directory, so pass
  the same `--data-dir` when starting it (the commands it prints do).
- **Save dialogs.** Each folder is pinned where Save As dialogs list it (T-1204), unless
  `--no-pin`: Quick Access on Windows (the Shell's own "Pin to Quick access", skipped when it is
  there already), a GTK bookmark on Linux (`$XDG_CONFIG_HOME/gtk-3.0/bookmarks`, added once).
  macOS has no supported way to add to Finder's sidebar, so it says how to drag it there. A
  failure is printed and never fails the setup.
- **Once only, embedded database only.** It refuses when `config.json` exists (add folders to
  `sources` by hand, or use another data directory), and while the server holds the embedded
  database, as admin commands do. It refuses `OPENHOARD_DATABASE_URL` naming PostgreSQL: a
  shared database has no lock keeping a second run out, and a team sets one up by hand. The
  database work is all or nothing and `config.json` is written last. If writing it fails,
  running the same command again picks the tenant up, but only when that is unambiguous: the
  database holds that one tenant, with the same name and nobody but that person. Anything else
  is refused, with what to do: the manual setup, or another data directory.
- **The API key** stays in the environment (`OPENHOARD_MODEL_CLAUDE_API_KEY`): the command says
  whether it is set, and how to set it on this OS, and never asks for it. Without it the server
  starts with a warning and no summaries; search still works by keywords.

### Claude Desktop: `connect claude-desktop` (T-1202)

```sh
node apps/server/dist/main.js connect claude-desktop [--tenant ten_…] [--user <usr_… | email>] \
  [--claude-config <file>] [--data-dir <dir>]
```

After `init --solo` (it needs `config.json` with `auth.signInLinks`, and the same data directory
default), with the server stopped as for admin commands:

1. **Adds `openhoard` to Claude Desktop's config** (`%APPDATA%\Claude\claude_desktop_config.json`,
   `~/Library/Application Support/Claude/claude_desktop_config.json`; Linux has no official Claude
   Desktop, so there `--claude-config` is required), running mcp-remote with the arguments
   docs/dogfood.md gives. Other keys and servers are kept (their entries often hold tokens): a
   linked file is written through to the file it points to, keeping its mode, and a new one is
   owner-only. The first previous file is kept as `.bak`, never overwritten by later runs. A file
   that isn't a JSON object is refused and left alone; an `openhoard` entry that runs something
   else is replaced, and it says so.
2. **Approves the client** in `config.json`: an `auth.clients` entry for the tenant with
   `redirectUris: ["http://127.0.0.1/oauth/callback"]` (mcp-remote's), trust `commercial`, unless
   one is there already. An entry for that redirect with another trust is refused, naming it,
   before anything is written: change it yourself. The rest of the file is kept, and it is loaded
   again before going on. The tenant is the one `sources` names, or `--tenant`. Audited
   `oauth-client.approve` as `system:admin-cli`.
3. **Issues a one-time sign-in link** (60 minutes) for the folders' owner (or `--user`), on
   standard output, audited `sign-in-link.issue` as `user sign-in-link` is.

If a step fails, the files the steps before it wrote are put back as they were (and no approval
is audited), so a failed run leaves no approval behind. Both configs may start with a byte order
mark (Windows editors write one); the server's `config.json` loads with one too.

It then prints what is left: start the server, open the link and press Sign in, restart Claude
Desktop, press Allow on the consent page. Approving `http://127.0.0.1/oauth/callback` trusts
every program on the machine (MCP clients, above): any local program can register the same way
and, once Allowed, read the person's files as them. Running it again changes nothing already
right and issues a new link.

## Reaching it from outside: `tunnel` (T-1205)

claude.ai (web and mobile) and other hosted AI clients need an https address they can reach.
`tunnel` gives a server on this machine one, with no port opened on the network: it runs
Cloudflare's [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
beside the server and tells the server where it is reached. You install cloudflared (Windows:
`winget install Cloudflare.cloudflared`; macOS: `brew install cloudflared`); OpenHoard downloads
nothing and depends on no service of its own.

```sh
openhoard tunnel                                             # a quick tunnel, to try
openhoard tunnel --name home --hostname files.example.com    # your own tunnel, to keep
```

The first time an AI client connects, the page that opens asks you, as the tenant's admin, to
approve it ("MCP clients", above).

It prints the address, the connector address to give the AI client (`<address>/mcp`), and, when
the person who signs in has no passkey for that address, an invite link (alone on standard
output) that makes one. Then it runs until Ctrl+C. Run it instead of starting the server: the
embedded database belongs to one process.

|                    | Quick tunnel                                          | Named tunnel                   |
| ------------------ | ----------------------------------------------------- | ------------------------------ |
| Cloudflare account | none                                                  | yours, with a domain on it     |
| Address            | `https://<words>.trycloudflare.com`, new on every run | the host name you routed to it |
| Sign-in            | a new invite and passkey on every run                 | one passkey, made once         |
| AI clients         | connect again on every run (new address)              | stay connected                 |
| For                | trying it                                             | using it                       |

A named tunnel is set up once, on your own Cloudflare account:

```sh
cloudflared tunnel login
cloudflared tunnel create home
cloudflared tunnel route dns home files.example.com
```

and can be named in config.json, so `openhoard tunnel` alone runs it:

```json
{ "tunnel": { "name": "home", "hostname": "files.example.com" } }
```

**What changes while it runs.** The server is started with `OPENHOARD_TUNNEL_URL`, which for that
run sets `auth.publicUrl` to the tunnel's address, turns one-time sign-in links off (they are for
this machine only) and turns passkeys on ("Built-in accounts", above). config.json isn't
changed: start the server without `tunnel` and it is local again. Two consequences:

- Claude Desktop set up with `connect claude-desktop` uses this machine's address, so it doesn't
  connect while the tunnel runs. Add the connector address to Claude instead.
- Tokens belong to the address they were issued for: clients of the local server and clients of
  the tunnel each consent again when you switch.

**Sign-in.** `--user` (default: the one owner of the tenant's folders) is who the invite is for.
A passkey belongs to the address it was made at, so a quick tunnel needs a new one every run
(passkeys left at old quick-tunnel addresses are removed), and a named tunnel's passkey keeps
working. The invite is good for an hour on a quick tunnel, 7 days on a named one, once. Every
start revokes that person's invites not yet used, so a link an earlier run printed (in a
terminal's history, a log) is no way in afterwards.

**Exposure.** Anyone who has the address reaches the server's public routes: the sign-in page,
the OAuth and MCP endpoints, SCIM, the upload page's script and icons. Everything behind them needs a passkey, an approved client's
token, or a SCIM token. The server must listen on this machine only (`tunnel` refuses any other
`host`); cloudflared connects out. A quick tunnel's address is unguessable but not secret: don't post it.

**Audit.** `tunnel.start` (the address, quick or named) and `invite.issue`, as
`system:admin-cli`.

**Stopping.** Ctrl+C stops both. If cloudflared stops, the server is stopped; if the server
stops, cloudflared is. The server is told to stop through a channel (it closes its database
first, on Windows too). If the `tunnel` command itself is killed outright, the server notices and
stops, but cloudflared may be left running: stop it by hand.

## Adding files: uploads and the share menu (T-1206)

With `uploads` in the config (`init --solo` writes it; `"uploads": {}` is enough), signed-in
members add files to OpenHoard itself, and OpenHoard keeps the bytes: the first content it
holds, in a **managed zone**.

```json
{ "uploads": { "zone": "Uploads", "maxBytes": 104857600 } }
```

- **`/app/`** is a page to pick or drop files on, listing what you added. Install it (the
  browser's menu: Install, or Add to Home screen) and OpenHoard appears in the share menu of
  Android, Windows and ChromeOS: share a photo, a PDF, a link or some text to it from any app.
  Installing needs https, so on a phone that means the tunnel's address (`openhoard tunnel`
  prints the page's address) or your own domain. iOS Safari can't be a share target: there, open
  the page and pick the files.
- **The browser extension** (clients/extension: Chrome, Edge, Firefox) saves the page you are
  on, a PDF or a selection, with the address it came from. It connects as an OAuth client that
  an admin approves and you allow, with the `files:add` scope only: it adds files as you and
  can read nothing. A page saved again is a new version of the same file.
- **`POST /api/uploads?name=<file name>`** takes one file as the request's body, with its type
  as `Content-Type`, from a signed-in member's browser session (201, or 200 when the file was
  there already, with `{object, version, title, size, created, newVersion}`). `GET /api/uploads` lists the caller's own.

The upload API also takes an approved client's token (`Authorization: Bearer`, scope
`files:add`) in place of the session: POST only, with no cookie, for an active member. The
token is checked as the MCP server checks it, when the request arrives and again when the file
is recorded, so revoking the client or the grant stops it there and then; the audit record
names the client.

`X-OpenHoard-Source-URL` (http or https, no credentials; its fragment is dropped) says where
the file is from: kept as the file's link, never fetched. It is a header, not a query
parameter, because addresses can hold secrets and queries are what proxies log. A file sent
again from the same address under the same name is a new version of that file (the person's,
whichever client or session first added it), so `files:add` also adds versions to such files,
and brings back one that was removed.

What happens to an upload:

- It streams to `<dataDir>/blobs` (core/storage), hashed as it arrives; a file over
  `uploads.maxBytes` (100 MiB by default) is refused with 413 and nothing of it is kept.
  Something in front may stop it sooner: Cloudflare's tunnels take about 100 MB a request.
- It is recorded in the zone `uploads.zone` (made in the tenant on its first upload, audited as
  `zone.create` by `system:uploads`), owned by the uploader. **Nobody else reads it** until it
  is shared: an upload comes with no grants.
- It is enriched like any other file (extracted, summarized, embedded, as far as its exposure
  lets its content reach a model), and found with the MCP tools.
- The same file (bytes and name) from the same person is one file: a share tapped twice, or
  sent again after a lost answer, answers with the file there is (brought back if it had been
  removed). The same bytes under another name are another file.
- Every upload is audited as `object.upload`, and so is one refused for who sent it or where
  it would go. (A request that names nobody, is too large or isn't a file is only answered.)

**How a share arrives.** The system posts a form to `/app/share`. The page's service worker
takes it in the browser, keeps the files in a cache of its own and opens the page, which lists
what was shared with **Save** and **Discard**. Save uploads each as above and drops it from the
cache once the server has it. So a share made while signed out waits through the sign-in
instead of being lost, and the server never accepts a form. Shared text or a link with no file
becomes a small `.txt`.

Save is a tap on purpose: any website can post a form to `/app/share` in a browser that has
the page, and the browser gives the worker no way to tell that from the system's share. Sent on
arrival, another site's files would land in your hoard under your name, for models to read.
Shown first, they are named and one tap from gone. What waits in the browser is that browser's,
not an account's: on a shared device, someone who signs in next sees it there.

**Back up `<dataDir>/blobs` with the database and the keys**: for uploads, it is the only copy.

Limits for now: members only (no guests, no service accounts); one file per request, within an hour; no quota per person or tenant, so a
member can fill the disk; bytes whose recording failed, or that a crash left half-written, stay
in the store unreferenced until maintenance learns to remove them; with uploads on, a folder
(`sources`) can't be named `uploads` or sync into the uploads' zone; there is no way yet to
download an upload again from the page (the MCP tools read it).

## Email-in: a mailbox whose mail becomes files (T-1208)

Forward a message to a dedicated mailbox and its text and attachments are files in OpenHoard.
The server reads the mailbox over IMAP every few minutes (on a worker).

```json
{
  "mailIn": [
    {
      "id": "inbox",
      "tenantId": "ten_…",
      "host": "imap.example.com",
      "user": "hoard@example.com",
      "authserv": "mx.example.com"
    }
  ]
}
```

The password is `OPENHOARD_MAIL_<ID>_PASSWORD` in the environment (`OPENHOARD_MAIL_INBOX_PASSWORD`
here), never in config.json. A mailbox with no password set is said in the log and not read.

| Setting              | Default   | What                                                                           |
| -------------------- | --------- | ------------------------------------------------------------------------------ |
| `port`, `secure`     | 993, true | TLS from the first byte. `secure: false` only for a server on this machine     |
| `folder`             | `INBOX`   | The folder read                                                                |
| `zone`               | `Mail`    | The managed zone its files go to, made on the first message                    |
| `everyMinutes`       | 5         | How often it is read                                                           |
| `authserv`           | none      | How a sender is known (below). Required, unless `allowUnauthenticated`         |
| `allowFrom`, `owner` | none      | Senders taken besides the tenant's members, and who owns their mail            |
| `maxBytes`           | 25 MiB    | The largest message taken, and the largest single attachment (100 MiB at most) |

**What a message becomes.** A Markdown file named after its subject (who, when, the text;
an HTML-only message as plain text) and one file for each attachment, as sent. A message
forwarded _as an attachment_ is opened too: its own text and attachments become files. The
files are OpenHoard's to keep (`<dataDir>/blobs`), enriched and found like any upload.

**Whose they are.** The sender's, when the sender's address is an active member's. For a sender
in `allowFrom` (a scanner, a shared address), `owner`'s. Mail from anyone else is refused.
Nobody but the owner reads the files until they share them.

**How the sender is known.** A From line is anyone's to write, so it isn't believed by itself.
Mail providers check a message when it arrives and write what they found in an
`Authentication-Results` header, signed with their own name, at the top of the message (and
are expected to remove any such header that arrives claiming that name). OpenHoard reads the
topmost one with that name, and nothing below one it can't read. `authserv` is that name (open a message in the mailbox and look at
its headers: for Gmail it is `mx.google.com`; a provider with several receiving servers may
need several, as a list). A message is taken only when that header says `dmarc=pass` for the
From address's domain, and the message has a single From line. So a sender whose domain
publishes no DMARC policy (some scanners and devices) is refused, and so is everything when
`authserv` is wrong: check the audit after the first message. A refused message is marked read
and isn't looked at again; mark it unread in the mailbox to have it tried once more. Without a provider that does this, set
`allowUnauthenticated: true`, and then anyone who can reach the mailbox can send as anyone: do
that only for a mailbox nobody outside can send to.

**Handled once.** A message taken or refused is marked read; a refused one is flagged too, so
it stands out in the mailbox. One that couldn't be handled just now stays unread for the next
run, and is given up on (refused as `failed`) after five. A message handled twice (the server stopped in between) is the same files, not twins.
Nothing in a message is followed: no link is fetched, no remote image loaded.

**Audit.** `mail.receive` for every message: allowed, with the files it became, or denied, with
why (`sender`, `unauthenticated`, `too-large`, `no-owner`, `failed`, …). Sender addresses are recorded;
subjects and text are not.

A mailbox whose tenant doesn't exist stops the server at start, naming it.

Limits for now: password sign-in only (an app password for Gmail; Microsoft 365, which needs
OAuth for IMAP, isn't supported yet); the text of an HTML-only message is read up to 2 MB of
HTML; messages are left in the mailbox, read, never moved or
deleted; 50 messages a run and 50 attachments a message; one worker should read a mailbox
(two would do the work twice, though not make twins); a reply isn't tied to the message it
answers.

## Testing with a new Entra tenant (T-102 and T-103 together)

Entra's provisioning service calls the Tenant URL from Microsoft's cloud, so it must be public
HTTPS with a valid certificate. For a trial, put a tunnel in front of the local server (for
example `cloudflared tunnel --url http://127.0.0.1:7420`), and use the tunnel's address as
`publicUrl`.

1. **Configure the server.** Set `auth.publicUrl` in `<dataDir>/config.json` to the public
   address. Build (`pnpm build`) and create the tenant and a token (with the server stopped, on
   PGlite):

   ```sh
   node apps/server/dist/main.js admin tenant create --name "Contoso trial" --data-dir .openhoard
   node apps/server/dist/main.js admin scim-token issue --tenant ten_… --name "Entra provisioning" --data-dir .openhoard
   ```

2. **Create the enterprise app.** In the Entra admin center (entra.microsoft.com), go to
   **Entra ID** › **Enterprise apps** › **New application** › **Create your own application**.
   Name it "OpenHoard", choose _Integrate any other application you don't find in the gallery
   (Non-gallery)_, and create it.

3. **Connect provisioning.** In the app, open **Provisioning** (**New configuration**, or
   **Get started**). Set Mode to **Automatic**, then fill in **Admin Credentials**:
   - Tenant URL: `https://<public host>/scim/v2`. Adding `?aadOptscim062020` is optional: both
     request styles work.
   - Secret Token: the `ohscim.…` token.

   **Test Connection** should succeed. Entra asks for a random userName and gets 200 with an
   empty list.

4. **Map the user attributes.** Under **Mappings** › **Provision Microsoft Entra ID Users**:
   - **Change `externalId` to `objectId`.** Entra's default is `mailNickname`, and with it people
     aren't matched on their first sign-in. Edit the `externalId` row and set the source
     attribute to `objectId`.
   - Keep `userName` ← `userPrincipalName`, the matching attribute.
   - Keep `active` ← `Switch([IsSoftDeleted], , "False", "True", "True", "False")`.
   - Keep `emails[type eq "work"].value` ← `mail`. A new tenant's users often have no mail;
     OpenHoard then uses the UPN.
   - Keep `displayName` ← `displayName`, `name.givenName` ← `givenName`, and
     `name.familyName` ← `surname`.
   - Optional: `userType` ← `userType`, so Entra guests become OpenHoard guests.
   - Delete the other rows (title, phone numbers, addresses, the enterprise extension,
     proxy-addresses). OpenHoard drops them anyway, and less data flows.

5. **Map the group attributes.** Under **Provision Microsoft Entra ID Groups**, keep
   `displayName` ← `displayName`, `externalId` ← `objectId` and `members` ← `members`.

6. **Choose who is provisioned.** Under **Settings**, set Scope to _Sync only assigned users and
   groups_. Assign a test user (and a group) under **Users and groups**. Then either use
   **Provision on demand** for one user, or set **Provisioning Status** to **On**. After the
   first cycle, Entra syncs every 40 minutes.

7. **Set up sign-in.** Add the tenant's provider to `auth.providers`. Use the same enterprise
   app's registration (**App registrations** › the app), or a new one. Add a Web redirect URI
   `https://<public host>/auth/callback/entra`, and create a client secret.

   ```json
   {
     "auth": {
       "publicUrl": "https://<public host>",
       "providers": [
         {
           "id": "entra",
           "label": "Contoso (Microsoft)",
           "kind": "entra",
           "tenantId": "ten_…",
           "issuer": "https://login.microsoftonline.com/<directory (tenant) id>/v2.0",
           "clientId": "<application (client) id>"
         }
       ]
     }
   }
   ```

   Start the server with `OPENHOARD_AUTH_ENTRA_CLIENT_SECRET=<secret>`. The `entra` kind matches
   a first sign-in's `oid` claim to the SCIM `externalId`, which is why step 4 maps `objectId`.

8. **Try it.**
   - Sign in at `https://<public host>/auth/login/entra`, then check `GET /auth/me`.
   - Block the user's sign-in in Entra, or remove them from the app, and provision on demand:
     Entra sends `active: false`, and the session ends on the next request.
   - Deleting a user in Entra first soft-deletes them (`active: false`). The permanent deletion
     sends DELETE, which retires them.
   - `node apps/server/dist/main.js admin scim-token list --tenant ten_…` shows when the token
     was last used.
   - Make the test account the tenant's first admin (T-106) with
     `admin user grant-admin --tenant ten_… --user <its UPN>` (server stopped, on PGlite), then
     `GET /api/admin/admins` after signing in. Or assign an Entra group to the app, provision
     it, find its `grp_…` id with `admin group list`, and name that in `auth.adminGroups`: its
     members are admins.
   - The audit log has every request.

Sources relied on for Entra's behaviour:

- Microsoft Learn: [Tutorial: Develop and plan provisioning for a SCIM
  endpoint](https://learn.microsoft.com/en-us/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups).
  It covers the request and response shapes, the default mappings, Test Connection, and
  `excludedAttributes=members`.
- Microsoft Learn: [Known issues and resolutions with SCIM 2.0 protocol
  compliance](https://learn.microsoft.com/en-us/entra/identity/app-provisioning/application-provisioning-config-problem-scim-compatibility).
  It covers capitalized ops, `active` as a string, value objects without a path, and removing
  members by path filter (`aadOptscim062020`).
- Microsoft Learn: [Configure automatic user provisioning to Microsoft Entra
  apps](https://learn.microsoft.com/en-us/entra/identity/app-provisioning/configure-automatic-user-provisioning-portal),
  for the admin center steps and the 40-minute cycle.
- Microsoft Q&A: [SCIM validator "Filter for an existing user with a different
  case"](https://learn.microsoft.com/en-us/answers/questions/5580319/scim-validator-fails-filter-for-an-existing-user-w).
  `userName` is compared without regard to case, and `externalId` exactly.
- [RFC 7643](https://www.rfc-editor.org/rfc/rfc7643) and
  [RFC 7644](https://www.rfc-editor.org/rfc/rfc7644), for the schemas, filters, PATCH, errors and
  paging.
