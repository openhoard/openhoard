import { appendAudit, type AuditRecord } from "@openhoard/core-audit";
import type { Database, Tx } from "@openhoard/core-db";
import {
  approvedTrust,
  checkAccessToken,
  decideClient,
  getUser,
  IdentityError,
  issueCode,
  noteClient,
  oauthTokenTenant,
  parseScopes,
  PrincipalCache,
  redeemCode,
  refreshGrant,
  revokeByToken,
  userPrincipal,
  type GrantResult,
  type OAuthScope,
  type TrustResolver,
} from "@openhoard/core-identity";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { Logger } from "pino";
import { RETURN_MAX, type AuthEnv } from "../auth.js";
import type { AuthConfig } from "../config.js";
import { seal, unseal } from "../login-state.js";
import { configuredTrust, listedIn } from "./allowlist.js";
import {
  ClientError,
  ClientResolver,
  matchRedirect,
  register,
  type MetadataFetcher,
  type ResolvedClient,
} from "./clients.js";
import { consentPage, errorPage, pendingPage, type Page } from "./pages.js";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";

/*
 * OpenHoard's OAuth 2.1 authorization server for MCP clients (T-105), per the MCP authorization
 * spec: the server is both the authorization server and the resource server (`/mcp`).
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]  RFC 9728: where to get tokens for /mcp
 *   GET  /.well-known/oauth-authorization-server      RFC 8414
 *   POST /oauth/register                               RFC 7591, public clients, stateless
 *   GET  /oauth/authorize                              sign in (T-102), then consent
 *   POST /oauth/authorize                              the person's answer → a code
 *   POST /oauth/token                                  authorization_code, refresh_token
 *   POST /oauth/revoke                                 RFC 7009
 *
 * - Only the S256 PKCE method, only public clients, only codes; tokens are bound to one resource
 *   (RFC 8707), `<publicUrl>/mcp`, and nothing else is accepted.
 * - Errors before the client and its redirect URI check out are shown here, never redirected
 *   (no open redirect); after, they go back to the client with `state` and `iss` (RFC 9207).
 * - A client needs an admin's approval in the person's tenant: in the app (the admin API,
 *   T-106) or in the config (`auth.clients`); allowlist.ts has which wins. Until then the person
 *   sees that it waits, and the tenant has a pending request for the admin. The check is made
 *   again on every code, token and MCP request, so a revocation counts from the next one.
 * - The consent form carries the checked request sealed and bound to the session, for ten
 *   minutes; the session cookie's Origin check covers the POST.
 * - Every authorization and token decision is audited.
 */

export interface OAuthDeps {
  auth: AuthConfig;
  db: Database;
  key: Buffer;
  log?: Logger;
  /** Fetches client metadata documents; tests pass their own. */
  fetchMetadata?: MetadataFetcher;
}

const CONSENT_TTL_MS = 10 * 60 * 1000;
const CONSENT = "openhoard/oauth-consent/v1";
const DEFAULT_SCOPES: OAuthScope[] = ["files:read"];
const SNAPSHOT = { isolationLevel: "repeatable read", accessMode: "read only" } as const;
const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" } as const;

interface ConsentRequest {
  tenantId: string;
  sessionId: string;
  userId: string;
  clientRef: string;
  clientKey: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: OAuthScope[];
  resource: string;
  state: string | null;
  expiresAt: number;
}

/** A canonical resource URI: lower-case scheme and host, no trailing slash; null with a fragment. */
export function canonicalResource(uri: string): string | null {
  try {
    const u = new URL(uri);
    if (u.hash !== "" || uri.includes("#")) return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return null;
  }
}

