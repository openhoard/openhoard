import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import type { Tx } from "./database.js";
import { newId } from "./ids.js";
import { facetValues, grants, type GRANT_ROLES } from "./schema.js";

/*
 * Grants as data (T-602, spike S3). Writes and reads of the grants table, and the one query that
 * turns a caller's principals into what core/policy's authorize() needs.
 *
 * Callers record grant changes in the audit log in the same transaction (core/audit's
 * appendAudit); this package cannot, because core/audit depends on it.
 */

/** How long a grant lasts when the caller does not say (T-602: grants expire by default). */
export const DEFAULT_GRANT_DAYS = 90;

export type GrantRole = (typeof GRANT_ROLES)[number];

export interface GrantInput {
  /** `user:<id>` or `group:<id>`. */
  principal: string;
  role: GrantRole;
  /** Every object carrying a tag (`facet:value`), or one object. */
  target: { tag: string } | { objectId: string };
  /** Who granted it, e.g. `user:<id>` or `pack:<name>`. */
  grantedBy: string;
  /**
   * When it stops working. Omitted: {@link DEFAULT_GRANT_DAYS} from now. `null`: never, which
   * has to be asked for explicitly.
   */
  expiresAt?: Date | null;
}

/** Adds a grant and returns its id. A tag must be an approved value of the tenant's vocabulary. */
export async function addGrant(
  tx: Tx,
  tenantId: string,
  input: GrantInput,
  now: Date = new Date(),
): Promise<string> {
  const target = input.target as { tag?: unknown; objectId?: unknown };
  if ("tag" in target === "objectId" in target) {
    throw new TypeError("a grant targets a tag or an object, not both or neither");
  }
  const id = newId("grant");
  const expiresAt =
    input.expiresAt === undefined
      ? new Date(now.getTime() + DEFAULT_GRANT_DAYS * 24 * 60 * 60 * 1000)
      : input.expiresAt;
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
    if (!value?.approved) throw new Error(`cannot grant ${input.target.tag}: not an approved tag`);
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
    createdAt: now,
    expiresAt,
  });
  return id;
}

/** Revokes a live grant. Returns false when there is no such grant, or it was already revoked. */
export async function revokeGrant(
  tx: Tx,
  tenantId: string,
  grantId: string,
  revokedBy: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await tx
    .update(grants)
    .set({ revokedAt: now, revokedBy })
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

/**
 * The grants of `principals` (a user and their groups) that were live at `at`: created by then,
 * not revoked by then, not expired. Expiry is part of this query, so a grant stops counting the
 * moment it expires, and asking about a past moment answers for that moment (T-606).
 *
 * Search needs the same answer per object (readable_by, T-504); object grants must be added to
 * that index too, not only to this set.
 */
export async function loadGrants(
  tx: Tx,
  tenantId: string,
  principals: readonly string[],
  at: Date = new Date(),
): Promise<GrantSet> {
  const set: GrantSet = {
    tagGrants: [],
    tagWriteGrants: [],
    objectGrants: [],
    objectWriteGrants: [],
  };
  const relevant = principals.filter((p) => p.startsWith("user:") || p.startsWith("group:"));
  if (relevant.length === 0) return set;
  const rows = await tx
    .select({
      role: grants.role,
      facet: grants.facet,
      value: grants.value,
      objectId: grants.objectId,
    })
    .from(grants)
    .where(
      and(
        eq(grants.tenantId, tenantId),
        inArray(grants.principal, [...new Set(relevant)]),
        // Live at `at`: created by then, not yet revoked, not yet expired.
        lte(grants.createdAt, at),
        or(isNull(grants.revokedAt), gt(grants.revokedAt, at)),
        or(isNull(grants.expiresAt), gt(grants.expiresAt, at)),
      ),
    );
  const add = (list: string[], item: string) => {
    if (!list.includes(item)) list.push(item);
  };
  for (const r of rows) {
    if (r.objectId !== null)
      add(r.role === "write" ? set.objectWriteGrants : set.objectGrants, r.objectId);
    else if (r.facet !== null && r.value !== null)
      add(r.role === "write" ? set.tagWriteGrants : set.tagGrants, `${r.facet}:${r.value}`);
  }
  for (const list of Object.values(set)) list.sort();
  return set;
}

/** `facet:value` → its parts; the database checks both against the vocabulary. */
function splitTag(tag: string): { facet: string; value: string } {
  const at = tag.indexOf(":");
  if (at <= 0 || at === tag.length - 1) throw new TypeError("a tag is facet:value");
  return { facet: tag.slice(0, at), value: tag.slice(at + 1) };
}
