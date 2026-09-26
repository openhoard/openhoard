# apps/server

The OpenHoard gateway: the HTTP API and the MCP server. See
[docs/architecture.md](../../docs/architecture.md).

```sh
pnpm --filter @openhoard/server dev    # watches src/, data in ../../.openhoard
```

## Configuration

Values are read from, in order: the environment (`OPENHOARD_*`), then
`<dataDir>/config.json`, then the defaults (`src/config.ts`). The schema is strict, so an unknown
key is an error.

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
| `google`  | `https://accounts.google.com`                                            | nothing (invitations, T-108/T-109)       |
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

Every sign-in is written to the audit log (`auth.sign-in`), whether it was allowed or refused, and
so is every sign-out (`auth.sign-out`). A refused person nobody provisioned is logged as
`oidc:<id>` with the subject the provider gave, so an admin can link them.

Later routes use `requireSignIn` and `c.get("auth")`: the tenant, the session and the
principal.

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

**Scopes:** `files:read` (search, read, open) and `files:tag` (propose tags). They become the
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
- **Tools:** `whoami` (the person, the client's id and trust, the scopes granted). `find`, `recent`
  and `describe` come with T-802. A tool is an `McpTool` (src/mcp.ts): it runs with the request's
  caller and an activity buffer.
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
   admin. Approve it with the admin API (`GET /api/admin/clients`, then
   `POST /api/admin/clients/<key>/approve`), or in `auth.clients` (above), and connect again.

Quick tunnels are for testing: the URL changes on every run, and there is no uptime guarantee.
OpenHoard depends on no domain of ours. A self-hoster serves it at their own `publicUrl`, behind
their own proxy or tunnel. A tunnel plugin running on the self-hoster's own Cloudflare account may
come later.

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
node apps/server/dist/main.js admin group list --tenant ten_…
node apps/server/dist/main.js admin source list --tenant ten_…
node apps/server/dist/main.js admin source confirm-reconcile --tenant ten_… --source <name>
node apps/server/dist/main.js admin source discard-reconcile --tenant ten_… --source <name>
node apps/server/dist/main.js admin source accept-identity --tenant ten_… --source <name>
```

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
  `source.discard-reconcile`, `source.accept-identity`), refusals too.

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
