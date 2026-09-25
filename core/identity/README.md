# core/identity

Part of the OpenHoard trusted core. See [../README.md](../README.md) and
[docs/architecture.md](../../docs/architecture.md).

The tenant's people and groups, and who a signed-in person is to `authorize()`. Other packages
ask here, never the `users`, `groups` and `group_members` tables in core/db.

- [`directory.ts`](src/directory.ts): users, groups, membership, `resolvePrincipal()` (T-101).
- [`principal-cache.ts`](src/principal-cache.ts): `PrincipalCache`, `resolvePrincipal()` with a
  cache in front (T-107).
- [`api-keys.ts`](src/api-keys.ts): service accounts' API keys (T-111).

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

`resolvePrincipal()` returns what `authorize()` needs: groups, every grant held directly or
through a group, guest status, and whether the user is active. A disabled user comes back
inactive, and `authorize()` denies them. Its `at` applies to grants only (which were live
then); memberships, kind and stops are always the current ones.

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

Group membership is direct for now. Nested groups come with SCIM.

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
