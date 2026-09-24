import {
  facets,
  facetValues,
  objects,
  objectTags,
  queryRows,
  tagOf,
  tagReviews,
  tenants,
  versions,
  zones,
  type Tx,
} from "@openhoard/core-db";
import {
  decideRead,
  mostRestrictiveExposure,
  mostRestrictiveVisibility,
  resolveLevels,
  type Authorizer,
  type AuthzClient,
  type AuthzPrincipal,
  type Exposure,
  type Visibility,
} from "@openhoard/core-policy";
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";

/*
 * Visibility (T-603): what someone who can't read a file learns about it.
 *
 * | visibility   | a non-reader gets                                                      |
 * | ------------ | ---------------------------------------------------------------------- |
 * | hidden       | nothing: the file doesn't appear to exist                              |
 * | discoverable | a title-only card: display title, type, owner, public tags, "request" |
 * | readable     | the card, never the content                                            |
 *
 * Levels come from trusted tags (rules, packs, people, and reviewed model tags) on approved
 * values, most restrictive wins, else the tenant default. Everything else can only tighten:
 *
 * - An object whose current version enrichment hasn't finished is unprocessed: hidden and
 *   metadata-only, whatever its tags say. A new version, or a rename, starts it over.
 * - An unreviewed model tag, a model tag waiting in review, and a value nobody approved add
 *   their levels only if stricter. A model saying a file is sensitive hides it at once; a model
 *   saying it is public changes nothing until a person agrees.
 *
 * Only active tenant members discover files: guests and deprovisioned users see what they can
 * read and nothing else.
 *
 * A title can be sensitive on its own. Non-readers see the owner's display title when there is
 * one, a generic title while a model's proposal waits for the owner, and the real title only
 * when nobody has flagged it (see nonReaderTitle()).
 *
 * viewObjects() reads in several statements, so it needs one snapshot: run it in a
 * REPEATABLE READ transaction ({@link VIEW_TRANSACTION}); it refuses weaker isolation.
 */

export interface ObjectLevels {
  visibility: Visibility;
  exposure: Exposure;
  /** Whether enrichment has finished the object's current version. */
  processed: boolean;
}

/** Transaction settings for viewObjects(): `db.withTenant(tenant, work, VIEW_TRANSACTION)`. */
export const VIEW_TRANSACTION = {
  isolationLevel: "repeatable read",
  accessMode: "read only",
} as const;

