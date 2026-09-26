import {
  CARD_SKIP_REASONS,
  CARD_STATUSES,
  facets,
  facetValues,
  isId,
  MAX_CARD_SUMMARY_CHARS,
  PROVIDER_KINDS,
  queryRows,
  tagOf,
  versionCards,
  type Tx,
} from "@openhoard/core-db";
import { and, asc, eq, ne, sql } from "drizzle-orm";

/*
 * Model cards (T-405): the summary a model wrote for a version, one row per version in
 * `version_cards`, written by enrichment's summarize step through its guarded write and read by
 * viewObjects() (visibility.ts), which shows it only where the file's exposure allows both the
 * client (not a metadata-only card) and the provider that wrote it.
 */

export type CardStatus = (typeof CARD_STATUSES)[number];
export type CardSkipReason = (typeof CARD_SKIP_REASONS)[number];

export type VersionCard =
  | {
      status: "summarized";
      summary: string;
      providerId: string;
      providerKind: (typeof PROVIDER_KINDS)[number];
      model: string;
      promptVersion: string;
      filtered: number;
      inputTokens: number;
      outputTokens: number;
    }
  | { status: "skipped"; reason: CardSkipReason; promptVersion: string };

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PROMPT = /^[a-z0-9][a-z0-9./-]{0,63}$/;
const count = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= 2_147_483_647;

/**
 * Stores a version's card, replacing any earlier one (a re-run rewrites the row, never adds a
 * second). Call it through enrichment's guarded write. Throws TypeError for a malformed card
 * before writing.
 */
