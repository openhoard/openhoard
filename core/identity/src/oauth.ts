import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  AI_CLIENT_TRUSTS,
  isId,
  newId,
  OAUTH_SCOPES,
  oauthClients,
  oauthCodes,
  oauthGrants,
  oauthTokens,
  users,
  ZONE_KINDS,
  type Tx,
} from "@openhoard/core-db";
import type { Action, AuthzClient, AuthzPrincipal, ClientTrust } from "@openhoard/core-policy";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { IdentityError, resolveWithExpiry } from "./directory.js";
import type { PrincipalCache } from "./principal-cache.js";

/*
 * OAuth 2.1 for MCP clients (T-105): OpenHoard's own authorization server, the core half. The
 * HTTP half (discovery, client metadata, the consent page, the token endpoint) is apps/server.
 *
 * - Clients: a tenant records every client its people try (`oauth_clients`, keyed by a hash of
 *   what identifies it), and an admin approves it with a trust label (local, commercial,
 *   consumer) before it gets a token. Refusing a client revokes its grants.
 * - A person's consent makes an authorization code: used once, within a minute, by that client,
 *   at that redirect URI, with the PKCE (S256) verifier, for that resource. A code used twice
 *   revokes the grant it made.
 * - A grant holds what the person allowed: scopes, one resource (the MCP server's URL), an
 *   expiry. Its refresh token rotates on every use; the previous one presented again revokes the
 *   grant. Access tokens live an hour at most.
 * - Every token is `<kind>.<tenant>.<id>.<secret>` (ohac, ohrt, ohat) and only a SHA-256 of the
 *   secret is kept, as for sessions and API keys.
 * - checkAccessToken() runs on every request: the token, its grant, its client (approved) and
 *   its person (active) must all hold. Locking, disabling or retiring a person revokes their
 *   grants (directory.ts).
 */

export type OAuthScope = (typeof OAUTH_SCOPES)[number];

/** The policy actions each scope allows. */
export const SCOPE_ACTIONS: Readonly<Record<OAuthScope, readonly Action[]>> = {
  "files:read": ["search", "read", "open"],
  "files:tag": ["tag"],
};

/** Limits, in seconds. */
export const OAUTH_LIMITS = {
  codeSeconds: 60,
  accessSeconds: 3600,
  defaultGrantDays: 30,
  maxGrantDays: 90,
} as const;

const SECRET_BYTES = 32;
const ID = "[0-9a-hjkmnp-tv-z]{26}";
const tokenPattern = (kind: string, prefix: string) =>
  new RegExp(`^${kind}\\.(ten_${ID})\\.(${prefix}_${ID})\\.([A-Za-z0-9_-]{43})$`);
const CODE = tokenPattern("ohac", "oac");
const ACCESS = tokenPattern("ohat", "oat");
const REFRESH = tokenPattern("ohrt", "ogr");
const PRINCIPAL = /^(user|system|scim):[^\0]{1,1000}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = () => randomBytes(SECRET_BYTES).toString("base64url");
/** Compared in constant time, and against something even when there is nothing to compare to. */
const matches = (given: string, stored: string | null | undefined) =>
  timingSafeEqual(
    Buffer.from(sha256hex(given), "hex"),
    Buffer.from(stored ?? "0".repeat(64), "hex"),
  );

