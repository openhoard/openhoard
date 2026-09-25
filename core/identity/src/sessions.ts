import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isId, loginRequests, newId, sessions, users, type Tx } from "@openhoard/core-db";
import type { AuthzPrincipal } from "@openhoard/core-policy";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import {
  findUserByExternalId,
  findUserByIdentity,
  IdentityError,
  linkIdentity,
  resolveWithExpiry,
  type User,
} from "./directory.js";
import type { PrincipalCache } from "./principal-cache.js";

/*
 * Sign-in (T-102): a person signs in through an OpenID Connect provider the server is configured
 * with, and gets a session.
 *
 * - Sign-in matches the provider's (issuer, subject) to a linked identity, never an email. The
 *   first time, a provider may name a claim holding the user's id at the identity provider
 *   (Entra's `oid`), matched once to a SCIM user's external id; the pair is then linked and used
 *   from then on. Anyone else is refused: people are provisioned (SCIM, T-103) or invited
 *   (T-108), never created by signing in.
 * - A session is `ohs.<tenant id>.<session id>.<secret>`: the tenant says where to look, the id
 *   finds it, the secret proves it. Only a SHA-256 of the secret is kept.
 * - checkSession() reads the session on every request: a revoked, expired or idle one fails at
 *   once, and so does one whose user is locked, disabled or retired (their principal is
 *   inactive). Retiring a user revokes their sessions.
 * - A sign-in under way (beginLogin/takeLogin) keeps the PKCE verifier and nonce on the server,
 *   found by a hash of the `state`, used once, for a few minutes.
 */

const SECRET_BYTES = 32;
const TOKEN =
  /^ohs\.(ten_[0-9a-hjkmnp-tv-z]{26})\.(ses_[0-9a-hjkmnp-tv-z]{26})\.([A-Za-z0-9_-]{43})$/;
const PROVIDER = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PRINCIPAL = /^(user|system|scim):[^\0]{1,1000}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** Longest a session may live, and the default limits. */
export const SESSION_LIMITS = {
  maxSeconds: 30 * 24 * 3600,
  defaultMaxSeconds: 7 * 24 * 3600,
  defaultIdleSeconds: 12 * 3600,
  minIdleSeconds: 60,
  /** A session's last use is written at most this often. */
  touchSeconds: 60,
} as const;

/** How long a sign-in may take at the provider. */
export const LOGIN_TTL_SECONDS = 600;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const chars = (s: string) => [...s].length;

// ---------------------------------------------------------------------------------------------
// Signing in

/** What the provider said about the person, after it checked the ID token. */
export interface SignInClaims {
  issuer: string;
  subject: string;
  /**
   * The person's id at the identity provider, when the provider is configured to match on one
   * (Entra's `oid`): matched once to a SCIM user's external id, before the identity is linked.
   */
  externalId?: string;
}

export type SignInRefusal =
  /** No linked identity, and nothing to match on. */
  | "unknown"
  /** Locked, disabled by the provider, or a service account. */
  | "inactive";

export type SignInResult =
  | { ok: true; user: User; linked: boolean }
  | { ok: false; refused: SignInRefusal; userId: string | null };

/**
 * Finds who is signing in. Run it in a read-write transaction: a first sign-in links the
 * identity. Refuses unknown and inactive people; creates nobody.
 */
export async function signIn(
  tx: Tx,
  tenantId: string,
  claims: SignInClaims,
): Promise<SignInResult> {
  const { issuer, subject } = claims;
  if (
    typeof issuer !== "string" ||
    typeof subject !== "string" ||
    chars(issuer) < 1 ||
    chars(issuer) > 1024 ||
    chars(subject) < 1 ||
    chars(subject) > 512
  ) {
    throw new IdentityError(
      "invalid",
      "issuer and subject must be 1 to 1024 and 1 to 512 characters",
    );
  }
  let user = await findUserByIdentity(tx, tenantId, { issuer, subject });
  let linked = false;
  if (!user && claims.externalId !== undefined && claims.externalId !== "") {
    const match = await findUserByExternalId(tx, tenantId, claims.externalId);
    if (match && match.kind !== "service") {
      if (!match.active) return { ok: false, refused: "inactive", userId: match.id };
      // conflict: the pair belongs to someone else, which findUserByIdentity would have found
      // unless that user is retired (their identities are gone) or a service account (refused).
      linked = await linkIdentity(tx, tenantId, match.id, { issuer, subject });
      user = match;
    }
  }
  if (!user) return { ok: false, refused: "unknown", userId: null };
  if (!user.active || user.kind === "service") {
    return { ok: false, refused: "inactive", userId: user.id };
  }
  return { ok: true, user, linked };
}

// ---------------------------------------------------------------------------------------------
// Sign-ins under way

export interface LoginRequest {
  provider: string;
  codeVerifier: string;
  nonce: string;
  returnTo: string;
}

/**
 * Whether `path` is somewhere on this server to return to: an absolute path, not `//host` or
 * `/\\host` (which browsers treat as another site), without control characters.
 */
export function isLocalPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length >= 1 &&
    path.length <= 2048 &&
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !path.includes("\\") &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(path)
  );
}