export async function saveCard(
  tx: Tx,
  tenantId: string,
  input: VersionCard & { objectId: string; versionId: string },
): Promise<void> {
  const bad = (what: string): never => {
    throw new TypeError(`invalid card: ${what}`);
  };
  if (!isId("object", input.objectId) || !isId("version", input.versionId)) bad("ids");
  if (!PROMPT.test(input.promptVersion)) bad("promptVersion");
  let row;
  if (input.status === "summarized") {
    if (typeof input.summary !== "string" || [...input.summary].length > MAX_CARD_SUMMARY_CHARS) {
      bad("summary");
    }
    if (input.summary.includes("\0")) bad("summary");
    if (!SLUG.test(input.providerId)) bad("providerId");
    if (!(PROVIDER_KINDS as readonly string[]).includes(input.providerKind)) bad("providerKind");
    if (typeof input.model !== "string" || input.model.length < 1 || input.model.length > 200) {
      bad("model");
    }
    if (![input.filtered, input.inputTokens, input.outputTokens].every(count)) bad("counts");
    row = {
      status: input.status,
      reason: null,
      summary: input.summary,
      providerId: input.providerId,
      providerKind: input.providerKind,
      model: input.model,
      promptVersion: input.promptVersion,
      filtered: input.filtered,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
    };
  } else if (input.status === "skipped") {
    if (!(CARD_SKIP_REASONS as readonly string[]).includes(input.reason)) bad("reason");
    row = {
      status: input.status,
      reason: input.reason,
      summary: "",
      providerId: null,
      providerKind: null,
      model: null,
      promptVersion: input.promptVersion,
      filtered: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
  } else {
    return bad("status");
  }
  await tx
    .insert(versionCards)
    .values({ tenantId, versionId: input.versionId, objectId: input.objectId, ...row })
    .onConflictDoUpdate({
      target: [versionCards.tenantId, versionCards.versionId],
      set: { ...row, updatedAt: sql`now()` },
    });
}

/** A version's stored card, or null. For pipeline steps; readers get it through viewObjects(). */
export async function readCard(
  tx: Tx,
  tenantId: string,
  versionId: string,
): Promise<(VersionCard & { updatedAt: Date }) | null> {
  if (typeof versionId !== "string" || !isId("version", versionId)) return null;
  const [r] = await tx
    .select()
    .from(versionCards)
    .where(and(eq(versionCards.tenantId, tenantId), eq(versionCards.versionId, versionId)));
  if (!r) return null;
  if (r.status === "summarized") {
    return {
      status: "summarized",
      summary: r.summary,
      providerId: r.providerId ?? "",
      providerKind: r.providerKind ?? "consumer",
      model: r.model ?? "",
      promptVersion: r.promptVersion,
      filtered: r.filtered,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      updatedAt: r.updatedAt,
    };
  }
  return {
    status: "skipped",
    reason: r.reason ?? "no-text",
    promptVersion: r.promptVersion,
    updatedAt: r.updatedAt,
  };
}

/**
 * The tenant's approved vocabulary a model may propose from (T-405): `facet:value` and label,
 * sorted, at most `limit` entries. Never the `risk` facet: flags are the detectors' alone.
 */
export async function modelVocabulary(
  tx: Tx,
  tenantId: string,
  limit = 300,
): Promise<{ tag: string; label: string }[]> {
  const rows = await tx
    .select({ facet: facetValues.facet, value: facetValues.value, label: facetValues.label })
    .from(facetValues)
    .innerJoin(
      facets,
      and(eq(facets.tenantId, facetValues.tenantId), eq(facets.key, facetValues.facet)),
    )
    .where(
      and(
        eq(facetValues.tenantId, tenantId),
        eq(facetValues.approved, true),
        ne(facetValues.facet, "risk"),
      ),
    )
    .orderBy(asc(facetValues.facet), asc(facetValues.value))
    .limit(Math.max(0, Math.min(limit, 5_000)));
  return rows.map((r) => ({ tag: tagOf(r.facet, r.value), label: r.label }));
}

/**
 * How many of the tenant's current versions have no summary, by reason (for an admin's health
 * view): every skip reason, with 0 for those that don't occur. Replaced versions don't count.
 */
export async function cardSkipCounts(
  tx: Tx,
  tenantId: string,
): Promise<Record<CardSkipReason, number>> {
  const rows = await queryRows<{ reason: string; n: number }>(
    tx,
    sql`select c.reason, count(*)::int as n
        from version_cards c
        join versions v on v.tenant_id = c.tenant_id and v.id = c.version_id
        where c.tenant_id = ${tenantId} and c.status = 'skipped'
          and not exists (select 1 from versions w
            where w.tenant_id = v.tenant_id and w.object_id = v.object_id and w.seq > v.seq)
        group by c.reason`,
  );
  const counts = Object.fromEntries(CARD_SKIP_REASONS.map((r) => [r, 0])) as Record<
    CardSkipReason,
    number
  >;
  for (const r of rows) {
    if ((CARD_SKIP_REASONS as readonly string[]).includes(r.reason)) {
      counts[r.reason as CardSkipReason] = Number(r.n);
    }
  }
  return counts;
}

/**
 * The tenant's current versions whose card was skipped for one of `reasons`, in version id
 * order after `after`, at most `limit` (1 to 1,000): what resummarize() (core/jobs) enqueues.
 */
export async function skippedVersions(
  tx: Tx,
  tenantId: string,
  reasons: readonly CardSkipReason[],
  options: { after?: string; limit?: number } = {},
): Promise<string[]> {
  const limit = options.limit ?? 500;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("skippedVersions: limit is 1 to 1000");
  }
  const known = reasons.filter((r) => (CARD_SKIP_REASONS as readonly string[]).includes(r));
  if (known.length === 0) return [];
  if (options.after !== undefined && !isId("version", options.after)) {
    throw new TypeError("skippedVersions: after is not a version id");
  }
  const rows = await queryRows<{ id: string }>(
    tx,
    sql`select c.version_id as id
        from version_cards c
        join versions v on v.tenant_id = c.tenant_id and v.id = c.version_id
        where c.tenant_id = ${tenantId} and c.status = 'skipped'
          and c.reason in (${sql.join(
            known.map((r) => sql`${r}`),
            sql`, `,
          )})
          and c.version_id > ${options.after ?? ""}
          and not exists (select 1 from versions w
            where w.tenant_id = v.tenant_id and w.object_id = v.object_id and w.seq > v.seq)
        order by c.version_id
        limit ${limit}`,
  );
  return rows.map((r) => r.id);
}