/** The tenant a token (of any kind) names, or null. Checks nothing else. */
export function oauthTokenTenant(token: unknown): string | null {
  if (typeof token !== "string") return null;
  for (const re of [ACCESS, REFRESH, CODE]) {
    const m = re.exec(token);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** Checks and orders requested scopes; null when one isn't known or there are none. */
export function parseScopes(scope: string | undefined | null): OAuthScope[] | null {
  const asked = (scope ?? "").split(" ").filter((s) => s !== "");
  if (asked.length === 0) return null;
  if (!asked.every((s) => (OAUTH_SCOPES as readonly string[]).includes(s))) return null;
  return [...new Set(asked as OAuthScope[])].sort();
}

function scopeOf(scopes: readonly string[]) {
  const actions = [
    ...new Set(scopes.flatMap((s) => SCOPE_ACTIONS[s as OAuthScope] ?? [])),
  ].sort() as Action[];
  return { actions, zones: [...ZONE_KINDS] };
}

function checkBy(by: string) {
  if (typeof by !== "string" || !PRINCIPAL.test(by)) {
    throw new IdentityError("invalid", "by must be a principal: user:…, system:… or scim:…");
  }
}

// ---------------------------------------------------------------------------------------------
// Clients

export type ClientKind = "cimd" | "dcr";
export type ClientStatus = "pending" | "approved" | "refused";

export interface OAuthClientInput {
  kind: ClientKind;
  /** The metadata URL (cimd), or `dcr:<key prefix>`. */
  clientRef: string;
  /** Display only. */
  name: string;
  redirectUris: readonly string[];
}

export interface OAuthClient extends OAuthClientInput {
  clientKey: string;
  status: ClientStatus;
  trust: ClientTrust | null;
  requestedBy: string;
  requestedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
}

/**
 * What identifies a client: its metadata URL (cimd), or its redirect URIs (dcr), since a code
 * only ever goes to them. Loopback redirects count without their port (RFC 8252).
 */
export function clientKeyOf(kind: ClientKind, idOrRedirects: string | readonly string[]): string {
  if (kind === "cimd") return sha256hex(`cimd\n${String(idOrRedirects)}`);
  const list = [...new Set((idOrRedirects as readonly string[]).map(redirectIdentity))].sort();
  return sha256hex(`dcr\n${list.join("\n")}`);
}

/** A redirect URI as it identifies a client: loopback ports don't. */
export function redirectIdentity(uri: string): string {
  const u = new URL(uri);
  if (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) {
    u.port = "";
  }
  return u.href;
}

type ClientRow = typeof oauthClients.$inferSelect;
const toClient = (r: ClientRow): OAuthClient => ({
  clientKey: r.clientKey,
  kind: r.kind as ClientKind,
  clientRef: r.clientRef,
  name: r.name,
  redirectUris: r.redirectUris,
  status: r.status as ClientStatus,
  trust: r.trust as ClientTrust | null,
  requestedBy: r.requestedBy,
  requestedAt: r.requestedAt,
  decidedBy: r.decidedBy,
  decidedAt: r.decidedAt,
});

/**
 * Records a client someone of the tenant tried (pending, for an admin), or refreshes what it
 * says about itself; never changes a decision. Returns it as it stands.
 */
export async function noteClient(
  tx: Tx,
  tenantId: string,
  input: OAuthClientInput,
  by: string,
): Promise<OAuthClient> {
  checkBy(by);
  const clientKey =
    input.kind === "cimd"
      ? clientKeyOf("cimd", input.clientRef)
      : clientKeyOf("dcr", input.redirectUris);
  const name = [...input.name].slice(0, 200).join("") || input.clientRef.slice(0, 200);
  const [row] = await tx
    .insert(oauthClients)
    .values({
      tenantId,
      clientKey,
      kind: input.kind,
      clientRef: input.clientRef,
      name,
      redirectUris: [...input.redirectUris],
      requestedBy: by,
    })
    .onConflictDoUpdate({
      target: [oauthClients.tenantId, oauthClients.clientKey],
      set: { name, redirectUris: [...input.redirectUris] },
    })
    .returning();
  if (!row) throw new Error("client upsert returned nothing");
  return toClient(row);
}

export async function getClient(
  tx: Tx,
  tenantId: string,
  clientKey: string,
): Promise<OAuthClient | null> {
  const [row] = await tx
    .select()
    .from(oauthClients)
    .where(and(eq(oauthClients.tenantId, tenantId), eq(oauthClients.clientKey, clientKey)));
  return row ? toClient(row) : null;
}

export async function listClients(tx: Tx, tenantId: string): Promise<OAuthClient[]> {
  const rows = await tx
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.tenantId, tenantId))
    .orderBy(oauthClients.requestedAt);
  return rows.map(toClient);
}

/**
 * An admin's decision on a client: approved with a trust label, or refused (which revokes every
 * grant the client holds in the tenant). `by` is `user:` or `system:`.
 */