/** Effective levels for each object that exists; missing ids are left out. */
export async function levelsFor(
  tx: Tx,
  tenantId: string,
  objectIds: readonly string[],
): Promise<Map<string, ObjectLevels>> {
  const out = new Map<string, ObjectLevels>();
  const ids = [...new Set(objectIds)];
  if (ids.length === 0) return out;
  const [tenant] = await tx
    .select({ visibility: tenants.defaultVisibility, exposure: tenants.defaultExposure })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) return out;

  const current = await tx
    .selectDistinctOn([versions.objectId], {
      objectId: versions.objectId,
      processedAt: versions.processedAt,
    })
    .from(versions)
    .where(and(eq(versions.tenantId, tenantId), inArray(versions.objectId, ids)))
    .orderBy(versions.objectId, desc(versions.seq));
  const processed = new Map(current.map((v) => [v.objectId, v.processedAt !== null]));

  const levelled = or(isNotNull(facetValues.visibility), isNotNull(facetValues.exposure));
  const applied = tx
    .select({
      objectId: objectTags.objectId,
      visibility: facetValues.visibility,
      exposure: facetValues.exposure,
      trusted: sql<boolean>`(${facetValues.approved} and (${objectTags.source} <> 'model' or ${objectTags.reviewed}))`,
    })
    .from(objectTags)
    .innerJoin(
      facetValues,
      and(
        eq(facetValues.tenantId, objectTags.tenantId),
        eq(facetValues.facet, objectTags.facet),
        eq(facetValues.value, objectTags.value),
      ),
    )
    .where(and(eq(objectTags.tenantId, tenantId), inArray(objectTags.objectId, ids), levelled));
  const pending = tx
    .select({
      objectId: tagReviews.objectId,
      visibility: facetValues.visibility,
      exposure: facetValues.exposure,
      trusted: sql<boolean>`false`,
    })
    .from(tagReviews)
    .innerJoin(
      facetValues,
      and(
        eq(facetValues.tenantId, tagReviews.tenantId),
        eq(facetValues.facet, tagReviews.facet),
        eq(facetValues.value, tagReviews.value),
      ),
    )
    .where(
      and(
        eq(tagReviews.tenantId, tenantId),
        inArray(tagReviews.objectId, ids),
        isNull(tagReviews.resolvedAt),
        levelled,
      ),
    );
  interface Collected {
    trusted: { visibilities: string[]; exposures: string[] };
    tighten: { visibilities: string[]; exposures: string[] };
  }
  const byObject = new Map<string, Collected>();
  for (const row of [...(await applied), ...(await pending)]) {
    const entry = byObject.get(row.objectId) ?? {
      trusted: { visibilities: [], exposures: [] },
      tighten: { visibilities: [], exposures: [] },
    };
    // Raw SQL booleans come back as booleans on both drivers; anything else is untrusted.
    const side = row.trusted === true ? entry.trusted : entry.tighten;
    if (row.visibility !== null) side.visibilities.push(row.visibility);
    if (row.exposure !== null) side.exposures.push(row.exposure);
    byObject.set(row.objectId, entry);
  }

  const present = await tx
    .select({ id: objects.id })
    .from(objects)
    .where(and(eq(objects.tenantId, tenantId), inArray(objects.id, ids)));
  for (const { id } of present) {
    const isProcessed = processed.get(id) ?? false;
    const entry = byObject.get(id);
    const base = resolveLevels({
      processed: isProcessed,
      visibilities: entry?.trusted.visibilities ?? [],
      exposures: entry?.trusted.exposures ?? [],
      defaults: tenant,
    });
    out.set(id, {
      visibility: mostRestrictiveVisibility([
        base.visibility,
        ...(entry?.tighten.visibilities ?? []),
      ]),
      exposure: mostRestrictiveExposure([base.exposure, ...(entry?.tighten.exposures ?? [])]),
      processed: isProcessed,
    });
  }
  return out;
}

/** What non-readers see when a model's display title waits for the owner. */
export const GENERIC_TITLE = "Document";

/**
 * The title a non-reader sees.
 *
 * - The owner decided: their display title, or the real one if they cleared it. After a rename
 *   their display title still stands; a clear doesn't vouch for the new title, but nothing
 *   flagged it either, and the rename sends the object back through enrichment.
 * - A model proposed a display title: the generic title until the owner confirms. The proposal
 *   is model output, which content can steer, so it never reaches non-readers unconfirmed.
 * - Nobody flagged it: the real title.
 */
export function nonReaderTitle(object: {
  title: string;
  displayTitle: string | null;
  displayTitleBy: string | null;
}): string {
  if (object.displayTitleBy === null) return object.title;
  if (!object.displayTitleBy.startsWith("user:")) return GENERIC_TITLE;
  return object.displayTitle ?? object.title;
}

/** Fields every view carries. */
interface ViewBase {
  id: string;
  /** Media type of the current version. */
  mime: string;
  ownerId: string;
}

/** What a non-reader sees of a discoverable file. */
export interface TitleOnlyView extends ViewBase {
  shape: "title-only";
  /** nonReaderTitle(): the owner's display title, the generic title, or the real one. */
  title: string;
  /** Tags of facets marked public, only. */
  tags: string[];
  requestAccess: true;
}

/** A card: a reader's, or a non-reader's for a readable file. Never the content. */
export interface CardView extends ViewBase {
  shape: "card";
  title: string;
  /** Every tag for a reader; public-facet tags only for a non-reader. */
  tags: string[];
  /** Whether the caller can read the file (and so open it). */
  readable: boolean;
  updatedAt: Date;
}

export type ObjectView = TitleOnlyView | CardView;

export interface ViewRequest {
  principal: AuthzPrincipal;
  client: AuthzClient;
}

/**
 * The views a caller may have of some objects, in the order asked, as search results and
 * listings show them. Objects the caller may not know about, deleted ones and unknown ids are
 * left out, indistinguishably.
 */
