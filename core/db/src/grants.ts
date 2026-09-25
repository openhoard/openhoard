import { and, eq, gt, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { Tx } from "./database.js";
import { lockPrincipals } from "./principals.js";
import { newId } from "./ids.js";
import { facetValues, grants, groups, users, type GRANT_ROLES } from "./schema.js";

/*
 * Grants as data (T-602, spike S3). Writes and reads of the grants table, and the one query that
 * turns a caller's principals into what core/policy's authorize() needs.
 *
 * Callers record grant changes in the audit log in the same transaction (core/audit's
 * appendAudit); this package cannot, because core/audit depends on it.
 *
 * Times come from the database unless the caller passes one: creation, the default expiry,
 * revocation and "live now" all use the transaction's now(), the same clock core/identity
 * revokes with. The application's clock can drift from the database's; mixing the two let a
 * quick revoke land "before" the grant's creation, which grants_revoked_after_creation refuses.
 * An explicit `now` or `at` is for tests and for asking about another moment: it is then used
 * as given, so it must agree with the database's clock where it meets rows the database dated.
 */

/** How long a grant lasts when the caller does not say (T-602: grants expire by default). */
export const DEFAULT_GRANT_DAYS = 90;

export type GrantRole = (typeof GRANT_ROLES)[number];

export type GrantErrorCode =
  /** Malformed input: a principal, target or tag that isn't one. */
  | "invalid"
  /** The principal names no current user or existing group. */
  | "unknown-principal"
  /** The tag isn't approved vocabulary. */
  | "unapproved-tag";

/** Why addGrant() refused, for the API to map (400, 404, 409). */
export class GrantError extends Error {
  constructor(
    readonly code: GrantErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GrantError";
  }
}

export interface GrantInput {
  /** `user:<id>` or `group:<id>`. */
  principal: string;
  role: GrantRole;
  /** Every object carrying a tag (`facet:value`), or one object. */
  target: { tag: string } | { objectId: string };
  /** Who granted it, e.g. `user:<id>` or `pack:<name>`. */
  grantedBy: string;
  /**
   * When it stops working. Omitted: {@link DEFAULT_GRANT_DAYS} after its creation. `null`:
   * never, which has to be asked for explicitly.
   */
  expiresAt?: Date | null;
}

/**
 * Adds a grant and returns its id. The principal must be a current user or an existing group,
 * and a tag an approved value of the tenant's vocabulary. It is created at the database's
 * now(), or at `now` when given (tests).
 *
 * The principal's row is locked (FOR KEY SHARE) until the transaction ends, so a grant can't
 * slip in while its group is being deleted (core/identity deleteGroup revokes a group's grants
 * under FOR UPDATE).
 */
export async function addGrant(
  tx: Tx,
  tenantId: string,
  input: GrantInput,
  now?: Date,
): Promise<string> {
  const target = input.target as { tag?: unknown; objectId?: unknown };
  if ("tag" in target === "objectId" in target) {
    throw new GrantError("invalid", "a grant targets a tag or an object, not both or neither");
  }
  await lockPrincipals(tx, tenantId);
  await lockPrincipal(tx, tenantId, input.principal);
  const id = newId("grant");
  const created: Date | SQL = now ?? sql`now()`;
  const expiresAt: Date | SQL | null =
    input.expiresAt !== undefined
      ? input.expiresAt
      : now === undefined
        ? sql`now() + make_interval(days => ${DEFAULT_GRANT_DAYS})`
        : new Date(now.getTime() + DEFAULT_GRANT_DAYS * 24 * 60 * 60 * 1000);
  let where: { facet: string; value: string } | { objectId: string };
  if ("tag" in input.target) {
    where = splitTag(input.target.tag);
    // Only reviewed vocabulary can carry access: a value a model or agent proposed can't.
    const [value] = await tx
      .select({ approved: facetValues.approved })
      .from(facetValues)
      .where(
        and(
          eq(facetValues.tenantId, tenantId),
          eq(facetValues.facet, where.facet),
          eq(facetValues.value, where.value),
        ),
      );
    if (!value?.approved) {
      throw new GrantError(
        "unapproved-tag",
        `cannot grant ${input.target.tag}: not an approved tag`,
      );
    }
  } else {
    where = { objectId: input.target.objectId };
  }
  await tx.insert(grants).values({
    tenantId,
    id,
    principal: input.principal,
    role: input.role,
    ...where,
    grantedBy: input.grantedBy,
    createdAt: created,
    expiresAt,
  });
  return id;
}

async function lockPrincipal(tx: Tx, tenantId: string, principal: string) {
  const match = /^(user|group):(.+)$/s.exec(principal);
  if (!match) {
    throw new GrantError("invalid", `a grant goes to a user:<id> or group:<id>, not ${principal}`);
  }
  const [, kind, id] = match as unknown as [string, "user" | "group", string];
  if (kind === "user") {
    const [user] = await tx
      .select({ retiredAt: users.retiredAt })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, id)))
      .for("key share");
    if (!user || user.retiredAt !== null)
      throw new GrantError("unknown-principal", `cannot grant to ${principal}: no such user`);
  } else {
    const [group] = await tx
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.tenantId, tenantId), eq(groups.id, id)))
      .for("key share");
    if (!group) {
      throw new GrantError("unknown-principal", `cannot grant to ${principal}: no such group`);
    }
  }
}

