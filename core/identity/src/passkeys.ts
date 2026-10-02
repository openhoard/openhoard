import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  invites,
  isId,
  newId,
  passkeyChallenges,
  passkeys,
  users,
  type Tx,
} from "@openhoard/core-db";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { endAccess, getUser, IdentityError, type EndedAccess, type User } from "./directory.js";
import { startSession, type Session } from "./sessions.js";
import {
  fromBase64Url,
  PASSKEY_ALGORITHMS,
  verifyAuthentication,
  verifyRegistration,
  WebAuthnError,
  type AuthenticationResponse,
  type Expected,
  type RegistrationResponse,
} from "./webauthn.js";

/*
 * Built-in accounts (T-108): how a person signs in to a server that has no identity provider.
 * An admin makes a local person and issues an invite; whoever opens the invite's link registers
 * a passkey for that person, and from then on the passkey signs them in.
 *
 * - Only local people have passkeys and invites. A SCIM person signs in through their identity
 *   provider, whose rules (MFA, conditional access) a passkey here would bypass.
 * - An invite's token is `ohi.<tenant id>.<invite id>.<secret>`, 32 random bytes of secret; only
 *   its SHA-256 is kept. It lives at most 7 days (the database's clock) and makes one passkey. A
 *   newer invite for the same person revokes the older, and so does any stop on them.
 * - A passkey is a discoverable credential whose user handle is `<tenant id>.<user id>`: the
 *   browser returns it with the assertion, which says where to look before anything is read.
 *   Sign-in needs no user name.
 * - Signing in starts a session recorded with provider `passkey`, issuer `openhoard:passkey` and
 *   the passkey's id as subject, so removing a passkey ends the sessions it signed in.
 * - The checks on what the browser returns are in webauthn.ts. The challenge is the server's to
 *   issue and keep for the ceremony (apps/server: a sealed cookie, as for a sign-in under way).
 *   It is answered once: the first answer that names a real invite or passkey records the
 *   challenge (spendChallenge()), whether or not the answer holds, and a later one with the same
 *   challenge is refused as a `replay`. So a copied request signs nobody in a second time.
 * - Lock order: the person's row first (as the stops take it), always. A sign-in then takes
 *   its passkey's row and the challenge; a registration the challenge, then the invite's row.
 *   The audit comes last.
 */

const SECRET_BYTES = 32;
const TOKEN =
  /^ohi\.(ten_[0-9a-hjkmnp-tv-z]{26})\.(inv_[0-9a-hjkmnp-tv-z]{26})\.([A-Za-z0-9_-]{43})$/;
const HANDLE = /^(ten_[0-9a-hjkmnp-tv-z]{26})\.(usr_[0-9a-hjkmnp-tv-z]{26})$/;
const ADMIN = /^(user|system):[^\0]{1,1000}$/;
const STOPPER = /^(user|system|scim):[^\0]{1,1000}$/;

/** The provider and issuer a passkey's sessions are recorded with. */
export const PASSKEY_PROVIDER = "passkey";
export const PASSKEY_ISSUER = "openhoard:passkey";
/** An invite's longest and default life (T-108: 7 days). */
export const INVITE_MAX_HOURS = 7 * 24;
/** Passkeys one person may hold. */
export const PASSKEY_MAX_PER_USER = 20;
/** Random bytes in a challenge. */
export const CHALLENGE_BYTES = 32;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const chars = (s: string) => [...s].length;

// ---------------------------------------------------------------------------------------------
// Invites

/** The tenant and invite a token names, or null when it isn't one. Checks nothing else. */
export function parseInvite(token: unknown): { tenantId: string; inviteId: string } | null {
  const m = typeof token === "string" ? TOKEN.exec(token) : null;
  return m?.[1] && m[2] ? { tenantId: m[1], inviteId: m[2] } : null;
}

/** Whether passkeys are for this person: a current, active, local person. Throws why not. */
function checkBuiltIn(user: User | null): User {
  if (!user || user.retired !== null) throw new IdentityError("not-found", "no such person");
  if (user.kind === "service") {
    throw new IdentityError("invalid", "a service account never signs in: it uses API keys");
  }
  if (user.source !== "local") {
    throw new IdentityError(
      "wrong-source",
      "they sign in through the identity provider: passkeys are for built-in accounts",
    );
  }
  if (!user.active) throw new IdentityError("inactive", "they are locked");
  return user;
}

