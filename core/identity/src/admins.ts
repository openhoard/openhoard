import { groupMembers, groups, lockPrincipals, users, type Tx } from "@openhoard/core-db";
import { and, asc, eq, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { getUser, IdentityError, type User } from "./directory.js";

/*
 * Tenant admins (T-106): who may administer a tenant (its settings, its AI clients, its
 * admins). Administration only: being an admin gives nothing on files (core/policy
 * mayAdminister(), and authorize() never reads it).
 *
 * Someone is an admin two ways:
 *
 * - The admin role, held in OpenHoard (`users.admin_at`). The first is granted by an operator
 *   with the admin CLI (`admin user grant-admin`), later ones by admins (the admin API).
 * - Membership of the tenant's admin group, one identity provider group the server's config
 *   names by SCIM externalId (optional). The identity provider decides who is in it, so nobody
 *   can remove a group admin in OpenHoard: they leave the group upstream.
 *
 * Either way it counts only while the person is an active member: a lock, a provider disable or
 * a guest's kind suspends it, and retirement removes the role for good. A service account or a
 * guest is never granted it.
 *
 * The tenant keeps at least one admin: removing the role from the last one who counts (group
 * admins included) is refused. Locking, disabling or retiring people isn't limited by it (the
 * identity provider may do all three), so a tenant can still end up with none; the admin CLI
 * grants a new one.
 *
 * Every change takes the tenant's principal lock first (core/db lockPrincipals()), which also
 * serializes the last-admin check with any concurrent removal, lock or retirement. The admin
 * role is part of the principal (resolvePrincipal()), so its column bumps the principal epoch
 * (core/db migration 0036). Callers audit every grant and removal (apps/server).
 */

/** Where an admin's role comes from. */
export type AdminVia = "role" | "group";

export interface AdminOptions {
  /** The SCIM externalId of the tenant's admin group (the server's config), if any. */
  adminGroup?: string | undefined;
}

export interface Admin {
  user: User;
  /** The role held in OpenHoard, the identity provider's admin group, or both. */
  via: AdminVia[];
  /** Whether it counts now: an active member. */
  effective: boolean;
}

/** At most this many admins listed (an admin group may be large). */
export const MAX_ADMINS_LISTED = 1000;

const ADMIN_ACTOR = /^(user|system):[^\0]{1,1000}$/;

function checkBy(by: string): void {
  if (typeof by !== "string" || !ADMIN_ACTOR.test(by)) {
    throw new IdentityError("invalid", "an admin or the system decides: user:… or system:…");
  }
}

/** A user row that counts as an admin now, if it holds the role or is in the admin group. */
const counts = sql`${users.retiredAt} is null and ${users.lockedAt} is null
  and ${users.providerDisabledAt} is null and ${users.kind} = 'member'`;

/** The user row is in the tenant's admin group. */
function inGroup(externalId: string): SQL {
  return sql`exists (select 1 from ${groupMembers} gm join ${groups} g
      on g.tenant_id = gm.tenant_id and g.id = gm.group_id
    where gm.tenant_id = ${users.tenantId} and gm.user_id = ${users.id}
      and g.source = 'scim' and g.external_id = ${externalId})`;
}

/** Holds the role, or is in the admin group (when there is one). */
function holds(options: AdminOptions): SQL {
  const role = isNotNull(users.adminAt);
  return options.adminGroup === undefined ? role : (or(role, inGroup(options.adminGroup)) as SQL);
}

/** Whether a user is an admin now: an active member with the role or in the admin group. */
export async function isAdmin(
  tx: Tx,
  tenantId: string,
  userId: string,
  options: AdminOptions = {},
): Promise<boolean> {
  const [row] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId), counts, holds(options)));
  return row !== undefined;
}

/**
 * The tenant's admins: everyone current who holds the role or is in the admin group, whether it
 * counts now or not (a locked admin is listed, not effective). In id order, at most
 * {@link MAX_ADMINS_LISTED}.
 */
