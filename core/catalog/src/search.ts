import { queryRows, type Tx } from "@openhoard/core-db";
import type { Authorizer } from "@openhoard/core-policy";
import { sql, type SQL } from "drizzle-orm";
import {
  GENERIC_TITLE,
  requireSnapshot,
  viewObjects,
  type ObjectView,
  type ViewRequest,
} from "./visibility.js";

/*
 * Search behind policy (T-504): an access filter inside the query, then the one gate.
 *
 * 1. In SQL, the candidates a caller may see: files they can read by a grant (on the file, or on
 *    one of its trusted tags) or as the owner, and, for members, files whose effective
 *    visibility is discoverable or readable (the same rule levelsFor() applies: trusted level
 *    tags or the tenant default, tightened by untrusted ones, hidden while unprocessed). A
 *    credential's scope narrows it (a service account's key). Each is matched twice: as a reader
 *    sees it (the real title, every tag) and as anyone else does (nonReaderTitle(), trusted tags
 *    of public facets).
 * 2. Every candidate then goes through viewObjects(), which decides with authorize(), pack rules
 *    included (`read`, and `search`: a forbid on either takes a file out), and the levels. A view
 *    is kept only if the match for what it shows holds, and ranked by that match: a caller a pack
 *    turns into a non-reader is matched only against the title and tags they are shown. Hits AND
 *    the total come from what passes, so nothing reaches a caller that the gate didn't allow.
 *
 * Limits of this first version (option 1 of the T-504 design): SQL knows grants, ownership and
 * levels, not a pack's Cedar rules.
 * - A file someone may read only through a pack `permit` is matched only as a non-reader sees
 *   it (its display title, public tags), and only if it is discoverable to them, so their
 *   search may miss it (it still opens, and still lists by id).
 * - Past SEARCH_CANDIDATES, which candidates are checked is picked by SQL's guess, so it can
 *   depend on files a pack forbids: `totalIsLowerBound` may be true when fewer than that many
 *   pass (one bit: that many matches exist under the caller's grants), and a visible match can
 *   be crowded out by forbidden ones.
 * Upgrade path (option 3): compile the rules packs use (a subset of Cedar: tag, zone, group and
 * client conditions) into this SQL, keep the gate as the final check, and drop the candidate cap
 * for exact counts. Whole-tenant scans go with T-501 (a search index).
 */

/** Most candidates the gate checks per search; past it, the total is a lower bound. */
export const SEARCH_CANDIDATES = 1_000;

export interface SearchQuery {
  /** Words match titles; `facet:value` terms match tags. Empty lists everything visible. */
  query: string;
  /** Hits to return, 1 to 100. Default 20. */
  limit?: number;
}

export interface SearchResult {
  hits: ObjectView[];
  /** Matches the caller may see: exact unless `totalIsLowerBound`. */
  total: number;
  /** More than {@link SEARCH_CANDIDATES} candidates: `total` counts only those checked. */
  totalIsLowerBound: boolean;
}