/**
 * Records a sign-in about to go to the provider, found later by `state` (from the provider's
 * redirect back). Also drops the tenant's expired ones.
 */
export async function beginLogin(
  tx: Tx,
  tenantId: string,
  state: string,
  request: LoginRequest,
): Promise<void> {
  if (typeof state !== "string" || state.length < 32) {
    throw new IdentityError("invalid", "state must be at least 32 characters");
  }
  if (!PROVIDER.test(request.provider)) throw new IdentityError("invalid", "invalid provider id");
  if (!VERIFIER.test(request.codeVerifier)) {
    throw new IdentityError("invalid", "invalid PKCE code verifier");
  }
  if (chars(request.nonce) < 16 || chars(request.nonce) > 256) {
    throw new IdentityError("invalid", "invalid nonce");
  }
  if (!isLocalPath(request.returnTo)) throw new IdentityError("invalid", "invalid return path");
  await tx
    .delete(loginRequests)
    .where(and(eq(loginRequests.tenantId, tenantId), lt(loginRequests.expiresAt, sql`now()`)));
  await tx.insert(loginRequests).values({
    tenantId,
    stateHash: sha256(state),
    provider: request.provider,
    codeVerifier: request.codeVerifier,
    nonce: request.nonce,
    returnTo: request.returnTo,
    expiresAt: sql`now() + make_interval(secs => ${LOGIN_TTL_SECONDS})`,
  });
}

/**
 * The sign-in `state` names, for `provider`, removed so it can't be used again; null if there is
 * none, it expired, or it was for another provider.
 */
export async function takeLogin(
  tx: Tx,
  tenantId: string,
  provider: string,
  state: string,
): Promise<LoginRequest | null> {
  if (typeof state !== "string" || state.length < 32 || state.length > 512) return null;
  const [row] = await tx
    .delete(loginRequests)
    .where(and(eq(loginRequests.tenantId, tenantId), eq(loginRequests.stateHash, sha256(state))))
    .returning({
      provider: loginRequests.provider,
      codeVerifier: loginRequests.codeVerifier,
      nonce: loginRequests.nonce,
      returnTo: loginRequests.returnTo,
      live: sql<boolean>`${loginRequests.expiresAt} > now()`,
    });
  if (!row || !row.live || row.provider !== provider) return null;
  return {
    provider: row.provider,
    codeVerifier: row.codeVerifier,
    nonce: row.nonce,
    returnTo: row.returnTo,
  };
}

// ---------------------------------------------------------------------------------------------
// Sessions

export interface SessionInput {
  userId: string;
  provider: string;
  issuer: string;
  subject: string;
  /** Longest it may go unused (default SESSION_LIMITS.defaultIdleSeconds). */
  idleSeconds?: number;
  /** Longest it may live (default SESSION_LIMITS.defaultMaxSeconds, at most 30 days). */
  maxSeconds?: number;
}

export interface Session {
  id: string;
  userId: string;
  provider: string;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Starts a session for a person who just signed in. Returns it with its `token`, for the
 * cookie: the only time the secret is seen.
 */
export async function startSession(
  tx: Tx,
  tenantId: string,
  input: SessionInput,
): Promise<Session & { token: string }> {
  const idle = input.idleSeconds ?? SESSION_LIMITS.defaultIdleSeconds;
  const max = input.maxSeconds ?? SESSION_LIMITS.defaultMaxSeconds;
  if (!Number.isSafeInteger(idle) || idle < SESSION_LIMITS.minIdleSeconds || idle > max) {
    throw new IdentityError("invalid", "idleSeconds must be at least 60 and at most maxSeconds");
  }
  if (!Number.isSafeInteger(max) || max < 60 || max > SESSION_LIMITS.maxSeconds) {
    throw new IdentityError("invalid", "maxSeconds must be 60 s to 30 days");
  }
  if (!PROVIDER.test(input.provider)) throw new IdentityError("invalid", "invalid provider id");
  if (!isId("user", input.userId)) throw new IdentityError("invalid", "invalid user id");
  // FOR KEY SHARE, as addMember does: a retirement running now finishes first, and is seen.
  const [user] = await tx
    .select({ kind: users.kind, retiredAt: users.retiredAt })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, input.userId)))
    .for("key share");
  if (!user) throw new IdentityError("not-found", `no user ${input.userId}`);
  if (user.retiredAt !== null)
    throw new IdentityError("retired", `user ${input.userId} is retired`);
  if (user.kind === "service") {
    throw new IdentityError("invalid", "a service account never signs in: it uses API keys");
  }
  const id = newId("session");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const [row] = await tx
    .insert(sessions)
    .values({
      tenantId,
      id,
      userId: input.userId,
      userKind: user.kind,
      secretHash: sha256(secret),
      provider: input.provider,
      issuer: input.issuer,
      subject: input.subject,
      idleSeconds: idle,
      expiresAt: sql`now() + make_interval(secs => ${max})`,
    })
    .returning({ createdAt: sessions.createdAt, expiresAt: sessions.expiresAt });
  if (!row) throw new Error("session insert returned nothing");
  return {
    id,
    userId: input.userId,
    provider: input.provider,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    token: `ohs.${tenantId}.${id}.${secret}`,
  };
}