/**
 * Issues an invite for a local person, revoking any earlier one of theirs not yet used. Returns
 * the token once: only its hash is kept.
 */
export async function issueInvite(
  tx: Tx,
  tenantId: string,
  input: { userId: string; by: string; hours?: number },
): Promise<{ id: string; token: string; expiresAt: Date; revoked: number }> {
  const hours = input.hours ?? INVITE_MAX_HOURS;
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > INVITE_MAX_HOURS) {
    throw new IdentityError("invalid", `an invite lives 1 to ${INVITE_MAX_HOURS} hours`);
  }
  if (!ADMIN.test(input.by)) throw new IdentityError("invalid", "by is user:… or system:…");
  // The person's row first, as a stop takes it: a lock running now finishes, and is seen.
  if (isId("user", input.userId)) await lockPerson(tx, tenantId, input.userId);
  const user = checkBuiltIn(
    isId("user", input.userId) ? await getUser(tx, tenantId, input.userId) : null,
  );
  const revoked = await revokeInvites(tx, tenantId, user.id, input.by);
  const id = newId("invite");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const [row] = await tx
    .insert(invites)
    .values({
      tenantId,
      id,
      userId: user.id,
      secretHash: sha256(secret),
      createdBy: input.by,
      expiresAt: sql`now() + make_interval(hours => ${hours})`,
    })
    .returning({ expiresAt: invites.expiresAt });
  if (!row) throw new Error("invite insert returned nothing");
  return { id, token: `ohi.${tenantId}.${id}.${secret}`, expiresAt: row.expiresAt, revoked };
}

/** Revokes a person's invites not yet used (a stop on them, or a newer invite); returns how many. */
export async function revokeInvites(
  tx: Tx,
  tenantId: string,
  userId: string,
  by: string,
): Promise<number> {
  if (!STOPPER.test(by)) throw new IdentityError("invalid", "by is a principal");
  const rows = await tx
    .update(invites)
    .set({ revokedAt: sql`greatest(now(), ${invites.createdAt})`, revokedBy: by })
    .where(
      and(
        eq(invites.tenantId, tenantId),
        eq(invites.userId, userId),
        isNull(invites.usedAt),
        isNull(invites.revokedAt),
      ),
    )
    .returning({ id: invites.id });
  return rows.length;
}

export type InviteRefusal =
  /** Not a token, another tenant's, or no such invite. */
  | "unknown"
  | "wrong-secret"
  | "expired"
  | "used"
  | "revoked"
  /** The person is locked, retired, or no longer a built-in account. */
  | "inactive";

export type InviteCheck =
  | { ok: true; inviteId: string; user: User }
  | { ok: false; refused: InviteRefusal; inviteId?: string; userId?: string };

/**
 * Whether an invite's token is good now, and whose it is. Writes nothing; with `lock` it takes
 * the invite's row for the transaction (registration), so two uses can't both pass.
 */
export async function checkInvite(
  tx: Tx,
  tenantId: string,
  token: unknown,
  options: { lock?: boolean } = {},
): Promise<InviteCheck> {
  const named = parseInvite(token);
  if (!named || named.tenantId !== tenantId) return { ok: false, refused: "unknown" };
  const query = tx
    .select({
      userId: invites.userId,
      secretHash: invites.secretHash,
      usedAt: invites.usedAt,
      revokedAt: invites.revokedAt,
      live: sql<boolean>`${invites.expiresAt} > now()`,
    })
    .from(invites)
    .where(and(eq(invites.tenantId, tenantId), eq(invites.id, named.inviteId)));
  const [invite] = await (options.lock ? query.for("update") : query);
  const secret = (token as string).slice((token as string).lastIndexOf(".") + 1);
  // Compared in constant time, and against something even when there is no invite.
  const same = timingSafeEqual(
    Buffer.from(sha256(secret), "hex"),
    Buffer.from(invite?.secretHash ?? "0".repeat(64), "hex"),
  );
  if (!invite) return { ok: false, refused: "unknown" };
  const who = { inviteId: named.inviteId, userId: invite.userId };
  if (!same) return { ok: false, refused: "wrong-secret", ...who };
  if (invite.usedAt !== null) return { ok: false, refused: "used", ...who };
  if (invite.revokedAt !== null) return { ok: false, refused: "revoked", ...who };
  if (!invite.live) return { ok: false, refused: "expired", ...who };
  let user: User;
  try {
    user = checkBuiltIn(await getUser(tx, tenantId, invite.userId));
  } catch (e) {
    if (e instanceof IdentityError) return { ok: false, refused: "inactive", ...who };
    throw e;
  }
  return { ok: true, inviteId: named.inviteId, user };
}