export async function viewObjects(
  tx: Tx,
  tenantId: string,
  authz: Authorizer,
  request: ViewRequest,
  objectIds: readonly string[],
): Promise<ObjectView[]> {
  const ids = [...new Set(objectIds)];
  if (ids.length === 0) return [];
  await requireSnapshot(tx);
  const rows = await tx
    .select({
      id: objects.id,
      title: objects.title,
      displayTitle: objects.displayTitle,
      displayTitleBy: objects.displayTitleBy,
      ownerId: objects.ownerId,
      updatedAt: objects.updatedAt,
      zone: zones.kind,
    })
    .from(objects)
    .innerJoin(zones, and(eq(zones.tenantId, objects.tenantId), eq(zones.id, objects.zoneId)))
    .where(
      and(eq(objects.tenantId, tenantId), inArray(objects.id, ids), isNull(objects.deletedAt)),
    );
  if (rows.length === 0) return [];
  const found = rows.map((r) => r.id);

  const tagRows = await tx
    .select({
      objectId: objectTags.objectId,
      facet: objectTags.facet,
      value: objectTags.value,
      source: objectTags.source,
      reviewed: objectTags.reviewed,
      public: facets.public,
    })
    .from(objectTags)
    .innerJoin(
      facets,
      and(eq(facets.tenantId, objectTags.tenantId), eq(facets.key, objectTags.facet)),
    )
    .where(and(eq(objectTags.tenantId, tenantId), inArray(objectTags.objectId, found)));
  const tagsOf = new Map<string, { all: string[]; grantable: string[]; public: string[] }>();
  for (const r of tagRows) {
    const entry = tagsOf.get(r.objectId) ?? { all: [], grantable: [], public: [] };
    const tag = tagOf(r.facet, r.value);
    entry.all.push(tag);
    if (r.source !== "model" || r.reviewed) entry.grantable.push(tag);
    if (r.public) entry.public.push(tag);
    tagsOf.set(r.objectId, entry);
  }

  const mimes = await tx
    .selectDistinctOn([versions.objectId], { objectId: versions.objectId, mime: versions.mime })
    .from(versions)
    .where(and(eq(versions.tenantId, tenantId), inArray(versions.objectId, found)))
    .orderBy(versions.objectId, desc(versions.seq));
  const mimeOf = new Map(mimes.map((m) => [m.objectId, m.mime]));
  const levels = await levelsFor(tx, tenantId, found);
  const { principal } = request;
  const member = principal.active && !principal.guest;

  const views = new Map<string, ObjectView>();
  for (const row of rows) {
    const tags = tagsOf.get(row.id) ?? { all: [], grantable: [], public: [] };
    const level = levels.get(row.id);
    if (!level) continue;
    const canRead = authz.authorize({
      principal,
      action: "read",
      resource: { id: row.id, ownerId: row.ownerId, tags: tags.grantable, zone: row.zone },
      client: request.client,
    }).allow;
    if (!canRead && !member) continue;
    const decision = decideRead({
      canRead,
      visibility: level.visibility,
      exposure: level.exposure,
      wantsContent: false,
    });
    const base = {
      id: row.id,
      mime: mimeOf.get(row.id) ?? "application/octet-stream",
      ownerId: row.ownerId,
    };
    const sorted = (list: string[]) => [...list].sort();
    if (decision.shape === "title-only") {
      views.set(row.id, {
        ...base,
        shape: "title-only",
        title: nonReaderTitle(row),
        tags: sorted(tags.public),
        requestAccess: true,
      });
    } else if (decision.shape === "card") {
      views.set(row.id, {
        ...base,
        shape: "card",
        title: canRead ? row.title : nonReaderTitle(row),
        tags: sorted(canRead ? tags.all : tags.public),
        readable: canRead,
        updatedAt: row.updatedAt,
      });
    }
  }
  return ids.flatMap((id) => views.get(id) ?? []);
}

/** Refuses to read across snapshots: see VIEW_TRANSACTION. */
async function requireSnapshot(tx: Tx) {
  const [row] = await queryRows<{ level: string }>(
    tx,
    sql`select current_setting('transaction_isolation') as level`,
  );
  if (row?.level !== "repeatable read" && row?.level !== "serializable") {
    throw new Error("viewObjects needs a repeatable read transaction (VIEW_TRANSACTION)");
  }
}

