import { timingSafeEqual } from "node:crypto";
import { appendAudit, type AuditRecord } from "@openhoard/core-audit";
import type { Database, Tx } from "@openhoard/core-db";
import {
  checkSession,
  getUser,
  IdentityError,
  localPath,
  parseSessionToken,
  PrincipalCache,
  revokeSession,
  signIn,
  startSession,
  touchSession,
  userPrincipal,
  type SessionCheck,
} from "@openhoard/core-identity";
import type { AuthzPrincipal } from "@openhoard/core-policy";
import type { Hono, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as oidc from "openid-client";
import type { Logger } from "pino";
import { externalIdClaim, type AuthConfig, type ProviderConfig } from "./config.js";
import { loginCookieName, loginKey, openLogin, sealLogin } from "./login-state.js";

/*
 * Signing in (T-102): OpenID Connect, authorization code with PKCE, as a relying party of the
 * providers in the config. Each provider belongs to one tenant, so its URL says where the
 * person's account is before anything is read.
 *
 *   GET  /auth/providers           the providers to offer
 *   GET  /auth/login/:provider     → the provider, with state, nonce and a PKCE challenge
 *   GET  /auth/callback/:provider  ← back: checks everything, starts a session
 *   GET  /auth/me                  who is signed in
 *   POST /auth/logout              ends the session
 *
 * - A sign-in under way lives in an encrypted cookie of its own (login-state.ts): the state, the
 *   PKCE verifier, the nonce, the provider and where to return. Starting one writes nothing. The
 *   callback needs this browser's cookie for that exact state and provider, within 10 minutes.
 *   openid-client checks the issuer, audience, signature, nonce and expiry of the ID token.
 * - Sign-in never creates anyone and never matches on email (core/identity signIn()).
 * - The session cookie is HttpOnly, SameSite=Lax, and `__Host-` and Secure over https. A
 *   state-changing request carrying it must come from this origin (the Origin header).
 * - Every sign-in, allowed or refused, and every sign-out is audited.
 */

export interface AuthDeps {
  auth: AuthConfig;
  db: Database;
  log?: Logger;
}

/** What a signed-in request carries (c.get("auth")). */
export interface SignedIn {
  tenantId: string;
  sessionId: string;
  principal: AuthzPrincipal;
}

export type AuthEnv = { Variables: { auth?: SignedIn } };

const LOGIN_TTL = 600;
/** Reading a session: a snapshot the principal cache serves from, that writes nothing. */
const SNAPSHOT = { isolationLevel: "repeatable read", accessMode: "read only" } as const;
const SCOPE = "openid profile email";
const FAILED = { error: "sign-in failed" } as const;

export function mountAuth(app: Hono<AuthEnv>, deps: AuthDeps): void {
  const { auth, db, log } = deps;
  const origin = new URL(auth.publicUrl).origin;
  const secure = new URL(auth.publicUrl).protocol === "https:";
  const SESSION_COOKIE = secure ? "__Host-oh_session" : "oh_session";
  // One cookie per sign-in under way, named by its state, so two tabs don't undo each other.
  const loginCookie = (state: string) => loginCookieName(state, secure);
  // Without a configured key, sign-ins under way don't survive a restart (or reach another node).
  const key = loginKey(auth.cookieKey);
  if (auth.cookieKey === undefined) {
    log?.info("sign-in: no auth.cookieKey, so this process made its own (fine for one server)");
  }
  const providers = new Map(auth.providers.map((p) => [p.id, p]));
  const cache = new PrincipalCache();
  const discovered = new Map<string, Promise<oidc.Configuration>>();

  /** The provider's configuration, discovered once (and again after a failure). */
  const configFor = (p: ProviderConfig): Promise<oidc.Configuration> => {
    let found = discovered.get(p.id);
    if (!found) {
      const insecure = new URL(p.issuer).protocol === "http:";
      found = oidc
        .discovery(
          new URL(p.issuer),
          p.clientId,
          undefined,
          p.clientSecret === undefined ? oidc.None() : oidc.ClientSecretPost(p.clientSecret),
          insecure ? { execute: [oidc.allowInsecureRequests], timeout: 10 } : { timeout: 10 },
        )
        .catch((err: unknown) => {
          discovered.delete(p.id);
          throw err;
        });
      discovered.set(p.id, found);
    }
    return found;
  };
  const redirectUri = (p: ProviderConfig) => new URL(`/auth/callback/${p.id}`, origin).href;
  const audit = (tx: Tx, tenantId: string, record: AuditRecord) =>
    appendAudit(tx, tenantId, record);

  // Cross-site requests can't act for a signed-in person: a state-changing request carrying
  // the session cookie must come from this origin. (Without the cookie it acts for nobody.)
  app.use("*", async (c, next) => {
    const method = c.req.method;
    const unsafe = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    if (unsafe && getCookie(c, SESSION_COOKIE) !== undefined && c.req.header("origin") !== origin) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  });

  // Who is signed in, for every route after this one; nobody is fine here.
  app.use("*", async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const named = parseSessionToken(token);
    if (token !== undefined && named) {
      const check: SessionCheck = await db.withTenant(
        named.tenantId,
        (tx) => checkSession(tx, named.tenantId, token, { cache }),
        SNAPSHOT,
      );
      if (check.ok && check.stale) {
        await db.withTenant(named.tenantId, (tx) =>
          touchSession(tx, named.tenantId, check.session.id),
        );
      }
      if (!check.ok && check.refused === "wrong-secret") {
        // Someone holds a real session id with the wrong secret: worth an operator's look.
        log?.warn({ session: named.sessionId, user: check.userId }, "session: wrong secret");
      }
      if (check.ok) {
        c.set("auth", {
          tenantId: named.tenantId,
          sessionId: check.session.id,
          principal: check.principal,
        });
      } else {
        deleteCookie(c, SESSION_COOKIE, { path: "/", secure });
      }
    }
    await next();
  });

  app.get("/auth/providers", (c) =>
    c.json({
      providers: auth.providers.map((p) => ({ id: p.id, label: p.label ?? p.id, kind: p.kind })),
    }),
  );

  app.get("/auth/login/:provider", async (c) => {
    const p = providers.get(c.req.param("provider"));
    if (!p) return c.json({ error: "not found" }, 404);
    const returnTo = c.req.query("return_to");
    let config: oidc.Configuration;
    try {
      config = await configFor(p);
    } catch (err) {
      log?.error({ err, provider: p.id }, "provider discovery failed");
      return c.json({ error: "sign-in is unavailable" }, 503);
    }
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri(p),
      scope: SCOPE,
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: "S256",
      state,
      nonce,
    });
    const sealed = sealLogin(key, {
      provider: p.id,
      state,
      codeVerifier,
      nonce,
      returnTo: returnPath(returnTo),
      expiresAt: Date.now() + LOGIN_TTL * 1000,
    });
    setCookie(c, loginCookie(state), sealed, {
      path: `/auth/callback/${p.id}`,
      httpOnly: true,
      secure,
      sameSite: "Lax",
      maxAge: LOGIN_TTL,
    });
    return c.redirect(url.href, 302);
  });

  app.get("/auth/callback/:provider", async (c) => {
    const p = providers.get(c.req.param("provider"));
    if (!p) return c.json({ error: "not found" }, 404);
    const state = c.req.query("state");
    if (state === undefined || state.length > 512) return c.json(FAILED, 400);
    const sealed = getCookie(c, loginCookie(state));
    deleteCookie(c, loginCookie(state), { path: `/auth/callback/${p.id}`, secure });
    // The sign-in this browser started, for this state and provider, not yet expired: no one
    // else's sign-in lands here.
    const login = sealed === undefined ? null : openLogin(key, sealed);
    if (
      !login ||
      login.provider !== p.id ||
      !sameText(state, login.state) ||
      login.expiresAt <= Date.now()
    ) {
      // Often another server's key (set auth.cookieKey on every node), or an old tab.
      log?.info(
        { provider: p.id, cookie: sealed !== undefined },
        "sign-in: no usable sign-in cookie",
      );
      return c.json(FAILED, 400);
    }
    const refuse = async (reason: string, subject?: string, userId?: string | null) => {
      await db.withTenant(p.tenantId, (tx) =>
        audit(tx, p.tenantId, {
          actor: userId ? userPrincipal(userId) : `oidc:${p.id}`,
          action: "auth.sign-in",
          decision: "deny",
          detail: {
            provider: p.id,
            reason,
            ...(subject !== undefined && !userId ? { subject } : {}),
          },
        }),
      );
      return c.json(FAILED, 401);
    };
    let claims: oidc.IDToken;
    try {
      const config = await configFor(p);
      // The URL the provider sent the browser to, on our public origin (a proxy may sit between).
      const current = new URL(c.req.url);
      const here = new URL(`/auth/callback/${p.id}${current.search}`, origin);
      const tokens = await oidc.authorizationCodeGrant(config, here, {
        pkceCodeVerifier: login.codeVerifier,
        expectedState: state,
        expectedNonce: login.nonce,
        idTokenExpected: true,
      });
      const got = tokens.claims();
      if (!got) throw new Error("no ID token");
      claims = got;
    } catch (err) {
      log?.warn({ err, provider: p.id }, "sign-in: code exchange failed");
      return refuse(providerError(err));
    }
    const claim = externalIdClaim(p);
    const externalId = claim === undefined ? undefined : claims[claim];
    const previous = c.get("auth");
    let result;
    try {
      result = await db.withTenant(p.tenantId, async (tx) => {
        const who = await signIn(tx, p.tenantId, {
          issuer: claims.iss,
          subject: claims.sub,
          ...(typeof externalId === "string" && externalId !== "" ? { externalId } : {}),
        });
        if (!who.ok) return who;
        const session = await startSession(tx, p.tenantId, {
          userId: who.user.id,
          provider: p.id,
          issuer: claims.iss,
          subject: claims.sub,
          idleSeconds: auth.sessionIdleMinutes * 60,
          maxSeconds: auth.sessionMaxHours * 3600,
        });
        // Audit last: its lock is the last one taken (core/audit).
        await audit(tx, p.tenantId, {
          actor: userPrincipal(who.user.id),
          action: "auth.sign-in",
          decision: "allow",
          detail: { provider: p.id, session: session.id, linked: who.linked },
        });
        return { ok: true as const, session };
      });
    } catch (err) {
      // Claims OpenHoard can't hold (an over-long subject), or the person was locked or retired
      // since signIn() found them.
      if (!(err instanceof IdentityError)) throw err;
      log?.warn({ err, provider: p.id }, "sign-in: refused");
      const inactive = err.code === "inactive" || err.code === "retired";
      return refuse(inactive ? "inactive" : "invalid-claims");
    }
    if (!result.ok) return refuse(result.refused, claims.sub, result.userId);
    // The session this browser had (if any) is replaced, not left alive beside the new one.
    if (previous) {
      const by = userPrincipal(previous.principal.userId);
      try {
        await db.withTenant(previous.tenantId, async (tx) => {
          if (await revokeSession(tx, previous.tenantId, previous.sessionId, by)) {
            await audit(tx, previous.tenantId, {
              actor: by,
              action: "auth.sign-out",
              decision: "allow",
              detail: { session: previous.sessionId, replaced: true },
            });
          }
        });
      } catch (err) {
        // The new session stands; the old one still ends by itself.
        log?.error(
          { err, session: previous.sessionId },
          "sign-in: ending the previous session failed",
        );
      }
    }
    setCookie(c, SESSION_COOKIE, result.session.token, {
      path: "/",
      httpOnly: true,
      secure,
      sameSite: "Lax",
      maxAge: Math.max(0, Math.floor((result.session.expiresAt.getTime() - Date.now()) / 1000)),
    });
    return c.redirect(login.returnTo, 302);
  });

  app.get("/auth/me", async (c) => {
    const signedIn = c.get("auth");
    if (!signedIn) return c.json({ error: "not signed in" }, 401);
    const user = await db.withTenant(signedIn.tenantId, (tx) =>
      getUser(tx, signedIn.tenantId, signedIn.principal.userId),
    );
    if (!user) return c.json({ error: "not signed in" }, 401);
    return c.json({
      user: { id: user.id, displayName: user.displayName, email: user.email, kind: user.kind },
      tenantId: signedIn.tenantId,
    });
  });

  app.post("/auth/logout", async (c) => {
    const signedIn = c.get("auth");
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure });
    if (signedIn) {
      const by = userPrincipal(signedIn.principal.userId);
      await db.withTenant(signedIn.tenantId, async (tx) => {
        await revokeSession(tx, signedIn.tenantId, signedIn.sessionId, by);
        await audit(tx, signedIn.tenantId, {
          actor: by,
          action: "auth.sign-out",
          decision: "allow",
          detail: { session: signedIn.sessionId },
        });
      });
    }
    return c.body(null, 204);
  });
}

/** Refuses a request nobody signed in to. */
export const requireSignIn: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (!c.get("auth")) return c.json({ error: "not signed in" }, 401);
  await next();
};

/**
 * Where to return after signing in: a path on this server, at most 512 characters (every sign-in
 * under way rides in a cookie sent to the callback, and headers have a limit), else `/`.
 */
function returnPath(asked: string | undefined): string {
  const path = localPath(asked);
  return path !== null && path.length <= 512 ? path : "/";
}

/** Equal strings, compared in constant time. */
function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A short reason for the audit: the provider's error code, or what failed. Never token text. */
function providerError(err: unknown): string {
  if (err instanceof oidc.AuthorizationResponseError || err instanceof oidc.ResponseBodyError) {
    return `provider:${String(err.error).slice(0, 64)}`;
  }
  if (err instanceof oidc.ClientError) return `client:${String(err.code ?? "error").slice(0, 64)}`;
  return "exchange-failed";
}
