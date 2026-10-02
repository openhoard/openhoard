import { appendAudit, type AuditRecord } from "@openhoard/core-audit";
import { AI_CLIENT_TRUSTS, lockPrincipals, type Database, type Tx } from "@openhoard/core-db";
import type { ClientTrust } from "@openhoard/core-policy";
import {
  approvedTrust,
  checkAccessToken,
  decideClient,
  getClient,
  getUser,
  IdentityError,
  isAdmin,
  issueCode,
  localPath,
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
import { adminGroupOf, type AuthConfig } from "../config.js";
import { seal, unseal } from "../login-state.js";
import { retrying } from "../retry.js";
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
 *   POST /oauth/approve                                an admin's answer for a waiting client
 *   POST /oauth/token                                  authorization_code, refresh_token
 *   POST /oauth/revoke                                 RFC 7009
 *
 * - Only the S256 PKCE method, only public clients, only codes; tokens are bound to one resource
 *   (RFC 8707), `<publicUrl>/mcp`, and nothing else is accepted.
 * - Errors before the client and its redirect URI check out are shown here, never redirected
 *   (no open redirect); after, they go back to the client with `state` and `iss` (RFC 9207).
 * - A client needs an admin's approval in the person's tenant: in the app (the admin API,
 *   T-106) or in the config (`auth.clients`); allowlist.ts has which wins. Until then the person
 *   sees that it waits, and the tenant has a pending request for the admin. An admin sees a
 *   form instead and decides there and then (the same decision, checks and audit as the admin
 *   API's: an admin still, in the decision's own transaction, signed in recently), then goes on
 *   to their own consent. The check is made again on every code, token and MCP request, so a
 *   revocation counts from the next one.
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
const APPROVAL = "openhoard/oauth-approval/v1";

const STATUSES: readonly string[] = ["pending", "refused", "approved"];

/** What the approval form carries back, sealed: the client an admin was asked about. */
interface ApprovalRequest {
  tenantId: string;
  sessionId: string;
  userId: string;
  clientKey: string;
  clientRef: string;
  /** How the client stood when the form was shown: the decision holds only if it still does. */
  status: "pending" | "refused" | "approved";
  /** The authorization request to go back to (a path on this server). */
  returnTo: string;
  expiresAt: number;
}
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

/** Longest resource URI taken (what oauth_codes and oauth_grants hold). */
const MAX_RESOURCE = 2048;

/**
 * A canonical resource URI: lower-case scheme and host, no trailing slash; null with a fragment,
 * or over {@link MAX_RESOURCE} characters. It arrives before anyone is known (the token
 * endpoint), so the length is checked before parsing, and trailing slashes are trimmed by a loop:
 * the regex `/\/+$/` retries from every slash of a long run, which is quadratic.
 */
export function canonicalResource(uri: string): string | null {
  if (typeof uri !== "string" || uri.length > MAX_RESOURCE || uri.includes("#")) return null;
  try {
    const u = new URL(uri);
    if (u.hash !== "") return null;
    return `${u.protocol}//${u.host}${withoutTrailingSlashes(u.pathname)}${u.search}`;
  } catch {
    return null;
  }
}

function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 0x2f) end--;
  return path.slice(0, end);
}

/**
 * The WWW-Authenticate challenge for /mcp (after `Bearer `): where to get a token (RFC 9728),
 * the scope to ask for, and any error parameters (quotes and backslashes dropped).
 */
export function bearerChallenge(publicUrl: string, extra: Record<string, string> = {}): string {
  const issuer = new URL(publicUrl).origin;
  return [
    `resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`,
    `scope="files:read"`,
    ...Object.entries(extra).map(([k, v]) => `${k}="${v.replace(/["\\]/g, "")}"`),
  ].join(", ");
}

