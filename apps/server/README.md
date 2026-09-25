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
exposure rules check (T-604).

- Until T-106 adds approval in the app, list approved clients in the config:

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
  is told it is waiting.
- A refused client is turned away, and its grants are revoked.
- Taking a client out of the config stops its tokens.
- A trust label in the config wins over one given in the app, and a refusal in the app wins over
  the config.
- At most 200 pending clients are recorded per tenant.
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