// ---------------------------------------------------------------------------------------------
// Challenges

/** How long an answered challenge is remembered: longer than any ceremony's cookie lives. */
export const CHALLENGE_MEMORY_SECONDS = 15 * 60;

/**
 * Records that a challenge was answered; returns false when it was answered before (a replay).
 * Call it once an answer names a real invite or passkey, before checking the answer, in the
 * transaction that will commit the outcome, and after locking the person (the lock order).
 * Forgets challenges too old to matter as it goes, without waiting for anyone else's.
 */
export async function spendChallenge(
  tx: Tx,
  tenantId: string,
  challenge: string,
): Promise<boolean> {
  // (An array, so the locking subquery runs once whatever plan is chosen: at most 100 rows.)
  const stale = tx
    .select({ hash: passkeyChallenges.challengeHash })
    .from(passkeyChallenges)
    .where(
      and(eq(passkeyChallenges.tenantId, tenantId), lt(passkeyChallenges.expiresAt, sql`now()`)),
    )
    .limit(100)
    .for("update", { skipLocked: true });
  await tx
    .delete(passkeyChallenges)
    .where(
      and(
        eq(passkeyChallenges.tenantId, tenantId),
        sql`${passkeyChallenges.challengeHash} = any(array(${stale}))`,
      ),
    );
  const spent = await tx
    .insert(passkeyChallenges)
    .values({
      tenantId,
      challengeHash: sha256(challenge),
      expiresAt: sql`now() + make_interval(secs => ${CHALLENGE_MEMORY_SECONDS})`,
    })
    .onConflictDoNothing()
    .returning({ hash: passkeyChallenges.challengeHash });
  return spent.length > 0;
}

/** The person's row, locked as the stops lock it: before anything of theirs is touched. */
async function lockPerson(tx: Tx, tenantId: string, userId: string, share = false): Promise<void> {
  const query = tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)));
  await (share ? query.for("key share") : query.for("update"));
}

// ---------------------------------------------------------------------------------------------
// What the browser is asked

/** A new challenge, base64url. */
export function newChallenge(): string {
  return randomBytes(CHALLENGE_BYTES).toString("base64url");
}

/** A passkey's user handle: where its person is, with nothing about who they are. */
export function userHandle(tenantId: string, userId: string): string {
  return Buffer.from(`${tenantId}.${userId}`).toString("base64url");
}

/** The tenant and person a user handle names, or null. */
export function parseUserHandle(handle: unknown): { tenantId: string; userId: string } | null {
  if (typeof handle !== "string" || handle.length > 128 || !/^[A-Za-z0-9_-]+$/.test(handle)) {
    return null;
  }
  const m = HANDLE.exec(Buffer.from(handle, "base64url").toString("utf8"));
  return m?.[1] && m[2] ? { tenantId: m[1], userId: m[2] } : null;
}

export interface RelyingParty {
  /** The server's origin's host. */
  id: string;
  /** What the authenticator shows: "OpenHoard". */
  name: string;
}

/**
 * What to pass `navigator.credentials.create()` (as JSON, the form
 * `PublicKeyCredential.parseCreationOptionsFromJSON()` reads): a discoverable credential, the
 * person verified, no attestation, and the person's existing passkeys excluded so one
 * authenticator holds one.
 */
export function registrationOptions(input: {
  rp: RelyingParty;
  tenantId: string;
  user: Pick<User, "id" | "email" | "displayName">;
  challenge: string;
  exclude: readonly { credentialId: string; transports: readonly string[] }[];
}): Record<string, unknown> {
  return {
    rp: input.rp,
    user: {
      id: userHandle(input.tenantId, input.user.id),
      name: input.user.email ?? input.user.displayName,
      displayName: input.user.displayName,
    },
    challenge: input.challenge,
    pubKeyCredParams: PASSKEY_ALGORITHMS.map((alg) => ({ type: "public-key", alg })),
    timeout: 300_000,
    excludeCredentials: input.exclude.map((c) => ({
      type: "public-key",
      id: c.credentialId,
      transports: c.transports,
    })),
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    },
    attestation: "none",
  };
}

