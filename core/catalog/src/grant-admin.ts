import { appendAudit } from "@openhoard/core-audit";
import {
  addGrant,
  BUILT_IN_VOCABULARY,
  GrantError,
  grants,
  GRANT_ROLES,
  lockPrincipals,
  revokeGrant,
  type GrantRole,
  type Tx,
} from "@openhoard/core-db";
import { and, count, desc, eq, gt, isNotNull, isNull, not, or, sql } from "drizzle-orm";

/*
 * Grants an admin makes by hand, on a tag: "the Finance group reads everything tagged
 * department:finance". One function each for giving, taking back and listing, which checks,
 * acts and writes the audit record, so every door (the admin CLI today) is the same use case.
 *
 * - Only tags: a grant on one file by its id is what sharing is for, and what a source imports.
 * - Never a source's own grants: those are the source's to give and take (core/jobs acl.ts), and
 *   one taken back here would return at the source's next visit.
 * - Who may do this is the door's to check: these take the actor as given. The admin CLI is the
 *   operator (`system:admin-cli`).
 */

export type AdminGrantErrorCode =
  /** A role, tag, expiry or id that isn't one; the message says which. */
  | "invalid"
  /** No current user or existing group is that principal. */
  | "unknown-principal"
  /** The tag isn't an approved value of the tenant's vocabulary. */
  | "unapproved-tag"
  /** The principal already holds that role on that tag, from a person. */
  | "exists"
  /** No live grant has that id. */
  | "not-found"
  /** The grant is a source's: changed at the source, never here. */
  | "imported";

export class AdminGrantError extends Error {
  constructor(
    readonly code: AdminGrantErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AdminGrantError";
  }
}

/** A grant a source imported, by who granted it (core/jobs acl.ts `sourceGranter()`). */
const IMPORTED = sql`${grants.grantedBy} like 'source:%'`;
const LIVE = and(
  isNull(grants.revokedAt),
  or(isNull(grants.expiresAt), gt(grants.expiresAt, sql`now()`)),
);

export interface TagGrantInput {
  /** `user:<id>` or `group:<id>`. */
  principal: string;
  role: GrantRole;
  /** `facet:value`, an approved value. */
  tag: string;
  /** When it ends. Omitted: the default (core/db DEFAULT_GRANT_DAYS). Null: never. */
  expiresAt?: Date | null;
  /** Who gives it, for the grant and the audit record. */
  by: string;
}

export interface TagGrant {
  id: string;
  principal: string;
  role: GrantRole;
  tag: string;
  grantedBy: string;
  createdAt: Date;
  expiresAt: Date | null;
}

/**
 * Gives `principal` a role on every file that carries `tag`, audited `grant.add`. Run it in a
 * read-write transaction; the audit record is appended last. Throws AdminGrantError before
 * anything is written.
 *
 * A reader by grant reads a file whatever its visibility level says (levels hold back people
 * with no grant); only a policy's forbid stops them. So a grant on a broad tag reaches that
 * tag's confidential files too.
 */
export async function giveTagGrant(
  tx: Tx,
  tenantId: string,
  input: TagGrantInput,
): Promise<TagGrant> {
  if (!(GRANT_ROLES as readonly string[]).includes(input.role)) {
    throw new AdminGrantError("invalid", `a role is ${GRANT_ROLES.join(" or ")}`);
  }
  if (input.expiresAt instanceof Date && !(input.expiresAt.getTime() > Date.now())) {
    throw new AdminGrantError("invalid", "a grant ends in the future, or never");
  }
  // The tenant's principals first, as every writer of grants takes them (core/db principals.ts):
  // two of these for one principal run one after the other, so the check below holds.
  await lockPrincipals(tx, tenantId);
  const at = input.tag.indexOf(":");
  const [facet, value] = [input.tag.slice(0, at), input.tag.slice(at + 1)];
  if (typeof input.tag !== "string" || at <= 0 || value === "") {
    throw new AdminGrantError("invalid", "a tag is facet:value");
  }
  // A detector's flag marks what to keep from AI, across every source: never a way in.
  if (facet === BUILT_IN_VOCABULARY.facet.key) {
    throw new AdminGrantError(
      "invalid",
      `${input.tag} is a flag OpenHoard sets on files, not a tag to give access by`,
    );
  }
  const [twin] = await tx
    .select({ id: grants.id })
    .from(grants)
    .where(
      and(
        eq(grants.tenantId, tenantId),
        eq(grants.principal, input.principal),
        eq(grants.role, input.role),
        eq(grants.facet, facet),
        eq(grants.value, value),
        not(IMPORTED),
        LIVE,
      ),
    )
    .limit(1);
  if (twin) {
    throw new AdminGrantError(
      "exists",
      `${input.principal} already has ${input.role} on ${input.tag} (${twin.id}): revoke that one first to change when it ends`,
    );
  }
  let id: string;
  try {
    id = await addGrant(tx, tenantId, {
      principal: input.principal,
      role: input.role,
      target: { tag: input.tag },
      grantedBy: input.by,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    });
  } catch (e) {
    if (e instanceof GrantError) throw new AdminGrantError(e.code, e.message);
    throw e;
  }
  const [made] = await tx
    .select()
    .from(grants)
    .where(and(eq(grants.tenantId, tenantId), eq(grants.id, id)));
  if (!made || made.facet === null || made.value === null) {
    throw new Error(`grant ${id} was not recorded as a tag grant`);
  }
  const grant: TagGrant = {
    id,
    principal: made.principal,
    role: made.role,
    tag: `${made.facet}:${made.value}`,
    grantedBy: made.grantedBy,
    createdAt: made.createdAt,
    expiresAt: made.expiresAt,
  };
  await appendAudit(tx, tenantId, {
    actor: input.by,
    action: "grant.add",
    decision: "allow",
    detail: {
      grant: id,
      principal: grant.principal,
      role: grant.role,
      tag: grant.tag,
      expires: grant.expiresAt?.toISOString() ?? "never",
    },
  });
  return grant;
}

