import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isId, newId, sessions, users, type Tx } from "@openhoard/core-db";
import type { AuthzPrincipal } from "@openhoard/core-policy";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
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
 *   inactive). Locking, disabling and retiring a user end their sessions for good, and unlinking
 *   an identity ends the sessions it signed in.
 * - A sign-in under way (its PKCE verifier, nonce and return path) is the server's to keep; see
 *   apps/server (an encrypted cookie, so starting a sign-in writes nothing).
 */

const SECRET_BYTES = 32;
const TOKEN =
  /^ohs\.(ten_[0-9a-hjkmnp-tv-z]{26})\.(ses_[0-9a-hjkmnp-tv-z]{26})\.([A-Za-z0-9_-]{43})$/;
const PROVIDER = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PRINCIPAL = /^(user|system|scim):[^\0]{1,1000}$/;

/** Longest a session may live, and the default limits. */
export const SESSION_LIMITS = {
  maxSeconds: 30 * 24 * 3600,
  defaultMaxSeconds: 7 * 24 * 3600,
  defaultIdleSeconds: 12 * 3600,
  minIdleSeconds: 60,
  /** A session's last use is written at most this often (or a quarter of its idle limit). */
  touchSeconds: 60,
} as const;

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
// Return paths

const BASE = "http://openhoard.invalid";

/**
 * `path` as a path on this server to return to after signing in, normalized the way a browser
 * would resolve it (so `/.//evil.example` can't turn into `//evil.example`), or null when it
 * isn't one: another origin, `//host`, backslashes, control characters, over 2,048 characters.
 */
export function localPath(path: unknown): string | null {
  if (typeof path !== "string" || path.length < 1 || path.length > 2048) return null;
  // eslint-disable-next-line no-control-regex
  if (!path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f-\u009f]/.test(path)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(path, BASE);
  } catch {
    return null;
  }
  const out = url.pathname + url.search + url.hash;
  if (url.origin !== BASE || out.startsWith("//") || out.length > 2048) return null;
  return out;
}

/** Whether localPath() accepts `path` unchanged. */
export function isLocalPath(path: unknown): path is string {
  return typeof path === "string" && localPath(path) === path;
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
  // FOR KEY SHARE, as addMember does: a retirement, lock or disable running now finishes first,
  // and is seen.
  const [user] = await tx
    .select({
      kind: users.kind,
      retiredAt: users.retiredAt,
      lockedAt: users.lockedAt,
      providerDisabledAt: users.providerDisabledAt,
    })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, input.userId)))
    .for("key share");
  if (!user) throw new IdentityError("not-found", `no user ${input.userId}`);
  if (user.retiredAt !== null) {
    throw new IdentityError("retired", `user ${input.userId} is retired`);
  }
  // A sign-in racing a lock gets no session, which unlocking would otherwise bring back.
  if (user.lockedAt !== null || user.providerDisabledAt !== null) {
    throw new IdentityError("inactive", `user ${input.userId} is locked or disabled`);
  }
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
  | {
      ok: true;
      session: Session;
      principal: AuthzPrincipal;
      /** Its last recorded use is old enough to record this one: call touchSession(). */
      stale: boolean;
    }
  | { ok: false; refused: SessionRefusal; userId?: string };

/**
 * Checks a session token on a request: the session must exist, match, be neither revoked,
 * expired nor idle too long, and belong to an active person. It writes nothing, so it can run in
 * a read-only snapshot, where the principal cache serves (`{ isolationLevel: "repeatable read",
 * accessMode: "read only" }`); when it says `stale`, record the use with touchSession().
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
      stale: sql<boolean>`${sessions.lastSeenAt} < statement_timestamp()
        - make_interval(secs => least(${SESSION_LIMITS.touchSeconds}, ${sessions.idleSeconds} / 4))`,
    })
    .from(sessions)
    .where(and(eq(sessions.tenantId, tenantId), eq(sessions.id, sessionId)));
  // Compared in constant time, and against something even when there is no session.
  const same = timingSafeEqual(
    Buffer.from(sha256(secret), "hex"),
    Buffer.from(row?.secretHash ?? "0".repeat(64), "hex"),
  );
  if (!row) return { ok: false, refused: "unknown" };
  if (!same) return { ok: false, refused: "wrong-secret", userId: row.userId };
  if (!row.live) return { ok: false, refused: "ended" };
  const principal = options.cache
    ? await options.cache.resolve(tx, tenantId, row.userId)
    : ((await resolveWithExpiry(tx, tenantId, row.userId))?.principal ?? null);
  if (!principal || !principal.active || principal.service === true) {
    return { ok: false, refused: "account-inactive" };
  }
  return {
    ok: true,
    stale: row.stale,
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

/**
 * Records a session's use now, which keeps it from going idle. Only a live session is touched.
 * Returns whether it was.
 */
export async function touchSession(tx: Tx, tenantId: string, sessionId: string): Promise<boolean> {
  const rows = await tx
    .update(sessions)
    .set({ lastSeenAt: sql`statement_timestamp()` })
    .where(
      and(
        eq(sessions.tenantId, tenantId),
        eq(sessions.id, sessionId),
        isNull(sessions.revokedAt),
        sql`${sessions.expiresAt} > statement_timestamp()`,
        sql`${sessions.lastSeenAt} + make_interval(secs => ${sessions.idleSeconds}) > statement_timestamp()`,
      ),
    )
    .returning({ id: sessions.id });
  return rows.length > 0;
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

/**
 * Removes up to `limit` of a tenant's sessions that ended before `before`, those that ended
 * first first; returns how many went. Call it again until it returns less than the limit (the
 * scheduled maintenance in core/jobs does).
 */
export async function pruneSessions(
  tx: Tx,
  tenantId: string,
  before: Date,
  limit = 10_000,
): Promise<number> {
  if (!(before instanceof Date) || Number.isNaN(before.getTime())) {
    throw new IdentityError("invalid", "invalid time");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) {
    throw new IdentityError("invalid", "limit is 1 to 100000");
  }
  const ended = sql`least(${sessions.expiresAt}, coalesce(${sessions.revokedAt}, ${sessions.expiresAt}))`;
  const due = tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(eq(sessions.tenantId, tenantId), sql`${ended} < ${before.toISOString()}::timestamptz`),
    )
    .orderBy(ended)
    .limit(limit);
  const rows = await tx
    .delete(sessions)
    .where(and(eq(sessions.tenantId, tenantId), inArray(sessions.id, due)))
    .returning({ id: sessions.id });
  return rows.length;
}