export async function decideClient(
  tx: Tx,
  tenantId: string,
  clientKey: string,
  decision: { approve: true; trust: ClientTrust } | { approve: false },
  by: string,
): Promise<OAuthClient> {
  if (typeof by !== "string" || !/^(user|system):[^\0]{1,1000}$/.test(by)) {
    throw new IdentityError("invalid", "an admin decides: user:… or system:…");
  }
  if (decision.approve && !(AI_CLIENT_TRUSTS as readonly string[]).includes(decision.trust)) {
    throw new IdentityError("invalid", `trust is one of ${AI_CLIENT_TRUSTS.join(", ")}`);
  }
  const [row] = await tx
    .update(oauthClients)
    .set({
      status: decision.approve ? "approved" : "refused",
      trust: decision.approve ? decision.trust : null,
      decidedBy: by,
      decidedAt: sql`now()`,
    })
    .where(and(eq(oauthClients.tenantId, tenantId), eq(oauthClients.clientKey, clientKey)))
    .returning();
  if (!row) throw new IdentityError("not-found", "no such client");
  if (!decision.approve) {
    await tx
      .update(oauthGrants)
      .set({ revokedAt: sql`greatest(now(), ${oauthGrants.createdAt})`, revokedBy: by })
      .where(
        and(
          eq(oauthGrants.tenantId, tenantId),
          eq(oauthGrants.clientKey, clientKey),
          isNull(oauthGrants.revokedAt),
        ),
      );
  }
  return toClient(row);
}

/**
 * What an admin said about a client outside the database (the server's config), or undefined for
 * nothing: a trust label (approved), or null (not approved).
 */
export type TrustResolver = (client: OAuthClient) => ClientTrust | null | undefined;

/**
 * The trust a client gets tokens with, or null when it gets none: a refusal always stands; else
 * the resolver's word, else the database's decision.
 */
export function approvedTrust(
  client: OAuthClient | null,
  resolver?: TrustResolver,
): ClientTrust | null {
  if (!client || client.status === "refused") return null;
  const said = resolver?.(client);
  if (said !== undefined) return said;
  return client.status === "approved" ? client.trust : null;
}

// ---------------------------------------------------------------------------------------------
// Codes and tokens

export interface CodeInput {
  userId: string;
  clientKey: string;
  redirectUri: string;
  /** S256 code challenge. */
  codeChallenge: string;
  scopes: readonly OAuthScope[];
  resource: string;
}

/**
 * The code for a consent the person just gave: `ohac.<tenant>.<id>.<secret>`, shown once. The
 * client must be approved and the person active, now.
 */
export async function issueCode(
  tx: Tx,
  tenantId: string,
  input: CodeInput,
  options: { clientTrust?: TrustResolver } = {},
): Promise<string> {
  if (!CHALLENGE.test(input.codeChallenge)) {
    throw new IdentityError("invalid", "code_challenge must be an S256 challenge");
  }
  if (input.scopes.length === 0 || !input.scopes.every((s) => s in SCOPE_ACTIONS)) {
    throw new IdentityError("invalid", "unknown scope");
  }
  const user = await livePerson(tx, tenantId, input.userId);
  const client = await getClient(tx, tenantId, input.clientKey);
  if (approvedTrust(client, options.clientTrust) === null) {
    throw new IdentityError("invalid", "client not approved");
  }
  const id = newId("oauthCode");
  const s = secret();
  await tx.insert(oauthCodes).values({
    tenantId,
    id,
    secretHash: sha256hex(s),
    userId: input.userId,
    userKind: user.kind,
    clientKey: input.clientKey,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    scopes: [...new Set(input.scopes)].sort(),
    resource: input.resource,
    expiresAt: sql`now() + make_interval(secs => ${OAUTH_LIMITS.codeSeconds})`,
  });
  return `ohac.${tenantId}.${id}.${s}`;
}

/** The person, locked for the rest of the transaction; refuses anyone who can't sign in now. */
async function livePerson(tx: Tx, tenantId: string, userId: string) {
  if (!isId("user", userId)) throw new IdentityError("invalid", "invalid user id");
  const [user] = await tx
    .select({
      kind: users.kind,
      retiredAt: users.retiredAt,
      lockedAt: users.lockedAt,
      providerDisabledAt: users.providerDisabledAt,
    })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
    .for("key share");
  if (!user) throw new IdentityError("not-found", `no user ${userId}`);
  if (user.kind === "service")
    throw new IdentityError("invalid", "a service account uses API keys");
  if (user.retiredAt !== null || user.lockedAt !== null || user.providerDisabledAt !== null) {
    throw new IdentityError("inactive", `user ${userId} can't sign in`);
  }
  return user;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Seconds. */
  expiresIn: number;
  scopes: OAuthScope[];
  grantId: string;
  userId: string;
}

