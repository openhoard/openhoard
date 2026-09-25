# apps/server

The OpenHoard gateway: the HTTP API, and later the MCP server. See
[docs/architecture.md](../../docs/architecture.md).

```sh
pnpm --filter @openhoard/server dev    # watches src/, data in ../../.openhoard
```

## Configuration

Values are read from, in order: the environment (`OPENHOARD_*`), then
`<dataDir>/config.json`, then the defaults (`src/config.ts`). The schema is strict, so an unknown
key is an error.

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

**Provider kinds:**

| Kind      | Issuer                                                                   | First sign-in matches                 |
| --------- | ------------------------------------------------------------------------ | ------------------------------------- |
| `entra`   | `https://login.microsoftonline.com/<directory id>/v2.0` (never `common`) | `oid` to the SCIM user's external id  |
| `google`  | `https://accounts.google.com`                                            | nobody new (invitations, T-108/T-109) |
| `generic` | any issuer (https, or http on this machine only)                         | `externalIdClaim`, if set             |

After the first sign-in, only the linked (issuer, subject) counts. Sign-in never matches on
email and never creates anyone (core/identity `signIn()`).

**Sessions.** A session is a row in `sessions`, and the cookie holds an opaque token of which
only a hash is stored.

- The cookie is HttpOnly and SameSite=Lax. Over https it is also Secure and named
  `__Host-oh_session`.
- A session ends after `sessionIdleMinutes` unused (default 720) or `sessionMaxHours` (default
  168, at most 720), at sign-out, or when the person is locked or retired.
- A state-changing request that carries the cookie must come from `publicUrl`'s origin (the
  Origin header), or it is refused (403).

**Routes:**

| Route                     | What it does                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /auth/providers`     | The providers to offer on a sign-in page.                                                  |
| `GET /auth/login/<id>`    | Starts sign-in. `?return_to=/path` sets where to come back to (only paths on this server). |
| `GET /auth/callback/<id>` | The provider sends the browser back here.                                                  |
| `GET /auth/me`            | Who is signed in (401 if nobody).                                                          |
| `POST /auth/logout`       | Ends the session (204).                                                                    |

Every sign-in is written to the audit log (`auth.sign-in`), whether it was allowed or refused, and
so is every sign-out (`auth.sign-out`). A refused person nobody provisioned is logged as
`oidc:<id>` with the subject the provider gave, so an admin can link them.

Later routes use `requireSignIn` and `c.get("auth")`: the tenant, the session and the
principal.
