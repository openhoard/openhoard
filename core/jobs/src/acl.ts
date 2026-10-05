import { appendAudit } from "@openhoard/core-audit";
import {
  addObjectGrants,
  liveObjectGrantsBy,
  queryRows,
  revokeGrants,
  revokeGrantsBy,
  sourceShares,
  type GrantRole,
  type SHARE_KINDS,
  type Tx,
} from "@openhoard/core-db";
import { and, eq, sql } from "drizzle-orm";
import {
  findGroupByExternalId,
  findUserByEmail,
  findUserByExternalId,
  groupPrincipal,
  userPrincipal,
} from "@openhoard/core-identity";
import type { AclPrincipal, AclRole, ItemAcl } from "@openhoard/sdk";

/*
 * A source's permissions as grants (T-305).
 *
 * A connector says who its source lets see an item (aclImport(): users and groups by the
 * source's ids, guests by email, sharing links, the whole organization). Here that becomes
 * grants on the object, made by the source (`granted_by` is `source:<id>`), and kept equal to
 * what the source says each time the item is synced: a permission added there is a grant added
 * here, one removed there is a grant revoked here. Nothing else decides access: the grants are
 * read by the same authorize() as any other, and a grant a person made is never touched.
 *
 * Who a permission is for is matched to someone OpenHoard already knows, and to nobody otherwise
 * (fails closed, and is counted, so an admin sees what to provision):
 *
 * - a user or a guest: the SCIM user whose `externalId` is the source's id for them; failing
 *   that, the local user with that email (a local user has no external id to match; a SCIM user
 *   is never matched by email, which the identity provider doesn't promise is theirs alone);
 *   never a service account. An invitation nobody has taken up names nobody;
 * - a group: the SCIM group whose `externalId` is the source's id. Its members are whoever the
 *   identity provider says, as for any group;
 * - a sharing link, and "everyone in the organization": nobody. Holding a link is not being
 *   named, and OpenHoard has no principal that is everyone: what members who aren't named may
 *   find is the object's visibility level, as for any file.
 *
 * Roles: `read` is read; `write` and `owner` are write (the object's owner here stays the
 * source's configured owner). An expiry the source gives is kept; without one the grant lasts
 * until the source takes the permission away.
 */

/** Who made an imported grant: the source, by its id. */
export const sourceGranter = (source: string): string => `source:${source}`;

/** What applying one item's permissions did. */
export interface AclOutcome {
  added: number;
  revoked: number;
  /** Users and guests the source names that match nobody here, by the source's id or email. */
  unmappedUsers: string[];
  /** Groups the source names that match no group here, by the source's id. */
  unmappedGroups: string[];
}

/** Matches a source's principals to OpenHoard's, remembering answers for one run. */
export interface AclResolver {
  /** `user:<id>` or `group:<id>`, or null for nobody. */
  principalOf(tx: Tx, principal: AclPrincipal): Promise<string | null>;
  /** Forgets every answer that was this principal (it is gone). */
  forget(principal: string): void;
  /** Forgets everything: the directory may have changed since. */
  clear(): void;
}

/** An expiry this close to the database's now() is taken as passed: a grant must outlast its creation. */
const EXPIRY_MARGIN_MS = 60_000;
/** Principals listed in one audit event; the counts say the rest. */
const AUDIT_LISTED = 50;

export function aclResolver(tenantId: string): AclResolver {
  const known = new Map<string, string | null>();
  const person = async (tx: Tx, id: string | undefined, email: string | undefined) => {
    if (id !== undefined) {
      const byId = await findUserByExternalId(tx, tenantId, id);
      if (byId) return byId.kind === "service" ? null : userPrincipal(byId.id);
    }
    if (email !== undefined) {
      const byEmail = await findUserByEmail(tx, tenantId, email);
      if (byEmail && byEmail.source === "local" && byEmail.kind !== "service") {
        return userPrincipal(byEmail.id);
      }
    }
    return null;
  };
  return {
    async principalOf(tx, p) {
      if (p.kind === "link" || p.kind === "organization") return null;
      const key = JSON.stringify(
        p.kind === "group" ? ["group", p.id] : ["person", p.id ?? null, p.email ?? null],
      );
      const cached = known.get(key);
      if (cached !== undefined) return cached;
      let found: string | null;
      if (p.kind === "group") {
        const group = await findGroupByExternalId(tx, tenantId, p.id);
        found = group ? groupPrincipal(group.id) : null;
      } else {
        found = await person(tx, p.id, p.email);
      }
      known.set(key, found);
      return found;
    },
    forget(principal) {
      for (const [key, value] of known) if (value === principal) known.delete(key);
    },
    clear() {
      known.clear();
    },
  };
}

