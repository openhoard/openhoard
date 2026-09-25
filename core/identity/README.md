# core/identity

Part of the OpenHoard trusted core. See [../README.md](../README.md) and
[docs/architecture.md](../../docs/architecture.md).

The tenant's people and groups, and who a signed-in person is to `authorize()`. Other packages
ask here, never the `users`, `groups` and `group_members` tables in core/db.

- [`directory.ts`](src/directory.ts): users, groups, membership, `resolvePrincipal()` (T-101).
- [`principal-cache.ts`](src/principal-cache.ts): `PrincipalCache`, `resolvePrincipal()` with a
  cache in front (T-107).
- [`api-keys.ts`](src/api-keys.ts): service accounts' API keys (T-111).
- [`sessions.ts`](src/sessions.ts): signing in and sessions (T-102).
- [`scim-tokens.ts`](src/scim-tokens.ts): each tenant's SCIM bearer tokens (T-103).

## Sources

People and groups come from two places:

- **The identity provider, over SCIM** (Entra ID, Okta, Google; T-103). The provider is the
  source of truth.
- **OpenHoard itself**, for teams without one: invitations (T-108) and groups managed in the
  admin UI (T-110).

Each user and group records its `source`, and only that source may change it. A SCIM group
can't be edited in OpenHoard, where the next sync would silently undo the edit, and SCIM can't
touch local groups.

An `externalId` is the identity provider's id, so only SCIM users and groups have one: it is
refused for local ones (and the database checks it), and `findUserByExternalId()` and
`findGroupByExternalId()` look among SCIM records only.

A user is active unless something stops them. There are three stops, and they are independent:

| Stop             | Set and lifted by                            | For                           |
| ---------------- | -------------------------------------------- | ----------------------------- |
| Lock             | an admin or the system                       | an investigation, emergencies |
| Provider disable | SCIM, for SCIM users                         | the provider deactivated them |
| Retirement       | SCIM for SCIM users, an admin for local ones | they left: final              |

A sync that re-activates a user doesn't lift an admin's lock. Lifting a lock doesn't bring back
someone the provider deactivated. To remove a SCIM user for good, lock them and delete them in
the identity provider; otherwise the next sync would create them again.

## Principals

A user is `user:<id>` and a group `group:<id>`, using OpenHoard's ids (`usr_…`, `grp_…`), so
renaming either never breaks a grant. Grants need a current user or an existing group, and
deleting a group revokes its grants.

Retiring a user revokes their grants, removes them from every group and unlinks their sign-in
identities. It also frees their email for someone new, who gets a new id and inherits nothing.
The row stays, because users own objects and appear in audit.

## Sign-in

Sign-in matches an (issuer, subject) pair: `linkIdentity()` and `findUserByIdentity()`. It
never matches on email, because an email is a label a person can change, and it never returns
a retired user.

`signIn()` (in [`sessions.ts`](src/sessions.ts), T-102) is what the server calls with the claims
of a checked ID token:

- A linked (issuer, subject) finds its user.
- The first time, a provider may pass `externalId` (Entra's `oid`). It is matched once to a SCIM
  user's external id, and the pair is then linked, so from then on only the pair counts.
- Anyone else is refused (`unknown`), as is a locked, disabled or retired person (`inactive`).
  Signing in creates nobody: people come from SCIM (T-103) or invitations (T-108).

Sessions:

- `startSession()` returns `ohs.<tenant id>.<session id>.<secret>`, shown once. Only a SHA-256 of
  the secret is stored, with an idle limit and an absolute expiry (at most 30 days). A service
  account never gets a session.
- `checkSession()` reads the session on every request. It fails a revoked, expired or idle one,
  and one whose person is inactive, so a lock takes effect on the next request.
- `revokeSession()` is sign-out. `revokeUserSessions()` ends all of a person's sessions (for
  T-104). Locking, disabling and retiring a person end their sessions for good, so unlocking
  doesn't bring one back. `unlinkIdentity()` ends the sessions that identity signed in, and
  `startSession()` refuses a person locked since `signIn()` found them.
- `checkSession()` writes nothing. Run it in a read-only snapshot, where the principal cache
  serves it, and call `touchSession()` when it says `stale`.
- `localPath()` normalizes a return path the way a browser would, and refuses anything that
  would leave this server.

`resolvePrincipal()` returns what `authorize()` needs: groups, every grant held directly or
through a group, guest status, and whether the user is active. A disabled user comes back
inactive, and `authorize()` denies them. Its `at` applies to grants only (which were live
then); memberships, kind and stops are always the current ones.

## OAuth for MCP clients

[`oauth.ts`](src/oauth.ts) (T-105) is the core of the authorization server. The HTTP side is in
apps/server.

- `noteClient()` records a client a tenant's person tried; it starts pending.
  `decideClient()` is an admin's approval (with a trust label) or refusal, and a refusal revokes
  the client's grants.
- `issueCode()` needs an approved client and an active person. `redeemCode()` checks the client,
  the redirect URI, the resource and PKCE (S256), and works once. A code presented again revokes
  its grant.
- `refreshGrant()` rotates the refresh token, and the previous one presented again revokes the
  grant. It can narrow the scopes of the new access token.
- `checkAccessToken()` writes nothing, like `checkSession()`. It returns the principal, with the
  grant's scopes as its credential scope, and the client with its trust label.
- `revokeGrant()`, `revokeUserGrants()` and `revokeByToken()` (RFC 7009) end grants, and
  `pruneOAuth()` clears ended ones. Locking, disabling and retiring a person revoke their grants.
- Tokens are `ohac.`, `ohrt.` and `ohat.<tenant>.<id>.<secret>`, and only their hashes are
  stored.