/** What to pass `navigator.credentials.get()`: any passkey of this site, the person verified. */
export function authenticationOptions(input: {
  rpId: string;
  challenge: string;
}): Record<string, unknown> {
  return {
    challenge: input.challenge,
    rpId: input.rpId,
    timeout: 300_000,
    userVerification: "required",
    allowCredentials: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Passkeys

export interface Passkey {
  id: string;
  userId: string;
  name: string;
  /** base64url. */
  credentialId: string;
  transports: string[];
  /** Whether it can be synced between the person's devices, and is. */
  backupEligible: boolean;
  backedUp: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}

const SHOWN = {
  id: passkeys.id,
  userId: passkeys.userId,
  name: passkeys.name,
  credentialId: passkeys.credentialId,
  transports: passkeys.transports,
  backupEligible: passkeys.backupEligible,
  backedUp: passkeys.backedUp,
  createdAt: passkeys.createdAt,
  lastUsedAt: passkeys.lastUsedAt,
};

/** A person's passkeys, newest first. */
export async function listPasskeys(tx: Tx, tenantId: string, userId: string): Promise<Passkey[]> {
  return tx
    .select(SHOWN)
    .from(passkeys)
    .where(and(eq(passkeys.tenantId, tenantId), eq(passkeys.userId, userId)))
    .orderBy(desc(passkeys.createdAt), desc(passkeys.id));
}

function checkName(name: string | undefined): string {
  const trimmed = (name ?? "Passkey").normalize("NFC").trim();
  // eslint-disable-next-line no-control-regex
  if (chars(trimmed) < 1 || chars(trimmed) > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) {
    throw new IdentityError("invalid", "a passkey's name is 1 to 100 characters");
  }
  return trimmed;
}

export interface NewPasskey {
  userId: string;
  /** What `navigator.credentials.create()` returned, as JSON. */
  response: RegistrationResponse;
  expected: Expected;
  name?: string;
  inviteId?: string;
}

/**
 * Adds a passkey to a local person, after checking what the browser returned (WebAuthnError
 * when it doesn't hold). Refuses a credential someone already has (`conflict`), and more than
 * PASSKEY_MAX_PER_USER. Run it in a read-write transaction; the caller decided the person may
 * (an invite, or their own recent sign-in).
 */
export async function registerPasskey(
  tx: Tx,
  tenantId: string,
  input: NewPasskey,
): Promise<Passkey> {
  const name = checkName(input.name);
  if (!isId("user", input.userId)) throw new IdentityError("invalid", "invalid user id");
  const made = verifyRegistration(input.response, input.expected);
  // The person's row first: a stop running now finishes, and is seen.
  await lockPerson(tx, tenantId, input.userId);
  const user = checkBuiltIn(await getUser(tx, tenantId, input.userId));
  const [held] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(passkeys)
    .where(and(eq(passkeys.tenantId, tenantId), eq(passkeys.userId, user.id)));
  if ((held?.n ?? 0) >= PASSKEY_MAX_PER_USER) {
    throw new IdentityError("invalid", `a person holds at most ${PASSKEY_MAX_PER_USER} passkeys`);
  }
  const [row] = await tx
    .insert(passkeys)
    .values({
      tenantId,
      id: newId("passkey"),
      userId: user.id,
      credentialId: made.credentialId,
      publicKey: made.publicKey,
      algorithm: made.algorithm,
      signCount: made.signCount,
      transports: made.transports,
      backupEligible: made.backupEligible,
      backedUp: made.backedUp,
      aaguid: made.aaguid,
      name,
      inviteId: input.inviteId ?? null,
    })
    .onConflictDoNothing()
    .returning(SHOWN);
  if (!row) throw new IdentityError("conflict", "that passkey is registered already");
  return row;
}

export type PasskeyAddition =
  | { ok: true; passkey: Passkey }
  /** The challenge was answered before (nothing to audit: the first answer was). */
  | { ok: false; refused: "replay" }
  /** `reason`: a WebAuthnError's or an IdentityError's code. */
  | { ok: false; refused: "invalid-passkey"; reason: string };

/**
 * A signed-in person adds a passkey of their own: registerPasskey() with the challenge answered
 * once, in the lock order. A refusal leaves nothing written but the spent challenge, so the
 * caller can commit it with its audit record.
 */
export async function addPasskey(
  tx: Tx,
  tenantId: string,
  input: NewPasskey,
): Promise<PasskeyAddition> {
  if (!isId("user", input.userId)) throw new IdentityError("invalid", "invalid user id");
  await lockPerson(tx, tenantId, input.userId);
  if (!(await spendChallenge(tx, tenantId, input.expected.challenge))) {
    return { ok: false, refused: "replay" };
  }
  try {
    return { ok: true, passkey: await registerPasskey(tx, tenantId, input) };
  } catch (e) {
    if (e instanceof WebAuthnError || e instanceof IdentityError) {
      return { ok: false, refused: "invalid-passkey", reason: e.code };
    }
    throw e;
  }
}

export interface SessionLimits {
  idleSeconds?: number;
  maxSeconds?: number;
}

export type InviteAcceptance =
  | {
      ok: true;
      user: User;
      inviteId: string;
      passkey: Passkey;
      session: Session & { token: string };
    }
  | {
      ok: false;
      /** `replay`: this challenge was answered before (nothing to audit: the first answer was). */
      refused: InviteRefusal | "invalid-passkey" | "replay";
      /** Why the browser's answer didn't hold (a WebAuthnError's code, or `conflict`). */
      reason?: string;
      inviteId?: string;
      userId?: string;
    };

/**
 * Uses an invite: registers the passkey the browser made for the invite's person, marks the
 * invite used and signs them in. `challengeFor` is the invite the challenge was issued for: a
 * token naming any other invite is refused as `unknown` before anything is read. A passkey that doesn't check out leaves the invite
 * unused, to try again.
 */
export async function acceptInvite(
  tx: Tx,
  tenantId: string,
  input: {
    token: string;
    challengeFor: string;
    response: RegistrationResponse;
    expected: Expected;
    name?: string;
  },
  limits: SessionLimits = {},
): Promise<InviteAcceptance> {
  // The challenge was issued for one invite: with another's token it is nothing, and touches
  // nothing of that other invite's person (no lock, no challenge spent, nothing to audit).
  if (parseInvite(input.token)?.inviteId !== input.challengeFor) {
    return { ok: false, refused: "unknown" };
  }
  // Whose it is, then their row, the challenge, and the invite's row (the order the stops take
  // them in), with the invite checked again once nothing can change it.
  const first = await checkInvite(tx, tenantId, input.token);
  if (!first.ok && first.userId === undefined) return first;
  const userId = first.ok ? first.user.id : (first.userId as string);
  await lockPerson(tx, tenantId, userId);
  // A real invite is named: this answer is the challenge's one answer, whatever it turns out to
  // be, so a refusal can't be sent again and again into the audit log.
  if (!(await spendChallenge(tx, tenantId, input.expected.challenge))) {
    return { ok: false, refused: "replay" };
  }
  if (!first.ok) return first;
  const invite = await checkInvite(tx, tenantId, input.token, { lock: true });
  if (!invite.ok) return invite;
  const who = { inviteId: invite.inviteId, userId: invite.user.id };
  let passkey: Passkey;
  try {
    // Everything that can refuse does so before the passkey's row is written, so a refusal
    // returned from here (which commits) leaves nothing behind.
    passkey = await registerPasskey(tx, tenantId, {
      userId: invite.user.id,
      response: input.response,
      expected: input.expected,
      inviteId: invite.inviteId,
      ...(input.name === undefined ? {} : { name: input.name }),
    });
  } catch (e) {
    if (e instanceof WebAuthnError) {
      return { ok: false, refused: "invalid-passkey", reason: e.code, ...who };
    }
    if (e instanceof IdentityError) {
      return ["inactive", "retired", "not-found", "wrong-source"].includes(e.code)
        ? { ok: false, refused: "inactive", ...who }
        : { ok: false, refused: "invalid-passkey", reason: e.code, ...who };
    }
    throw e;
  }
  // registerPasskey() holds the person's row and saw them active: this throws only on a bug, and
  // then the transaction (and the passkey) rolls back.
  const session = await startSession(tx, tenantId, {
    userId: invite.user.id,
    provider: PASSKEY_PROVIDER,
    issuer: PASSKEY_ISSUER,
    subject: passkey.id,
    ...limits,
  });
  await tx
    .update(invites)
    .set({ usedAt: sql`greatest(now(), ${invites.createdAt})`, passkeyId: passkey.id })
    .where(and(eq(invites.tenantId, tenantId), eq(invites.id, invite.inviteId)));
  return { ok: true, user: invite.user, inviteId: invite.inviteId, passkey, session };
}

export type PasskeyRefusal =
  /** No such passkey in the tenant its user handle names, or the handle isn't its person's. */
  | "unknown"
  /** The assertion doesn't check out (`reason`: a WebAuthnError's code). */
  | "invalid"
  /** The person is locked, retired, or no longer a built-in account. */
  | "inactive"
  /** This challenge was answered before (nothing to audit: the first answer was). */
  | "replay";

export type PasskeySignIn =
  | { ok: true; userId: string; passkeyId: string; session: Session & { token: string } }
  | { ok: false; refused: PasskeyRefusal; reason?: string; passkeyId?: string; userId?: string };

/**
 * Signs a person in with a passkey: finds the credential the assertion names in `tenantId` (the
 * tenant its user handle names; the caller parsed it), checks the assertion, records the
 * counter and the use, and starts a session. Run it in a read-write transaction.
 */
export async function signInWithPasskey(
  tx: Tx,
  tenantId: string,
  input: { response: AuthenticationResponse; expected: Expected },
  limits: SessionLimits = {},
): Promise<PasskeySignIn> {
  const assertion = input.response as Partial<AuthenticationResponse> | null;
  const handle = parseUserHandle(assertion?.response?.userHandle);
  let credentialId: string;
  try {
    credentialId = fromBase64Url(assertion?.id, "id", 1023).toString("base64url");
  } catch {
    return { ok: false, refused: "unknown" };
  }
  if (!handle || handle.tenantId !== tenantId) return { ok: false, refused: "unknown" };
  // The person's row first (shared: sign-ins don't queue behind each other), as the stops and
  // removePasskey() take it, then the passkey's.
  await lockPerson(tx, tenantId, handle.userId, true);
  const [stored] = await tx
    .select({
      id: passkeys.id,
      userId: passkeys.userId,
      publicKey: passkeys.publicKey,
      algorithm: passkeys.algorithm,
      signCount: passkeys.signCount,
      backupEligible: passkeys.backupEligible,
    })
    .from(passkeys)
    .where(and(eq(passkeys.tenantId, tenantId), eq(passkeys.credentialId, credentialId)))
    .for("update");
  if (!stored || stored.userId !== handle.userId) return { ok: false, refused: "unknown" };
  const who = { passkeyId: stored.id, userId: stored.userId };
  if (!(await spendChallenge(tx, tenantId, input.expected.challenge))) {
    return { ok: false, refused: "replay" };
  }
  let checked: { signCount: number; backedUp: boolean };
  try {
    checked = verifyAuthentication(input.response, stored, input.expected);
  } catch (e) {
    if (e instanceof WebAuthnError)
      return { ok: false, refused: "invalid", reason: e.code, ...who };
    throw e;
  }
  let session: Session & { token: string };
  try {
    checkBuiltIn(await getUser(tx, tenantId, stored.userId));
    session = await startSession(tx, tenantId, {
      userId: stored.userId,
      provider: PASSKEY_PROVIDER,
      issuer: PASSKEY_ISSUER,
      subject: stored.id,
      ...limits,
    });
  } catch (e) {
    if (e instanceof IdentityError) return { ok: false, refused: "inactive", ...who };
    throw e;
  }
  await tx
    .update(passkeys)
    .set({
      signCount: checked.signCount,
      backedUp: checked.backedUp,
      lastUsedAt: sql`greatest(now(), ${passkeys.createdAt})`,
    })
    .where(and(eq(passkeys.tenantId, tenantId), eq(passkeys.id, stored.id)));
  return { ok: true, ...who, session };
}

/**
 * Removes a person's passkey, and ends the sessions it signed in and the grants AI clients hold
 * for them (as unlinking an identity does); `by` is who did it. Returns what ended, or null if
 * they have no such passkey.
 */
export async function removePasskey(
  tx: Tx,
  tenantId: string,
  userId: string,
  passkeyId: string,
  by: string,
): Promise<EndedAccess | null> {
  if (!ADMIN.test(by)) throw new IdentityError("invalid", "by is user:… or system:…");
  if (!isId("user", userId) || !isId("passkey", passkeyId)) return null;
  // The person first (as a sign-in takes them): one running now finishes, then its session ends.
  await lockPerson(tx, tenantId, userId);
  const removed = await tx
    .delete(passkeys)
    .where(
      and(eq(passkeys.tenantId, tenantId), eq(passkeys.id, passkeyId), eq(passkeys.userId, userId)),
    )
    .returning({ id: passkeys.id });
  if (removed.length === 0) return null;
  return endAccess(tx, tenantId, userId, by, { issuer: PASSKEY_ISSUER, subject: passkeyId });
}
