import {
  facets,
  facetValues,
  isId,
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
import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { lockObject } from "./locks.js";

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
 * viewObjects(), levelsFor() and explainLevels() read in several statements, so they need one
 * snapshot: run them in a REPEATABLE READ transaction ({@link VIEW_TRANSACTION}); they refuse
 * weaker isolation. (Under READ COMMITTED, a review approved between two of the statements made
 * a pending restrictive tag vanish from both.) They take at most {@link MAX_OBJECT_IDS} ids.
 *
 * markProcessed(), proposeDisplayTitle() and setDisplayTitle() take the object's lock first,
 * like ingest (locks.ts), so a rename can't slip between their check of the title and their
 * write.
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

/** A tag (applied or waiting in review) whose value sets a level, and how it counts. */
export interface LevelContribution {
  tag: string;
  visibility: Visibility | null;
  exposure: Exposure | null;
  /** Trusted tags decide; the others can only tighten (see the header). */
  trusted: boolean;
  /** Why an untrusted tag only tightens; null for a trusted one. */
  untrustedBecause: "pending-review" | "unreviewed-model-tag" | "unapproved-value" | null;
  /** Waiting in the review inbox rather than applied. */
  pending: boolean;
}

/** Why an object has its levels (T-606). */
export interface LevelsExplanation extends ObjectLevels {
  /** The tenant default, which applies when no trusted tag sets a level. */
  defaults: { visibility: Visibility; exposure: Exposure };
  contributions: LevelContribution[];
}

/**
 * The most distinct object ids one call of viewObjects(), levelsFor() or explainLevels() takes.
 * Page your ids: a statement binds at most 65,535 parameters, and a page this size is already
 * more than any listing shows.
 */
export const MAX_OBJECT_IDS = 10_000;

function distinctIds(objectIds: readonly string[], what: string): string[] {
  // Checked before any work: a list far past the cap is refused however many repeat.
  if (objectIds.length > MAX_OBJECT_IDS * 4) {
    throw new RangeError(
      `${what} takes at most ${MAX_OBJECT_IDS} distinct object ids: page your ids`,
    );
  }
  // Anything that isn't an object id is an unknown id, left out like one (a NUL byte would
  // otherwise fail the query, telling a caller something an unknown id doesn't).
  const ids = [...new Set(objectIds)].filter((id) => typeof id === "string" && isId("object", id));
  if (ids.length > MAX_OBJECT_IDS) {
    throw new RangeError(
      `${what} takes at most ${MAX_OBJECT_IDS} distinct object ids, not ${ids.length}: page your ids`,
    );
  }
  return ids;
}

/**
 * Effective levels for each object that exists; missing ids are left out. It reads in several
 * statements, so it needs one snapshot, like viewObjects(): run it in a REPEATABLE READ (or
 * serializable) transaction, {@link VIEW_TRANSACTION}; it refuses weaker isolation. At most
 * {@link MAX_OBJECT_IDS} distinct ids.
 */
export async function levelsFor(
  tx: Tx,
  tenantId: string,
  objectIds: readonly string[],
): Promise<Map<string, ObjectLevels>> {
  const ids = distinctIds(objectIds, "levelsFor");
  await requireSnapshot(tx, "levelsFor");
  const explained = await collectLevels(tx, tenantId, ids);
  return new Map(
    [...explained].map(([id, e]) => [
      id,
      { visibility: e.visibility, exposure: e.exposure, processed: e.processed },
    ]),
  );
}

/**
 * Levels with the tags behind them, for one object; null if it doesn't exist. Needs one
 * snapshot, like levelsFor().
 */
export async function explainLevels(
  tx: Tx,
  tenantId: string,
  objectId: string,
): Promise<LevelsExplanation | null> {
  await requireSnapshot(tx, "explainLevels");
  return (await collectLevels(tx, tenantId, [objectId])).get(objectId) ?? null;
}

/**
 * Levels of `ids` (distinct, at most MAX_OBJECT_IDS), read in one snapshot the caller checked.
 * `known` passes what the caller has read already: which of the ids exist, and whether each
 * one's current version is processed.
 */
async function collectLevels(
  tx: Tx,
  tenantId: string,
  ids: readonly string[],
  known?: { present: readonly string[]; processed: ReadonlyMap<string, boolean> },
): Promise<Map<string, LevelsExplanation>> {
  const out = new Map<string, LevelsExplanation>();
  if (ids.length === 0) return out;
  const [tenant] = await tx
    .select({ visibility: tenants.defaultVisibility, exposure: tenants.defaultExposure })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) return out;

  let processed = known?.processed;
  if (!processed) {
    const current = await currentVersions(tx, tenantId, ids);
    processed = new Map([...current].map(([id, v]) => [id, v.processed]));
  }

  const levelled = or(isNotNull(facetValues.visibility), isNotNull(facetValues.exposure));
  const applied = tx
    .select({
      objectId: objectTags.objectId,
      facet: objectTags.facet,
      value: objectTags.value,
      visibility: facetValues.visibility,
      exposure: facetValues.exposure,
      trusted: sql<boolean>`(${facetValues.approved} and (${objectTags.source} <> 'model' or ${objectTags.reviewed}))`,
      approved: facetValues.approved,
      pending: sql<boolean>`false`,
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
      facet: tagReviews.facet,
      value: tagReviews.value,
      visibility: facetValues.visibility,
      exposure: facetValues.exposure,
      trusted: sql<boolean>`false`,
      approved: facetValues.approved,
      pending: sql<boolean>`true`,
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
        // A primary proposal names a tag the object carries already, and applies nothing.
        ne(tagReviews.reason, "primary"),
        levelled,
      ),
    );
  interface Collected {
    trusted: { visibilities: string[]; exposures: string[] };
    tighten: { visibilities: string[]; exposures: string[] };
    contributions: LevelContribution[];
  }
  const byObject = new Map<string, Collected>();
  for (const row of [...(await applied), ...(await pending)]) {
    const entry = byObject.get(row.objectId) ?? {
      trusted: { visibilities: [], exposures: [] },
      tighten: { visibilities: [], exposures: [] },
      contributions: [],
    };
    // Raw SQL booleans come back as booleans on both drivers; anything else is untrusted.
    const trusted = row.trusted === true;
    const side = trusted ? entry.trusted : entry.tighten;
    if (row.visibility !== null) side.visibilities.push(row.visibility);
    if (row.exposure !== null) side.exposures.push(row.exposure);
    const isPending = row.pending === true;
    entry.contributions.push({
      tag: tagOf(row.facet, row.value),
      visibility: row.visibility,
      exposure: row.exposure,
      trusted,
      untrustedBecause: trusted
        ? null
        : isPending
          ? "pending-review"
          : row.approved
            ? "unreviewed-model-tag"
            : "unapproved-value",
      pending: isPending,
    });
    byObject.set(row.objectId, entry);
  }

  const present =
    known?.present ??
    (
      await tx
        .select({ id: objects.id })
        .from(objects)
        .where(and(eq(objects.tenantId, tenantId), inArray(objects.id, [...ids])))
    ).map((r) => r.id);
  for (const id of present) {
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
      defaults: { visibility: tenant.visibility, exposure: tenant.exposure },
      contributions: (entry?.contributions ?? []).sort(
        (a, b) =>
          Number(a.pending) - Number(b.pending) || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0),
      ),
    });
  }
  return out;
}

