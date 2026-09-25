import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  apiKeys,
  isId,
  KEY_ACTIONS,
  lockPrincipals,
  newId,
  queryRows,
  users,
  ZONE_KINDS,
  zones,
  type Tx,
} from "@openhoard/core-db";
import type { Action, AuthzPrincipal, CredentialScope } from "@openhoard/core-policy";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { IdentityError, resolveWithExpiry } from "./directory.js";
import { freezePrincipal, type PrincipalCache } from "./principal-cache.js";

/*
 * API keys (T-111): how a service account (CI, a connector, a script) authenticates. Never for
 * people: a person signs in (T-102, T-108), and a key belongs to a service account only.
 *
 * - A key is `ohk.<key id>.<secret>`: the id finds it, the secret proves it. Only a SHA-256 of
 *   the secret is kept; the whole key is returned once, by issueApiKey(), and never again.
 * - Every key is scoped to some actions and zone kinds. The scope rides on the principal
 *   (AuthzPrincipal.scope) into authorize(), where the core rule `core/scope` forbids anything
 *   outside it; within it the service account still needs grants, like anyone.
 * - Every key expires, within a year; revokeApiKey() stops it, and authenticateApiKey() reads
 *   the key on every call, so a revoked key fails on the next request. A service account that is
 *   locked or retired fails too (its principal is inactive; retiring revokes its keys).
 * - Every use is to be audited, by the caller: authenticateApiKey() returns what
 *   keyUseRecord() turns into the audit record, and the caller appends it (core/audit
 *   appendAudit) with the request it served, allowed or not. checkApiKey() also says why an
 *   attempt on a real key id was refused, for the same log. See the README for the server's part.
 * - A key that searches must also read: listings decide by `read` (core/catalog viewObjects).
 */

/** Most a key can live: a year. */
export const API_KEY_MAX_DAYS = 365;
const SECRET_BYTES = 32;
const TOKEN = /^ohk\.(key_[0-9a-hjkmnp-tv-z]{26})\.([A-Za-z0-9_-]{43})$/;
const PRINCIPAL = /^(user|system):[^\0]{1,1000}$/;

export interface ApiKeyInput {
  /** The service account it authenticates. */
  userId: string;
  /** What it is for: "nightly export", "CI". 1 to 200 characters. */
  name: string;
  actions: readonly Action[];
  /** Zone kinds. */
  zones: readonly string[];
  /** Only these zones (ids), when the key is for some zones only: a connector's own site. */
  zoneIds?: readonly string[];
  /** When it stops working: in the future, within {@link API_KEY_MAX_DAYS}. */
  expiresAt: Date;
  /** The admin issuing it: `user:…` or `system:…`. */
  by: string;
}

/** A key as an admin sees it: never the secret. */
export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  scope: CredentialScope;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
}

/**
 * Issues a key for a service account. Returns it with its `token`, the only time the secret is
 * seen: show it once and keep nothing.
 */
