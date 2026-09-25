import { domainToASCII } from "node:url";
import {
  apiKeys,
  grants,
  groupMembers,
  grantSetOf,
  groups,
  IDENTITY_SOURCES,
  liveGrants,
  lockPrincipals,
  newId,
  sqlState,
  USER_KINDS,
  userIdentities,
  users,
  type Tx,
  sessions,
  oauthGrants,
} from "@openhoard/core-db";
import type { AuthzPrincipal } from "@openhoard/core-policy";
import { and, asc, eq, gt, isNull, ne, sql } from "drizzle-orm";

/*
 * The directory (T-101): the tenant's people and groups, and what a signed-in person is to the
 * rest of the core. Everything else asks here, never the tables.
 *
 * Two sources keep it: the identity provider over SCIM (T-103), and OpenHoard itself, for teams
 * without one (invitations T-108, groups T-110). Each user and group belongs to one source, and
 * only that source may change it: a SCIM-managed group can't be edited in OpenHoard, where the
 * next sync would silently undo it, and SCIM can't touch local ones.
 *
 * A user is active unless something stops them, and each stop has one owner:
 *
 * | stop              | set and lifted by                 | for                                   |
 * | ----------------- | --------------------------------- | ------------------------------------- |
 * | lock              | an admin or the system (`user:`, `system:`) | an investigation, an emergency |
 * | provider disable  | SCIM (`scim:`), SCIM users only   | the identity provider deactivated them |
 * | retirement        | SCIM for SCIM users, else an admin; final | they left; frees the email     |
 *
 * The stops are independent, so a sync re-activating a user doesn't lift an admin's lock, and
 * lifting a lock doesn't bring back someone the identity provider deactivated.
 *
 * Who may call these is the API's question (admins, the SCIM endpoint); they trust the caller
 * and record who acted.
 *
 * An admin who wants a SCIM user gone for good locks them and removes them upstream: if an admin
 * could retire them, the identity provider would simply create them again on the next sync.
 * The SCIM endpoint (T-103) maps a soft delete (the user can be restored upstream) to
 * setProviderActive(false), and only a hard delete to retireUser().
 *
 * Sign-in matches people by (issuer, subject) through linkIdentity() / findUserByIdentity(),
 * never by email: an email is a label a person can change, and a key two people may briefly
 * share.
 */

export type IdentitySource = (typeof IDENTITY_SOURCES)[number];
export type UserKind = (typeof USER_KINDS)[number];

/** Who set a stop, and when. */
export interface Stop {
  at: Date;
  by: string;
}

export interface User {
  id: string;
  /** A person's address; null for a service account. */
  email: string | null;
  displayName: string;
  kind: UserKind;
  /** No lock, no provider disable, not retired. */
  active: boolean;
  source: IdentitySource;
  externalId: string | null;
  createdAt: Date;
  lock: Stop | null;
  providerDisabled: Stop | null;
  retired: Stop | null;
}

export interface Group {
  id: string;
  name: string;
  source: IdentitySource;
  externalId: string | null;
  createdAt: Date;
}

export type IdentityErrorCode =
  | "invalid"
  | "not-found"
  | "conflict"
  | "wrong-source"
  | "retired"
  /** Locked or disabled by the identity provider. */
  | "inactive";

export class IdentityError extends Error {
  constructor(
    readonly code: IdentityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IdentityError";
  }
}

export const userPrincipal = (userId: string): string => `user:${userId}`;
export const groupPrincipal = (groupId: string): string => `group:${groupId}`;

const chars = (s: string) => [...s].length;

/**
 * An email address as matched: trimmed, Unicode NFC, the local part in lower case, the domain
 * in lower-case ASCII (IDNA), so `Ana@Bücher.de` and `ana@xn--bcher-kva.de` are one address.
 * (Case folding happens here, not in the database: spike S2.) Returns "" for something that
 * isn't an address.
 */
export function emailKey(email: string): string {
  const e = email.trim().normalize("NFC");
  const at = e.lastIndexOf("@");
  if (at < 1 || at === e.length - 1) return "";
  const domain = asciiDomain(e.slice(at + 1));
  return domain === "" ? "" : `${e.slice(0, at).toLowerCase()}@${domain}`;
}