export async function listAdmins(
  tx: Tx,
  tenantId: string,
  options: AdminOptions = {},
): Promise<Admin[]> {
  const group = options.adminGroup === undefined ? sql`false` : inGroup(options.adminGroup);
  const rows = await tx
    .select({
      id: users.id,
      role: sql<boolean>`${users.adminAt} is not null`,
      group: sql<boolean>`${group}`,
      effective: sql<boolean>`${counts}`,
    })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), isNull(users.retiredAt), holds(options)))
    .orderBy(asc(users.id))
    .limit(MAX_ADMINS_LISTED);
  const out: Admin[] = [];
  for (const r of rows) {
    const user = await getUser(tx, tenantId, r.id);
    if (!user) continue;
    const via: AdminVia[] = [];
    if (r.role === true) via.push("role");
    if (r.group === true) via.push("group");
    out.push({ user, via, effective: r.effective === true });
  }
  return out;
}

/** How many admins count now, besides `except`. */
async function othersCounting(
  tx: Tx,
  tenantId: string,
  except: string,
  options: AdminOptions,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), ne(users.id, except), counts, holds(options)));
  return row?.n ?? 0;
}

/** The user, locked for the rest of the transaction. */
async function lockedUser(tx: Tx, tenantId: string, userId: string) {
  if (typeof userId !== "string" || !/^usr_[0-9a-hjkmnp-tv-z]{26}$/.test(userId)) {
    throw new IdentityError("not-found", "no such user");
  }
  const [row] = await tx
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
    .for("update");
  if (!row || row.retiredAt !== null) throw new IdentityError("not-found", `no user ${userId}`);
  return row;
}

/**
 * Grants the admin role to an active member (`by`: an admin, `user:…`, or `system:…` such as
 * the admin CLI). Returns false, changing nothing, if they hold it already. Refuses a guest or a
 * service account (`invalid`), someone locked or disabled (`inactive`: lift that first), and
 * anyone unknown or retired (`not-found`).
 */
export async function grantAdmin(
  tx: Tx,
  tenantId: string,
  userId: string,
  by: string,
): Promise<boolean> {
  checkBy(by);
  await lockPrincipals(tx, tenantId);
  const row = await lockedUser(tx, tenantId, userId);
  if (row.kind === "service") throw new IdentityError("invalid", "a service account is no admin");
  if (row.kind === "guest") throw new IdentityError("invalid", "a guest is never an admin");
  if (row.lockedAt !== null || row.providerDisabledAt !== null) {
    throw new IdentityError("inactive", `user ${userId} is locked or disabled`);
  }
  if (row.adminAt !== null) return false;
  await tx
    .update(users)
    .set({ adminAt: sql`now()`, adminBy: by })
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)));
  return true;
}

/** What revokeAdmin() did. */
export interface AdminRevocation {
  /** Whether the role was removed (false: they didn't hold it). */
  revoked: boolean;
  /** Whether they are still an admin, through the admin group. */
  stillAdminByGroup: boolean;
}

/**
 * Removes the admin role (`by`: an admin or the system). Refuses:
 * - someone who is an admin only through the admin group (`wrong-source`): the identity provider
 *   owns that membership;
 * - the tenant's last admin who counts (`conflict`), group admins included: grant another first.
 * Removing the role from someone who stays an admin through the group, or whose role doesn't
 * count now (locked, say), is fine.
 */
export async function revokeAdmin(
  tx: Tx,
  tenantId: string,
  userId: string,
  by: string,
  options: AdminOptions = {},
): Promise<AdminRevocation> {
  checkBy(by);
  await lockPrincipals(tx, tenantId);
  const row = await lockedUser(tx, tenantId, userId);
  const byGroup =
    options.adminGroup !== undefined &&
    (await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, userId), inGroup(options.adminGroup)))
      .then((r) => r.length > 0));
  if (row.adminAt === null) {
    if (byGroup) {
      throw new IdentityError(
        "wrong-source",
        "an admin through the identity provider's admin group: remove them from it there",
      );
    }
    return { revoked: false, stillAdminByGroup: false };
  }
  const active = row.lockedAt === null && row.providerDisabledAt === null && row.kind === "member";
  if (active && !byGroup && (await othersCounting(tx, tenantId, userId, options)) === 0) {
    throw new IdentityError("conflict", "the tenant's last admin: make someone else admin first");
  }
  await tx
    .update(users)
    .set({ adminAt: null, adminBy: null })
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)));
  return { revoked: true, stillAdminByGroup: byGroup };
}