const DISPLAY_TITLE_MAX = 1024;

function checkTitle(title: string) {
  const n = [...title].length;
  if (n < 1 || n > DISPLAY_TITLE_MAX || title.trim() === "") {
    throw new RangeError(`a display title is 1 to ${DISPLAY_TITLE_MAX} characters, not blank`);
  }
}

/** A display-title decision, made while looking at the object under `forTitle`. */
export interface DisplayTitleInput {
  objectId: string;
  /** The neutral title; for setDisplayTitle(), null clears it (the real title is fine). */
  title: string | null;
  /** `model:…` for proposeDisplayTitle(), `user:…` for setDisplayTitle(). */
  by: string;
  /**
   * The object's title as the caller saw it. If the object has been renamed since, nothing
   * changes: a decision about one title must not stick to another.
   */
  forTitle: string;
}

/**
 * A model's neutral title for an object whose title looks sensitive. Non-readers see the generic
 * title until the owner confirms it. Returns false, changing nothing, when a person has already
 * decided for the current title or the object was renamed since `forTitle`. A rename lets models
 * propose again.
 */
export async function proposeDisplayTitle(
  tx: Tx,
  tenantId: string,
  input: DisplayTitleInput & { title: string },
): Promise<boolean> {
  checkTitle(input.title);
  if (!input.by.startsWith("model:")) {
    throw new TypeError("a proposal comes from a model: principal");
  }
  const updated = await tx
    .update(objects)
    .set({ displayTitle: input.title, displayTitleBy: input.by, displayTitleFor: input.forTitle })
    .where(
      and(
        eq(objects.tenantId, tenantId),
        eq(objects.id, input.objectId),
        eq(objects.title, input.forTitle),
        or(
          isNull(objects.displayTitleBy),
          sql`${objects.displayTitleBy} like 'model:%'`,
          sql`${objects.displayTitleFor} is distinct from ${objects.title}`,
        ),
      ),
    )
    .returning({ id: objects.id });
  return updated.length > 0;
}

/**
 * A person's decision on the display title: confirm or edit it (a title), or clear it (null:
 * the real title is fine to show). Either way models stop proposing for this title. Returns
 * false, changing nothing, if the object is unknown or was renamed since `forTitle`. Who may
 * decide (the owner) is the API's question.
 */
export async function setDisplayTitle(
  tx: Tx,
  tenantId: string,
  input: DisplayTitleInput,
): Promise<boolean> {
  if (input.title !== null) checkTitle(input.title);
  if (!input.by.startsWith("user:")) {
    throw new TypeError("a decision comes from a user: principal");
  }
  const updated = await tx
    .update(objects)
    .set({ displayTitle: input.title, displayTitleBy: input.by, displayTitleFor: input.forTitle })
    .where(
      and(
        eq(objects.tenantId, tenantId),
        eq(objects.id, input.objectId),
        eq(objects.title, input.forTitle),
      ),
    )
    .returning({ id: objects.id });
  return updated.length > 0;
}

/**
 * Enrichment finished a version, having seen the object under `title`: once it is the current
 * version, the object's tags and the tenant defaults decide its levels. Returns false, changing
 * nothing, if the version is unknown, already marked, or the object was renamed since (the
 * rename needs its own enrichment run).
 */
export async function markProcessed(
  tx: Tx,
  tenantId: string,
  input: { versionId: string; title: string },
): Promise<boolean> {
  const updated = await tx
    .update(versions)
    .set({ processedAt: sql`greatest(now(), ${versions.createdAt})` })
    .where(
      and(
        eq(versions.tenantId, tenantId),
        eq(versions.id, input.versionId),
        isNull(versions.processedAt),
        sql`exists (select 1 from ${objects} where ${objects.tenantId} = ${versions.tenantId}
          and ${objects.id} = ${versions.objectId} and ${objects.title} = ${input.title})`,
      ),
    )
    .returning({ id: versions.id });
  return updated.length > 0;
}