/** Letters, marks, digits and hyphens in labels joined by ASCII dots; nothing else. */
const DOMAIN_INPUT = /^[\p{L}\p{M}\p{N}-]+(?:\.[\p{L}\p{M}\p{N}-]+)+$/u;
const ASCII_DOMAIN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A domain as lower-case ASCII (IDNA), or "" unless it is a plain host name. URL host parsing
 * alone would accept percent-escapes, other scripts' full stops, IP addresses and a trailing
 * dot, each of which gives one mailbox several spellings.
 */
function asciiDomain(domain: string): string {
  if (!DOMAIN_INPUT.test(domain)) return "";
  const ascii = domainToASCII(domain);
  return ASCII_DOMAIN.test(ascii) && chars(ascii) <= 253 ? ascii : "";
}

const EMAIL = /^[^\s@]+@[^\s@]+$/u;
/** Control, format (zero-width), private-use, unassigned and surrogate code points. */
const INVISIBLE = /\p{C}/u;

/**
 * Checks an email and returns it trimmed with its key. Refused: invisible characters (which make
 * two identical-looking addresses), compatibility characters such as the Kelvin sign that fold
 * into ASCII letters (which make two different-looking addresses one key), and anything
 * whose key isn't 3 to 320 characters.
 */
/**
 * A non-ASCII character that normalizes into ASCII, like the Kelvin sign (K) or a fullwidth
 * letter: it would give a different-looking address the key of an ASCII one.
 */
const foldsIntoAscii = (c: string) =>
  (c.codePointAt(0) ?? 0) > 0x7f && /^[\x20-\x7e]+$/.test(c.normalize("NFKC"));

function checkEmail(email: string): { email: string; key: string } {
  const trimmed = email.trim();
  const nfc = trimmed.normalize("NFC");
  const key = emailKey(trimmed);
  if (
    !EMAIL.test(trimmed) ||
    INVISIBLE.test(trimmed) ||
    trimmed.normalize("NFKC") !== nfc ||
    [...trimmed].some(foldsIntoAscii) ||
    chars(trimmed) > 320 ||
    chars(key) < 3 ||
    chars(key) > 320
  ) {
    throw new IdentityError("invalid", "not a usable email address");
  }
  return { email: trimmed, key };
}

function checkName(what: string, name: string): string {
  const trimmed = name.trim();
  if (trimmed === "" || chars(trimmed) > 256 || INVISIBLE.test(trimmed.replace(/\s/gu, ""))) {
    throw new IdentityError("invalid", `${what} must be 1 to 256 visible characters`);
  }
  return trimmed;
}

/**
 * An external id for a user or group of `source`. It is the identity provider's id, so only
 * SCIM records have one (the database checks that too).
 */
function checkExternalId(id: string | undefined | null, source: IdentitySource): string | null {
  if (id === undefined || id === null) return null;
  if (source !== "scim") {
    throw new IdentityError("invalid", "only SCIM users and groups have an externalId");
  }
  if (typeof id !== "string" || id.length < 1 || chars(id) > 512 || /\p{Cc}/u.test(id)) {
    throw new IdentityError("invalid", "externalId must be 1 to 512 characters");
  }
  return id;
}

function checkSource(source: unknown): IdentitySource {
  if (!(IDENTITY_SOURCES as readonly unknown[]).includes(source)) {
    throw new IdentityError("invalid", `not an identity source: ${String(source)}`);
  }
  return source as IdentitySource;
}

/** What a person can be. A service account is made as one and stays one. */
export type PersonKind = Exclude<UserKind, "service">;

function checkKind(kind: unknown): PersonKind {
  if (kind === "service") {
    throw new IdentityError("invalid", "a service account is made with createServiceAccount()");
  }
  if (!(USER_KINDS as readonly unknown[]).includes(kind)) {
    throw new IdentityError("invalid", `not a user kind: ${String(kind)}`);
  }
  return kind as PersonKind;
}