export function mountOAuth(
  app: Hono<AuthEnv>,
  deps: OAuthDeps,
): { requireBearer: (scope?: OAuthScope) => MiddlewareHandler<AuthEnv> } {
  const { auth, db, key, log } = deps;
  const issuer = new URL(auth.publicUrl).origin;
  const resource = `${issuer}/mcp`;
  const resourceMetadata = `${issuer}/.well-known/oauth-protected-resource/mcp`;
  const clients = new ClientResolver(deps.fetchMetadata);
  const cache = new PrincipalCache();

  /** What the config says about a client in a tenant (allowlist.ts has the precedence). */
  const configured = (tenantId: string): TrustResolver => configuredTrust(auth, tenantId);

  const audit = (tx: Tx, tenantId: string, record: AuditRecord) =>
    appendAudit(tx, tenantId, record);

  const show = (c: Context, p: Page, status: 200 | 400 | 403 = 200) => {
    c.header("content-security-policy", p.csp);
    c.header("cache-control", "no-store");
    return c.html(p.html, status);
  };

  /** Sends the browser back to the client with an error, `state` and `iss`. */
  const backWith = (c: Context, redirectUri: string, params: Record<string, string | null>) => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries({ ...params, iss: issuer })) {
      if (v !== null) u.searchParams.set(k, v);
    }
    c.header("cache-control", "no-store");
    return c.redirect(u.href, 302);
  };

  // Clients in a browser (the MCP Inspector) read metadata and call these across origins, never
  // with the person's cookies.
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/*",
    "/.well-known/oauth-authorization-server",
    "/oauth/token",
    "/oauth/register",
    "/oauth/revoke",
  ]) {
    app.use(path, cors({ origin: "*", allowHeaders: ["content-type", "mcp-protocol-version"] }));
  }

  // Small bodies only, and the media type each endpoint takes: never multipart (files), which
  // parseBody() would buffer, before anyone is known.
  app.use(
    "/oauth/*",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) =>
        c.json({ error: "invalid_request", error_description: "the body is too large" }, 413),
    }),
  );
  for (const [path, type] of [
    ["/oauth/token", "application/x-www-form-urlencoded"],
    ["/oauth/revoke", "application/x-www-form-urlencoded"],
    ["/oauth/authorize", "application/x-www-form-urlencoded"],
    ["/oauth/register", "application/json"],
  ] as const) {
    app.on("POST", path, async (c, next) => {
      const given = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
      if (given !== type) {
        return c.json({ error: "invalid_request", error_description: `the body is ${type}` }, 415);
      }
      await next();
    });
  }

  // --- Discovery -------------------------------------------------------------------------------

  const protectedResource = (c: Context) =>
    c.json({
      resource,
      authorization_servers: [issuer],
      scopes_supported: ["files:read", "files:tag"],
      bearer_methods_supported: ["header"],
      resource_name: "OpenHoard",
    });
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["files:read", "files:tag"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    }),
  );

  // --- Registration ----------------------------------------------------------------------------

  app.post("/oauth/register", async (c) => {
    let body: unknown;
    try {
      const text = await c.req.text();
      if (text.length > 16384) throw new ClientError("registration too large");
      body = JSON.parse(text) as unknown;
    } catch (err) {
      const message = err instanceof ClientError ? err.message : "the body is JSON";
      return c.json({ error: "invalid_client_metadata", error_description: message }, 400);
    }
    try {
      return c.json(register(body as Record<string, unknown>), 201, NO_STORE);
    } catch (err) {
      if (!(err instanceof ClientError)) throw err;
      const error = /redirect/.test(err.message)
        ? "invalid_redirect_uri"
        : "invalid_client_metadata";
      return c.json({ error, error_description: err.message }, 400);
    }
  });

  // --- Authorization ---------------------------------------------------------------------------

  app.get("/oauth/authorize", async (c) => {
    const q = c.req.query();
    // Signed in first: nothing (not even fetching a client's document, or an error redirect)
    // happens for someone nobody knows.
    const signedIn = c.get("auth");
    if (!signedIn) {
      const here = new URL(c.req.url);
      const path = `${here.pathname}${here.search}`;
      if (path.length > RETURN_MAX) return show(c, errorPage("The request is too long."), 400);
      return c.redirect(`/auth/sign-in?return_to=${encodeURIComponent(path)}`, 302);
    }
    let client: ResolvedClient;
    try {
      client = await clients.resolve(
        q.client_id,
        `${signedIn.tenantId}/${signedIn.principal.userId}`,
      );
    } catch (err) {
      log?.info({ err }, "oauth: unknown client");
      const message = err instanceof ClientError ? err.message : "the client can't be verified";
      return show(c, errorPage(`Unknown client: ${message}.`), 400);
    }
    const redirectUri = matchRedirect(client, q.redirect_uri);
    if (!redirectUri) {
      return show(c, errorPage("The redirect URI isn't one this client registered."), 400);
    }
    const { tenantId } = signedIn;
    const userId = signedIn.principal.userId;
    // The config's approval is known before anything is recorded: it doesn't wait on the counts.
    const inConfig = listedIn(auth, tenantId, client) !== undefined;
    const { noted, trust, user } = await db.withTenant(tenantId, async (tx) => {
      const n = await noteClient(
        tx,
        tenantId,
        {
          kind: client.kind,
          clientRef: client.clientRef,
          name: client.name,
          redirectUris: client.redirectUris,
        },
        userPrincipal(userId),
        { approved: inConfig },
      );
      const said = n ? configured(tenantId)(n) : undefined;
      // Keep the config's approval in the database too, for the admin's list (T-106).
      const decided =
        n && said !== undefined && said !== null && n.status === "pending"
          ? await decideClient(
              tx,
              tenantId,
              n.clientKey,
              { approve: true, trust: said },
              "system:config",
            )
          : n;
      const who = await getUser(tx, tenantId, userId);
      const t = approvedTrust(decided, configured(tenantId));
      if (t === null) {
        await audit(tx, tenantId, {
          actor: userPrincipal(userId),
          action: "oauth.authorize",
          decision: "deny",
          client: client.clientRef,
          detail: { reason: decided?.status === "refused" ? "client-refused" : "client-pending" },
        });
      }
      return { noted: decided, trust: t, user: who };
    });
    // Until an admin approved the client, nothing goes back to it (no redirect for anyone's URL).
    if (trust === null) {
      if (noted?.status === "refused") {
        return show(c, errorPage("Your admin refused this client."), 403);
      }
      return show(c, pendingPage(client.name, client.clientRef), 403);
    }
    const state = q.state ?? null;
    const back = (error: string, description: string) =>
      backWith(c, redirectUri, { error, error_description: description, state });
    if (q.response_type !== "code") return back("unsupported_response_type", "only code");
    if (q.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge ?? "")) {
      return back("invalid_request", "PKCE with S256 is required");
    }
    if (q.resource !== undefined && canonicalResource(q.resource) !== resource) {
      return back("invalid_target", `tokens are for ${resource} only`);
    }
    const scopes = q.scope === undefined || q.scope === "" ? DEFAULT_SCOPES : parseScopes(q.scope);
    if (!scopes) return back("invalid_scope", "scopes are files:read and files:tag");
    if (state !== null && state.length > 1024) return back("invalid_request", "state is too long");
    const request: ConsentRequest = {
      tenantId,
      sessionId: signedIn.sessionId,
      userId,
      clientRef: client.clientRef,
      clientKey: client.clientKey,
      redirectUri,
      codeChallenge: q.code_challenge as string,
      scopes,
      resource,
      state,
      expiresAt: Date.now() + CONSENT_TTL_MS,
    };
    return show(
      c,
      consentPage({
        clientName: client.name,
        clientRef: client.clientRef,
        redirectUri,
        scopes,
        userName: user?.displayName ?? userId,
        request: seal(key, CONSENT, request),
      }),
    );
  });

  app.post("/oauth/authorize", async (c) => {
    const signedIn = c.get("auth");
    const form = await c.req.parseBody();
    const r =
      typeof form.request === "string"
        ? (unseal(key, CONSENT, form.request) as ConsentRequest | null)
        : null;
    // The request this session was shown, not expired: nobody else's consent lands here.
    if (
      !r ||
      !signedIn ||
      r.sessionId !== signedIn.sessionId ||
      r.tenantId !== signedIn.tenantId ||
      typeof r.expiresAt !== "number" ||
      r.expiresAt <= Date.now()
    ) {
      return show(
        c,
        errorPage("This consent has expired or isn't yours. Start again from your app."),
        400,
      );
    }
    const allow = form.decision === "allow";
    const outcome = await db.withTenant(r.tenantId, async (tx) => {
      const actor = userPrincipal(r.userId);
      if (!allow) {
        await audit(tx, r.tenantId, {
          actor,
          action: "oauth.authorize",
          decision: "deny",
          client: r.clientRef,
          detail: { reason: "person-denied" },
        });
        return null;
      }
      try {
        const code = await issueCode(
          tx,
          r.tenantId,
          {
            userId: r.userId,
            clientKey: r.clientKey,
            redirectUri: r.redirectUri,
            codeChallenge: r.codeChallenge,
            scopes: r.scopes,
            resource: r.resource,
          },
          { clientTrust: configured(r.tenantId) },
        );
        await audit(tx, r.tenantId, {
          actor,
          action: "oauth.authorize",
          decision: "allow",
          client: r.clientRef,
          detail: { scopes: r.scopes.join(" ") },
        });
        return code;
      } catch (err) {
        if (!(err instanceof IdentityError)) throw err;
        return err;
      }
    });
    if (outcome === null) {
      return backWith(c, r.redirectUri, {
        error: "access_denied",
        error_description: "denied",
        state: r.state,
      });
    }
    if (outcome instanceof IdentityError) {
      log?.info({ err: outcome }, "oauth: no code");
      return backWith(c, r.redirectUri, {
        error: "access_denied",
        error_description: "the client or your account can't be used now",
        state: r.state,
      });
    }
    return backWith(c, r.redirectUri, { code: outcome, state: r.state });
  });

  // --- Tokens ----------------------------------------------------------------------------------

  const tokenError = (c: Context, error: string, description: string, status: 400 | 401 = 400) =>
    c.json({ error, error_description: description }, status, NO_STORE);

  app.post("/oauth/token", async (c) => {
    let form: Record<string, string | File | (string | File)[]>;
    try {
      form = await c.req.parseBody({ all: false });
    } catch {
      return tokenError(c, "invalid_request", "a form body is expected");
    }
    const str = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : undefined);
    const known = clients.keyOf(str("client_id"));
    if (!known) return tokenError(c, "invalid_client", "unknown client_id", 401);
    const { clientKey, clientRef } = known;
    const grantType = str("grant_type");
    const token =
      grantType === "authorization_code"
        ? str("code")
        : grantType === "refresh_token"
          ? str("refresh_token")
          : undefined;
    if (grantType !== "authorization_code" && grantType !== "refresh_token") {
      return tokenError(c, "unsupported_grant_type", "authorization_code or refresh_token");
    }
    const tenantId = oauthTokenTenant(token);
    if (!token || !tenantId) return tokenError(c, "invalid_grant", "unknown code or token");
    const askedResource = str("resource");
    if (askedResource !== undefined && canonicalResource(askedResource) !== resource) {
      return tokenError(c, "invalid_target", `tokens are for ${resource} only`);
    }
    let scopes: OAuthScope[] | undefined;
    if (grantType === "refresh_token" && str("scope") !== undefined) {
      const parsed = parseScopes(str("scope"));
      if (!parsed) return tokenError(c, "invalid_scope", "unknown scope");
      scopes = parsed;
    }
    let result: GrantResult;
    try {
      result = await db.withTenant(tenantId, async (tx) => {
        const r =
          grantType === "authorization_code"
            ? await redeemCode(tx, tenantId, token, {
                clientKey,
                redirectUri: str("redirect_uri") ?? "",
                codeVerifier: str("code_verifier") ?? "",
                resource,
                grantDays: auth.grantDays,
                clientTrust: configured(tenantId),
              })
            : await refreshGrant(tx, tenantId, token, {
                clientKey,
                resource,
                ...(scopes ? { scopes } : {}),
                clientTrust: configured(tenantId),
              });
        await audit(tx, tenantId, {
          actor:
            r.ok || r.userId
              ? userPrincipal(r.ok ? r.userId : (r.userId as string))
              : "oauth:unknown",
          action: grantType === "authorization_code" ? "oauth.token" : "oauth.refresh",
          decision: r.ok ? "allow" : "deny",
          client: clientRef,
          detail: r.ok
            ? { grant: r.grantId }
            : { reason: r.reason, ...(r.grantId ? { grant: r.grantId } : {}) },
        });
        return r;
      });
    } catch (err) {
      // A tenant that doesn't exist, or one row's constraint: the same answer as a wrong code.
      log?.warn({ err }, "oauth: token request failed");
      return tokenError(c, "invalid_grant", "unknown code or token");
    }
    if (!result.ok) {
      return tokenError(
        c,
        result.error,
        result.reason,
        result.error === "invalid_client" ? 401 : 400,
      );
    }
    return c.json(
      {
        access_token: result.accessToken,
        token_type: "Bearer",
        expires_in: result.expiresIn,
        refresh_token: result.refreshToken,
        scope: result.scopes.join(" "),
      },
      200,
      NO_STORE,
    );
  });

  app.post("/oauth/revoke", async (c) => {
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const token = typeof form.token === "string" ? form.token : undefined;
    const tenantId = oauthTokenTenant(token);
    if (token && tenantId) {
      await db
        .withTenant(tenantId, (tx) => revokeByToken(tx, tenantId, token))
        .catch((err: unknown) => log?.warn({ err }, "oauth: revoke failed"));
    }
    // RFC 7009: the same answer whatever the token was.
    return c.body(null, 200, NO_STORE);
  });

  // --- The resource server's side --------------------------------------------------------------

  const challenge = (extra: Record<string, string> = {}) =>
    [
      `resource_metadata="${resourceMetadata}"`,
      `scope="files:read"`,
      ...Object.entries(extra).map(([k, v]) => `${k}="${v.replace(/["\\]/g, "")}"`),
    ].join(", ");

  const requireBearer =
    (scope: OAuthScope = "files:read"): MiddlewareHandler<AuthEnv> =>
    async (c, next) => {
      const header = c.req.header("authorization") ?? "";
      const m = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(header);
      if (!m) {
        c.header("www-authenticate", `Bearer ${challenge()}`);
        return c.json({ error: "unauthorized" }, 401);
      }
      const token = m[1] as string;
      const tenantId = oauthTokenTenant(token);
      const check = tenantId
        ? await db
            .withTenant(
              tenantId,
              (tx) =>
                checkAccessToken(tx, tenantId, token, resource, {
                  cache,
                  clientTrust: configured(tenantId),
                }),
              SNAPSHOT,
            )
            .catch((err: unknown) => {
              log?.warn({ err }, "oauth: token check failed");
              return { ok: false as const, refused: "unknown" as const };
            })
        : ({ ok: false, refused: "unknown" } as const);
      if (!check.ok || !tenantId) {
        c.header("www-authenticate", `Bearer ${challenge({ error: "invalid_token" })}`);
        return c.json({ error: "invalid_token" }, 401);
      }
      if (!check.scopes.includes(scope)) {
        c.header(
          "www-authenticate",
          `Bearer ${challenge({ error: "insufficient_scope", scope: [...new Set([...check.scopes, scope])].join(" ") })}`,
        );
        return c.json({ error: "insufficient_scope" }, 403);
      }
      c.set("bearer", {
        tenantId,
        principal: check.principal,
        client: check.client,
        grantId: check.grantId,
        scopes: check.scopes,
      });
      await next();
    };

  return { requireBearer };
}