export async function issueApiKey(
  tx: Tx,
  tenantId: string,
  input: ApiKeyInput,
): Promise<ApiKey & { token: string }> {
  const name = typeof input.name === "string" ? input.name : "";
  const chars = [...name].length;
  if (chars < 1 || chars > 200 || /[\p{C}\p{Zl}\p{Zp}]/u.test(name) || name.trim() === "") {
    throw new IdentityError("invalid", "a key's name is 1 to 200 visible characters");
  }
  const scope = checkScope(input.actions, input.zones, input.zoneIds);
  if (scope.actions.includes("search") && !scope.actions.includes("read")) {
    throw new IdentityError("invalid", "a key that searches must also read: listings need read");
  }
  if (!PRINCIPAL.test(input.by)) throw new IdentityError("invalid", "by must be user: or system:");
  const expires = input.expiresAt;
  if (!(expires instanceof Date) || Number.isNaN(expires.getTime())) {
    throw new IdentityError("invalid", "expiresAt must be a date");
  }
  // The principal lock first, as every change to what a principal can do takes it; then the
  // service account, which must exist, be one and be current. Key-share holds it, so a
  // retirement runs before or after this, never in between.
  await lockPrincipals(tx, tenantId);
  const [owner] = await tx
    .select({ kind: users.kind, retiredAt: users.retiredAt })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, input.userId)))
    .for("key share");
  if (!owner) throw new IdentityError("not-found", `no user ${input.userId}`);
  if (owner.kind !== "service") {
    throw new IdentityError("invalid", "API keys are for service accounts, never for people");
  }
  if (owner.retiredAt !== null) {
    throw new IdentityError("retired", `service account ${input.userId} is retired`);
  }
  // Zone ids name zones of this tenant, of the key's kinds: a typo would make a useless key.
  if (scope.zoneIds !== undefined) {
    const found = await tx
      .select({ id: zones.id, kind: zones.kind })
      .from(zones)
      .where(and(eq(zones.tenantId, tenantId), inArray(zones.id, [...scope.zoneIds])));
    const fits = new Set(found.filter((z) => scope.zones.includes(z.kind)).map((z) => z.id));
    const off = scope.zoneIds.filter((z) => !fits.has(z));
    if (off.length > 0) {
      throw new IdentityError(
        "invalid",
        `not zones of this tenant of the key's kinds: ${off.join(", ")}`,
      );
    }
  }
  // Checked by the database's clock, which also dates the key.
  const [window] = await queryRows<{ ok: boolean }>(
    tx,
    sql`select ${expires.toISOString()}::timestamptz > now()
           and ${expires.toISOString()}::timestamptz <= now() + make_interval(days => ${API_KEY_MAX_DAYS}) as ok`,
  );
  if (!window?.ok) {
    throw new IdentityError(
      "invalid",
      `expiresAt must be in the future, within ${API_KEY_MAX_DAYS} days`,
    );
  }
  const id = newId("apiKey");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const [row] = await tx
    .insert(apiKeys)
    .values({
      tenantId,
      id,
      userId: input.userId,
      name,
      secretHash: hash(secret),
      actions: [...scope.actions],
      zones: [...scope.zones],
      zoneIds: scope.zoneIds === undefined ? null : [...scope.zoneIds],
      createdBy: input.by,
      expiresAt: expires,
    })
    .returning();
  return { ...toKey(row as KeyRow), token: `ohk.${id}.${secret}` };
}

/** A service account's keys, newest first, without secrets. */
export async function listApiKeys(tx: Tx, tenantId: string, userId: string): Promise<ApiKey[]> {
  const rows = await tx
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.userId, userId)))
    .orderBy(asc(apiKeys.createdAt), asc(apiKeys.id));
  return rows.map(toKey).reverse();
}

/** Stops a key for good. Returns false if it was revoked already (or doesn't exist). */
export async function revokeApiKey(
  tx: Tx,
  tenantId: string,
  keyId: string,
  by: string,
): Promise<boolean> {
  if (!PRINCIPAL.test(by)) throw new IdentityError("invalid", "by must be user: or system:");
  const revoked = await tx
    .update(apiKeys)
    .set({ revokedAt: sql`greatest(now(), ${apiKeys.createdAt})`, revokedBy: by })
    .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return revoked.length > 0;
}

/** Who a valid key speaks for, and what it may do. */
export interface KeyUse {
  keyId: string;
  userId: string;
  /** The service account's principal, with the key's scope: what authorize() takes. */
  principal: AuthzPrincipal;
}

/** Why a well-formed key for a real key id was refused: for the audit, never for the caller. */
export type KeyRefusal = "wrong-secret" | "revoked-or-expired" | "account-inactive";

/** checkApiKey()'s answer: the use, or, for a real key id, why it was refused. */
export type KeyCheck =
  | { ok: true; use: KeyUse }
  | { ok: false; refused: { keyId: string; userId: string; reason: KeyRefusal } | null };

/**
 * The service account a key speaks for, as a principal limited to the key's scope; null for
 * anything else (malformed, unknown, wrong secret, revoked, expired, a retired or locked
 * account), all alike. Reads the key every time, so a revocation counts from the next request.
 * `cache`, when given, serves the principal (core/identity PrincipalCache).
 */
export async function authenticateApiKey(
  tx: Tx,
  tenantId: string,
  token: string,
  options: { cache?: PrincipalCache } = {},
): Promise<KeyUse | null> {
  const check = await checkApiKey(tx, tenantId, token, options);
  return check.ok ? check.use : null;
}

/**
 * authenticateApiKey(), and for a refused attempt on a real key id, why: for the server's audit
 * log (never for the caller, who gets the same refusal whatever the reason).
 */