const listed = (grants: readonly { principal: string; role: GrantRole }[]) =>
  grants
    .slice(0, AUDIT_LISTED)
    .map((g) => `${g.role} ${g.principal}`)
    .join(", ");

const RANK: Record<GrantRole, number> = { read: 0, write: 1 };
const roleOf = (role: AclRole): GrantRole => (role === "read" ? "read" : "write");

interface Wanted {
  role: GrantRole;
  /** Null: until the source takes it away. */
  expiresAt: Date | null;
}

/**
 * What two of the source's entries for one person here come to, giving no more than both did
 * (as the SDK's normalizeAcl() does for one principal): the stronger role when it lasts at
 * least as long as the weaker, else the weaker for its longer life.
 */
function both(a: Wanted, b: Wanted): Wanted {
  const outlasts = (x: Wanted, y: Wanted) =>
    x.expiresAt === null || (y.expiresAt !== null && x.expiresAt >= y.expiresAt);
  const [strong, weak] = RANK[b.role] > RANK[a.role] ? [b, a] : [a, b];
  return outlasts(strong, weak) ? strong : weak;
}

/**
 * Makes the source's grants on `objectId` equal to `acl`: adds what is missing, revokes what
 * the source no longer says (or says with another role or expiry), and leaves alone what is
 * already so. Only grants made by this source are looked at. Audited as one `grant.import`
 * event when anything changed.
 *
 * The tenant's principal lock is taken (core/db) when there is something to change. A caller
 * that also ingests in this transaction should take it first (lockPrincipals()) whenever the
 * ACL has entries, to keep the lock order: principals, then the item.
 */
export async function applySourceAcl(
  tx: Tx,
  tenantId: string,
  input: {
    source: string;
    objectId: string;
    acl: ItemAcl;
    resolver: AclResolver;
  },
): Promise<AclOutcome> {
  const { source, objectId, acl, resolver } = input;
  // Grants are dated by the database's clock, so what has lapsed is asked of it too (only when
  // an entry has an expiry at all).
  let now = 0;
  if (acl.entries.some((e) => e.expiresAt !== undefined)) {
    const [row] = await queryRows<{ now: Date | string }>(tx, sql`select now() as now`);
    now = new Date(row?.now ?? Date.now()).getTime();
  }
  const granter = sourceGranter(source);
  const outcome: AclOutcome = { added: 0, revoked: 0, unmappedUsers: [], unmappedGroups: [] };

  // What the source says, in OpenHoard's principals. Two of its principals may be one here (a
  // user named directly and by an invitation): the stronger role, the later expiry.
  const wanted = new Map<string, Wanted>();
  const shares = new Map<string, Share>();
  for (const entry of acl.entries) {
    const expiry = entry.expiresAt === undefined ? null : new Date(entry.expiresAt);
    if (expiry !== null && !(expiry.getTime() > now + EXPIRY_MARGIN_MS)) continue;
    const principal = await resolver.principalOf(tx, entry.principal);
    const share = shareOf(entry.principal, principal !== null);
    if (share) {
      shares.set(`${share.kind} ${share.key}`, {
        ...share,
        role: entry.role,
        inherited: entry.inherited,
        expiresAt: expiry,
      });
    }
    if (principal === null) {
      const p = entry.principal;
      if (p.kind === "group") outcome.unmappedGroups.push(p.id);
      else if (p.kind === "user") outcome.unmappedUsers.push(p.id);
      else if (p.kind === "guest") outcome.unmappedUsers.push(p.id ?? p.email);
      continue;
    }
    const want: Wanted = { role: roleOf(entry.role), expiresAt: expiry };
    const seen = wanted.get(principal);
    wanted.set(principal, seen ? both(seen, want) : want);
  }

  const same = (a: Date | null, b: Date | null) =>
    a === null || b === null ? a === b : a.getTime() === b.getTime();
  const held = await liveObjectGrantsBy(tx, tenantId, objectId, granter);
  const keep = new Set<string>();
  const revoke: typeof held = [];
  for (const grant of held) {
    const want = wanted.get(grant.principal);
    if (
      want &&
      !keep.has(grant.principal) &&
      want.role === grant.role &&
      same(want.expiresAt, grant.expiresAt)
    ) {
      keep.add(grant.principal);
    } else {
      revoke.push(grant);
    }
  }
  const add = [...wanted].filter(([principal]) => !keep.has(principal));
  if (revoke.length === 0 && add.length === 0) {
    await keepShares(tx, tenantId, source, objectId, [...shares.values()]);
    return outcome;
  }

  // Revoked first: a grant replaced by a weaker one is never live beside it. One statement
  // each way, so the tenant's principals are recomputed once for the file, not once a grant.
  outcome.revoked = await revokeGrants(
    tx,
    tenantId,
    revoke.map((g) => g.id),
    granter,
  );
  const made = await addObjectGrants(tx, tenantId, {
    objectId,
    grantedBy: granter,
    grants: add.map(([principal, want]) => ({ principal, ...want })),
  });
  // Retired or deleted since they were matched: nobody now, and not remembered as someone.
  for (const principal of made.unknown) resolver.forget(principal);
  // After the grants, which take the principals' lock: that lock comes before the object's
  // (core/catalog locks.ts), which a row naming the object takes a share of.
  await keepShares(tx, tenantId, source, objectId, [...shares.values()]);
  const added = add
    .filter(([principal]) => !made.unknown.includes(principal))
    .map(([principal, want]) => ({ principal, role: want.role }));
  outcome.added = added.length;
  if (outcome.added + outcome.revoked > 0) {
    await appendAudit(tx, tenantId, {
      actor: granter,
      action: "grant.import",
      decision: "allow",
      object: objectId,
      detail: {
        source,
        basis: acl.basis,
        added: outcome.added,
        revoked: outcome.revoked,
        // (An audit detail holds text and numbers: the lists are text.)
        granted: listed(added),
        withdrawn: listed(revoke),
      },
    });
  }
  return outcome;
}