/** Who may act on users: `user:` and `system:` are admins, `scim:` the identity provider. */
type Actor = "user" | "system" | "scim";
function checkActor(by: string, allowed: readonly Actor[]): Actor {
  const match = /^([a-z]+):.+$/s.exec(by);
  const kind = match?.[1] as Actor | undefined;
  if (kind === undefined || !allowed.includes(kind)) {
    throw new IdentityError("invalid", `${by} can't do this; expected ${allowed.join(":, ")}:`);
  }
  return kind;
}

type UserRow = typeof users.$inferSelect;
const stop = (at: Date | null, by: string | null): Stop | null =>
  at !== null && by !== null ? { at, by } : null;
const toUser = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  displayName: r.displayName,
  kind: r.kind,
  active: r.lockedAt === null && r.providerDisabledAt === null && r.retiredAt === null,
  source: r.source,
  externalId: r.externalId,
  createdAt: r.createdAt,
  lock: stop(r.lockedAt, r.lockedBy),
  providerDisabled: stop(r.providerDisabledAt, r.providerDisabledBy),
  retired: stop(r.retiredAt, r.retiredBy),
});
type GroupRow = typeof groups.$inferSelect;
const toGroup = (r: GroupRow): Group => ({
  id: r.id,
  name: r.name,
  source: r.source,
  externalId: r.externalId,
  createdAt: r.createdAt,
});

export interface NewUser {
  email: string;
  displayName: string;
  /** Defaults to `member`. A service account is made with createServiceAccount(). */
  kind?: PersonKind;
  source: IdentitySource;
  /** The identity provider's id: SCIM users should have one, local users can't. */
  externalId?: string;
}

/** Adds a user. Refuses an email or external id a current user has (`conflict`). */
export async function createUser(tx: Tx, tenantId: string, input: NewUser): Promise<User> {
  const { email, key } = checkEmail(input.email);
  const source = checkSource(input.source);
  const row = {
    tenantId,
    id: newId("user"),
    email,
    emailKey: key,
    displayName: checkName("displayName", input.displayName),
    kind: checkKind(input.kind ?? "member"),
    source,
    externalId: checkExternalId(input.externalId, source),
  };
  // No conflict target: any unique key (email or external id) makes this a no-op, and a no-op
  // leaves the transaction usable, unlike a unique violation.
  const [created] = await tx.insert(users).values(row).onConflictDoNothing().returning();
  if (!created) throw new IdentityError("conflict", "a user with that email or external id exists");
  return toUser(created);
}

/**
 * Adds a service account (T-111): a machine (CI, a connector, a script) that authenticates with
 * API keys only, never signs in and has no email. OpenHoard's own (source `local`); it holds
 * grants and joins groups like anyone, and like a guest it never discovers what it can't read.
 * Made by an admin (`user:` or `system:`), who is recorded in the audit, not here.
 */
export async function createServiceAccount(
  tx: Tx,
  tenantId: string,
  input: { displayName: string; by: string },
): Promise<User> {
  checkActor(input.by, ["user", "system"]);
  const [created] = await tx
    .insert(users)
    .values({
      tenantId,
      id: newId("user"),
      email: null,
      emailKey: null,
      displayName: checkName("displayName", input.displayName),
      kind: "service",
      source: "local",
    })
    .returning();
  return toUser(created as UserRow);
}

/** A user by id, retired ones included (they still own objects and appear in audit). */
export async function getUser(tx: Tx, tenantId: string, userId: string): Promise<User | null> {
  const [row] = await tx
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)));
  return row ? toUser(row) : null;
}

/** The current (not retired) user with this email, for invitations and admin lookups. */
export async function findUserByEmail(
  tx: Tx,
  tenantId: string,
  email: string,
): Promise<User | null> {
  const key = emailKey(email);
  if (key === "") return null;
  const [row] = await tx
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.emailKey, key), isNull(users.retiredAt)));
  return row ? toUser(row) : null;
}

/** The current (not retired) SCIM user with this identity-provider id. */
export async function findUserByExternalId(
  tx: Tx,
  tenantId: string,
  externalId: string,
): Promise<User | null> {
  const [row] = await tx
    .select()
    .from(users)
    .where(
      and(
        eq(users.tenantId, tenantId),
        eq(users.source, "scim"),
        eq(users.externalId, externalId),
        isNull(users.retiredAt),
      ),
    );
  return row ? toUser(row) : null;
}

