import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isId, newId, signInLinks, type Tx } from "@openhoard/core-db";
import { and, eq, sql } from "drizzle-orm";
import { getUser, IdentityError } from "./directory.js";
import { revokeSession, startSession, type Session } from "./sessions.js";

/*
 * One-time sign-in links: how a person signs in to a server that has no identity provider (a
 * single person trying OpenHoard out on their own machine). An operator issues one with the admin
 * CLI (`openhoard admin user sign-in-link`); the person opens it in their browser, and it starts
 * a session, once. The server offers the route only when `auth.signInLinks` is on and it listens
 * on this machine only.
 *
 * - A link's token is `ohl.<tenant id>.<link id>.<secret>`, 32 random bytes of secret; only its
 *   SHA-256 is kept. It lives `minutes` (default 15, at most 60, by the database's clock), and
 *   starts one session: its use is recorded with the session it started.
 * - A used link presented again is refused, and ends the session it started (someone else may
 *   hold the link: as a replayed OAuth code revokes what it made), except by the browser holding
 *   that session (a double submit: `already`). An expired one is refused.
 * - Only a current person (a member or a guest, not locked, disabled or retired) signs in: the
 *   same check a session makes when it starts (startSession()).
 * - The session is recorded as signed in through `sign-in-link`, issuer `openhoard:sign-in-link`,
 *   subject the link's id: no identity is linked, so nothing lets that person sign in again
 *   without another link.
 */

const SECRET_BYTES = 32;
const TOKEN =
  /^ohl\.(ten_[0-9a-hjkmnp-tv-z]{26})\.(sil_[0-9a-hjkmnp-tv-z]{26})\.([A-Za-z0-9_-]{43})$/;
const ADMIN = /^(user|system):[^\0]{1,1000}$/;
/** The provider and issuer a link's sessions are recorded with. */
export const SIGN_IN_LINK_PROVIDER = "sign-in-link";
export const SIGN_IN_LINK_ISSUER = "openhoard:sign-in-link";
export const SIGN_IN_LINK_MAX_MINUTES = 60;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The tenant and link a token names, or null when it isn't one. Checks nothing else. */
export function parseSignInLink(token: unknown): { tenantId: string; linkId: string } | null {
  const m = typeof token === "string" ? TOKEN.exec(token) : null;
  return m?.[1] && m[2] ? { tenantId: m[1], linkId: m[2] } : null;
}

/**
 * Issues a sign-in link for a current person (not a service account). Returns the token once:
 * only its hash is kept.
 */
export async function issueSignInLink(
  tx: Tx,
  tenantId: string,
  input: { userId: string; by: string; minutes?: number },
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const minutes = input.minutes ?? 15;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > SIGN_IN_LINK_MAX_MINUTES) {
    throw new IdentityError("invalid", `a link lives 1 to ${SIGN_IN_LINK_MAX_MINUTES} minutes`);
  }
  if (!ADMIN.test(input.by)) throw new IdentityError("invalid", "by is user:… or system:…");
  const user = isId("user", input.userId) ? await getUser(tx, tenantId, input.userId) : null;
  if (!user || user.retired !== null) throw new IdentityError("not-found", "no such person");
  if (user.kind === "service") {
    throw new IdentityError("invalid", "a service account never signs in: it uses API keys");
  }
  if (!user.active) throw new IdentityError("inactive", "they are locked or disabled");
  const id = newId("signInLink");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const [row] = await tx
    .insert(signInLinks)
    .values({
      tenantId,
      id,
      userId: user.id,
      secretHash: sha256(secret),
      createdBy: input.by,
      expiresAt: sql`now() + make_interval(mins => ${minutes})`,
    })
    .returning({ expiresAt: signInLinks.expiresAt });
  if (!row) throw new Error("sign-in link insert returned nothing");
  return { id, token: `ohl.${tenantId}.${id}.${secret}`, expiresAt: row.expiresAt };
}

export type SignInLinkRefusal =
  /** Not a token, another tenant's, or no such link. */
  | "unknown"
  | "wrong-secret"
  | "expired"
  /** Used before: the session it started is ended too. */
  | "used"
  /** The person is locked, disabled, retired, or a service account now. */
  | "inactive";

export type SignInLinkResult =
  | { ok: true; userId: string; linkId: string; session: Session & { token: string } }
  /**
   * Used already, by the browser presenting it now (the session it started is the caller's): a
   * double submit, nothing to do.
   */
  | { ok: true; already: true; userId: string; linkId: string; sessionId: string }
  | {
      ok: false;
      refused: SignInLinkRefusal;
      linkId?: string;
      userId?: string;
      /** A replay's session, ended now. */
      endedSession?: string;
    };

/**
 * Redeems a link in `tx` (read-write, the tenant the token names): starts its session and
 * records its use, or says why not. A replay ends the session the link started.
 */
export async function redeemSignInLink(
  tx: Tx,
  tenantId: string,
  token: string,
  limits: {
    idleSeconds?: number;
    maxSeconds?: number;
    /** The session the request already carries: a link that started it is not a replay. */
    currentSession?: string;
  } = {},
): Promise<SignInLinkResult> {
  const named = parseSignInLink(token);
  if (!named || named.tenantId !== tenantId) return { ok: false, refused: "unknown" };
  const [link] = await tx
    .select({
      userId: signInLinks.userId,
      secretHash: signInLinks.secretHash,
      usedAt: signInLinks.usedAt,
      sessionId: signInLinks.sessionId,
      live: sql<boolean>`${signInLinks.expiresAt} > now()`,
    })
    .from(signInLinks)
    .where(and(eq(signInLinks.tenantId, tenantId), eq(signInLinks.id, named.linkId)))
    .for("update");
  if (!link) return { ok: false, refused: "unknown" };
  const who = { linkId: named.linkId, userId: link.userId };
  const secret = token.slice(token.lastIndexOf(".") + 1);
  const given = Buffer.from(sha256(secret));
  if (!timingSafeEqual(given, Buffer.from(link.secretHash))) {
    return { ok: false, refused: "wrong-secret", ...who };
  }
  if (link.usedAt !== null) {
    if (link.sessionId !== null && link.sessionId === limits.currentSession) {
      return { ok: true, already: true, ...who, sessionId: link.sessionId };
    }
    const ended =
      link.sessionId !== null &&
      (await revokeSession(tx, tenantId, link.sessionId, "system:sign-in-link-replay"));
    return {
      ok: false,
      refused: "used",
      ...who,
      ...(ended && link.sessionId !== null ? { endedSession: link.sessionId } : {}),
    };
  }
  if (!link.live) return { ok: false, refused: "expired", ...who };
  let session: Session & { token: string };
  try {
    session = await startSession(tx, tenantId, {
      userId: link.userId,
      provider: SIGN_IN_LINK_PROVIDER,
      issuer: SIGN_IN_LINK_ISSUER,
      subject: named.linkId,
      ...(limits.idleSeconds === undefined ? {} : { idleSeconds: limits.idleSeconds }),
      ...(limits.maxSeconds === undefined ? {} : { maxSeconds: limits.maxSeconds }),
    });
  } catch (e) {
    if (e instanceof IdentityError && ["inactive", "retired", "invalid"].includes(e.code)) {
      return { ok: false, refused: "inactive", ...who };
    }
    throw e;
  }
  await tx
    .update(signInLinks)
    .set({ usedAt: sql`greatest(now(), ${signInLinks.createdAt})`, sessionId: session.id })
    .where(and(eq(signInLinks.tenantId, tenantId), eq(signInLinks.id, named.linkId)));
  return { ok: true, userId: link.userId, linkId: named.linkId, session };
}