/**
 * Takes back a live tag grant a person made, audited `grant.revoke`. Throws AdminGrantError
 * (`not-found` for an id that names no live tag grant, `imported` for a source's), writing
 * nothing.
 */
export async function takeTagGrant(
  tx: Tx,
  tenantId: string,
  input: { grantId: string; by: string },
): Promise<TagGrant> {
  if (typeof input.grantId !== "string" || input.grantId === "") {
    throw new AdminGrantError("invalid", "a grant id is needed");
  }
  // The principals first, as revokeGrant() and whoever removes a group or a person take them.
  await lockPrincipals(tx, tenantId);
  const [row] = await tx
    .select()
    .from(grants)
    .where(
      and(
        eq(grants.tenantId, tenantId),
        eq(grants.id, input.grantId),
        isNotNull(grants.facet),
        LIVE,
      ),
    );
  if (!row || row.facet === null || row.value === null) {
    throw new AdminGrantError("not-found", `no live tag grant ${input.grantId}`);
  }
  if (row.grantedBy.startsWith("source:")) {
    throw new AdminGrantError(
      "imported",
      `${input.grantId} was imported from ${row.grantedBy.slice("source:".length)}: change it there`,
    );
  }
  if (!(await revokeGrant(tx, tenantId, row.id, input.by))) {
    throw new AdminGrantError("not-found", `no live tag grant ${input.grantId}`);
  }
  const grant: TagGrant = {
    id: row.id,
    principal: row.principal,
    role: row.role,
    tag: `${row.facet}:${row.value}`,
    grantedBy: row.grantedBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
  await appendAudit(tx, tenantId, {
    actor: input.by,
    action: "grant.revoke",
    decision: "allow",
    detail: { grant: grant.id, principal: grant.principal, role: grant.role, tag: grant.tag },
  });
  return grant;
}

/** Most grants one listTagGrants() call returns. */
export const TAG_GRANTS_MAX = 500;

/**
 * The tenant's live tag grants that people made (never a source's), newest first, at most
 * {@link TAG_GRANTS_MAX}, with how many there are. For a tenant admin or the operator: it names
 * who may read what, by tag. The caller checks who asks.
 */
export async function listTagGrants(
  tx: Tx,
  tenantId: string,
  filter: { principal?: string } = {},
): Promise<{ total: number; grants: TagGrant[] }> {
  const where = and(
    eq(grants.tenantId, tenantId),
    isNotNull(grants.facet),
    not(IMPORTED),
    LIVE,
    filter.principal === undefined ? undefined : eq(grants.principal, filter.principal),
  );
  const [counted] = await tx.select({ n: count() }).from(grants).where(where);
  const rows = await tx
    .select()
    .from(grants)
    .where(where)
    .orderBy(desc(grants.createdAt), desc(grants.id))
    .limit(TAG_GRANTS_MAX);
  return {
    total: Number(counted?.n ?? 0),
    grants: rows.map((r) => ({
      id: r.id,
      principal: r.principal,
      role: r.role,
      tag: `${r.facet}:${r.value}`,
      grantedBy: r.grantedBy,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
    })),
  };
}