/** Why the token endpoint refuses: RFC 6749 errors. */
export type GrantRefusal = "invalid_grant" | "invalid_client" | "invalid_target" | "invalid_scope";

export type GrantResult =
  | ({ ok: true } & TokenSet)
  | { ok: false; error: GrantRefusal; reason: string; userId?: string; grantId?: string };

async function newAccessToken(
  tx: Tx,
  tenantId: string,
  grantId: string,
  scopes: readonly string[],
) {
  const id = newId("oauthToken");
  const s = secret();
  await tx.insert(oauthTokens).values({
    tenantId,
    id,
    grantId,
    secretHash: sha256hex(s),
    scopes: [...scopes],
    expiresAt: sql`now() + make_interval(secs => ${OAUTH_LIMITS.accessSeconds})`,
  });
  return `ohat.${tenantId}.${id}.${s}`;
}

const revokeGrantRow = (tx: Tx, tenantId: string, grantId: string, by: string) =>
  tx
    .update(oauthGrants)
    .set({ revokedAt: sql`greatest(now(), ${oauthGrants.createdAt})`, revokedBy: by })
    .where(
      and(
        eq(oauthGrants.tenantId, tenantId),
        eq(oauthGrants.id, grantId),
        isNull(oauthGrants.revokedAt),
      ),
    )
    .returning({ id: oauthGrants.id });

/**
 * The token endpoint's authorization_code grant: redeems a code for tokens, once. Run it in a
 * read-write transaction of the code's tenant.
 */
export async function redeemCode(
  tx: Tx,
  tenantId: string,
  code: string,
  given: {
    clientKey: string;
    redirectUri: string;
    codeVerifier: string;
    resource: string;
    grantDays?: number;
    clientTrust?: TrustResolver;
  },
): Promise<GrantResult> {
  const m = CODE.exec(typeof code === "string" ? code : "");
  const refuse = (reason: string, extra: Partial<{ userId: string; grantId: string }> = {}) => ({
    ok: false as const,
    error: "invalid_grant" as const,
    reason,
    ...extra,
  });
  if (!m || m[1] !== tenantId) return refuse("unknown code");
  const [found] = await tx
    .select({ code: oauthCodes, live: sql<boolean>`${oauthCodes.expiresAt} > now()` })
    .from(oauthCodes)
    .where(and(eq(oauthCodes.tenantId, tenantId), eq(oauthCodes.id, m[2] as string)))
    .for("update");
  const row = found?.code;
  const same = matches(m[3] as string, row?.secretHash);
  if (!found || !row || !same) return refuse("unknown code");
  if (row.usedAt !== null) {
    // Replayed: whatever it made is suspect (RFC 6749 §4.1.2).
    if (row.grantId) await revokeGrantRow(tx, tenantId, row.grantId, "system:code-replay");
    return refuse("code used twice; its grant is revoked", {
      userId: row.userId,
      ...(row.grantId ? { grantId: row.grantId } : {}),
    });
  }
  // Used up whatever happens next: a failed redemption can't be retried.
  await tx
    .update(oauthCodes)
    .set({ usedAt: sql`now()` })
    .where(and(eq(oauthCodes.tenantId, tenantId), eq(oauthCodes.id, row.id)));
  if (!found.live) return refuse("code expired", { userId: row.userId });
  if (row.clientKey !== given.clientKey) return refuse("code was for another client");
  if (row.redirectUri !== given.redirectUri) return refuse("redirect_uri differs");
  if (row.resource !== given.resource) {
    return { ok: false, error: "invalid_target", reason: "resource differs", userId: row.userId };
  }
  if (typeof given.codeVerifier !== "string" || !VERIFIER.test(given.codeVerifier)) {
    return refuse("invalid code_verifier", { userId: row.userId });
  }
  const challenge = createHash("sha256").update(given.codeVerifier).digest("base64url");
  if (!timingSafeEqual(Buffer.from(challenge), Buffer.from(row.codeChallenge))) {
    return refuse("PKCE verification failed", { userId: row.userId });
  }
  const client = await getClient(tx, tenantId, row.clientKey);
  if (approvedTrust(client, given.clientTrust) === null) {
    return {
      ok: false,
      error: "invalid_client",
      reason: "client not approved",
      userId: row.userId,
    };
  }
  try {
    await livePerson(tx, tenantId, row.userId);
  } catch (err) {
    if (err instanceof IdentityError) return refuse("person can't sign in", { userId: row.userId });
    throw err;
  }
  const days = given.grantDays ?? OAUTH_LIMITS.defaultGrantDays;
  if (!Number.isSafeInteger(days) || days < 1 || days > OAUTH_LIMITS.maxGrantDays) {
    throw new IdentityError("invalid", `grantDays is 1 to ${OAUTH_LIMITS.maxGrantDays}`);
  }
  const grantId = newId("oauthGrant");
  const refresh = secret();
  await tx.insert(oauthGrants).values({
    tenantId,
    id: grantId,
    userId: row.userId,
    userKind: row.userKind,
    clientKey: row.clientKey,
    scopes: row.scopes,
    resource: row.resource,
    refreshHash: sha256hex(refresh),
    expiresAt: sql`now() + make_interval(days => ${days})`,
  });
  await tx
    .update(oauthCodes)
    .set({ grantId })
    .where(and(eq(oauthCodes.tenantId, tenantId), eq(oauthCodes.id, row.id)));
  return {
    ok: true,
    accessToken: await newAccessToken(tx, tenantId, grantId, row.scopes),
    refreshToken: `ohrt.${tenantId}.${grantId}.${refresh}`,
    expiresIn: OAUTH_LIMITS.accessSeconds,
    scopes: row.scopes as OAuthScope[],
    grantId,
    userId: row.userId,
  };
}