export async function checkApiKey(
  tx: Tx,
  tenantId: string,
  token: string,
  options: { cache?: PrincipalCache } = {},
): Promise<KeyCheck> {
  const match = typeof token === "string" ? TOKEN.exec(token) : null;
  const keyId = match?.[1];
  const secret = match?.[2];
  const [row] =
    keyId !== undefined && isId("apiKey", keyId)
      ? await tx
          .select({
            userId: apiKeys.userId,
            secretHash: apiKeys.secretHash,
            actions: apiKeys.actions,
            zones: apiKeys.zones,
            zoneIds: apiKeys.zoneIds,
            live: sql<boolean>`${apiKeys.revokedAt} is null and ${apiKeys.expiresAt} > statement_timestamp()`,
          })
          .from(apiKeys)
          .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, keyId)))
      : [];
  // Compared in constant time, and against something even when there is no key to compare to.
  const given = Buffer.from(hash(secret ?? ""), "hex");
  const stored = Buffer.from(row?.secretHash ?? "0".repeat(64), "hex");
  const same = timingSafeEqual(given, stored);
  if (!row || !keyId) return { ok: false, refused: null };
  const refuse = (reason: KeyRefusal): KeyCheck => ({
    ok: false,
    refused: { keyId, userId: row.userId, reason },
  });
  if (!same) return refuse("wrong-secret");
  if (!row.live) return refuse("revoked-or-expired");
  const base = options.cache
    ? await options.cache.resolve(tx, tenantId, row.userId)
    : ((await resolveWithExpiry(tx, tenantId, row.userId))?.principal ?? null);
  if (!base || base.service !== true || !base.active) return refuse("account-inactive");
  const scope = checkScope(row.actions as Action[], row.zones, row.zoneIds ?? undefined);
  return {
    ok: true,
    use: { keyId, userId: row.userId, principal: freezePrincipal({ ...base, scope }) },
  };
}

/**
 * The audit record for one use of a key, for core/audit appendAudit(): who (the service
 * account), which key, and what it did.
 */
export function keyUseRecord(
  use: KeyUse,
  event: {
    action: string;
    decision: "allow" | "deny";
    client?: string;
    object?: string;
    version?: string;
  },
): {
  actor: string;
  action: string;
  decision: "allow" | "deny";
  client?: string;
  object?: string;
  version?: string;
  detail: Record<string, string>;
} {
  return { ...event, actor: `user:${use.userId}`, detail: { apiKey: use.keyId } };
}

function checkScope(
  actions: readonly unknown[],
  zones: readonly unknown[],
  zoneIds?: readonly unknown[],
): CredentialScope {
  const list = (v: readonly unknown[], allowed: readonly string[], what: string) => {
    if (!Array.isArray(v) || v.length === 0 || !v.every((x) => allowed.includes(x as string))) {
      throw new IdentityError("invalid", `a key's ${what} are some of ${allowed.join(", ")}`);
    }
    return [...new Set(v as string[])].sort();
  };
  const ids = (v: readonly unknown[]) => {
    if (!Array.isArray(v) || v.length === 0 || v.length > 100) {
      throw new IdentityError("invalid", "a key's zone ids are 1 to 100 zone ids");
    }
    if (!v.every((x) => typeof x === "string" && isId("zone", x))) {
      throw new IdentityError("invalid", "a key's zone ids must be zone ids");
    }
    return [...new Set(v as string[])].sort();
  };
  return {
    actions: list(actions, KEY_ACTIONS, "actions") as Action[],
    zones: list(zones, ZONE_KINDS, "zones"),
    ...(zoneIds === undefined ? {} : { zoneIds: ids(zoneIds) }),
  };
}

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");

type KeyRow = typeof apiKeys.$inferSelect;
const toKey = (r: KeyRow): ApiKey => ({
  id: r.id,
  userId: r.userId,
  name: r.name,
  scope: {
    actions: r.actions as Action[],
    zones: r.zones,
    ...(r.zoneIds === null ? {} : { zoneIds: r.zoneIds }),
  },
  createdBy: r.createdBy,
  createdAt: r.createdAt,
  expiresAt: r.expiresAt,
  revokedAt: r.revokedAt,
  revokedBy: r.revokedBy,
});