const TAG = /^[a-z][a-z0-9-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/;
const QUERY_MAX = 1_000;
/**
 * Split on these before the text parser, in titles and queries alike: Postgres reads
 * `Forecast.xlsx` or `q3_forecast` as one token, so "forecast" would never match either.
 */
const SEPARATORS = "[._/\\\\]+";
const separate = (text: string) => text.replace(/[._/\\]+/g, " ");

/** Runs in a snapshot (VIEW_TRANSACTION), like viewObjects. */
export async function searchObjects(
  tx: Tx,
  tenantId: string,
  authz: Authorizer,
  request: ViewRequest,
  search: SearchQuery,
): Promise<SearchResult> {
  await requireSnapshot(tx, "searchObjects");
  const limit = search.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("limit must be 1 to 100");
  }
  const none: SearchResult = { hits: [], total: 0, totalIsLowerBound: false };
  const text = typeof search.query === "string" ? search.query : "";
  if ([...text].length > QUERY_MAX || text.includes("\0")) return none;
  const terms = text.split(/\s+/).filter((t) => t !== "");
  const tags = [...new Set(terms.filter((t) => TAG.test(t)))];
  const words = separate(terms.filter((t) => !TAG.test(t)).join(" "));

  const { principal } = request;
  // What authorize() forbids outright, before any query: the inactive, and a service account
  // without a key's scope, or with one that doesn't allow searching and reading.
  if (!principal.active) return none;
  const { scope } = principal;
  if (principal.service === true && scope === undefined) return none;
  if (scope !== undefined && !(scope.actions.includes("search") && scope.actions.includes("read")))
    return none;
  const member = !principal.guest && principal.service !== true;

  const readTags = [...new Set([...principal.tagGrants, ...principal.tagWriteGrants])];
  const readObjects = [...new Set([...principal.objectGrants, ...principal.objectWriteGrants])];
  const owner = `user:${principal.userId}`;
  const array = (values: readonly string[]) =>
    sql`array[${sql.join(
      values.map((v) => sql`${v}`),
      sql`, `,
    )}]::text[]`;
  const inList = (values: readonly string[]) =>
    values.length === 0 ? sql`'{}'::text[]` : array(values);

  // Each candidate is matched twice: as a reader would see it (the real title, every tag) and as
  // anyone else would (nonReaderTitle(), trusted tags of public facets). Which one counts is
  // decided after the gate, by the view it gave: SQL's idea of who reads is only a guess (a pack
  // may forbid a grant holder), and matching a non-reader against the real title or a hidden tag
  // would tell them what's in it.
  const otherTitle = sql`case when a.display_title_by is null then a.title
      when a.display_title_by not like 'user:%' then ${GENERIC_TITLE}
      else coalesce(a.display_title, a.title) end`;
  const vector = (title: SQL) =>
    sql`to_tsvector('simple', regexp_replace(${title}, ${SEPARATORS}, ' ', 'g'))`;
  const tsQuery = sql`plainto_tsquery('simple', ${words})`;
  const textMatch = (title: SQL) =>
    words === "" ? sql`true` : sql`${vector(title)} @@ ${tsQuery}`;
  const rank = (title: SQL) =>
    words === "" ? sql`0::real` : sql`ts_rank(${vector(title)}, ${tsQuery})`;
  const tagMatch = (shown: SQL) =>
    tags.length === 0
      ? sql`true`
      : sql.join(
          tags.map(
            (tag) => sql`exists (
              select 1 from object_tags ot join facets f
                on f.tenant_id = ot.tenant_id and f.key = ot.facet
               where ot.tenant_id = ${tenantId} and ot.object_id = a.id
                 and ot.facet || ':' || ot.value = ${tag} and ${shown})`,
          ),
          sql` and `,
        );
  const scopeFilter: SQL[] = [];
  if (scope !== undefined) {
    scopeFilter.push(sql`z.kind = any(${inList(scope.zones)})`);
    if (scope.zoneIds !== undefined) scopeFilter.push(sql`z.id = any(${inList(scope.zoneIds)})`);
  }
  const scoped = scopeFilter.length === 0 ? sql`true` : sql.join(scopeFilter, sql` and `);

  const rows = await queryRows<Candidate>(
    tx,
    sql`with candidates as (
          select o.id, o.title, o.display_title, o.display_title_by, o.updated_at,
                 (o.owner_id = ${owner}
                  or o.id = any(${inList(readObjects)})
                  or exists (
                    select 1 from object_tags ot
                     where ot.tenant_id = ${tenantId} and ot.object_id = o.id
                       and (ot.source <> 'model' or ot.reviewed)
                       and ot.facet || ':' || ot.value = any(${inList(readTags)}))) as readable
            from objects o
            join zones z on z.tenant_id = o.tenant_id and z.id = o.zone_id
           where o.tenant_id = ${tenantId} and o.deleted_at is null and ${scoped}
        ), matched as (
          select a.id, a.readable, a.updated_at,
                 (${textMatch(sql`a.title`)} and ${tagMatch(sql`true`)}) as as_reader,
                 (${textMatch(otherTitle)}
                   and ${tagMatch(sql`f.public and (ot.source <> 'model' or ot.reviewed)`)}) as as_other,
                 ${rank(sql`a.title`)} as reader_rank,
                 ${rank(otherTitle)} as other_rank
            from candidates a
           where a.readable or (${member} and ${effectiveVisibility(tenantId)} >= 1)
        )
        select id, readable, as_reader, as_other, reader_rank, other_rank from matched
         where (readable and as_reader) or as_other
         order by case when readable and as_reader then reader_rank else other_rank end desc,
                  case when readable then updated_at end desc nulls last, id
         limit ${SEARCH_CANDIDATES + 1}`,
  );
  const checked = rows.slice(0, SEARCH_CANDIDATES);
  const byId = new Map(checked.map((r) => [r.id, r]));
  // The gate: authorize() with every rule, `search` included, and the levels. Only what passes,
  // and matched as what the caller is shown, is returned or counted.
  const views = (
    checked.length === 0
      ? []
      : await viewObjects(tx, tenantId, authz, request, [...byId.keys()], { search: true })
  ).flatMap((view) => {
    const row = byId.get(view.id) as Candidate;
    const reader = view.shape === "card" && view.readable;
    // A reader SQL didn't expect (a pack permit) was matched only as anyone else: that match
    // still counts, since what anyone may be shown tells a reader nothing new.
    const asReader = row.as_reader && row.readable;
    if (reader ? !(asReader || row.as_other) : !row.as_other) return [];
    return [{ view, rank: Number(reader && asReader ? row.reader_rank : row.other_rank) }];
  });
  // Best match first; then cards newest first (a card shows its date), then title-only views by
  // id: a title-only view hides when the file changed, so its place can't depend on it.
  views.sort(
    (x, y) =>
      y.rank - x.rank ||
      updated(y.view) - updated(x.view) ||
      (x.view.id < y.view.id ? -1 : x.view.id > y.view.id ? 1 : 0),
  );
  return {
    hits: views.slice(0, limit).map((v) => v.view),
    total: views.length,
    totalIsLowerBound: rows.length > SEARCH_CANDIDATES,
  };
}

