import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isId, newId, queryRows, scimTokens, type Tx } from "@openhoard/core-db";
import { and, asc, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { IdentityError } from "./directory.js";

/*
 * SCIM tokens (T-103): how a tenant's identity provider authenticates to the SCIM endpoint
 * (`/scim/v2`), which creates, changes and retires that tenant's SCIM users and groups.
 *
 * - Not API keys. A key speaks for a service account, a principal holding grants; a SCIM token
 *   speaks for the tenant's identity provider, which holds no grants and does one thing: keep
 *   the directory in step. Its changes are recorded as `scim:<token id>`, the actor the directory
 *   lets manage SCIM users and groups (and nothing else).
 * - A token is `ohscim.<tenant id>.<token id>.<secret>`: the tenant says where to look (as a
 *   session's `ohs.` does), so the endpoint is one URL for every tenant; the id finds the token,
 *   the secret proves it. Only a SHA-256 of the secret is kept; issueScimToken() returns the
 *   whole token once, and never again.
 * - Every token expires, within a year; revokeScimToken() stops it. checkScimToken() reads the
 *   token on every request, so a revoked or expired one fails on the next request.
 * - Every use is to be audited by the caller, allowed or refused. checkScimToken() says why an
 *   attempt on a real token id was refused (wrong secret, revoked, expired), for the audit log
 *   only: the caller answers every refusal alike.
 */

/** Most a token can live: a year. */
export const SCIM_TOKEN_MAX_DAYS = 365;
const SECRET_BYTES = 32;
const TOKEN =
  /^ohscim\.(ten_[0-9a-hjkmnp-tv-z]{26})\.(sct_[0-9a-hjkmnp-tv-z]{26})\.([A-Za-z0-9_-]{43})$/;
const ADMIN = /^(user|system):[^\0]{1,1000}$/;
/** A token's last use is written at most this often. */
const TOUCH_SECONDS = 60;

export interface ScimTokenInput {
  /** What it is for: "Entra provisioning". 1 to 200 visible characters. */
  name: string;
  /**
   * When it stops working: a time in the future, within {@link SCIM_TOKEN_MAX_DAYS} days, or a
   * whole number of days (1 to {@link SCIM_TOKEN_MAX_DAYS}) from now by the database's clock.
   * Exactly one of the two.
   */
  expiresAt?: Date;
  days?: number;
  /** The admin issuing it: `user:…` or `system:…`. */
  by: string;
}

/** A token as an admin sees it: never the secret. */
export interface ScimToken {
  id: string;
  name: string;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  revokedBy: string | null;
}

/** The directory actor a token's changes are recorded as. */
export const scimActor = (tokenId: string): string => `scim:${tokenId}`;

/**
 * Issues a SCIM token for the tenant. Returns it with its `token`, the only time the secret is
 * seen: show it once and keep nothing.
 */
export async function issueScimToken(
  tx: Tx,
  tenantId: string,
  input: ScimTokenInput,
): Promise<ScimToken & { token: string }> {
  const name = typeof input.name === "string" ? input.name : "";
  const chars = [...name].length;
  if (chars < 1 || chars > 200 || /[\p{C}\p{Zl}\p{Zp}]/u.test(name) || name.trim() === "") {
    throw new IdentityError("invalid", "a token's name is 1 to 200 visible characters");
  }
  if (typeof input.by !== "string" || !ADMIN.test(input.by)) {
    throw new IdentityError("invalid", "by must be user: or system:");
  }
  const { expiresAt, days } = input;
  let expires: Date | SQL;
  if (days !== undefined && expiresAt === undefined) {
    if (!Number.isSafeInteger(days) || days < 1 || days > SCIM_TOKEN_MAX_DAYS) {
      throw new IdentityError("invalid", `days must be 1 to ${SCIM_TOKEN_MAX_DAYS}`);
    }
    expires = sql`now() + make_interval(days => ${days})`;
  } else {
    if (days !== undefined || !(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
      throw new IdentityError("invalid", "give expiresAt (a date) or days, not both");
    }
    // Checked by the database's clock, which also dates the token.
    const [window] = await queryRows<{ ok: boolean }>(
      tx,
      sql`select ${expiresAt.toISOString()}::timestamptz > now()
             and ${expiresAt.toISOString()}::timestamptz <= now() + make_interval(days => ${SCIM_TOKEN_MAX_DAYS}) as ok`,
    );
    if (!window?.ok) {
      throw new IdentityError(
        "invalid",
        `expiresAt must be in the future, within ${SCIM_TOKEN_MAX_DAYS} days`,
      );
    }
    expires = expiresAt;
  }
  const id = newId("scimToken");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const [row] = await tx
    .insert(scimTokens)
    .values({
      tenantId,
      id,
      name,
      secretHash: hash(secret),
      createdBy: input.by,
      expiresAt: expires,
    })
    .returning();
  return { ...toToken(row as TokenRow), token: `ohscim.${tenantId}.${id}.${secret}` };
}

/** The tenant's SCIM tokens, newest first, without secrets. */
export async function listScimTokens(tx: Tx, tenantId: string): Promise<ScimToken[]> {
  const rows = await tx
    .select()
    .from(scimTokens)
    .where(eq(scimTokens.tenantId, tenantId))
    .orderBy(asc(scimTokens.createdAt), asc(scimTokens.id));
  return rows.map(toToken).reverse();
}

/** Stops a token for good. Returns false if it was revoked already (or doesn't exist). */
export async function revokeScimToken(
  tx: Tx,
  tenantId: string,
  tokenId: string,
  by: string,
): Promise<boolean> {
  if (typeof by !== "string" || !ADMIN.test(by)) {
    throw new IdentityError("invalid", "by must be user: or system:");
  }
  if (typeof tokenId !== "string" || !isId("scimToken", tokenId)) return false;
  const revoked = await tx
    .update(scimTokens)
    .set({ revokedAt: sql`greatest(now(), ${scimTokens.createdAt})`, revokedBy: by })
    .where(
      and(
        eq(scimTokens.tenantId, tenantId),
        eq(scimTokens.id, tokenId),
        isNull(scimTokens.revokedAt),
      ),
    )
    .returning({ id: scimTokens.id });
  return revoked.length > 0;
}

/**
 * The tenant and token a bearer token names, or null when it isn't one. Checks nothing else:
 * it only says which tenant's transaction to check it in.
 */
export function parseScimToken(token: unknown): { tenantId: string; tokenId: string } | null {
  const m = typeof token === "string" ? TOKEN.exec(token) : null;
  return m?.[1] && m[2] ? { tenantId: m[1], tokenId: m[2] } : null;
}

/** Why a well-formed token for a real token id was refused: for the audit, never the caller. */
export type ScimTokenRefusal = "wrong-secret" | "revoked" | "expired";

export type ScimTokenCheck =
  | {
      ok: true;
      tokenId: string;
      /** `scim:<token id>`: who the directory records as acting. */
      actor: string;
      /** Its last recorded use is old enough to record this one: call touchScimToken(). */
      stale: boolean;
    }
  | { ok: false; refused: { tokenId: string; reason: ScimTokenRefusal } | null };

/**
 * Checks a bearer token on a request to `tenantId`'s SCIM endpoint: it must name this tenant and
 * a token of it, match its secret, and be neither revoked nor expired. For a refused attempt on
 * a real token id it says why (for the audit log); anything else is refused with `null`, alike.
 * Writes nothing.
 */
export async function checkScimToken(
  tx: Tx,
  tenantId: string,
  token: string,
): Promise<ScimTokenCheck> {
  const m = typeof token === "string" ? TOKEN.exec(token) : null;
  const named = m !== null && m[1] === tenantId;
  const tokenId = named ? (m[2] as string) : undefined;
  const [row] =
    tokenId === undefined
      ? []
      : await tx
          .select({
            secretHash: scimTokens.secretHash,
            revoked: sql<boolean>`${scimTokens.revokedAt} is not null`,
            expired: sql<boolean>`${scimTokens.expiresAt} <= statement_timestamp()`,
            stale: sql<boolean>`${scimTokens.lastUsedAt} is null
              or ${scimTokens.lastUsedAt} < statement_timestamp() - make_interval(secs => ${TOUCH_SECONDS})`,
          })
          .from(scimTokens)
          .where(and(eq(scimTokens.tenantId, tenantId), eq(scimTokens.id, tokenId)));
  // Compared in constant time, and against something even when there is no token.
  const same = timingSafeEqual(
    Buffer.from(hash(named ? (m[3] as string) : ""), "hex"),
    Buffer.from(row?.secretHash ?? "0".repeat(64), "hex"),
  );
  if (!row || tokenId === undefined) return { ok: false, refused: null };
  const refuse = (reason: ScimTokenRefusal): ScimTokenCheck => ({
    ok: false,
    refused: { tokenId, reason },
  });
  if (!same) return refuse("wrong-secret");
  if (row.revoked) return refuse("revoked");
  if (row.expired) return refuse("expired");
  return { ok: true, tokenId, actor: scimActor(tokenId), stale: row.stale };
}

/** Records a token's use now (for admins: when it last worked). Returns whether it was written. */
export async function touchScimToken(tx: Tx, tenantId: string, tokenId: string): Promise<boolean> {
  const rows = await tx
    .update(scimTokens)
    .set({ lastUsedAt: sql`greatest(statement_timestamp(), ${scimTokens.createdAt})` })
    .where(
      and(
        eq(scimTokens.tenantId, tenantId),
        eq(scimTokens.id, tokenId),
        isNull(scimTokens.revokedAt),
        or(
          isNull(scimTokens.lastUsedAt),
          sql`${scimTokens.lastUsedAt} < statement_timestamp() - make_interval(secs => ${TOUCH_SECONDS})`,
        ),
      ),
    )
    .returning({ id: scimTokens.id });
  return rows.length > 0;
}

/**
 * Removes up to `limit` of a tenant's SCIM tokens that were revoked or expired before `before`;
 * returns how many went. Call it again until it returns less than the limit (the scheduled
 * maintenance in core/jobs does). The audit log keeps each token's issue, revocation and uses
 * (`scim:<token id>`); the row only matters while the token could still work, and for
 * listScimTokens() a while after.
 */
export async function pruneScimTokens(
  tx: Tx,
  tenantId: string,
  before: Date,
  limit = 1_000,
): Promise<number> {
  if (!(before instanceof Date) || Number.isNaN(before.getTime())) {
    throw new IdentityError("invalid", "invalid time");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) {
    throw new IdentityError("invalid", "limit is 1 to 100000");
  }
  const at = sql`${before.toISOString()}::timestamptz`;
  const due = tx
    .select({ id: scimTokens.id })
    .from(scimTokens)
    .where(
      and(
        eq(scimTokens.tenantId, tenantId),
        or(lt(scimTokens.revokedAt, at), lt(scimTokens.expiresAt, at)),
      ),
    )
    .limit(limit);
  const rows = await tx
    .delete(scimTokens)
    .where(and(eq(scimTokens.tenantId, tenantId), inArray(scimTokens.id, due)))
    .returning({ id: scimTokens.id });
  return rows.length;
}

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");

type TokenRow = typeof scimTokens.$inferSelect;
const toToken = (r: TokenRow): ScimToken => ({
  id: r.id,
  name: r.name,
  createdBy: r.createdBy,
  createdAt: r.createdAt,
  expiresAt: r.expiresAt,
  lastUsedAt: r.lastUsedAt,
  revokedAt: r.revokedAt,
  revokedBy: r.revokedBy,
});