/** The user, locked for the rest of the transaction; refuses unknown and retired users. */
async function lockUserRow(tx: Tx, tenantId: string, userId: string) {
  const [row] = await tx
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
    .for("update");
  if (!row) throw new IdentityError("not-found", `no user ${userId}`);
  if (row.retiredAt !== null) throw new IdentityError("retired", `user ${userId} is retired`);
  return row;
}

/** As lockUserRow, and only for the source that manages the user. */
async function ownedUser(tx: Tx, tenantId: string, userId: string, as: IdentitySource) {
  checkSource(as);
  const row = await lockUserRow(tx, tenantId, userId);
  if (row.source !== as) {
    throw new IdentityError("wrong-source", `user ${userId} is managed by ${row.source}`);
  }
  return row;
}

export interface UserChanges {
  email?: string;
  displayName?: string;
  kind?: PersonKind;
  externalId?: string | null;
}

/**
 * Changes a user's details, as the source that manages them. A clash with another current user's
 * email or external id is a `conflict`, even when that user appeared concurrently.
 */
export async function updateUser(
  tx: Tx,
  tenantId: string,
  userId: string,
  changes: UserChanges,
  as: IdentitySource,
): Promise<User> {
  await lockPrincipals(tx, tenantId);
  const current = await ownedUser(tx, tenantId, userId, as);
  if (current.kind === "service" && (changes.email !== undefined || changes.kind !== undefined)) {
    throw new IdentityError("invalid", "a service account has no email and stays one");
  }
  const set: Partial<typeof users.$inferInsert> = {};
  if (changes.email !== undefined) {
    const { email, key } = checkEmail(changes.email);
    set.email = email;
    set.emailKey = key;
  }
  if (changes.displayName !== undefined) {
    set.displayName = checkName("displayName", changes.displayName);
  }
  if (changes.kind !== undefined) set.kind = checkKind(changes.kind);
  if (changes.externalId !== undefined) {
    set.externalId = checkExternalId(changes.externalId, current.source);
  }
  if (Object.keys(set).length === 0) return toUser(current);
  try {
    // A savepoint, so a unique violation from a concurrent insert leaves the caller's
    // transaction usable.
    const [row] = await tx.transaction((sp) =>
      sp
        .update(users)
        .set(set)
        .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
        .returning(),
    );
    return toUser(row as UserRow);
  } catch (e) {
    if (sqlState(e) === "23505") {
      throw new IdentityError("conflict", "another user has that email or external id");
    }
    throw e;
  }
}

/**
 * An admin's lock (`user:` or `system:`): the user is denied everything from the next
 * resolution (authorize() forbids inactive principals), whatever their source, and their sessions
 * end, so unlocking doesn't bring back one from before (a stolen cookie). Returns false if
 * already locked. Revoking tokens elsewhere (MCP clients) is T-104.
 */
export async function lockUser(
  tx: Tx,
  tenantId: string,
  userId: string,
  by: string,
): Promise<boolean> {
  await lockPrincipals(tx, tenantId);
  checkActor(by, ["user", "system"]);
  const row = await lockUserRow(tx, tenantId, userId);
  if (row.lockedAt !== null) return false;
  await tx
    .update(users)
    .set({ lockedAt: sql`now()`, lockedBy: by })
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)));
  // Unlocking must not bring back a session (a stolen cookie) from before the lock.
  await endSessions(tx, tenantId, userId, by);
  return true;
}

/**
 * Ends a user's live sessions and OAuth grants (a lock, a provider disable, retirement), or, with
 * `identity`, the sessions that identity signed in and every grant: they don't come back.
 */
