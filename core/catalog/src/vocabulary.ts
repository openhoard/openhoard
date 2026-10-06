import { facets, facetValues, isId, tagOf, tagReviews, type Tx } from "@openhoard/core-db";
import { isAdmin } from "@openhoard/core-identity";
import { and, asc, count, eq, isNull, ne } from "drizzle-orm";
import { requireSnapshot } from "./visibility.js";

/*
 * The tenant's tag vocabulary as its admins see it (T-903): every facet and every value, the
 * approved and the proposed, with what a value does to a file that carries it and how many
 * open review items propose it.
 *
 * For tenant admins only, and it checks the asker is one itself. A value can be a client's or
 * a project's name, and a facet that isn't `public` is one whose tags aren't shown to people
 * who can't read a file: the whole list is not for everyone. It reads no file: counts of open
 * items say nothing of which files they are on. (A proposed value's name can come from a file
 * the admin can't read: a model made it up from what it read. That much of files reaches every
 * admin, as their titles do in the File Health Report.)
 */

export class VocabularyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VocabularyError";
  }
}

export interface VocabularyValue {
  value: string;
  /** `facet:value`. */
  tag: string;
  label: string;
  /** In the vocabulary: tags of it apply. Otherwise proposed, waiting in the review inbox. */
  approved: boolean;
  /** The visibility a file gets by carrying it, when it sets one. */
  visibility: string | null;
  /** The exposure level a file gets by carrying it, when it sets one. */
  exposure: string | null;
  /** Open review items proposing it, on any file. */
  waiting: number;
}

export interface VocabularyFacet {
  key: string;
  label: string;
  /** Its tags may be shown on the title-only card of a file someone can't read. */
  public: boolean;
  /** A file carries at most one of its values. */
  single: boolean;
  values: VocabularyValue[];
}

/** Most values read: a vocabulary larger than this is cut, and says so. */
export const VOCABULARY_MAX = 5_000;

export interface Vocabulary {
  facets: VocabularyFacet[];
  /** There are more values than {@link VOCABULARY_MAX}: the last facets are short or missing. */
  cut: boolean;
}

/**
 * Every facet and value of the tenant, by facet key then value, for one of its admins. Throws
 * VocabularyError when `asker` isn't one now.
 */
export async function tenantVocabulary(
  tx: Tx,
  tenantId: string,
  asker: { userId: string; adminGroupId?: string | undefined },
): Promise<Vocabulary> {
  await requireSnapshot(tx, "tenantVocabulary");
  const admin =
    typeof asker.userId === "string" &&
    isId("user", asker.userId) &&
    (await isAdmin(tx, tenantId, asker.userId, {
      ...(asker.adminGroupId === undefined ? {} : { adminGroupId: asker.adminGroupId }),
    }));
  if (!admin) throw new VocabularyError("the vocabulary is for tenant admins");

  const all = await tx
    .select({ key: facets.key, label: facets.label, public: facets.public, single: facets.single })
    .from(facets)
    .where(eq(facets.tenantId, tenantId))
    .orderBy(asc(facets.key));
  const values = await tx
    .select({
      facet: facetValues.facet,
      value: facetValues.value,
      label: facetValues.label,
      approved: facetValues.approved,
      visibility: facetValues.visibility,
      exposure: facetValues.exposure,
    })
    .from(facetValues)
    .where(eq(facetValues.tenantId, tenantId))
    .orderBy(asc(facetValues.facet), asc(facetValues.value))
    .limit(VOCABULARY_MAX + 1);
  const waiting = await tx
    .select({ facet: tagReviews.facet, value: tagReviews.value, n: count() })
    .from(tagReviews)
    // (A `primary` item proposes no value: it names a tag the file carries already.)
    .where(
      and(
        eq(tagReviews.tenantId, tenantId),
        isNull(tagReviews.resolvedAt),
        ne(tagReviews.reason, "primary"),
      ),
    )
    .groupBy(tagReviews.facet, tagReviews.value);
  const open = new Map(waiting.map((w) => [tagOf(w.facet, w.value), Number(w.n)]));

  const byFacet = new Map<string, VocabularyValue[]>();
  for (const v of values.slice(0, VOCABULARY_MAX)) {
    const tag = tagOf(v.facet, v.value);
    const list = byFacet.get(v.facet) ?? [];
    list.push({
      value: v.value,
      tag,
      label: v.label,
      approved: v.approved,
      visibility: v.visibility,
      exposure: v.exposure,
      waiting: open.get(tag) ?? 0,
    });
    byFacet.set(v.facet, list);
  }
  return {
    facets: all.map((f) => ({ ...f, values: byFacet.get(f.key) ?? [] })),
    cut: values.length > VOCABULARY_MAX,
  };
}