/**
 * The refresh_token grant: new tokens for a live grant, the refresh token rotated. The previous
 * refresh token presented again revokes the grant. `scopes`, when given, may only narrow what
 * was granted: the new access token gets only those, and the grant keeps its own.
 */
export async function refreshGrant(
  tx: Tx,
  tenantId: string,
  refreshToken: string,
  given: {
    clientKey: string;
    resource?: string;
    scopes?: readonly OAuthScope[];
    clientTrust?: TrustResolver;
  },
): Promise<GrantResult> {
  const m = REFRESH.exec(typeof refreshToken === "string" ? refreshToken : "");
  const refuse = (reason: string, extra: Partial<{ userId: string; grantId: string }> = {}) => ({
    ok: false as const,
    error: "invalid_grant" as const,
    reason,
    ...extra,
  });
  if (!m || m[1] !== tenantId) return refuse("unknown refresh token");
  const grantId = m[2] as string;
  const [grant] = await tx
    .select({
      g: oauthGrants,
      live: sql<boolean>`${oauthGrants.revokedAt} is null and ${oauthGrants.expiresAt} > now()`,
    })
    .from(oauthGrants)
    .where(and(eq(oauthGrants.tenantId, tenantId), eq(oauthGrants.id, grantId)))
    .for("update");
  const current = matches(m[3] as string, grant?.g.refreshHash);
  if (!grant) return refuse("unknown refresh token");
  const who = { userId: grant.g.userId, grantId };
  if (!current) {
    if (grant.g.previousRefreshHash && matches(m[3] as string, grant.g.previousRefreshHash)) {
      // A rotated-out refresh token came back: one of the two holders isn't the client.
      await revokeGrantRow(tx, tenantId, grantId, "system:refresh-replay");
      return refuse("refresh token replayed; the grant is revoked", who);
    }
    return refuse("unknown refresh token");
  }
  if (!grant.live) return refuse("grant revoked or expired", who);
  if (grant.g.clientKey !== given.clientKey) return refuse("grant is another client's", who);
  if (given.resource !== undefined && given.resource !== grant.g.resource) {
    return { ok: false, error: "invalid_target", reason: "resource differs", ...who };
  }
  let scopes = grant.g.scopes as OAuthScope[];
  if (given.scopes !== undefined) {
    if (!given.scopes.every((s) => scopes.includes(s)) || given.scopes.length === 0) {
      return { ok: false, error: "invalid_scope", reason: "scope beyond the grant", ...who };
    }
    scopes = [...new Set(given.scopes)].sort();
  }
  const client = await getClient(tx, tenantId, grant.g.clientKey);
  if (approvedTrust(client, given.clientTrust) === null) {
    return { ok: false, error: "invalid_client", reason: "client not approved", ...who };
  }
  try {
    await livePerson(tx, tenantId, grant.g.userId);
  } catch (err) {
    if (err instanceof IdentityError) return refuse("person can't sign in", who);
    throw err;
  }
  const refresh = secret();
  await tx
    .update(oauthGrants)
    .set({
      refreshHash: sha256hex(refresh),
      previousRefreshHash: grant.g.refreshHash,
      refreshedAt: sql`now()`,
    })
    .where(and(eq(oauthGrants.tenantId, tenantId), eq(oauthGrants.id, grantId)));
  return {
    ok: true,
    accessToken: await newAccessToken(tx, tenantId, grantId, scopes),
    refreshToken: `ohrt.${tenantId}.${grantId}.${refresh}`,
    expiresIn: OAUTH_LIMITS.accessSeconds,
    scopes,
    grantId,
    userId: grant.g.userId,
  };
}