/** Each object's current version: its media type, and whether enrichment has finished it. */
async function currentVersions(
  tx: Tx,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, { mime: string; processed: boolean }>> {
  const rows = await tx
    .selectDistinctOn([versions.objectId], {
      objectId: versions.objectId,
      mime: versions.mime,
      processedAt: versions.processedAt,
    })
    .from(versions)
    .where(and(eq(versions.tenantId, tenantId), inArray(versions.objectId, [...ids])))
    .orderBy(versions.objectId, desc(versions.seq));
  return new Map(
    rows.map((v) => [v.objectId, { mime: v.mime, processed: v.processedAt !== null }]),
  );
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
  /**
   * The file's primary tag, its home (T-409), for breadcrumbs and grouping: shown to a reader,
   * and to anyone else only when it is one of the tags they are shown.
   */
  primaryTag: string | null;
}

/** What a non-reader sees of a discoverable file. */
export interface TitleOnlyView extends ViewBase {
  shape: "title-only";
  /** nonReaderTitle(): the owner's display title, the generic title, or the real one. */
  title: string;
  /** Trusted tags (not a model's unreviewed guess) of facets marked public, only. */
  tags: string[];
  requestAccess: true;
}

/** A card: a reader's, or a non-reader's for a readable file. Never the content. */
export interface CardView extends ViewBase {
  shape: "card";
  title: string;
  /** Every tag for a reader; trusted public-facet tags only for a non-reader. */
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

export interface ViewOptions {
  /**
   * The views are search results (searchObjects): `search` is authorized too, and a file it
   * forbids (a pack rule, or a key's scope without `search`) is left out entirely, as is one
   * whose rules fail to evaluate (fail closed).
   */
  search?: boolean;
}

/**
 * The views a caller may have of some objects, in the order asked, as search results and
 * listings show them. Objects the caller may not know about, deleted ones and unknown ids are
 * left out, indistinguishably. At most {@link MAX_OBJECT_IDS} distinct ids: page your ids.
 */
export async function viewObjects(
  tx: Tx,
  tenantId: string,
  authz: Authorizer,
  request: ViewRequest,
  objectIds: readonly string[],
  options: ViewOptions = {},
): Promise<ObjectView[]> {
  const ids = distinctIds(objectIds, "viewObjects");
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
      zoneId: zones.id,
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
      primaryBy: objectTags.primaryBy,
      public: facets.public,
    })
    .from(objectTags)
    .innerJoin(
      facets,
      and(eq(facets.tenantId, objectTags.tenantId), eq(facets.key, objectTags.facet)),
    )
    .where(and(eq(objectTags.tenantId, tenantId), inArray(objectTags.objectId, found)));
  interface Tags {
    all: string[];
    grantable: string[];
    public: string[];
    primary: string | null;
  }
  const none = (): Tags => ({ all: [], grantable: [], public: [], primary: null });
  const tagsOf = new Map<string, Tags>();
  for (const r of tagRows) {
    const entry = tagsOf.get(r.objectId) ?? none();
    const tag = tagOf(r.facet, r.value);
    const trusted = r.source !== "model" || r.reviewed;
    // The database never lets an untrusted tag be the home; this doesn't rely on it.
    if (r.primaryBy !== null && trusted) entry.primary = tag;
    entry.all.push(tag);
    if (trusted) entry.grantable.push(tag);
    // Model output never reaches non-readers unconfirmed: public tags shown to them are trusted.
    if (r.public && trusted) entry.public.push(tag);
    tagsOf.set(r.objectId, entry);
  }

  // One read of the current versions serves both the media types and the levels.
  const current = await currentVersions(tx, tenantId, found);
  const levels = await collectLevels(tx, tenantId, found, {
    present: found,
    processed: new Map([...current].map(([id, v]) => [id, v.processed])),
  });
  const { principal } = request;
  // Service accounts, like guests, see only what they can read.
  const member = principal.active && !principal.guest && principal.service !== true;

  const views = new Map<string, ObjectView>();
  for (const row of rows) {
    const tags = tagsOf.get(row.id) ?? none();
    const level = levels.get(row.id);
    if (!level) continue;
    const resource = {
      id: row.id,
      ownerId: row.ownerId,
      tags: tags.grantable,
      allTags: tags.all,
      zone: row.zone,
      zoneId: row.zoneId,
    };
    const canRead = authz.authorize({
      principal,
      action: "read",
      resource,
      client: request.client,
    }).allow;
    if (!canRead && !member) continue;
    if (options.search === true) {
      // No permit is fine (members find by level); a forbid or an error takes the file out.
      const { kind } = authz.authorize({
        principal,
        action: "search",
        resource,
        client: request.client,
      });
      if (kind === "forbid" || kind === "error") continue;
    }
    const decision = decideRead({
      canRead,
      visibility: level.visibility,
      exposure: level.exposure,
      clientTrust: request.client.trust,
      wantsContent: false,
    });
    const shown = canRead ? tags.all : tags.public;
    const base = {
      id: row.id,
      mime: current.get(row.id)?.mime ?? "application/octet-stream",
      ownerId: row.ownerId,
      primaryTag: tags.primary !== null && shown.includes(tags.primary) ? tags.primary : null,
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
        tags: sorted(shown),
        readable: canRead,
        updatedAt: row.updatedAt,
      });
    }
  }
  return ids.flatMap((id) => views.get(id) ?? []);
}

