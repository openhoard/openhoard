import { queryRows, type Tx } from "@openhoard/core-db";
import type { AuthzPrincipal } from "@openhoard/core-policy";
import { sql } from "drizzle-orm";
import { resolveWithExpiry, type PrincipalOptions } from "./directory.js";

/*
 * The principal-set service (T-107): resolvePrincipal() with a cache in front, since every
 * request needs its caller's principal and resolving one reads memberships and grants.
 *
 * Invalidation is the database's job, so it holds across processes: every change resolvePrincipal
 * reads bumps the tenant's principal epoch in the writing transaction (triggers, core/db
 * migration 0021). An entry remembers the epoch it was resolved at and is used only by a
 * transaction that sees that same epoch, so a committed change (a grant, a membership, a lock, a
 * retirement, a SCIM sync) reaches the next request everywhere at once. Time does the rest: an
 * entry lasts until its soonest grant expires, and never longer than `ttlMillis`.
 *
 * Only read-only snapshot transactions (VIEW_TRANSACTION: REPEATABLE READ, or SERIALIZABLE) use
 * or fill the cache. A transaction that writes may see its own uncommitted changes, and may yet
 * roll back; a READ COMMITTED one reads the epoch and the rows in different snapshots. Either
 * resolves afresh and keeps nothing, as does a tenant with no epoch yet.
 *
 * Grants are resolved as of the moment the epoch is read (statement_timestamp()), not the
 * transaction's start: every change the snapshot shows committed before that moment, and was
 * timed before it (a grant or revocation takes its writer's now()), so the entry is exactly what
 * the snapshot holds at that moment.
 *
 * Invalidation is tenant-wide: any grant or membership change, even a one-object share, drops
 * every entry of that tenant. Grants and revocations dated in the future (tests pass `now`)
 * reach the cache at the latest after `ttlMillis`.
 */

export interface PrincipalCacheOptions {
  /** Most entries kept; the least recently used go first. Default 10,000. */
  maxEntries?: number;
  /** Longest an entry lives, whatever changes. Default 60 s. */
  ttlMillis?: number;
  /**
   * Each tenant's admin group, by SCIM externalId (the server's config, T-106): see
   * resolvePrincipal(). Fixed for the cache's life: a config change comes with a new process.
   */
  adminGroup?: (tenantId: string) => string | undefined;
}

export interface PrincipalCacheStats {
  hits: number;
  misses: number;
  /** Resolved without the cache: a transaction that can write. */
  bypassed: number;
  size: number;
}

interface Entry {
  epoch: number;
  /** Milliseconds, by the database's clock. */
  validUntil: number;
  principal: AuthzPrincipal;
}

export class PrincipalCache {
  readonly #entries = new Map<string, Entry>();
  readonly #max: number;
  readonly #ttl: number;
  readonly #adminGroup: ((tenantId: string) => string | undefined) | undefined;
  #stats = { hits: 0, misses: 0, bypassed: 0 };

  constructor(options: PrincipalCacheOptions = {}) {
    this.#max = options.maxEntries ?? 10_000;
    this.#ttl = options.ttlMillis ?? 60_000;
    this.#adminGroup = options.adminGroup;
    if (!Number.isSafeInteger(this.#max) || this.#max < 1) {
      throw new RangeError("maxEntries must be a whole number of at least 1");
    }
    if (!Number.isSafeInteger(this.#ttl) || this.#ttl < 0) {
      throw new RangeError("ttlMillis must be a whole number of milliseconds");
    }
  }

  /**
   * The user's principal (see resolvePrincipal()), from the cache when it still holds; null for
   * an unknown user, which isn't cached.
   */
  async resolve(tx: Tx, tenantId: string, userId: string): Promise<AuthzPrincipal | null> {
    const [state] = await queryRows<{
      epoch: string | null;
      moment: Date | string;
      readOnly: string;
      isolation: string;
    }>(
      tx,
      sql`select (select epoch from principal_epochs where tenant_id = ${tenantId})::text as epoch,
                 statement_timestamp() as moment,
                 current_setting('transaction_read_only') as "readOnly",
                 current_setting('transaction_isolation') as isolation`,
    );
    const snapshot = state?.isolation === "repeatable read" || state?.isolation === "serializable";
    if (!state || state.readOnly !== "on" || !snapshot || state.epoch === null) {
      this.#stats.bypassed++;
      return (
        (await resolveWithExpiry(tx, tenantId, userId, undefined, this.options(tenantId)))
          ?.principal ?? null
      );
    }
    const epoch = Number(state.epoch);
    const at = new Date(state.moment);
    const now = at.getTime();
    const key = `${tenantId}/${userId}`;
    const entry = this.#entries.get(key);
    if (entry && entry.epoch === epoch && now < entry.validUntil) {
      this.#stats.hits++;
      // Most recently used goes last.
      this.#entries.delete(key);
      this.#entries.set(key, entry);
      return entry.principal;
    }
    this.#stats.misses++;
    const resolved = await resolveWithExpiry(tx, tenantId, userId, at, this.options(tenantId));
    if (!resolved) {
      this.#entries.delete(key);
      return null;
    }
    const principal = freezePrincipal(resolved.principal);
    const expires = resolved.expiresAt?.getTime() ?? Infinity;
    const validUntil = Math.min(now + this.#ttl, expires);
    // An older snapshot never replaces what a newer one resolved, nor a longer-lived entry of
    // the same epoch (a long transaction's moment is early).
    if (!entry || entry.epoch < epoch || (entry.epoch === epoch && validUntil > entry.validUntil)) {
      this.#entries.delete(key);
      this.#entries.set(key, { epoch, validUntil, principal });
      while (this.#entries.size > this.#max) {
        const oldest = this.#entries.keys().next().value as string;
        this.#entries.delete(oldest);
      }
    }
    return principal;
  }

  /** What resolving a principal of this tenant needs besides the database. */
  options(tenantId: string): PrincipalOptions {
    const adminGroup = this.#adminGroup?.(tenantId);
    return adminGroup === undefined ? {} : { adminGroup };
  }

  /** Forgets this process's entries: for one tenant, or all. The epoch makes this rarely needed. */
  clear(tenantId?: string): void {
    if (tenantId === undefined) return this.#entries.clear();
    for (const key of this.#entries.keys()) {
      if (key.startsWith(`${tenantId}/`)) this.#entries.delete(key);
    }
  }

  stats(): PrincipalCacheStats {
    return { ...this.#stats, size: this.#entries.size };
  }
}

/** A principal nobody can change: its lists (and its scope's) are frozen too. */
export function freezePrincipal(p: AuthzPrincipal): AuthzPrincipal {
  return Object.freeze({
    ...p,
    ...(p.scope === undefined
      ? {}
      : {
          scope: Object.freeze({
            ...p.scope,
            actions: Object.freeze([...p.scope.actions]),
            zones: Object.freeze([...p.scope.zones]),
            ...(p.scope.zoneIds === undefined
              ? {}
              : { zoneIds: Object.freeze([...p.scope.zoneIds]) }),
          }),
        }),
    groupIds: Object.freeze([...p.groupIds]),
    tagGrants: Object.freeze([...p.tagGrants]),
    tagWriteGrants: Object.freeze([...p.tagWriteGrants]),
    objectGrants: Object.freeze([...p.objectGrants]),
    objectWriteGrants: Object.freeze([...p.objectWriteGrants]),
  }) as AuthzPrincipal;
}