async function endSessions(
  tx: Tx,
  tenantId: string,
  userId: string,
  by: string,
  identity?: { issuer: string; subject: string },
) {
  await tx
    .update(sessions)
    .set({ revokedAt: sql`greatest(now(), ${sessions.createdAt})`, revokedBy: by })
    .where(
      and(
        eq(sessions.tenantId, tenantId),
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        ...(identity
          ? [eq(sessions.issuer, identity.issuer), eq(sessions.subject, identity.subject)]
          : []),
      ),
    );
  // What AI clients hold for them ends too (the grants' tokens with them). A grant doesn't record
  // which identity signed in to consent, so unlinking one ends them all: the person consents again.
  await tx
    .update(oauthGrants)
    .set({ revokedAt: sql`greatest(now(), ${oauthGrants.createdAt})`, revokedBy: by })
    .where(
      and(
        eq(oauthGrants.tenantId, tenantId),
        eq(oauthGrants.userId, userId),
        isNull(oauthGrants.revokedAt),
      ),
    );
}

/** Lifts an admin's lock. Any provider disable stays. Returns false if there was no lock. */
export async function unlockUser(
  tx: Tx,
  tenantId: string,
  userId: string,
  by: string,
): Promise<boolean> {
  await lockPrincipals(tx, tenantId);
  checkActor(by, ["user", "system"]);
  const row = await lockUserRow(tx, tenantId, userId);
  if (row.lockedAt === null) return false;
  await tx
    .update(users)
    .set({ lockedAt: null, lockedBy: null })
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)));
  return true;
}

/**
 * The identity provider's view of a SCIM user (SCIM `active`). Idempotent: returns whether
 * anything changed. Re-activating never lifts an admin's lock.
 */
export async function setProviderActive(
  tx: Tx,
  tenantId: string,
  userId: string,
  active: boolean,
  by: string,
): Promise<boolean> {
  await lockPrincipals(tx, tenantId);
  checkActor(by, ["scim"]);
  const row = await ownedUser(tx, tenantId, userId, "scim");
  if ((row.providerDisabledAt === null) === active) return false;
  await tx
    .update(users)
    .set(
      active
        ? { providerDisabledAt: null, providerDisabledBy: null }
        : { providerDisabledAt: sql`now()`, providerDisabledBy: by },
    )
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)));
  if (!active) await endSessions(tx, tenantId, userId, by);
  return true;
}

/**
 * Retires a user for good: they left, or the identity provider deleted them. They leave every
 * group, their grants are revoked, their sign-in identities are unlinked and sessions ended, and their email and
 * external id become free for someone new (who gets a new id, so inherits nothing). The row
 * stays: they own objects and appear in audit. SCIM retires SCIM users and admins local ones.
 * Returns false if already retired.
 */
export async function retireUser(
  tx: Tx,
  tenantId: string,
  userId: string,
  by: string,
): Promise<boolean> {
  await lockPrincipals(tx, tenantId);
  const actor = checkActor(by, ["user", "system", "scim"]);
  const [row] = await tx
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
    .for("update");
  if (!row) throw new IdentityError("not-found", `no user ${userId}`);
  if (row.retiredAt !== null) return false;
  // Each source retires its own: SCIM would re-create a SCIM user an admin retired.
  if ((actor === "scim") !== (row.source === "scim")) {
    throw new IdentityError(
      "wrong-source",
      `user ${userId} is managed by ${row.source}` +
        (row.source === "scim" ? "; lock them and remove them in the identity provider" : ""),
    );
  }
  await tx
    .update(grants)
    .set({ revokedAt: sql`greatest(now(), ${grants.createdAt})`, revokedBy: by })
    .where(
      and(
        eq(grants.tenantId, tenantId),
        eq(grants.principal, userPrincipal(userId)),
        isNull(grants.revokedAt),
      ),
    );
  await tx
    .delete(groupMembers)
    .where(and(eq(groupMembers.tenantId, tenantId), eq(groupMembers.userId, userId)));
  await tx
    .delete(userIdentities)
    .where(and(eq(userIdentities.tenantId, tenantId), eq(userIdentities.userId, userId)));
  // Their sessions end now (they would fail anyway: the principal is inactive).
  await endSessions(tx, tenantId, userId, by);
  // A retired service account's keys stop at once (they would anyway: it is inactive).
  await tx
    .update(apiKeys)
    .set({ revokedAt: sql`greatest(now(), ${apiKeys.createdAt})`, revokedBy: by })
    .where(
      and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)),
    );
  await tx
    .update(users)
    .set({ retiredAt: sql`now()`, retiredBy: by })
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)));
  return true;
}

