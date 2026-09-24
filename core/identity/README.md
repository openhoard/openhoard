# core/identity

Part of the OpenHoard trusted core. See [../README.md](../README.md) and
[docs/architecture.md](../../docs/architecture.md).

The tenant's people and groups, and who a signed-in person is to `authorize()`. Other packages
ask here, never the `users`, `groups` and `group_members` tables in core/db.

- [`directory.ts`](src/directory.ts): users, groups, membership, `resolvePrincipal()` (T-101).
- [`principals.ts`](src/principals.ts): namespaced principal sets for search filters.

## Sources

People and groups come from two places:

- **The identity provider, over SCIM** (Entra ID, Okta, Google; T-103). The provider is the
  source of truth.
- **OpenHoard itself**, for teams without one: invitations (T-108) and groups managed in the
  admin UI (T-110).

Each user and group records its `source`, and only that source may change it. A SCIM group
can't be edited in OpenHoard, where the next sync would silently undo the edit, and SCIM can't
touch local groups.

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
never matches on email, because an email is a label a person can change.

`resolvePrincipal()` returns what `authorize()` needs: groups, every grant held directly or
through a group, guest status, and whether the user is active. A disabled user comes back
inactive, and `authorize()` denies them. Caching arrives with T-107.

Emails are still unique among current users, keyed by `emailKey()`:

- trimmed, Unicode NFC, with the local part in lower case;
- the domain in lower-case ASCII (IDNA).

Refused: invisible characters, characters that fold into ASCII (the Kelvin sign, fullwidth
letters), and domains that aren't plain host names (percent-escapes, IP addresses, trailing
dots).

Group membership is direct for now. Nested groups come with SCIM.