export type AccessRefusal =
  "unknown" | "expired" | "revoked" | "wrong-audience" | "client-not-approved" | "account-inactive";

export type AccessCheck =
  | {
      ok: true;
      principal: AuthzPrincipal;
      client: AuthzClient;
      grantId: string;
      clientKey: string;
      scopes: OAuthScope[];
    }
  | { ok: false; refused: AccessRefusal; grantId?: string };

/**
 * Checks an access token on a request to `resource`: the token, its grant (live, for this
 * resource), its client (approved: its trust label is the request's client trust) and its person
 * (active). Writes nothing: run it in a read-only snapshot, where the principal cache serves.
 * The principal carries the grant's scopes as its credential scope, so authorize() refuses
 * anything else (core/scope). `clientTrust` lets the caller say what an admin configured instead
 * of the database's decision (never over a refusal).
 */
export async function checkAccessToken(
  tx: Tx,
  tenantId: string,
  token: string,
  resource: string,
  options: {
    cache?: PrincipalCache;
    clientTrust?: TrustResolver;
  } = {},
): Promise<AccessCheck> {
  const m = ACCESS.exec(typeof token === "string" ? token : "");
  if (!m || m[1] !== tenantId) return { ok: false, refused: "unknown" };
  const [row] = await tx
    .select({
      secretHash: oauthTokens.secretHash,
      grantId: oauthTokens.grantId,
      tokenLive: sql<boolean>`${oauthTokens.expiresAt} > statement_timestamp()`,
      grantLive: sql<boolean>`${oauthGrants.revokedAt} is null and ${oauthGrants.expiresAt} > statement_timestamp()`,
      resource: oauthGrants.resource,
      userId: oauthGrants.userId,
      clientKey: oauthGrants.clientKey,
      scopes: oauthTokens.scopes,
    })
    .from(oauthTokens)
    .innerJoin(
      oauthGrants,
      and(eq(oauthGrants.tenantId, oauthTokens.tenantId), eq(oauthGrants.id, oauthTokens.grantId)),
    )
    .where(and(eq(oauthTokens.tenantId, tenantId), eq(oauthTokens.id, m[2] as string)));
  const same = matches(m[3] as string, row?.secretHash);
  if (!row || !same) return { ok: false, refused: "unknown" };
  const grantId = row.grantId;
  if (!row.tokenLive) return { ok: false, refused: "expired", grantId };
  if (!row.grantLive) return { ok: false, refused: "revoked", grantId };
  if (row.resource !== resource) return { ok: false, refused: "wrong-audience", grantId };
  const client = await getClient(tx, tenantId, row.clientKey);
  const trust = approvedTrust(client, options.clientTrust);
  if (!client || trust === null) return { ok: false, refused: "client-not-approved", grantId };
  const base = options.cache
    ? await options.cache.resolve(tx, tenantId, row.userId)
    : ((await resolveWithExpiry(tx, tenantId, row.userId))?.principal ?? null);
  if (!base || !base.active || base.service === true) {
    return { ok: false, refused: "account-inactive", grantId };
  }
  return {
    ok: true,
    principal: { ...base, scope: scopeOf(row.scopes) },
    client: { id: client.clientRef, trust },
    grantId,
    clientKey: row.clientKey,
    scopes: row.scopes as OAuthScope[],
  };
}

