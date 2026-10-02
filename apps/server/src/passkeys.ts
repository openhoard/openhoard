import type { AuditRecord } from "@openhoard/core-audit";
import type { Database, Tx } from "@openhoard/core-db";
import {
  acceptInvite,
  addPasskey,
  authenticationOptions,
  checkInvite,
  getUser,
  listPasskeys,
  newChallenge,
  parseInvite,
  parseUserHandle,
  PASSKEY_PROVIDER,
  registrationOptions,
  removePasskey,
  signInWithPasskey,
  userPrincipal,
  type AuthenticationResponse,
  type InviteRefusal,
  type Passkey,
  type RegistrationResponse,
  type Session,
} from "@openhoard/core-identity";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Logger } from "pino";
import type { AuthEnv, SignedIn } from "./auth.js";
import { relyingPartyId, type AuthConfig } from "./config.js";
import { seal, unseal } from "./login-state.js";
import { invitePage, PASSKEY_SCRIPT } from "./oauth/pages.js";

/*
 * Passkeys for built-in accounts (T-108), with `auth.passkeys`: a local person signs in with a
 * passkey, made the first time from an invite an admin issued (`openhoard admin user invite`).
 *
 *   GET    /auth/invite                    an invite's page (the token rides in the fragment)
 *   GET    /auth/passkey.js                the script that page and the sign-in page run
 *   POST   /auth/passkey/register/options  what to make a passkey with (an invite, or signed in)
 *   POST   /auth/passkey/register          the passkey made: stored; an invite signs its person in
 *   POST   /auth/passkey/options           what to sign in with
 *   POST   /auth/passkey                   the assertion: starts a session
 *   GET    /auth/passkeys                  the signed-in person's passkeys
 *   DELETE /auth/passkeys/:id              removes one (and the sessions it signed in)
 *
 * - The relying party is this server: its id is publicUrl's host, and the origin every
 *   ceremony must come from is publicUrl's. The checks are core/identity's (webauthn.ts).
 * - A ceremony's challenge lives in a sealed cookie of its own (login-state.ts), for 5 minutes,
 *   bound to what it was issued for (which invite, or which session). Asking for options writes
 *   nothing on the server. An answer that names a real invite or passkey records the challenge
 *   as answered (core/identity spendChallenge()), so the same cookie and answer sent again (a
 *   copied request) is refused; the cookie is cleared when its ceremony finishes, either way.
 * - An invite's token is in the link's fragment, which browsers send to no server: it reaches
 *   this one only in the body of the two registration requests, never in a URL or a log.
 * - Every POST here must come from this origin, signed in or not.
 * - A signed-in person adds or removes a passkey only with a recent sign-in
 *   (auth.adminSignInMinutes): a session left open, or stolen later, can't be turned into a way
 *   back in, or lock its person out.
 * - Audited: `passkey.register` and `passkey.remove`, and `auth.sign-in` with provider
 *   `passkey`, allowed or refused, once a real invite or passkey is named.
 */

export interface PasskeyDeps {
  auth: AuthConfig;
  db: Database;
  log?: Logger;
  key: Buffer;
  sameOrigin: (origin: string | undefined, site: string | undefined) => boolean;
  /** Sets the session cookie, and ends the session the browser had before. */
  signedIn: (c: Context<AuthEnv>, session: Session & { token: string }) => Promise<void>;
  audit: (tx: Tx, tenantId: string, record: AuditRecord) => Promise<unknown>;
  returnPath: (asked: string | undefined) => string;
}

const PURPOSE = "openhoard/passkey/v1";
const CEREMONY_SECONDS = 300;
const FAILED = { error: "sign-in failed" } as const;
const NO_STORE = { "cache-control": "no-store" } as const;

/** A ceremony under way, as its cookie holds it. */
interface Ceremony {
  kind: "register" | "sign-in";
  challenge: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  /** Registration: whose passkey, and what allowed it (an invite, or their session). */
  tenantId?: string;
  userId?: string;
  inviteId?: string;
  sessionId?: string;
}

/** Why an invite its holder presented can't be used, said only to someone who holds it. */
const INVITE_REASONS: readonly InviteRefusal[] = ["used", "expired", "revoked", "inactive"];