/**
 * Links a sign-in identity (an issuer and the subject it gives the person) to a user. Idempotent
 * for the same user; `conflict` if the pair belongs to someone else. Retired users can't be
 * linked.
 */
export async function linkIdentity(
  tx: Tx,
  tenantId: string,
  userId: string,
  identity: { issuer: string; subject: string },
): Promise<boolean> {
  const { issuer, subject } = identity;
  if (chars(issuer) < 1 || chars(issuer) > 1024 || chars(subject) < 1 || chars(subject) > 512) {
    throw new IdentityError(
      "invalid",
      "issuer and subject must be 1 to 1024 and 1 to 512 characters",
    );
  }
  const row = await lockUserRow(tx, tenantId, userId);
  if (row.kind === "service") {
    throw new IdentityError("invalid", "a service account never signs in: it uses API keys");
  }
  const added = await tx
    .insert(userIdentities)
    .values({ tenantId, issuer, subject, userId })
    .onConflictDoNothing()
    .returning({ userId: userIdentities.userId });
  if (added.length > 0) return true;
  const [existing] = await tx
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.tenantId, tenantId),
        eq(userIdentities.issuer, issuer),
        eq(userIdentities.subject, subject),
      ),
    );
  if (existing?.userId !== userId) {
    throw new IdentityError("conflict", "that identity is linked to another user");
  }
  return false;
}

/**
 * Unlinks a sign-in identity, and ends the sessions it signed in; `by` is who did it (`user:`,
 * `system:` or `scim:`). Returns false if it wasn't linked to this user.
 */
export async function unlinkIdentity(
  tx: Tx,
  tenantId: string,
  userId: string,
  identity: { issuer: string; subject: string },
  by: string,
): Promise<boolean> {
  checkActor(by, ["user", "system", "scim"]);
  const removed = await tx
    .delete(userIdentities)
    .where(
      and(
        eq(userIdentities.tenantId, tenantId),
        eq(userIdentities.issuer, identity.issuer),
        eq(userIdentities.subject, identity.subject),
        eq(userIdentities.userId, userId),
      ),
    )
    .returning({ userId: userIdentities.userId });
  // Sessions signed in with that identity end with it.
  if (removed.length > 0) await endSessions(tx, tenantId, userId, by, identity);
  return removed.length > 0;
}

/**
 * The user a sign-in identity belongs to, or null. Never a retired user: retiring unlinks their
 * identities, and this doesn't rely on that alone. Sign-in then checks `active` (a lock or a
 * provider disable).
 */
export async function findUserByIdentity(
  tx: Tx,
  tenantId: string,
  identity: { issuer: string; subject: string },
): Promise<User | null> {
  const [row] = await tx
    .select({ user: users })
    .from(userIdentities)
    .innerJoin(
      users,
      and(eq(users.tenantId, userIdentities.tenantId), eq(users.id, userIdentities.userId)),
    )
    .where(
      and(
        eq(userIdentities.tenantId, tenantId),
        eq(userIdentities.issuer, identity.issuer),
        eq(userIdentities.subject, identity.subject),
        isNull(users.retiredAt),
        // A service account never signs in (the database refuses its identities too).
        ne(users.kind, "service"),
      ),
    );
  return row ? toUser(row.user) : null;
}

export interface NewGroup {
  name: string;
  source: IdentitySource;
  /** The identity provider's id: SCIM groups should have one, local groups can't. */
  externalId?: string;
}

export async function createGroup(tx: Tx, tenantId: string, input: NewGroup): Promise<Group> {
  const source = checkSource(input.source);
  const [created] = await tx
    .insert(groups)
    .values({
      tenantId,
      id: newId("group"),
      name: checkName("name", input.name),
      source,
      externalId: checkExternalId(input.externalId, source),
    })
    .onConflictDoNothing()
    .returning();
  if (!created) throw new IdentityError("conflict", "a group with that external id exists");
  return toGroup(created);
}

export async function getGroup(tx: Tx, tenantId: string, groupId: string): Promise<Group | null> {
  const [row] = await tx
    .select()
    .from(groups)
    .where(and(eq(groups.tenantId, tenantId), eq(groups.id, groupId)));
  return row ? toGroup(row) : null;
}