interface Candidate {
  id: string;
  readable: boolean;
  as_reader: boolean;
  as_other: boolean;
  reader_rank: number;
  other_rank: number;
}

/** A card's update time; -Infinity for a title-only view, which doesn't show one. */
const updated = (view: ObjectView) =>
  view.shape === "card" ? view.updatedAt.getTime() : Number.NEGATIVE_INFINITY;

/**
 * The effective visibility of candidate `a.id` as a rank (0 hidden, 1 discoverable, 2 readable),
 * as visibility.ts collectLevels() and core/policy resolveLevels() work it out: hidden while the
 * current version is unprocessed; otherwise the most restrictive trusted level tag (approved,
 * and not an unreviewed model guess), or the tenant default without one; then tightened by any
 * untrusted level tag or pending review item. An unknown level counts as hidden.
 */
function effectiveVisibility(tenantId: string): SQL {
  const rank = (column: SQL) =>
    sql`(case ${column} when 'readable' then 2 when 'discoverable' then 1 else 0 end)`;
  // Level tags on the candidate, from object_tags or open review items (both aliased `x`).
  const levelled = (from: SQL, where: SQL) =>
    sql`select ${rank(sql`fv.visibility`)} as r from ${from}
          join facet_values fv
            on fv.tenant_id = x.tenant_id and fv.facet = x.facet and fv.value = x.value
         where x.tenant_id = ${tenantId} and x.object_id = a.id
           and fv.visibility is not null and ${where}`;
  const trusted = sql`(fv.approved and (x.source <> 'model' or x.reviewed))`;
  const processed = sql`coalesce((
      select v.processed_at is not null from versions v
       where v.tenant_id = ${tenantId} and v.object_id = a.id
       order by v.seq desc limit 1), false)`;
  const byDefault = sql`(select ${rank(sql`d.default_visibility`)} from tenants d where d.id = ${tenantId})`;
  return sql`(case when not ${processed} then 0 else least(
      coalesce((select min(t.r) from (${levelled(sql`object_tags x`, trusted)}) t), ${byDefault}),
      coalesce((select min(u.r) from (
          ${levelled(sql`object_tags x`, sql`not ${trusted}`)}
          union all
          ${levelled(sql`tag_reviews x`, sql`x.resolved_at is null and x.reason <> 'primary'`)}
        ) u), 2))
    end)`;
}