/** The tenant and session a token names, or null when it isn't one. Checks nothing else. */
export function parseSessionToken(token: unknown): { tenantId: string; sessionId: string } | null {
  const m = typeof token === "string" ? TOKEN.exec(token) : null;
  return m?.[1] && m[2] ? { tenantId: m[1], sessionId: m[2] } : null;
}

export type SessionRefusal = "unknown" | "wrong-secret" | "ended" | "account-inactive";

export type SessionCheck =
  | { ok: true; session: Session; principal: AuthzPrincipal }
  | { ok: false; refused: SessionRefusal };

/**
 * Checks a session token on a request, in its tenant's read-write transaction: the session must
 * exist, match, be neither revoked, expired nor idle too long, and belong to an active person.
 * Records its use (at most once a minute).
 */
export async function checkSession(
  tx: Tx,
  tenantId: string,
  token: string,
  options: { cache?: PrincipalCache } = {},
): Promise<SessionCheck> {
  const m = typeof token === "string" ? TOKEN.exec(token) : null;
  if (!m || m[1] !== tenantId) return { ok: false, refused: "unknown" };
  const sessionId = m[2] as string;
  const secret = m[3] as string;
  const [row] = await tx
    .select({
      userId: sessions.userId,
      provider: sessions.provider,
      secretHash: sessions.secretHash,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
      live: sql<boolean>`${sessions.revokedAt} is null and ${sessions.expiresAt} > statement_timestamp()
        and ${sessions.lastSeenAt} + make_interval(secs => ${sessions.idleSeconds}) > statement_timestamp()`,
      stale: sql<boolean>`${sessions.lastSeenAt} < statement_timestamp() - make_interval(secs => ${SESSION_LIMITS.touchSeconds})`,
    })
    .from(sessions)
    .where(and(eq(sessions.tenantId, tenantId), eq(sessions.id, sessionId)));
  // Compared in constant time, and against something even when there is no session.
  const same = timingSafeEqual(
    Buffer.from(sha256(secret), "hex"),
    Buffer.from(row?.secretHash ?? "0".repeat(64), "hex"),
  );
  if (!row) return { ok: false, refused: "unknown" };
  if (!same) return { ok: false, refused: "wrong-secret" };
  if (!row.live) return { ok: false, refused: "ended" };
  const principal = options.cache
    ? await options.cache.resolve(tx, tenantId, row.userId)
    : ((await resolveWithExpiry(tx, tenantId, row.userId))?.principal ?? null);
  if (!principal || !principal.active || principal.service === true) {
    return { ok: false, refused: "account-inactive" };
  }
  if (row.stale) {
    await tx
      .update(sessions)
      .set({ lastSeenAt: sql`statement_timestamp()` })
      .where(and(eq(sessions.tenantId, tenantId), eq(sessions.id, sessionId)));
  }
  return {
    ok: true,
    session: {
      id: sessionId,
      userId: row.userId,
      provider: row.provider,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    },
    principal,
  };
}

function checkBy(by: string) {
  if (typeof by !== "string" || !PRINCIPAL.test(by)) {
    throw new IdentityError("invalid", "by must be a principal: user:…, system:… or scim:…");
  }
}

/** Ends a session (sign-out). Returns false if it had ended already. */
export async function revokeSession(
  tx: Tx,
  tenantId: string,
  sessionId: string,
  by: string,
): Promise<boolean> {
  checkBy(by);
  const rows = await tx
    .update(sessions)
    .set({ revokedAt: sql`greatest(now(), ${sessions.createdAt})`, revokedBy: by })
    .where(
      and(eq(sessions.tenantId, tenantId), eq(sessions.id, sessionId), isNull(sessions.revokedAt)),
    )
    .returning({ id: sessions.id });
  return rows.length > 0;
}

/** Ends every session of a user; returns how many. */
export async function revokeUserSessions(
  tx: Tx,
  tenantId: string,
  userId: string,
  by: string,
): Promise<number> {
  checkBy(by);
  const rows = await tx
    .update(sessions)
    .set({ revokedAt: sql`greatest(now(), ${sessions.createdAt})`, revokedBy: by })
    .where(
      and(eq(sessions.tenantId, tenantId), eq(sessions.userId, userId), isNull(sessions.revokedAt)),
    )
    .returning({ id: sessions.id });
  return rows.length;
}

/** Removes a tenant's sessions that ended before `before`; returns how many. */
export async function pruneSessions(tx: Tx, tenantId: string, before: Date): Promise<number> {
  if (!(before instanceof Date) || Number.isNaN(before.getTime())) {
    throw new IdentityError("invalid", "invalid time");
  }
  const rows = await tx
    .delete(sessions)
    .where(
      and(
        eq(sessions.tenantId, tenantId),
        sql`least(${sessions.expiresAt}, coalesce(${sessions.revokedAt}, ${sessions.expiresAt}))
          < ${before.toISOString()}::timestamptz`,
      ),
    )
    .returning({ id: sessions.id });
  return rows.length;
}