/** The SCIM group with this identity-provider id. */
export async function findGroupByExternalId(
  tx: Tx,
  tenantId: string,
  externalId: string,
): Promise<Group | null> {
  const [row] = await tx
    .select()
    .from(groups)
    .where(
      and(
        eq(groups.tenantId, tenantId),
        eq(groups.source, "scim"),
        eq(groups.externalId, externalId),
      ),
    );
  return row ? toGroup(row) : null;
}

async function ownedGroup(tx: Tx, tenantId: string, groupId: string, as: IdentitySource) {
  checkSource(as);
  const [row] = await tx
    .select()
    .from(groups)
    .where(and(eq(groups.tenantId, tenantId), eq(groups.id, groupId)))
    .for("update");
  if (!row) throw new IdentityError("not-found", `no group ${groupId}`);
  if (row.source !== as) {
    throw new IdentityError("wrong-source", `group ${groupId} is managed by ${row.source}`);
  }
  return row;
}

export async function renameGroup(
  tx: Tx,
  tenantId: string,
  groupId: string,
  name: string,
  as: IdentitySource,
): Promise<Group> {
  await ownedGroup(tx, tenantId, groupId, as);
  const [row] = await tx
    .update(groups)
    .set({ name: checkName("name", name) })
    .where(and(eq(groups.tenantId, tenantId), eq(groups.id, groupId)))
    .returning();
  return toGroup(row as GroupRow);
}

/**
 * Deletes a group and its memberships, and revokes its live grants (recorded as revoked by
 * `by`), so a later group can never inherit them and "why could X see this?" still has the
 * history.
 */
export async function deleteGroup(
  tx: Tx,
  tenantId: string,
  groupId: string,
  as: IdentitySource,
  by: string,
): Promise<void> {
  await lockPrincipals(tx, tenantId);
  checkActor(by, ["user", "system", "scim"]);
  await ownedGroup(tx, tenantId, groupId, as);
  await tx
    .update(grants)
    .set({ revokedAt: sql`greatest(now(), ${grants.createdAt})`, revokedBy: by })
    .where(
      and(
        eq(grants.tenantId, tenantId),
        eq(grants.principal, groupPrincipal(groupId)),
        isNull(grants.revokedAt),
      ),
    );
  await tx.delete(groups).where(and(eq(groups.tenantId, tenantId), eq(groups.id, groupId)));
}

/** Adds a user to a group, as the group's source. Returns false if they were already in it. */
export async function addMember(
  tx: Tx,
  tenantId: string,
  groupId: string,
  userId: string,
  as: IdentitySource,
): Promise<boolean> {
  await lockPrincipals(tx, tenantId);
  await ownedGroup(tx, tenantId, groupId, as);
  // Key-share: a retirement (FOR UPDATE) can't run between this check and the insert.
  const [user] = await tx
    .select({ retiredAt: users.retiredAt, kind: users.kind })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
    .for("key share");
  if (!user) throw new IdentityError("not-found", `no user ${userId}`);
  if (user.retiredAt !== null) throw new IdentityError("retired", `user ${userId} is retired`);
  // What a service account holds is decided in OpenHoard, not by the identity provider.
  if (user.kind === "service" && as === "scim") {
    throw new IdentityError("invalid", "a service account joins only OpenHoard's own groups");
  }
  const added = await tx
    .insert(groupMembers)
    .values({ tenantId, groupId, userId })
    .onConflictDoNothing()
    .returning({ userId: groupMembers.userId });
  return added.length > 0;
}

/** Removes a user from a group, as the group's source. Returns false if they weren't in it. */
export async function removeMember(
  tx: Tx,
  tenantId: string,
  groupId: string,
  userId: string,
  as: IdentitySource,
): Promise<boolean> {
  await lockPrincipals(tx, tenantId);
  await ownedGroup(tx, tenantId, groupId, as);
  const removed = await tx
    .delete(groupMembers)
    .where(
      and(
        eq(groupMembers.tenantId, tenantId),
        eq(groupMembers.groupId, groupId),
        eq(groupMembers.userId, userId),
      ),
    )
    .returning({ userId: groupMembers.userId });
  return removed.length > 0;
}

