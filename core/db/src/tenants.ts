import { eq, sql } from "drizzle-orm";
import type { Tx } from "./database.js";
import { isId } from "./ids.js";
import { facets, facetValues, principalEpochs, tenants } from "./schema.js";

/*
 * Creating a tenant (T-103's admin bootstrap, later the admin API). A tenant starts with what
 * every tenant needs and nothing it doesn't:
 *
 * - its `tenants` row, with the fail-closed defaults (hidden, metadata-only) until an admin or a
 *   pack says otherwise;
 * - its principal epoch (principal_epochs), so the principal cache serves it from the first
 *   request instead of bypassing until the first principal change creates it;
 * - the built-in vocabulary (`risk:injection`, see ensureBuiltInVocabulary()), which OpenHoard's
 *   own detectors apply.
 *
 * Everything else (zones, vocabulary, packs, people) is added deliberately afterwards. The
 * caller runs this in a withTenant() transaction for the new id (row-level security admits only
 * that tenant's rows), and appends its audit record after it in the same transaction.
 */

export interface NewTenant {
  /** Shown to admins: 1 to 200 visible characters. */
  name: string;
}

export interface TenantRow {
  id: string;
  name: string;
  createdAt: Date;
}

/** A tenant's name: 1 to 200 characters, not blank, without control or invisible characters. */
function checkTenantName(name: unknown): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  const chars = [...trimmed].length;
  if (chars < 1 || chars > 200 || /\p{C}/u.test(trimmed.replace(/\s/gu, ""))) {
    throw new TypeError("a tenant's name is 1 to 200 visible characters");
  }
  return trimmed;
}

/**
 * Creates the tenant `tenantId` (a fresh `newId("tenant")`) inside `tx`, a withTenant()
 * transaction for that same id. Throws if the name isn't one, or if the tenant exists.
 */
export async function createTenant(tx: Tx, tenantId: string, input: NewTenant): Promise<TenantRow> {
  if (!isId("tenant", tenantId)) throw new TypeError("createTenant: not a tenant id");
  const name = checkTenantName(input.name);
  const [row] = await tx
    .insert(tenants)
    .values({ id: tenantId, name })
    .returning({ id: tenants.id, name: tenants.name, createdAt: tenants.createdAt });
  if (!row) throw new Error("tenant insert returned nothing");
  // A random first epoch, as core/db lockPrincipals() and the triggers start one (0021).
  await tx
    .insert(principalEpochs)
    .values({ tenantId, epoch: sql`1 + floor(random() * 1e12)::bigint` });
  await ensureBuiltInVocabulary(tx, tenantId);
  return row;
}

/**
 * Built-in vocabulary (T-408): values OpenHoard's own detectors apply, which must exist in every
 * tenant with exactly these levels, whatever packs and admins do, so that a detector's flag
 * always has its effect and never waits on an admin. Today one: `risk:injection`, exposure
 * `metadata-only` (AI clients get metadata-only cards; no model sees the content).
 */
export const BUILT_IN_VOCABULARY = {
  facet: { key: "risk", label: "Risk" },
  values: [{ value: "injection", label: "Possible prompt injection", exposure: "metadata-only" }],
} as const;

/**
 * Makes sure the tenant has the built-in vocabulary, as it must be: creates the `risk` facet
 * if missing, and creates the values, or puts them back to approved with their levels if a pack
 * or an admin changed them. The one exception to "nothing creates vocabulary": these values are
 * the system's, not the tenant's. Idempotent; inside a withTenant() transaction for the tenant.
 * Migration 0046 did the same for tenants that existed before; createTenant() calls it.
 */
export async function ensureBuiltInVocabulary(tx: Tx, tenantId: string): Promise<void> {
  const { facet, values } = BUILT_IN_VOCABULARY;
  await tx
    .insert(facets)
    .values({ tenantId, key: facet.key, label: facet.label })
    .onConflictDoNothing();
  for (const v of values) {
    await tx
      .insert(facetValues)
      .values({
        tenantId,
        facet: facet.key,
        value: v.value,
        label: v.label,
        approved: true,
        visibility: null,
        exposure: v.exposure,
      })
      .onConflictDoUpdate({
        target: [facetValues.tenantId, facetValues.facet, facetValues.value],
        set: { approved: true, exposure: v.exposure },
        // Only when it differs: no write (and no lock churn) on every flag.
        setWhere: sql`${facetValues.approved} is not true or ${facetValues.exposure} is distinct from ${v.exposure}`,
      });
  }
}

/** The tenant's own row (its name), or null: inside a withTenant() transaction for it. */
export async function getTenant(tx: Tx, tenantId: string): Promise<TenantRow | null> {
  const [row] = await tx
    .select({ id: tenants.id, name: tenants.name, createdAt: tenants.createdAt })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return row ?? null;
}