/** Refuses to read across snapshots: see VIEW_TRANSACTION. */
export async function requireSnapshot(tx: Tx, what = "viewObjects"): Promise<void> {
  const [row] = await queryRows<{ level: string }>(
    tx,
    sql`select current_setting('transaction_isolation') as level`,
  );
  if (row?.level !== "repeatable read" && row?.level !== "serializable") {
    throw new Error(`${what} needs a repeatable read transaction (VIEW_TRANSACTION)`);
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
  // The object's lock before its row, as ingest takes them (locks.ts).
  await lockObject(tx, tenantId, input.objectId);
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
  await lockObject(tx, tenantId, input.objectId);
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
  // A version never changes objects, so an unlocked read names the object to lock.
  const [version] = await tx
    .select({ objectId: versions.objectId })
    .from(versions)
    .where(and(eq(versions.tenantId, tenantId), eq(versions.id, input.versionId)));
  if (!version) return false;
  // Ingest renames under this lock, so once we hold it no rename is half done. The title is
  // compared in a statement of its own, after the lock: a single UPDATE … WHERE EXISTS would
  // compare against the title as of its snapshot, taken before it waited, and mark the renamed
  // object processed under a title nobody enriched. FOR SHARE reads the latest committed row;
  // in a snapshot transaction, a rename since the snapshot fails it with a serialization error
  // (retry) instead.
  await lockObject(tx, tenantId, version.objectId);
  const [object] = await tx
    .select({ title: objects.title })
    .from(objects)
    .where(and(eq(objects.tenantId, tenantId), eq(objects.id, version.objectId)))
    .for("share");
  if (object?.title !== input.title) return false;
  const updated = await tx
    .update(versions)
    .set({ processedAt: sql`greatest(now(), ${versions.createdAt})` })
    .where(
      and(
        eq(versions.tenantId, tenantId),
        eq(versions.id, input.versionId),
        isNull(versions.processedAt),
      ),
    )
    .returning({ id: versions.id });
  return updated.length > 0;
}