/** The groups a user is directly in, by name. */
export async function groupsOf(tx: Tx, tenantId: string, userId: string): Promise<Group[]> {
  const rows = await tx
    .select({ group: groups })
    .from(groupMembers)
    .innerJoin(
      groups,
      and(eq(groups.tenantId, groupMembers.tenantId), eq(groups.id, groupMembers.groupId)),
    )
    .where(and(eq(groupMembers.tenantId, tenantId), eq(groupMembers.userId, userId)))
    .orderBy(asc(groups.name), asc(groups.id));
  return rows.map((r) => toGroup(r.group));
}

/**
 * A page of a group's members, in id order: up to `limit` (default 500) after the id `after`.
 * Groups can be huge (an "everyone" group), so this pages instead of loading them all.
 */
export async function membersOf(
  tx: Tx,
  tenantId: string,
  groupId: string,
  page: { limit?: number; after?: string } = {},
): Promise<User[]> {
  const limit = page.limit ?? 500;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) {
    throw new IdentityError("invalid", "limit must be 1 to 5000");
  }
  const rows = await tx
    .select({ user: users })
    .from(groupMembers)
    .innerJoin(
      users,
      and(eq(users.tenantId, groupMembers.tenantId), eq(users.id, groupMembers.userId)),
    )
    .where(
      and(
        eq(groupMembers.tenantId, tenantId),
        eq(groupMembers.groupId, groupId),
        page.after === undefined ? undefined : gt(groupMembers.userId, page.after),
      ),
    )
    .orderBy(asc(groupMembers.userId))
    .limit(limit);
  return rows.map((r) => toUser(r.user));
}

/**
 * Who a signed-in user is to authorize(): their groups and every grant they hold, directly or
 * through a group. Null for an unknown user. A locked, deactivated or retired user comes back
 * inactive, which authorize() denies; callers shouldn't special-case it.
 *
 * `at` applies to grants only: which grants were live then (the database's now() by default).
 * Group memberships, the user's kind and their stops are always the current ones, because their
 * history isn't kept. So a past `at` answers "what would this person, as they are now, have
 * held then?", not "what could they see then?".
 *
 * Uncached; principal-cache.ts caches it. Every change this reads (memberships, grants, the
 * user's stops and kind) bumps the tenant's principal epoch, by trigger (core/db migration 0021),
 * which is what invalidates the cache: a new column read here needs its trigger too.
 */
export async function resolvePrincipal(
  tx: Tx,
  tenantId: string,
  userId: string,
  at?: Date,
): Promise<AuthzPrincipal | null> {
  return (await resolveWithExpiry(tx, tenantId, userId, at))?.principal ?? null;
}

/** resolvePrincipal(), and when the soonest of the grants it counted expires (null: none do). */
export async function resolveWithExpiry(
  tx: Tx,
  tenantId: string,
  userId: string,
  at?: Date,
): Promise<{ principal: AuthzPrincipal; expiresAt: Date | null } | null> {
  const user = await getUser(tx, tenantId, userId);
  if (!user) return null;
  // Just the ids, in id order: groupsOf() loads whole groups and sorts them by name.
  const memberships = await tx
    .select({ groupId: groupMembers.groupId })
    .from(groupMembers)
    .where(and(eq(groupMembers.tenantId, tenantId), eq(groupMembers.userId, userId)))
    .orderBy(asc(groupMembers.groupId));
  const groupIds = memberships.map((m) => m.groupId);
  const live = await liveGrants(
    tx,
    tenantId,
    [userPrincipal(userId), ...groupIds.map(groupPrincipal)],
    at,
  );
  const expiries = live.flatMap((g) => (g.expiresAt === null ? [] : [g.expiresAt.getTime()]));
  return {
    principal: {
      userId,
      groupIds,
      ...grantSetOf(live),
      guest: user.kind === "guest",
      active: user.active,
      ...(user.kind === "service" ? { service: true } : {}),
    },
    expiresAt: expiries.length === 0 ? null : new Date(Math.min(...expiries)),
  };
}