interface Share {
  kind: (typeof SHARE_KINDS)[number];
  key: string;
  role: AclRole;
  inherited: boolean;
  expiresAt: Date | null;
  matched: boolean;
}

/**
 * What an entry is beyond a grant, for the File Health Report (core/db source_shares): a
 * sharing link, the whole organization, a guest, or a person or group that matched nobody.
 * A user or group that matched is a grant, and nothing here.
 */
function shareOf(
  p: AclPrincipal,
  matched: boolean,
): Pick<Share, "kind" | "key" | "matched"> | null {
  switch (p.kind) {
    case "link":
      return { kind: `link-${p.scope}`, key: p.id, matched: false };
    case "organization":
      return { kind: "organization", key: "", matched: false };
    case "guest":
      return { kind: "guest", key: p.email, matched };
    case "user":
    case "group":
      return matched ? null : { kind: p.kind, key: p.id, matched: false };
  }
}

/**
 * Makes the source's shares on the object equal to `shares`: one read, and a write only when
 * they differ. They give nobody anything, so no lock on the principals and no audit event.
 */
async function keepShares(
  tx: Tx,
  tenantId: string,
  source: string,
  objectId: string,
  shares: readonly Share[],
): Promise<void> {
  const mine = and(
    eq(sourceShares.tenantId, tenantId),
    eq(sourceShares.source, source),
    eq(sourceShares.objectId, objectId),
  );
  const line = (s: Share) =>
    JSON.stringify([s.kind, s.key, s.role, s.inherited, s.expiresAt?.getTime() ?? null, s.matched]);
  const held = (await tx.select().from(sourceShares).where(mine)).map(line).sort();
  const want = shares.map(line).sort();
  if (held.length === want.length && held.every((h, i) => h === want[i])) return;
  if (held.length > 0) await tx.delete(sourceShares).where(mine);
  if (shares.length > 0) {
    await tx.insert(sourceShares).values(shares.map((s) => ({ tenantId, source, objectId, ...s })));
  }
}

/**
 * Takes back every grant the source made: for a source whose permissions are no longer
 * imported, which leaves its files to their owner. Audited as one `grant.import` event when
 * there was anything to take back. Returns how many grants.
 */
export async function withdrawSourceGrants(
  tx: Tx,
  tenantId: string,
  source: string,
): Promise<number> {
  const granter = sourceGranter(source);
  // What it shared is no longer known either.
  await tx
    .delete(sourceShares)
    .where(and(eq(sourceShares.tenantId, tenantId), eq(sourceShares.source, source)));
  const revoked = await revokeGrantsBy(tx, tenantId, granter, granter);
  if (revoked > 0) {
    await appendAudit(tx, tenantId, {
      actor: granter,
      action: "grant.import",
      decision: "allow",
      detail: { source, basis: "owner-only", added: 0, revoked, reason: "not-importing" },
    });
  }
  return revoked;
}