- A `TrustResolver` lets the server's config approve a client without a database decision. It
  never overrides a refusal.

## The principal cache

Every request needs its caller's principal, so `PrincipalCache.resolve()` keeps them. It is
invalidated by the database, so it holds across processes: every change `resolvePrincipal()`
reads (grants, memberships, a user's kind, lock, provider disable or retirement) bumps the
tenant's principal epoch in the writing transaction, by trigger. An entry is used only by a
snapshot that sees the epoch it was resolved at, so a change reaches every process as soon as a
snapshot shows it committed. Grants are resolved as of the moment the epoch is read, not the
transaction's start, so a revocation the snapshot shows is never counted. An entry also ends
when its soonest grant expires, and after `ttlMillis` (60 s) at most; the least recently used go
past `maxEntries` (10,000).

Only read-only snapshot transactions (`VIEW_TRANSACTION`: REPEATABLE READ or SERIALIZABLE) use
or fill it. A transaction that writes may see its own uncommitted changes and roll back, and a
READ COMMITTED one reads the epoch and the rows in different snapshots; either resolves afresh
and keeps nothing. Invalidation is tenant-wide: any grant or membership change, even a
one-object share, drops the tenant's entries.

Every function here that changes a principal takes the tenant's epoch lock first (core/db
`lockPrincipals()`), before its row locks, so two such transactions can't deadlock on the
triggers' bump. A new column `resolvePrincipal()` reads needs its trigger too (core/db
migration 0021).

Emails are still unique among current users, keyed by `emailKey()`:

- trimmed, Unicode NFC, with the local part in lower case;
- the domain in lower-case ASCII (IDNA).

Refused: invisible characters, characters that fold into ASCII (the Kelvin sign, fullwidth
letters), and domains that aren't plain host names (percent-escapes, IP addresses, trailing
dots).

Group membership is direct. A SCIM group's members are SCIM users: `addMember()` as `scim`
refuses a local user (an invited guest, a break-glass admin) as it refuses a service account,
since what the identity provider's groups hold would reach people it can't see or take it from.
The SCIM endpoint also refuses a group as a member (Entra doesn't
provision nested groups either); nesting would need resolution through groups first.

A SCIM user also keeps its `userName` (the identity provider's sign-in name, Entra's UPN) as
sent, and its given and family names. `userName` is for SCIM users only, unique among current
users compared as `userNameKey()` (NFC, lower case: SCIM compares it without regard to case), and
freed by retirement like the email. `findUserByUserName()` finds one. `listUsers()` and
`listGroups()` return a page of current users or groups matching what SCIM filters on, with the
total; `updateGroup()` changes a group's name or external id.

## SCIM tokens

The SCIM endpoint (apps/server, T-103) authenticates the tenant's identity provider with a
token of the tenant's own, not an API key: it acts as the provider (`scim:<token id>`, the actor
the directory lets manage SCIM users and groups), not as a principal with grants.

- `issueScimToken()` returns `ohscim.<tenant id>.<token id>.<secret>` once; only a SHA-256 of
  the secret is kept. The tenant in the token says which tenant's transaction to check it in, so
  the endpoint is one URL for all tenants (`parseScimToken()`).
- A token expires within a year (`expiresAt`, or `days` by the database's clock) and can be
  revoked (`revokeScimToken()`). `listScimTokens()` shows them without secrets, with when each
  was last used (`touchScimToken()`, at most once a minute).
- `checkScimToken()` reads the token on every request, so a revoked or expired one fails on the
  next, compares the secret in constant time, and for a refused attempt on a real token id says
  why (`wrong-secret`, `revoked`, `expired`), for the audit log only. The server audits every
  use, allowed or refused, and limits failed attempts.

## Service accounts and API keys

A service account (`createServiceAccount()`, kind `service`) is a machine: CI, a connector, a
script. It has no email, never signs in, never becomes a person and never joins a group the
identity provider manages; the database holds all of it (triggers, and a foreign key tying keys
to the `service` kind). It holds grants like anyone, and like a guest it never discovers what it
can't read. It acts only through API keys, which are never issued to people: a service
account's principal without a key's scope is refused everything (`core/scope`).

- `issueApiKey()` returns `ohk.<key id>.<secret>` once. Only a SHA-256 of the secret is kept.
- Every key is scoped to some actions and zone kinds (and, optionally, zone ids), carried on the
  principal into `authorize()`, where `core/scope` forbids the rest. A key that searches must
  also read, since listings decide by `read`. It expires within a year and can be revoked
  (`revokeApiKey()`); retiring the service account revokes its keys, and locking it stops them.
- `authenticateApiKey()` reads the key on every request, so a revocation counts from the next
  one, and answers null alike for anything but a valid key, comparing the secret in constant
  time. `checkApiKey()` gives the same answer and, for a refused attempt on a real key id, why
  (wrong secret, revoked or expired, inactive account), for the server's audit.

What the server must do with them (T-111's "every use is audited" is the server's to meet):

1. Choose the tenant before authenticating: the key doesn't carry it.
2. Authenticate every request, and never keep a `KeyUse` longer than the request.
3. Append `keyUseRecord()` (core/audit `appendAudit()`) for every use, allowed or denied, and
   fail the request if the append fails; audit the refusals `checkApiKey()` reports, issuing,
   revoking and new service accounts the same way.
4. Never rebuild a service account's principal from its id (it would have no scope, and be
   refused everything); pass the `KeyUse` principal on.
5. Apply the scope, and the no-discovery rule for service accounts, in search's SQL filter.
6. Rate-limit authentication attempts.