export function mountPasskeys(app: Hono<AuthEnv>, deps: PasskeyDeps): void {
  const { auth, db, log, key, audit } = deps;
  const origin = new URL(auth.publicUrl).origin;
  const secure = new URL(auth.publicUrl).protocol === "https:";
  const rp = { id: relyingPartyId(auth.publicUrl), name: "OpenHoard" };
  const limits = {
    idleSeconds: auth.sessionIdleMinutes * 60,
    maxSeconds: auth.sessionMaxHours * 3600,
  };
  const cookieName = (kind: Ceremony["kind"]) =>
    `${secure ? "__Secure-" : ""}oh_passkey_${kind === "register" ? "new" : "use"}`;
  const cookieOptions = { path: "/auth/passkey", secure } as const;

  const begin = (c: Context<AuthEnv>, ceremony: Omit<Ceremony, "challenge" | "expiresAt">) => {
    const challenge = newChallenge();
    const state: Ceremony = {
      ...ceremony,
      challenge,
      expiresAt: Date.now() + CEREMONY_SECONDS * 1000,
    };
    setCookie(c, cookieName(ceremony.kind), seal(key, PURPOSE, state), {
      ...cookieOptions,
      httpOnly: true,
      sameSite: "Strict",
      maxAge: CEREMONY_SECONDS,
    });
    return challenge;
  };

  /** The ceremony this browser began, taken from its cookie: a challenge is used once. */
  const finish = (c: Context<AuthEnv>, kind: Ceremony["kind"]): Ceremony | null => {
    const sealed = getCookie(c, cookieName(kind));
    deleteCookie(c, cookieName(kind), cookieOptions);
    const state = sealed === undefined ? null : (unseal(key, PURPOSE, sealed) as Ceremony | null);
    if (
      typeof state !== "object" ||
      state === null ||
      state.kind !== kind ||
      typeof state.challenge !== "string" ||
      typeof state.expiresAt !== "number" ||
      state.expiresAt <= Date.now()
    ) {
      return null;
    }
    return state;
  };

  const recent = (signedIn: SignedIn): boolean =>
    Date.now() - signedIn.signedInAt.getTime() <= auth.adminSignInMinutes * 60_000;

  /** The JSON object a request carries, or null. */
  const jsonBody = async (c: Context<AuthEnv>): Promise<Record<string, unknown> | null> => {
    const type = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") return null;
    const body: unknown = await c.req.json().catch(() => null);
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  };

  const shown = (p: Passkey) => ({
    id: p.id,
    name: p.name,
    createdAt: p.createdAt.toISOString(),
    lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
    synced: p.backedUp,
  });

  app.get("/auth/invite", (c) => {
    const page = invitePage();
    c.header("content-security-policy", page.csp);
    c.header("cache-control", "no-store");
    return c.html(page.html);
  });

  app.get("/auth/passkey.js", (c) =>
    c.body(PASSKEY_SCRIPT, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );

  // The four ceremony routes (the pattern covers /auth/passkey itself too, and neither
  // /auth/passkeys nor /auth/passkey.js).
  app.use(
    "/auth/passkey/*",
    bodyLimit({ maxSize: 65536, onError: (c) => c.json({ error: "body too large" }, 413) }),
  );
  // Every ceremony starts and ends on this origin, whoever is (or isn't) signed in.
  app.post("/auth/passkey/*", async (c, next) => {
    c.header("cache-control", "no-store");
    if (!deps.sameOrigin(c.req.header("origin"), c.req.header("sec-fetch-site"))) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  });

  app.post("/auth/passkey/register/options", async (c) => {
    const body = await jsonBody(c);
    if (!body) return c.json(FAILED, 400);
    if (body.invite !== undefined) {
      const named = parseInvite(body.invite);
      if (!named) return c.json(FAILED, 401);
      const { tenantId } = named;
      const found = await db.withTenant(tenantId, async (tx) => {
        const invite = await checkInvite(tx, tenantId, body.invite);
        return invite.ok
          ? { invite, held: await listPasskeys(tx, tenantId, invite.user.id) }
          : { invite };
      });
      if (!found.invite.ok) {
        // Why, only to someone who holds the invite (its secret was right).
        const refused = found.invite.refused;
        return c.json(
          INVITE_REASONS.includes(refused) ? { ...FAILED, reason: refused } : FAILED,
          401,
        );
      }
      const { user, inviteId } = found.invite;
      const challenge = begin(c, { kind: "register", tenantId, userId: user.id, inviteId });
      return c.json(
        registrationOptions({ rp, tenantId, user, challenge, exclude: found.held ?? [] }),
      );
    }
    const signedIn = c.get("auth");
    if (!signedIn) return c.json({ error: "not signed in" }, 401);
    if (!recent(signedIn)) {
      return c.json({ error: "sign in again to do this", signIn: "/auth/sign-in" }, 403);
    }
    const { tenantId } = signedIn;
    const userId = signedIn.principal.userId;
    const found = await db.withTenant(tenantId, async (tx) => {
      const user = await getUser(tx, tenantId, userId);
      return user && user.source === "local" && user.kind !== "service"
        ? { user, held: await listPasskeys(tx, tenantId, userId) }
        : null;
    });
    if (!found) {
      return c.json(
        { error: "passkeys are for built-in accounts: you sign in through your identity provider" },
        403,
      );
    }
    const challenge = begin(c, {
      kind: "register",
      tenantId,
      userId,
      sessionId: signedIn.sessionId,
    });
    return c.json(
      registrationOptions({ rp, tenantId, user: found.user, challenge, exclude: found.held }),
    );
  });

  app.post("/auth/passkey/register", async (c) => {
    const ceremony = finish(c, "register");
    const body = await jsonBody(c);
    if (!ceremony || !body || !ceremony.tenantId || !ceremony.userId) return c.json(FAILED, 400);
    const { tenantId, userId } = ceremony;
    const expected = { challenge: ceremony.challenge, origin, rpId: rp.id };
    const response = body.response as RegistrationResponse;
    const name = typeof body.name === "string" ? body.name : undefined;

    if (ceremony.inviteId !== undefined) {
      const { inviteId } = ceremony;
      const token = body.invite;
      const named = parseInvite(token);
      // The invite this ceremony began with, and no other (acceptInvite() holds to that too).
      if (
        !named ||
        typeof token !== "string" ||
        named.tenantId !== tenantId ||
        named.inviteId !== inviteId
      ) {
        return c.json(FAILED, 401);
      }
      const done = await db.withTenant(tenantId, async (tx) => {
        const result = await acceptInvite(
          tx,
          tenantId,
          {
            token,
            challengeFor: inviteId,
            response,
            expected,
            ...(name === undefined ? {} : { name }),
          },
          limits,
        );
        // Audit last: its lock is the last one taken (core/audit).
        if (result.ok) {
          await audit(tx, tenantId, {
            actor: userPrincipal(result.user.id),
            action: "passkey.register",
            decision: "allow",
            detail: { passkey: result.passkey.id, invite: result.inviteId },
          });
          await audit(tx, tenantId, {
            actor: userPrincipal(result.user.id),
            action: "auth.sign-in",
            decision: "allow",
            detail: {
              provider: PASSKEY_PROVIDER,
              passkey: result.passkey.id,
              session: result.session.id,
              invite: result.inviteId,
            },
          });
        } else if (result.inviteId !== undefined) {
          await audit(tx, tenantId, {
            actor: result.userId ? userPrincipal(result.userId) : `${PASSKEY_PROVIDER}:unknown`,
            action: "passkey.register",
            decision: "deny",
            detail: {
              invite: result.inviteId,
              reason: result.refused,
              ...(result.reason ? { why: result.reason } : {}),
            },
          });
        }
        return result;
      });
      if (!done.ok) {
        const told = (INVITE_REASONS as readonly string[]).includes(done.refused);
        return c.json(told ? { ...FAILED, reason: done.refused } : FAILED, 401);
      }
      await deps.signedIn(c, done.session);
      return c.json({ ok: true, passkey: shown(done.passkey) });
    }

    // Their own, added signed in: by the session the challenge was issued to, still recent.
    const signedIn = c.get("auth");
    if (
      !signedIn ||
      signedIn.tenantId !== tenantId ||
      signedIn.principal.userId !== userId ||
      signedIn.sessionId !== ceremony.sessionId
    ) {
      return c.json({ error: "not signed in" }, 401);
    }
    if (!recent(signedIn)) {
      return c.json({ error: "sign in again to do this", signIn: "/auth/sign-in" }, 403);
    }
    const actor = userPrincipal(userId);
    const done = await db.withTenant(tenantId, async (tx) => {
      const result = await addPasskey(tx, tenantId, {
        userId,
        response,
        expected,
        ...(name === undefined ? {} : { name }),
      });
      // Audit last. A copy of a request already answered audits nothing more.
      if (result.ok || result.refused !== "replay") {
        await audit(tx, tenantId, {
          actor,
          action: "passkey.register",
          decision: result.ok ? "allow" : "deny",
          detail: {
            ...(result.ok ? { passkey: result.passkey.id } : { reason: result.reason }),
            session: signedIn.sessionId,
          },
        });
      }
      return result;
    });
    if (done.ok) return c.json({ ok: true, passkey: shown(done.passkey) });
    if (done.refused === "replay") return c.json(FAILED, 400);
    const conflict = done.reason === "conflict";
    return c.json(
      { error: conflict ? "that passkey is registered already" : "that passkey can't be used" },
      conflict ? 409 : 400,
    );
  });

  app.post("/auth/passkey/options", (c) => {
    const challenge = begin(c, { kind: "sign-in" });
    return c.json(authenticationOptions({ rpId: rp.id, challenge }));
  });

  app.post("/auth/passkey", async (c) => {
    const ceremony = finish(c, "sign-in");
    const body = await jsonBody(c);
    if (!ceremony || !body) return c.json(FAILED, 400);
    const response = body.response as AuthenticationResponse;
    // The passkey's user handle says which tenant to look in.
    const handle = parseUserHandle(
      (response as { response?: { userHandle?: unknown } } | null)?.response?.userHandle,
    );
    if (!handle) return c.json(FAILED, 401);
    const { tenantId } = handle;
    const done = await db.withTenant(tenantId, async (tx) => {
      const result = await signInWithPasskey(
        tx,
        tenantId,
        { response, expected: { challenge: ceremony.challenge, origin, rpId: rp.id } },
        limits,
      );
      // Audit last, and only once a real passkey is named: guesses fill no audit log.
      if (result.ok) {
        await audit(tx, tenantId, {
          actor: userPrincipal(result.userId),
          action: "auth.sign-in",
          decision: "allow",
          detail: {
            provider: PASSKEY_PROVIDER,
            passkey: result.passkeyId,
            session: result.session.id,
          },
        });
      } else if (result.passkeyId !== undefined && result.userId !== undefined) {
        await audit(tx, tenantId, {
          actor: userPrincipal(result.userId),
          action: "auth.sign-in",
          decision: "deny",
          detail: {
            provider: PASSKEY_PROVIDER,
            passkey: result.passkeyId,
            reason: result.refused,
            ...(result.reason ? { why: result.reason } : {}),
          },
        });
      }
      return result;
    });
    if (!done.ok) {
      if (done.refused === "unknown") log?.info("passkey sign-in: no such passkey");
      return c.json(FAILED, 401);
    }
    await deps.signedIn(c, done.session);
    return c.json({
      ok: true,
      returnTo: deps.returnPath(typeof body.return_to === "string" ? body.return_to : undefined),
    });
  });

  app.get("/auth/passkeys", async (c) => {
    const signedIn = c.get("auth");
    if (!signedIn) return c.json({ error: "not signed in" }, 401);
    const held = await db.withTenant(signedIn.tenantId, (tx) =>
      listPasskeys(tx, signedIn.tenantId, signedIn.principal.userId),
    );
    return c.json({ passkeys: held.map(shown) }, 200, NO_STORE);
  });

  // (The session cookie's own check, in auth.ts, already refused another site's request.)
  app.delete("/auth/passkeys/:id", async (c) => {
    const signedIn = c.get("auth");
    if (!signedIn) return c.json({ error: "not signed in" }, 401);
    // As for adding one: an old session, left open or stolen, can't lock its person out.
    if (!recent(signedIn)) {
      return c.json({ error: "sign in again to do this", signIn: "/auth/sign-in" }, 403, NO_STORE);
    }
    const { tenantId } = signedIn;
    const userId = signedIn.principal.userId;
    const passkeyId = c.req.param("id");
    const actor = userPrincipal(userId);
    const ended = await db.withTenant(tenantId, async (tx) => {
      const result = await removePasskey(tx, tenantId, userId, passkeyId, actor);
      if (result) {
        await audit(tx, tenantId, {
          actor,
          action: "passkey.remove",
          decision: "allow",
          detail: {
            passkey: passkeyId,
            sessionsEnded: result.sessions,
            oauthGrantsRevoked: result.oauthGrants,
            oauthCodesUsedUp: result.oauthCodes,
          },
        });
      }
      return result;
    });
    if (!ended) return c.json({ error: "not found" }, 404, NO_STORE);
    return c.body(null, 204, NO_STORE);
  });
}