export function mountOAuth(
  app: Hono<AuthEnv>,
  deps: OAuthDeps,
): { requireBearer: (scope?: OAuthScope) => MiddlewareHandler<AuthEnv> } {
  const { auth, db, key, log } = deps;
  const issuer = new URL(auth.publicUrl).origin;
  const resource = `${issuer}/mcp`;
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
    ["/oauth/approve", "application/x-www-form-urlencoded"],
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
    const listed = listedIn(auth, tenantId, client);
    const inConfig = listed !== undefined;
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
      // An admin decides here; the form says so only to someone the session knows as one, and
      // the decision checks again. A client an admin refused can be approved here after all.
      if (signedIn.principal.admin === true) {
        const here = new URL(c.req.url);
        const returnTo = localPath(`${here.pathname}${here.search}`);
        if (!noted || returnTo === null) {
          return show(
            c,
            errorPage(
              noted
                ? "This request is too long to be put to you for approval. Approve the client with the admin API, or in the server's config."
                : "Too many clients are waiting for a decision, so this one wasn't recorded. Decide on the others first (the admin API lists them), then try again.",
            ),
            403,
          );
        }
        const approval: ApprovalRequest = {
          tenantId,
          sessionId: signedIn.sessionId,
          userId,
          clientKey: noted.clientKey,
          clientRef: client.clientRef,
          // (`approved`, yet with no label that counts: approved by the config once, and no
          // longer listed there.)
          status: noted.status,
          returnTo,
          expiresAt: Date.now() + CONSENT_TTL_MS,
        };
        return show(
          c,
          pendingPage(client.name, client.clientRef, {
            request: seal(key, APPROVAL, approval),
            redirectUris: client.redirectUris,
            status: noted.status,
            // Listed in the config (and refused here, or it wouldn't wait): the config's label.
            ...(listed ? { configTrust: listed.trust } : {}),
          }),
          403,
        );
      }
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

  // An admin's decision on a client that waits, from the form above. The session cookie's Origin
  // check covers it; the request is sealed to the session that was shown the form.
  app.post("/oauth/approve", async (c) => {
    const signedIn = c.get("auth");
    const form = await c.req.parseBody();
    const r =
      typeof form.request === "string"
        ? (unseal(key, APPROVAL, form.request) as ApprovalRequest | null)
        : null;
    if (
      !r ||
      !signedIn ||
      r.sessionId !== signedIn.sessionId ||
      r.tenantId !== signedIn.tenantId ||
      r.userId !== signedIn.principal.userId ||
      typeof r.expiresAt !== "number" ||
      r.expiresAt <= Date.now()
    ) {
      return show(c, errorPage("This has expired or isn't yours. Start again from your app."), 400);
    }
    const approve = form.decision === "approve";
    const seen = STATUSES.includes(r.status) ? r.status : "pending";
    // A refusal is of a client that waits; any other has nothing here to refuse.
    if (!approve && (form.decision !== "refuse" || seen !== "pending")) {
      return show(c, errorPage("Choose to approve or to refuse."), 400);
    }
    const asked =
      typeof form.trust === "string" && (AI_CLIENT_TRUSTS as readonly string[]).includes(form.trust)
        ? (form.trust as ClientTrust)
        : undefined;
    const { tenantId, clientKey } = r;
    const by = userPrincipal(r.userId);
    const action = approve ? "oauth-client.approve" : "oauth-client.refuse";
    const deny = (reason: string) =>
      db.withTenant(tenantId, (tx) =>
        audit(tx, tenantId, {
          actor: by,
          action,
          decision: "deny",
          client: r.clientRef,
          detail: { clientKey, via: "authorize", ...(asked ? { trust: asked } : {}), reason },
        }),
      );
    // Approving lets a client in: only with a recent sign-in (as the admin API asks).
    if (approve && Date.now() - signedIn.signedInAt.getTime() > auth.adminSignInMinutes * 60_000) {
      await deny("sign-in-again");
      return show(
        c,
        errorPage(
          "You signed in a while ago. To approve a client, sign out, then start again from your app and sign in.",
        ),
        403,
      );
    }
    const group = adminGroupOf(auth)(tenantId);
    const outcome = await retrying(() =>
      db.withTenant(tenantId, async (tx) => {
        // The principal lock first, as every admin change takes it: someone removing this
        // admin, committed first, is seen here.
        await lockPrincipals(tx, tenantId);
        const admin = await isAdmin(
          tx,
          tenantId,
          r.userId,
          group === undefined ? {} : { adminGroupId: group },
        );
        if (!admin) return "not-admin" as const;
        const client = await getClient(tx, tenantId, clientKey);
        if (!client) return "gone" as const;
        // What the config lists, the config decides, with its label. Only a refusal made in
        // the app before can be lifted here (the admin API's rule).
        const listed = listedIn(auth, tenantId, client);
        if (listed && !(approve && client.status === "refused")) return "config" as const;
        const trust = listed ? listed.trust : asked;
        if (approve && trust === undefined) return "no-trust" as const;
        try {
          const decided = await decideClient(
            tx,
            tenantId,
            clientKey,
            approve && trust !== undefined ? { approve: true, trust } : { approve: false },
            by,
            { expect: [seen] },
          );
          await audit(tx, tenantId, {
            actor: by,
            action,
            decision: "allow",
            client: r.clientRef,
            detail: { clientKey, via: "authorize", ...(trust ? { trust } : {}), was: decided.was },
          });
          return "done" as const;
        } catch (err) {
          // Decided by someone else meanwhile: the request shows how it stands now.
          if (err instanceof IdentityError && err.code === "conflict") return "moved" as const;
          throw err;
        }
      }),
    );
    switch (outcome) {
      case "not-admin":
      case "gone":
        await deny(outcome === "gone" ? "unknown-client" : outcome);
        return show(c, errorPage("Only an admin decides this."), 403);
      case "no-trust":
        return show(c, errorPage("Choose how far to trust the client."), 400);
      case "config":
        return show(
          c,
          errorPage("The server's config (auth.clients) decides for this client: change it there."),
          403,
        );
      case "moved":
        if (!approve) {
          return show(
            c,
            errorPage("Someone decided on this client meanwhile, so nothing was changed."),
          );
        }
        break;
      case "done":
        if (!approve) {
          return show(
            c,
            errorPage("You refused this client: it can't connect here. Close this window."),
          );
        }
    }
    // Back to the request: approved, it asks for their own consent next (and if someone decided
    // otherwise meanwhile, shows how it stands now).
    return c.redirect(r.returnTo, 303);
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

  const challenge = (extra: Record<string, string> = {}) => bearerChallenge(auth.publicUrl, extra);

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
        // A real grant's token refused (revoked, its person stopped, its client refused): the
        // client still holds what was taken away (T-104). Logged, not audited: a client retrying
        // in a loop would otherwise fill the audit log, which has the revocation itself.
        if (!check.ok && "grantId" in check && check.grantId !== undefined) {
          log?.info(
            { tenantId, grant: check.grantId, refused: check.refused },
            "oauth: bearer refused",
          );
        }
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
        tokenId: check.tokenId,
        scopes: check.scopes,
      });
      await next();
    };

  return { requireBearer };
}