/**
 * Revokes a live grant, at the database's now() (never before the grant's creation), or at `now`
 * when given (tests). Returns false when there is no such grant, or it was already revoked.
 */
export async function revokeGrant(
  tx: Tx,
  tenantId: string,
  grantId: string,
  revokedBy: string,
  now?: Date,
): Promise<boolean> {
  await lockPrincipals(tx, tenantId);
  const rows = await tx
    .update(grants)
    .set({ revokedAt: now ?? sql`greatest(now(), ${grants.createdAt})`, revokedBy })
    .where(and(eq(grants.tenantId, tenantId), eq(grants.id, grantId), isNull(grants.revokedAt)))
    .returning({ id: grants.id });
  return rows.length === 1;
}

/** What a caller holds, in the shape core/policy's AuthzPrincipal takes. */
export interface GrantSet {
  /** Tags readable through a read grant (write grants are listed separately). */
  tagGrants: string[];
  tagWriteGrants: string[];
  objectGrants: string[];
  objectWriteGrants: string[];
}

/** A grant that was live at some moment, as liveGrants() returns it. */
export interface LiveGrant {
  id: string;
  principal: string;
  role: GrantRole;
  /** `facet:value` for a tag grant; null for an object grant. */
  tag: string | null;
  objectId: string | null;
  grantedBy: string;
  createdAt: Date;
  expiresAt: Date | null;
}

/**
 * The grants of `principals` (a user and their groups) that were live at `at`: created by then,
 * not revoked by then, not expired. Expiry is part of this query, so a grant stops counting the
 * moment it expires, and asking about a past moment answers for that moment. Without `at`, the
 * moment is the database's now(), the clock grants are dated by.
 */
export async function liveGrants(
  tx: Tx,
  tenantId: string,
  principals: readonly string[],
  at?: Date,
): Promise<LiveGrant[]> {
  const moment: Date | SQL = at ?? sql`now()`;
  const relevant = principals.filter((p) => p.startsWith("user:") || p.startsWith("group:"));
  if (relevant.length === 0) return [];
  const rows = await tx
    .select({
      id: grants.id,
      principal: grants.principal,
      role: grants.role,
      facet: grants.facet,
      value: grants.value,
      objectId: grants.objectId,
      grantedBy: grants.grantedBy,
      createdAt: grants.createdAt,
      expiresAt: grants.expiresAt,
    })
    .from(grants)
    .where(
      and(
        eq(grants.tenantId, tenantId),
        inArray(grants.principal, [...new Set(relevant)]),
        // Live at `at`: created by then, not yet revoked, not yet expired.
        lte(grants.createdAt, moment),
        or(isNull(grants.revokedAt), gt(grants.revokedAt, moment)),
        or(isNull(grants.expiresAt), gt(grants.expiresAt, moment)),
      ),
    )
    .orderBy(grants.id);
  return rows.map(({ facet, value, ...r }) => ({
    ...r,
    tag: facet !== null && value !== null ? `${facet}:${value}` : null,
  }));
}

/**
 * What `principals` held at `at` (see liveGrants()), in the shape AuthzPrincipal takes.
 *
 * Search needs the same answer per object (readable_by, T-504); object grants must be added to
 * that index too, not only to this set.
 */
export async function loadGrants(
  tx: Tx,
  tenantId: string,
  principals: readonly string[],
  at?: Date,
): Promise<GrantSet> {
  return grantSetOf(await liveGrants(tx, tenantId, principals, at));
}

/** Live grants in the shape AuthzPrincipal takes (what loadGrants() returns). */
export function grantSetOf(live: readonly LiveGrant[]): GrantSet {
  const tagGrants = new Set<string>();
  const tagWriteGrants = new Set<string>();
  const objectGrants = new Set<string>();
  const objectWriteGrants = new Set<string>();
  for (const g of live) {
    const write = g.role === "write";
    if (g.objectId !== null) (write ? objectWriteGrants : objectGrants).add(g.objectId);
    else if (g.tag !== null) (write ? tagWriteGrants : tagGrants).add(g.tag);
  }
  const sorted = (s: Set<string>) => [...s].sort();
  return {
    tagGrants: sorted(tagGrants),
    tagWriteGrants: sorted(tagWriteGrants),
    objectGrants: sorted(objectGrants),
    objectWriteGrants: sorted(objectWriteGrants),
  };
}

/** `facet:value` → its parts; the database checks both against the vocabulary. */
function splitTag(tag: string): { facet: string; value: string } {
  const at = tag.indexOf(":");
  if (at <= 0 || at === tag.length - 1) throw new GrantError("invalid", "a tag is facet:value");
  return { facet: tag.slice(0, at), value: tag.slice(at + 1) };
}