/** Revokes a grant (and so its tokens). Returns false if it had ended already. */
export async function revokeGrant(
  tx: Tx,
  tenantId: string,
  grantId: string,
  by: string,
): Promise<boolean> {
  checkBy(by);
  return (await revokeGrantRow(tx, tenantId, grantId, by)).length > 0;
}

/**
 * Revokes the grant behind a refresh or access token the client presents (RFC 7009): a client
 * may end what it holds. Unknown tokens are fine (nothing happens).
 */
export async function revokeByToken(tx: Tx, tenantId: string, token: string): Promise<boolean> {
  const refresh = REFRESH.exec(typeof token === "string" ? token : "");
  const access = ACCESS.exec(typeof token === "string" ? token : "");
  if (refresh && refresh[1] === tenantId) {
    const [g] = await tx
      .select({ hash: oauthGrants.refreshHash })
      .from(oauthGrants)
      .where(and(eq(oauthGrants.tenantId, tenantId), eq(oauthGrants.id, refresh[2] as string)));
    if (!matches(refresh[3] as string, g?.hash) || !g) return false;
    return (
      (await revokeGrantRow(tx, tenantId, refresh[2] as string, "system:client-revoke")).length > 0
    );
  }
  if (access && access[1] === tenantId) {
    const [t] = await tx
      .select({ hash: oauthTokens.secretHash })
      .from(oauthTokens)
      .where(and(eq(oauthTokens.tenantId, tenantId), eq(oauthTokens.id, access[2] as string)));
    if (!matches(access[3] as string, t?.hash) || !t) return false;
    const removed = await tx
      .delete(oauthTokens)
      .where(and(eq(oauthTokens.tenantId, tenantId), eq(oauthTokens.id, access[2] as string)))
      .returning({ id: oauthTokens.id });
    return removed.length > 0;
  }
  return false;
}

/** Revokes every grant of a person; returns how many. */
export async function revokeUserGrants(
  tx: Tx,
  tenantId: string,
  userId: string,
  by: string,
): Promise<number> {
  checkBy(by);
  const rows = await tx
    .update(oauthGrants)
    .set({ revokedAt: sql`greatest(now(), ${oauthGrants.createdAt})`, revokedBy: by })
    .where(
      and(
        eq(oauthGrants.tenantId, tenantId),
        eq(oauthGrants.userId, userId),
        isNull(oauthGrants.revokedAt),
      ),
    )
    .returning({ id: oauthGrants.id });
  return rows.length;
}

/** Removes a tenant's codes, access tokens and ended grants from before `before`. */
export async function pruneOAuth(
  tx: Tx,
  tenantId: string,
  before: Date,
): Promise<{ codes: number; tokens: number; grants: number }> {
  if (!(before instanceof Date) || Number.isNaN(before.getTime())) {
    throw new IdentityError("invalid", "invalid time");
  }
  const at = sql`${before.toISOString()}::timestamptz`;
  const codes = await tx
    .delete(oauthCodes)
    .where(and(eq(oauthCodes.tenantId, tenantId), lt(oauthCodes.expiresAt, at)))
    .returning({ id: oauthCodes.id });
  const tokens = await tx
    .delete(oauthTokens)
    .where(and(eq(oauthTokens.tenantId, tenantId), lt(oauthTokens.expiresAt, at)))
    .returning({ id: oauthTokens.id });
  const ended = or(lt(oauthGrants.expiresAt, at), lt(oauthGrants.revokedAt, at));
  // Codes point at grants: a code still kept keeps its grant.
  const grants = await tx
    .delete(oauthGrants)
    .where(
      and(
        eq(oauthGrants.tenantId, tenantId),
        ended,
        sql`not exists (select 1 from oauth_codes c where c.tenant_id = ${oauthGrants.tenantId} and c.grant_id = ${oauthGrants.id})`,
      ),
    )
    .returning({ id: oauthGrants.id });
  return { codes: codes.length, tokens: tokens.length, grants: grants.length };
}
