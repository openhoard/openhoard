import {
  INDEXED_DIMENSIONS,
  MAX_EMBEDDING_DIMENSIONS,
  queryRows,
  type Tx,
} from "@openhoard/core-db";
import type { Authorizer } from "@openhoard/core-policy";
import { sql, type SQL } from "drizzle-orm";
import { isEmbeddingModel } from "./embeddings.js";
import { fuseChannels, type ChannelList } from "./rank.js";
import {
  GENERIC_TITLE,
  requireSnapshot,
  viewObjects,
  type ObjectView,
  type ViewRequest,
} from "./visibility.js";

/*
 * Search behind policy (T-504), hybrid (T-503): an access filter inside the query, then the one
 * gate, then fusion.
 *
 * 1. In SQL, the candidates a caller may see: files they can read by a grant (on the file, or on
 *    one of its trusted tags) or as the owner, and, for members, files whose effective
 *    visibility is discoverable or readable (the same rule levelsFor() applies: trusted level
 *    tags or the tenant default, tightened by untrusted ones, hidden while unprocessed). A
 *    credential's scope narrows it (a service account's key).
 * 2. Keyword matches (T-501) against each object's search document (core/db searchDocuments:
 *    title A, tags B, summary C, extracted text D, `simple` configuration), found through its
 *    GIN indexes. Each candidate is matched once per way a caller may be shown it, and only on
 *    what that view shows:
 *    - a reader whose card isn't metadata-only (the content is theirs to have): title, every
 *      tag, the summary (only while the file's exposure still allows the provider that wrote
 *      it, as the card shows it) and the extracted text;
 *    - a reader's metadata-only card (T-604: the file's exposure doesn't reach this AI client,
 *      or it is flagged `risk:injection`): the title and trusted tags, nothing content-derived;
 *    - anyone else: the title they are shown (nonReaderTitle()) and trusted tags of public
 *      facets.
 * 3. Vector matches (T-502): the nearest chunks and summaries by each query embedding's model
 *    (core/models embedQuery()), among files whose content SQL expects the caller may have (a
 *    reader, exposure reaching the client). The plan is spike S1's rule, never the planner's:
 *    count those rows, up to {@link EXACT_SEARCH_ROWS}; at or below it search exactly (every
 *    row's distance: recall 100%, fast on a small set); above it use the model's HNSW index
 *    with `hnsw.iterative_scan = relaxed_order` and `hnsw.ef_search = 200`, set for that
 *    statement only. (Filtered HNSW without that choice lost most of its recall on selective
 *    filters, and the planner picked it anyway.)
 * 4. Every candidate from both goes through viewObjects(), which decides with authorize(), pack
 *    rules included (`read`, and `search`: a forbid on either takes a file out), and the levels.
 *    A keyword match is kept only if it holds for the view the caller got; a vector match only
 *    for a reader's card that isn't metadata-only. So a file can only match on what its card
 *    shows the caller: nothing content-derived reaches a caller who may not have the content,
 *    through hits, ranks, counts, facets or suggestions.
 * 5. The survivors are ranked per channel (keyword by weighted ts_rank, vector by distance,
 *    activity by the caller's own recent views, opens and edits, T-205) and fused with
 *    Reciprocal Rank Fusion (rank.ts). Each hit's explanation says which channels matched it,
 *    its place in each, and which fields its keyword match was on, for the view it got.
 *    Channel ranks count survivors only, so a file the gate removed moves nobody.
 *
 * Snippets (highlighted lines of extracted text) only on request, and only to OpenHoard's own
 * apps (first-party), for a reader whose card isn't metadata-only: the text is raw document
 * text, which could carry instructions for an AI, so no AI client gets it in M1 (the output
 * filter of T-405 is for model answers, not documents). Plain text with highlight offsets,
 * never markup.
 *
 * Limits (option 1 of the T-504 design): SQL knows grants, ownership and levels, not a pack's
 * Cedar rules.
 * - A file someone may read only through a pack `permit` is matched only as a non-reader sees
 *   it (its display title, public tags), and only if it is discoverable to them, so their
 *   search may miss it (it still opens, and still lists by id). Its content isn't matched.
 * - Past SEARCH_CANDIDATES keyword candidates, or among the nearest vectors, which candidates
 *   are checked is picked by SQL's guess, so a file a pack forbids can crowd out a visible one
 *   (never shown, never counted): `totalIsLowerBound` may be true when fewer than that many
 *   pass (one bit: that many matches exist under the caller's grants). `vectorPlans` is the
 *   same kind of bit: whether more than EXACT_SEARCH_ROWS vectors are under their grants.
 * Upgrade path (option 3): compile the rules packs use into this SQL and keep the gate as the
 * final check.
 */

/** Most keyword candidates the gate checks per search; past it, the total is a lower bound. */
export const SEARCH_CANDIDATES = 1_000;
/** Spike S1's threshold: at or below this many visible vectors, search exactly. */
export const EXACT_SEARCH_ROWS = 50_000;
/** Spike S1's HNSW settings above the threshold. */
export const HNSW_EF_SEARCH = 200;
export const HNSW_ITERATIVE_SCAN = "relaxed_order";
/** Nearest files per model a vector search returns at most. */
export const VECTOR_NEIGHBOURS = 50;
/** Query embeddings one search uses at most. */
export const MAX_QUERY_VECTORS = 4;

/** A query's embedding under one model (core/models embedQuery()). */
export interface QueryVector {
  /** `<provider id>/<model>`, as the stored vectors are named. */
  model: string;
  vector: readonly number[];
}

export interface SearchQuery {
  /** Words match titles, tags and content; `facet:value` terms filter by tag. Empty lists all. */
  query: string;
  /** Hits to return, 1 to 100. Default 20. */
  limit?: number;
  /**
   * The words of the query embedded, once per embeddings model (core/models embedQuery()): with
   * them, files are also found by meaning. Without them (no embeddings model configured, or it
   * failed), search is keyword only. Ignored when the query has no words.
   */
  vectors?: readonly QueryVector[];
  /** Highlighted lines of matching text on each hit's explanation: first-party clients only. */
  snippets?: boolean;
}

/** Tuning, for tests and the benchmark; the defaults are spike S1's. */
export interface SearchTuning {
  /** At or below this many visible vectors, vector search is exact. Default 50,000. */
  exactLimit?: number;
  /** Nearest files per model. Default 50. */
  neighbours?: number;
  /**
   * A vector match counts from this cosine similarity up (-1 to 1). Default 0.3: below it, a
   * file is "nearest" only because every file is far. Depends on the model.
   */
  minSimilarity?: number;
  /** Activity from this many days back boosts a hit. Default 30. */
  activityDays?: number;
}

/** A field a keyword match was on. */
export type SearchField = "title" | "tags" | "summary" | "body";

/** How a hit was found, for "why is this here?" (T-503). Ranks count from 1. */
export interface HitExplanation {
  id: string;
  /** The fused score (Reciprocal Rank Fusion). */
  score: number;
  channels: {
    /** Words (or tag filters, or a listing) matched it; `fields`: what the words matched. */
    keyword?: { rank: number; fields: SearchField[] };
    /** Near the query's meaning, by the model named. */
    vector?: { rank: number; similarity: number; model: string };
    /** The caller viewed, opened or edited it lately. */
    activity?: { rank: number };
  };
  /** Highlighted extracted text: only when asked, first-party, content the caller may have. */
  snippet?: Snippet;
}

/** A line of document text, plain, with the matching words' offsets (UTF-16, end exclusive). */
export interface Snippet {
  text: string;
  highlights: [number, number][];
}

/** How the vector search ran for one model: spike S1's plan rule (T-502). */
export interface VectorPlan {
  model: string;
  plan: "exact" | "hnsw";
}

export interface SearchResult {
  hits: ObjectView[];
  /** One per hit, in the same order. */
  explanations: HitExplanation[];
  /** Matches the caller may see: exact unless `totalIsLowerBound`. */
  total: number;
  /** More than {@link SEARCH_CANDIDATES} candidates: `total` and `facets` count only those checked. */
  totalIsLowerBound: boolean;
  /**
   * Facet key → value → matches, over every match counted in `total` (not only the hits), from
   * the tags each match shows the caller: a reader's every tag, anyone else's public ones.
   */
  facets: Record<string, Record<string, number>>;
  /** The vector plan per query embedding used. */
  vectorPlans: VectorPlan[];
}

const TAG = /^[a-z][a-z0-9-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/;
const QUERY_MAX = 1_000;
const PREFIX_MAX = 100;
/** Escaped with a backslash in a Postgres regular expression, where each is then literal. */
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/g;
/**
 * Split on these before the text parser, in titles and queries alike: Postgres reads
 * `Forecast.xlsx` or `q3_forecast` as one token, so "forecast" would never match either. The
 * search documents are split the same way (migration 0053, openhoard_search_words()).
 */
const separate = (text: string) => text.replace(/[._/\\]+/g, " ");
/** The ts_rank weights for D, C, B, A: extracted text, summary, tags, title. */
const WEIGHTS = sql`'{0.1, 0.25, 0.5, 1.0}'::float4[]`;
/** Channel weights in the fusion: activity only nudges. */
const ACTIVITY_WEIGHT = 0.5;
const SNIPPET_MAX = 400;
const START = String.fromCharCode(0xe000);
const STOP = String.fromCharCode(0xe001);

/** Runs in a snapshot (VIEW_TRANSACTION), like viewObjects. */
export async function searchObjects(
  tx: Tx,
  tenantId: string,
  authz: Authorizer,
  request: ViewRequest,
  search: SearchQuery,
  tuning: SearchTuning = {},
): Promise<SearchResult> {
  await requireSnapshot(tx, "searchObjects");
  const limit = search.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("limit must be 1 to 100");
  }
  const none: SearchResult = {
    hits: [],
    explanations: [],
    total: 0,
    totalIsLowerBound: false,
    facets: {},
    vectorPlans: [],
  };
  const text = typeof search.query === "string" ? search.query : "";
  if ([...text].length > QUERY_MAX || text.includes("\0")) return none;
  const terms = text.split(/\s+/).filter((t) => t !== "");
  const tags = [...new Set(terms.filter((t) => TAG.test(t)))];
  const words = separate(terms.filter((t) => !TAG.test(t)).join(" ")).trim();
  const vectors = words === "" ? [] : checkVectors(search.vectors ?? []);
  const found = await gatedMatches(tx, tenantId, authz, request, { words, tags, vectors }, tuning);
  if (!found) return none;
  // Counted over what passed, from the tags each view shows: a hidden file or a hidden tag adds
  // nothing (T-505).
  // Prototype-free objects: a facet or value named `constructor` is just a name here.
  const facets: Record<string, Record<string, number>> = Object.create(null);
  for (const { view } of found.hits) {
    for (const tag of view.tags) {
      const at = tag.indexOf(":");
      const key = tag.slice(0, at);
      const bucket: Record<string, number> = (facets[key] ??= Object.create(null));
      const value = tag.slice(at + 1);
      bucket[value] = (bucket[value] ?? 0) + 1;
    }
  }
  const page = found.hits.slice(0, limit);
  const snippets =
    search.snippets === true && request.client.trust === "first-party" && words !== ""
      ? await snippetsFor(
          tx,
          tenantId,
          words,
          page.filter((h) => h.explanation.channels.keyword?.fields.includes("body")),
        )
      : new Map<string, Snippet>();
  return {
    hits: page.map((h) => h.view),
    explanations: page.map((h) => {
      const snippet = snippets.get(h.view.id);
      return snippet === undefined ? h.explanation : { ...h.explanation, snippet };
    }),
    total: found.hits.length,
    totalIsLowerBound: found.lowerBound,
    facets,
    vectorPlans: found.plans,
  };
}

export interface SuggestQuery {
  /** The start of a word in the title, 1 to 100 characters; case doesn't matter. */
  prefix: string;
  /** Titles to return, 1 to 50. Default 10. */
  limit?: number;
}

/**
 * Title suggestions for a search box (T-505): distinct titles, as the caller is shown them, with
 * a word starting with `prefix`. Drawn from what searchObjects() would return (the same
 * candidates and the same gate), so a suggestion never names a file, or a title, the caller
 * couldn't find. Titles only: nothing content-derived is ever suggested. Runs in a snapshot
 * (VIEW_TRANSACTION).
 */
export async function suggestTitles(
  tx: Tx,
  tenantId: string,
  authz: Authorizer,
  request: ViewRequest,
  suggest: SuggestQuery,
): Promise<string[]> {
  await requireSnapshot(tx, "suggestTitles");
  const limit = suggest.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError("limit must be 1 to 50");
  }
  const prefix = (typeof suggest.prefix === "string" ? suggest.prefix : "").trim();
  const n = [...prefix].length;
  if (n < 1 || n > PREFIX_MAX || prefix.includes("\0")) return [];
  const found = await gatedMatches(
    tx,
    tenantId,
    authz,
    request,
    { words: "", tags: [], vectors: [], prefix: prefix.replace(/\s+/g, " ") },
    {},
  );
  if (!found) return [];
  const titles = new Set<string>();
  for (const { view } of found.hits) {
    if (titles.size === limit) break;
    titles.add(view.title);
  }
  return [...titles];
}

/** Spike S1's plan rule: exact at or below `exactLimit` visible vectors, else HNSW. */
export function vectorPlanFor(
  visibleRows: number,
  dimensions: number,
  exactLimit = EXACT_SEARCH_ROWS,
): "exact" | "hnsw" {
  if (visibleRows <= exactLimit) return "exact";
  // Sizes without an index (core/db INDEXED_DIMENSIONS) can only be searched exactly.
  return (INDEXED_DIMENSIONS as readonly number[]).includes(dimensions) ? "hnsw" : "exact";
}

interface Match {
  /** Words for the text search; "" matches everything. */
  words: string;
  /** `facet:value` terms, all of which must match. */
  tags: readonly string[];
  vectors: readonly QueryVector[];
  /** Instead of words: a word in the title starts with this, in any case. */
  prefix?: string;
}

interface Hit {
  view: ObjectView;
  explanation: HitExplanation;
}

/** Valid query vectors, at most MAX_QUERY_VECTORS, one per model; the rest are ignored. */
function checkVectors(vectors: readonly QueryVector[]): QueryVector[] {
  if (!Array.isArray(vectors)) return [];
  const out = new Map<string, QueryVector>();
  for (const v of vectors) {
    if (out.size === MAX_QUERY_VECTORS) break;
    if (typeof v !== "object" || v === null || !isEmbeddingModel(v.model)) continue;
    const values = v.vector;
    if (!Array.isArray(values) || values.length < 1 || values.length > MAX_EMBEDDING_DIMENSIONS) {
      continue;
    }
    if (!values.every((x) => typeof x === "number" && Number.isFinite(x))) continue;
    if (values.every((x) => x === 0)) continue;
    if (!out.has(v.model)) out.set(v.model, { model: v.model, vector: [...values] });
  }
  return [...out.values()];
}

/** The caller as the SQL needs it; null when authorize() would refuse them everything. */
function callerOf(request: ViewRequest) {
  const { principal, client } = request;
  // What authorize() forbids outright, before any query: the inactive, and a service account
  // without a key's scope, or with one that doesn't allow searching and reading.
  if (!principal.active) return null;
  const { scope } = principal;
  if (principal.service === true && scope === undefined) return null;
  if (scope !== undefined && !(scope.actions.includes("search") && scope.actions.includes("read")))
    return null;
  return {
    principal,
    scope,
    member: !principal.guest && principal.service !== true,
    readTags: [...new Set([...principal.tagGrants, ...principal.tagWriteGrants])],
    readObjects: [...new Set([...principal.objectGrants, ...principal.objectWriteGrants])],
    owner: `user:${principal.userId}`,
    // The least exposure at which this client may have the content (core/policy decideRead()):
    // OpenHoard's own apps always, an AI client when its trust label reaches it, else never.
    contentNeed: CONTENT_NEED[client.trust] ?? NEVER,
  };
}
type Caller = NonNullable<ReturnType<typeof callerOf>>;

/** Exposure ranks: metadata-only 0, local-only 1, commercial-only 2, full 3. */
const NEVER = 99;
const CONTENT_NEED: Readonly<Record<string, number>> = Object.freeze({
  "first-party": 0,
  local: 1,
  commercial: 2,
  consumer: 3,
});

const array = (values: readonly string[]) =>
  values.length === 0
    ? sql`'{}'::text[]`
    : sql`array[${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )}]::text[]`;

/**
 * The candidates CTE body: the tenant's live objects in the caller's scope, with their search
 * documents and whether SQL expects the caller reads them (owner, object grant, trusted tag
 * grant). `where` narrows it (a text match on the documents, through their GIN indexes).
 */
function candidates(tenantId: string, caller: Caller, where: SQL): SQL {
  const { scope } = caller;
  const scopeFilter: SQL[] = [];
  if (scope !== undefined) {
    scopeFilter.push(sql`z.kind = any(${array(scope.zones)})`);
    if (scope.zoneIds !== undefined) scopeFilter.push(sql`z.id = any(${array(scope.zoneIds)})`);
  }
  const scoped = scopeFilter.length === 0 ? sql`true` : sql.join(scopeFilter, sql` and `);
  const empty = sql`''::tsvector`;
  return sql`select o.id, o.title, o.display_title, o.display_title_by, o.updated_at,
             d.version_id,
             coalesce(d.title_tsv, ${empty}) as title_tsv,
             coalesce(d.other_title_tsv, ${empty}) as other_title_tsv,
             coalesce(d.tags_tsv, ${empty}) as tags_tsv,
             coalesce(d.trusted_tags_tsv, ${empty}) as trusted_tags_tsv,
             coalesce(d.public_tags_tsv, ${empty}) as public_tags_tsv,
             coalesce(d.summary_tsv, ${empty}) as summary_tsv,
             d.summary_provider_kind,
             coalesce(d.body_tsv, ${empty}) as body_tsv,
             (o.owner_id = ${caller.owner}
              or o.id = any(${array(caller.readObjects)})
              or exists (
                select 1 from object_tags ot
                 where ot.tenant_id = ${tenantId} and ot.object_id = o.id
                   and (ot.source <> 'model' or ot.reviewed)
                   and ot.facet || ':' || ot.value = any(${array(caller.readTags)}))) as readable
        from objects o
        join zones z on z.tenant_id = o.tenant_id and z.id = o.zone_id
        left join search_documents d on d.tenant_id = o.tenant_id and d.object_id = o.id
       where o.tenant_id = ${tenantId} and o.deleted_at is null and ${scoped} and ${where}`;
}

/** `facet:value` terms, each a tag on candidate `a.id` that `shown` lets the caller see. */
function tagMatch(tenantId: string, tags: readonly string[], shown: SQL): SQL {
  if (tags.length === 0) return sql`true`;
  return sql.join(
    tags.map(
      (tag) => sql`exists (
          select 1 from object_tags ot join facets f
            on f.tenant_id = ot.tenant_id and f.key = ot.facet
           where ot.tenant_id = ${tenantId} and ot.object_id = a.id
             and ot.facet || ':' || ot.value = ${tag} and ${shown})`,
    ),
    sql` and `,
  );
}

/**
 * The levels CTE body over `from` (candidates `a`): each candidate's effective visibility and,
 * where SQL expects a reader, exposure, as ranks; and whether the caller may have its content
 * (`content_ok`) and its summary (`summary_ok`, the provider that wrote it still allowed).
 */
function levelled(tenantId: string, caller: Caller, from: SQL): SQL {
  const exposure = effectiveLevel(tenantId, "exposure");
  const need = (kind: SQL) =>
    sql`(case ${kind} when 'local' then 1 when 'commercial' then 2 when 'consumer' then 3 else ${NEVER} end)`;
  return sql`select b.*,
             (b.readable and b.exposure >= ${caller.contentNeed}) as content_ok,
             (b.readable and b.exposure >= ${caller.contentNeed}
              and b.summary_provider_kind is not null
              and b.exposure >= ${need(sql`b.summary_provider_kind`)}) as summary_ok
        from (select a.*,
                     -- Each level only where it decides something: visibility for a caller
                     -- SQL doesn't expect to read, exposure for one it does.
                     case when a.readable then 2
                          else ${effectiveLevel(tenantId, "visibility")} end as visibility,
                     case when a.readable then ${exposure} else 0 end as exposure
                from (${from}) a) b
       where b.readable or (${caller.member} and b.visibility >= 1)`;
}

/**
 * The views that pass the gate for a match, best first (fused), or null when the caller can't
 * search at all. `lowerBound`: more keyword candidates than {@link SEARCH_CANDIDATES} matched.
 */
async function gatedMatches(
  tx: Tx,
  tenantId: string,
  authz: Authorizer,
  request: ViewRequest,
  match: Match,
  tuning: SearchTuning,
): Promise<{ hits: Hit[]; lowerBound: boolean; plans: VectorPlan[] } | null> {
  const caller = callerOf(request);
  if (caller === null) return null;
  const { tags, prefix } = match;
  const rows = await keywordCandidates(tx, tenantId, caller, match);
  const checked = rows.slice(0, SEARCH_CANDIDATES);
  const byId = new Map(checked.map((r) => [r.id, r]));

  const near = new Map<string, { model: string; similarity: number }[]>();
  const plans: VectorPlan[] = [];
  for (const query of match.vectors) {
    const found = await nearest(tx, tenantId, caller, query, tags, tuning);
    plans.push({ model: query.model, plan: found.plan });
    for (const n of found.near) {
      const list = near.get(n.id) ?? [];
      list.push({ model: query.model, similarity: n.similarity });
      near.set(n.id, list);
    }
  }

  const startsWord =
    prefix === undefined
      ? undefined
      : new RegExp(`(?:^|[^\\p{L}\\p{N}])${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "iu");
  const ids = [...new Set([...byId.keys(), ...near.keys()])];
  // The gate: authorize() with every rule, `search` included, and the levels. Only what passes,
  // and matched as what the caller is shown, is returned or counted.
  const gated =
    ids.length === 0
      ? []
      : await viewObjects(tx, tenantId, authz, request, ids, {
          search: true,
        });
  interface Survivor {
    view: ObjectView;
    keyword?: { rank: number; fields: SearchField[] };
    vector?: { model: string; similarity: number }[];
  }
  const survivors: Survivor[] = [];
  for (const view of gated) {
    const reader = view.shape === "card" && view.readable;
    // A reader whose card isn't metadata-only may have what the content says (T-604).
    const content = reader && !view.metadataOnly;
    const row = byId.get(view.id);
    const survivor: Survivor = { view };
    if (row !== undefined) {
      const kw = keywordFor(view, row);
      if (kw !== null) survivor.keyword = kw;
    }
    const vec = near.get(view.id);
    if (content && vec !== undefined) survivor.vector = vec;
    if (survivor.keyword === undefined && survivor.vector === undefined) continue;
    if (startsWord !== undefined && !startsWord.test(view.title)) continue;
    survivors.push(survivor);
  }

  // Keyword: best match first; then cards newest first (a card shows its date), then title-only
  // views by id: a title-only view hides when the file changed, so its place can't depend on it.
  const byKeyword = survivors
    .filter((s) => s.keyword !== undefined)
    .sort(
      (x, y) =>
        (y.keyword?.rank ?? 0) - (x.keyword?.rank ?? 0) ||
        updated(y.view) - updated(x.view) ||
        (x.view.id < y.view.id ? -1 : x.view.id > y.view.id ? 1 : 0),
    );
  const lists: ChannelList<"keyword" | "vector" | "activity">[] = [
    { channel: "keyword", ids: byKeyword.map((s) => s.view.id) },
  ];
  const models = match.vectors.map((v) => v.model);
  for (const model of models) {
    const ranked = survivors
      .flatMap((s) => {
        const m = s.vector?.find((v) => v.model === model);
        return m === undefined ? [] : [{ id: s.view.id, similarity: m.similarity }];
      })
      .sort((x, y) => y.similarity - x.similarity || (x.id < y.id ? -1 : 1));
    lists.push({ channel: "vector", ids: ranked.map((r) => r.id), weight: 1 / models.length });
  }
  // Activity only reorders what matched; with no words it orders a listing too.
  const recent =
    prefix === undefined && survivors.length > 0
      ? await recentActivity(
          tx,
          tenantId,
          caller.owner,
          survivors.map((s) => s.view.id),
          tuning.activityDays ?? 30,
        )
      : [];
  if (recent.length > 0) lists.push({ channel: "activity", ids: recent, weight: ACTIVITY_WEIGHT });

  const fused = fuseChannels(lists);
  const survivorOf = new Map(survivors.map((s) => [s.view.id, s]));
  const hits = fused.map((f): Hit => {
    const s = survivorOf.get(f.id) as Survivor;
    const channels: HitExplanation["channels"] = {};
    if (f.ranks.keyword !== undefined && s.keyword !== undefined) {
      channels.keyword = { rank: f.ranks.keyword, fields: s.keyword.fields };
    }
    if (f.ranks.vector !== undefined && s.vector !== undefined) {
      // The best model's place, among those that found it.
      const best = [...s.vector].sort((x, y) => y.similarity - x.similarity)[0];
      if (best !== undefined) {
        channels.vector = { rank: f.ranks.vector, similarity: best.similarity, model: best.model };
      }
    }
    if (f.ranks.activity !== undefined) channels.activity = { rank: f.ranks.activity };
    return { view: s.view, explanation: { id: f.id, score: f.score, channels } };
  });
  return { hits, lowerBound: rows.length > SEARCH_CANDIDATES, plans };
}

/** A card's update time; -Infinity for a title-only view, which doesn't show one. */
const updated = (view: ObjectView) =>
  view.shape === "card" ? view.updatedAt.getTime() : Number.NEGATIVE_INFINITY;

interface KeywordRow {
  id: string;
  readable: boolean;
  /** Matched as a reader who may have the content: with the summary, and without it. */
  kw_content: boolean;
  kw_content_ns: boolean;
  /** Matched as a reader on the title and every tag (no content). */
  kw_reader: boolean;
  /** Matched as a reader on trusted tags only: a metadata-only card's (T-604). */
  kw_trusted: boolean;
  /** Matched as anyone else: the title they are shown, public trusted tags. */
  kw_other: boolean;
  r_content: number;
  r_content_ns: number;
  r_reader: number;
  r_trusted: number;
  r_other: number;
  /** Which fields hold any of the words (for the explanation). */
  f_title: boolean;
  f_tags: boolean;
  f_trusted_tags: boolean;
  f_summary: boolean;
  f_body: boolean;
  f_other_title: boolean;
  f_public_tags: boolean;
}

/**
 * The keyword match that holds for the view the gate gave, with its rank and fields, or null.
 * A reader SQL didn't expect (a pack permit) was matched only as anyone else: that match still
 * counts, since what anyone may be shown tells a reader nothing new.
 */
function keywordFor(
  view: ObjectView,
  row: KeywordRow,
): { rank: number; fields: SearchField[] } | null {
  const reader = view.shape === "card" && view.readable;
  const fields = (list: [boolean, SearchField][]) => list.filter(([on]) => on).map(([, f]) => f);
  if (reader && row.readable) {
    if (!view.metadataOnly) {
      // The content is the caller's to match on; the summary only if the card shows it.
      const withSummary = view.summary !== undefined;
      if (withSummary ? row.kw_content : row.kw_content_ns) {
        return {
          rank: Number(withSummary ? row.r_content : row.r_content_ns),
          fields: fields([
            [row.f_title, "title"],
            [row.f_tags, "tags"],
            [withSummary && row.f_summary, "summary"],
            [row.f_body, "body"],
          ]),
        };
      }
      if (row.kw_reader) {
        return {
          rank: Number(row.r_reader),
          fields: fields([
            [row.f_title, "title"],
            [row.f_tags, "tags"],
          ]),
        };
      }
    } else if (row.kw_trusted) {
      return {
        rank: Number(row.r_trusted),
        fields: fields([
          [row.f_title, "title"],
          [row.f_trusted_tags, "tags"],
        ]),
      };
    }
  }
  if (!row.kw_other) return null;
  return {
    rank: Number(row.r_other),
    fields: fields([
      [row.f_other_title, "title"],
      [row.f_public_tags, "tags"],
    ]),
  };
}

/** Keyword (or listing, or prefix) candidates, SQL's best guess first, at most one past the cap. */
async function keywordCandidates(
  tx: Tx,
  tenantId: string,
  caller: Caller,
  match: Match,
): Promise<KeywordRow[]> {
  const { words, tags, prefix } = match;
  const query = sql`plainto_tsquery('simple', ${words})`;
  // Any of the words, for the explanation's fields (the match itself needs all of them).
  const anyWord = sql`replace(plainto_tsquery('simple', ${words})::text, ' & ', ' | ')::tsquery`;
  // What each view may be matched on; these are the GIN-indexed expressions (migration 0053).
  const readerDoc = sql`(a.title_tsv || a.tags_tsv || a.summary_tsv || a.body_tsv)`;
  const otherDoc = sql`(a.other_title_tsv || a.public_tags_tsv)`;
  const noSummary = sql`(a.title_tsv || a.tags_tsv || a.body_tsv)`;
  const metaDoc = sql`(a.title_tsv || a.tags_tsv)`;
  const trustedDoc = sql`(a.title_tsv || a.trusted_tags_tsv)`;

  let where = sql`true`;
  let text: (doc: SQL, title: SQL) => SQL;
  let rank: (doc: SQL) => SQL;
  let field: (doc: SQL) => SQL;
  if (prefix !== undefined) {
    // A prefix: a word of the title starts with it (a regular expression, ASCII punctuation
    // escaped), in SQL so other matches don't crowd the candidates; checked again after the
    // gate on the title shown. A model's pending display title shows as the generic one, never
    // worth suggesting.
    const startsAt = `(^|[^[:alnum:]])${prefix.replace(ASCII_PUNCTUATION, "\\$&")}`;
    text = (_doc, title) => sql`coalesce(${title} ~* ${startsAt}, false)`;
    rank = () => sql`0::real`;
    field = () => sql`false`;
  } else if (words === "") {
    text = () => sql`true`;
    rank = () => sql`0::real`;
    field = () => sql`false`;
  } else {
    // Only documents holding the words, through the GIN indexes (the same expressions).
    where = sql`((d.title_tsv || d.tags_tsv || d.summary_tsv || d.body_tsv) @@ ${query}
                 or (d.other_title_tsv || d.public_tags_tsv) @@ ${query})`;
    text = (doc) => sql`${doc} @@ ${query}`;
    rank = (doc) => sql`ts_rank(${WEIGHTS}, ${doc}, ${query})`;
    field = (doc) => sql`${doc} @@ ${anyWord}`;
  }
  const realTitle = sql`a.title`;
  const otherTitle = sql`case when a.display_title_by is null then a.title
      when a.display_title_by not like 'user:%' then ${GENERIC_TITLE}
      else coalesce(a.display_title, a.title) end`;
  const suggestedOther = sql`case when a.display_title_by is null then a.title
      when a.display_title_by not like 'user:%' then null
      else coalesce(a.display_title, a.title) end`;
  const all = sql`true`;
  const trusted = sql`(ot.source <> 'model' or ot.reviewed)`;
  const shownToOthers = sql`f.public and (ot.source <> 'model' or ot.reviewed)`;
  const content = sql`(case when a.summary_ok then ${readerDoc} else ${noSummary} end)`;
  return queryRows<KeywordRow>(
    tx,
    sql`with candidates as (${candidates(tenantId, caller, where)}),
        levelled as (${levelled(tenantId, caller, sql`select * from candidates`)}),
        matched as (
          select a.id, a.readable, a.updated_at,
                 (a.content_ok and ${text(content, realTitle)} and ${tagMatch(tenantId, tags, all)}) as kw_content,
                 (a.content_ok and ${text(noSummary, realTitle)} and ${tagMatch(tenantId, tags, all)}) as kw_content_ns,
                 (a.readable and ${text(metaDoc, realTitle)} and ${tagMatch(tenantId, tags, all)}) as kw_reader,
                 (a.readable and ${text(trustedDoc, realTitle)} and ${tagMatch(tenantId, tags, trusted)}) as kw_trusted,
                 (${text(otherDoc, prefix === undefined ? otherTitle : suggestedOther)}
                   and ${tagMatch(tenantId, tags, shownToOthers)}) as kw_other,
                 ${rank(content)} as r_content,
                 ${rank(noSummary)} as r_content_ns,
                 ${rank(metaDoc)} as r_reader,
                 ${rank(trustedDoc)} as r_trusted,
                 ${rank(otherDoc)} as r_other,
                 ${field(sql`a.title_tsv`)} as f_title,
                 ${field(sql`a.tags_tsv`)} as f_tags,
                 ${field(sql`a.trusted_tags_tsv`)} as f_trusted_tags,
                 (a.summary_ok and ${field(sql`a.summary_tsv`)}) as f_summary,
                 (a.content_ok and ${field(sql`a.body_tsv`)}) as f_body,
                 ${field(sql`a.other_title_tsv`)} as f_other_title,
                 ${field(sql`a.public_tags_tsv`)} as f_public_tags
            from levelled a
        )
        select * from matched
         where (readable and (kw_content or kw_reader or kw_trusted)) or kw_other
         order by case when readable and kw_content then r_content
                       when readable and kw_reader then r_reader
                       when readable and kw_trusted then r_trusted
                       else r_other end desc,
                  case when readable then updated_at end desc nulls last, id
         limit ${SEARCH_CANDIDATES + 1}`,
  );
}

/**
 * The nearest files to one query vector, among those whose content SQL expects the caller may
 * have, with spike S1's plan: count the visible vectors of the model (up to the threshold, so
 * the count is bounded); exact at or below it, HNSW with an iterative scan above it.
 */
async function nearest(
  tx: Tx,
  tenantId: string,
  caller: Caller,
  query: QueryVector,
  tags: readonly string[],
  tuning: SearchTuning,
): Promise<{ plan: "exact" | "hnsw"; near: { id: string; similarity: number }[] }> {
  const exactLimit = tuning.exactLimit ?? EXACT_SEARCH_ROWS;
  const neighbours = tuning.neighbours ?? VECTOR_NEIGHBOURS;
  const minSimilarity = tuning.minSimilarity ?? 0.3;
  if (!Number.isSafeInteger(exactLimit) || exactLimit < 0) throw new RangeError("exactLimit");
  if (!Number.isSafeInteger(neighbours) || neighbours < 1 || neighbours > 1_000) {
    throw new RangeError("neighbours is 1 to 1000");
  }
  const dimensions = query.vector.length;
  const literal = `[${query.vector.join(",")}]`;
  // The vectors a caller may be matched on: current versions (the search document's) of files
  // SQL expects them to read, whose exposure reaches the client, carrying the tag filters.
  const eligible = sql`with candidates as (${candidates(tenantId, caller, sql`true`)}),
      levelled as (${levelled(tenantId, caller, sql`select * from candidates where readable`)}),
      eligible as materialized (select a.id, a.version_id from levelled a
                    where a.content_ok and a.version_id is not null
                      and ${tagMatch(tenantId, tags, sql`true`)})`;
  // One statement counts the visible vectors (at most one past the threshold) and, when the
  // count says exact, searches exactly: the eligible set is worked out once. Past the threshold
  // the exact half doesn't run (its condition is false before any row is read).
  const indexed = (INDEXED_DIMENSIONS as readonly number[]).includes(dimensions);
  const counted = await queryRows<{ n: number; id: string | null; distance: number | null }>(
    tx,
    sql`${eligible},
        counted as materialized (
          select count(*)::int as n from (
            select 1 from version_embeddings e
              join eligible x on x.id = e.object_id and x.version_id = e.version_id
             where e.tenant_id = ${tenantId} and e.model = ${query.model}
               and e.dimensions = ${dimensions}
             limit ${exactLimit + 1}) c)
        select c.n, exact.id, exact.distance from counted c
          left join lateral (
            -- No index can serve this ORDER BY: the indexes are on a cast to a fixed size.
            select e.object_id as id, min(e.embedding <=> ${literal}::vector) as distance
              from version_embeddings e
              join eligible x on x.id = e.object_id and x.version_id = e.version_id
             where e.tenant_id = ${tenantId} and e.model = ${query.model}
               and e.dimensions = ${dimensions}
               and ${indexed ? sql`c.n <= ${exactLimit}::bigint` : sql`true`}
             group by e.object_id
             order by distance, id
             limit ${neighbours}) exact on true`,
  );
  const plan = vectorPlanFor(Number(counted[0]?.n ?? 0), dimensions, exactLimit);
  const rows =
    plan === "exact"
      ? counted.flatMap((r) => (r.id === null ? [] : [{ id: r.id, distance: Number(r.distance) }]))
      : await withHnswSettings(tx, () =>
          queryRows<{ id: string; distance: number }>(
            tx,
            hnswSql(eligible, tenantId, query, neighbours),
          ),
        );
  return {
    plan,
    near: rows
      .map((r) => ({ id: r.id, similarity: 1 - Number(r.distance) }))
      .filter((r) => Number.isFinite(r.similarity) && r.similarity >= minSimilarity),
  };
}

/**
 * The HNSW query (exported for the plan tests): the model's partial index, by the same cast and
 * predicate as its definition (migration 0053; the size is from INDEXED_DIMENSIONS, never from
 * input), the filter kept a subplan (OFFSET 0) so the index scan checks each row it yields;
 * more rows than files, since a file has several chunks, re-sorted because relaxed order may
 * return near neighbours slightly out of order.
 */
export function hnswSql(
  eligible: SQL,
  tenantId: string,
  query: QueryVector,
  neighbours: number,
): SQL {
  const dimensions = query.vector.length;
  if (!(INDEXED_DIMENSIONS as readonly number[]).includes(dimensions)) {
    throw new RangeError("no HNSW index for this size");
  }
  const cast = sql.raw(`vector(${dimensions})`);
  const literal = `[${query.vector.join(",")}]`;
  const distance = sql`e.embedding::${cast} <=> ${literal}::${cast}`;
  return sql`${eligible},
      near as materialized (
        select e.object_id, ${distance} as distance
          from version_embeddings e
         where e.tenant_id = ${tenantId} and e.model = ${query.model}
           and e.dimensions = ${sql.raw(String(dimensions))}
           and e.version_id in (select version_id from eligible offset 0)
         order by ${distance}
         limit ${neighbours * 4})
      select object_id as id, min(distance) as distance from near
       group by object_id
       order by distance, id
       limit ${neighbours}`;
}

/**
 * Runs `work` with spike S1's HNSW settings, local to the transaction, and puts the previous
 * values back after, so nothing else in the caller's transaction runs with them.
 */
export async function withHnswSettings<T>(tx: Tx, work: () => Promise<T>): Promise<T> {
  const [before] = await queryRows<{ ef: string | null; scan: string | null }>(
    tx,
    sql`select current_setting('hnsw.ef_search', true) as ef,
               current_setting('hnsw.iterative_scan', true) as scan`,
  );
  await queryRows(
    tx,
    sql`select set_config('hnsw.ef_search', ${String(HNSW_EF_SEARCH)}, true),
               set_config('hnsw.iterative_scan', ${HNSW_ITERATIVE_SCAN}, true)`,
  );
  try {
    return await work();
  } finally {
    // pgvector's own defaults when nothing was set before (the library may load only now).
    await queryRows(
      tx,
      sql`select set_config('hnsw.ef_search', ${before?.ef || "40"}, true),
                 set_config('hnsw.iterative_scan', ${before?.scan || "off"}, true)`,
    );
  }
}

/** The caller's own views, opens and edits of these files lately, most recent first. */
async function recentActivity(
  tx: Tx,
  tenantId: string,
  actor: string,
  ids: readonly string[],
  days: number,
): Promise<string[]> {
  if (!Number.isSafeInteger(days) || days < 1 || days > 400) throw new RangeError("activityDays");
  const rows = await queryRows<{ id: string }>(
    tx,
    sql`select e.object_id as id from activity_events e
         where e.tenant_id = ${tenantId} and e.actor = ${actor}
           and e.type in ('view', 'open', 'edit')
           and e.at > now() - make_interval(days => ${days})
           and e.object_id = any(${array(ids)})
         group by e.object_id
         order by max(e.at) desc, e.object_id`,
  );
  return rows.map((r) => r.id);
}

/**
 * Snippets for hits whose keyword match was on the extracted text (the caller is a reader whose
 * card isn't metadata-only, or `body` wouldn't be among its fields): ts_headline() over the
 * current version's text, with private-use characters marking the words, turned into plain text
 * and offsets here. Control characters become spaces; nothing is markup.
 */
async function snippetsFor(
  tx: Tx,
  tenantId: string,
  words: string,
  hits: readonly Hit[],
): Promise<Map<string, Snippet>> {
  const out = new Map<string, Snippet>();
  if (hits.length === 0) return out;
  const options = `StartSel=${START}, StopSel=${STOP}, MaxWords=24, MinWords=8, MaxFragments=2, FragmentDelimiter=" … "`;
  const rows = await queryRows<{ id: string; headline: string }>(
    tx,
    sql`select d.object_id as id,
               ts_headline('simple',
                 translate(left(x.text, 200000), ${START + STOP}, '  '),
                 plainto_tsquery('simple', ${words}), ${options}) as headline
          from search_documents d
          join version_extracts x on x.tenant_id = d.tenant_id and x.version_id = d.version_id
         where d.tenant_id = ${tenantId} and x.status = 'extracted'
           and d.object_id = any(${array(hits.map((h) => h.view.id))})`,
  );
  for (const row of rows) out.set(row.id, toSnippet(row.headline));
  return out;
}

/** Headline text with START/STOP marks → plain text and highlight offsets, capped. */
export function toSnippet(headline: string): Snippet {
  let text = "";
  const highlights: [number, number][] = [];
  let open = -1;
  let space = false;
  for (const ch of headline) {
    if (text.length >= SNIPPET_MAX) break;
    if (ch === START) {
      open = text.length;
      continue;
    }
    if (ch === STOP) {
      if (open >= 0 && text.length > open) highlights.push([open, text.length]);
      open = -1;
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    // Control characters and any whitespace run become one space.
    const blank = code < 0x20 || (code >= 0x7f && code < 0xa0) || /\s/u.test(ch);
    if (blank) {
      if (!space && text.length > 0) text += " ";
      space = true;
      continue;
    }
    space = false;
    text += ch;
  }
  if (open >= 0 && text.length > open) highlights.push([open, text.length]);
  return { text: text.trimEnd(), highlights };
}

/**
 * The effective visibility or exposure of candidate `a.id` as a rank, as visibility.ts
 * collectLevels() and core/policy resolveLevels() work it out: the lowest while the current
 * version is unprocessed (hidden, metadata-only); otherwise the most restrictive trusted level
 * tag (approved, and not an unreviewed model guess), or the tenant default without one; then
 * tightened by any untrusted level tag or pending review item. An unknown level counts as the
 * most restrictive. Visibility: hidden 0, discoverable 1, readable 2. Exposure: metadata-only
 * 0, local-only 1, commercial-only 2, full 3.
 */
function effectiveLevel(tenantId: string, kind: "visibility" | "exposure"): SQL {
  const column = sql.raw(kind === "visibility" ? "fv.visibility" : "fv.exposure");
  const fallback = sql.raw(kind === "visibility" ? "d.default_visibility" : "d.default_exposure");
  const top = kind === "visibility" ? 2 : 3;
  const rank = (c: SQL) =>
    kind === "visibility"
      ? sql`(case ${c} when 'readable' then 2 when 'discoverable' then 1 else 0 end)`
      : sql`(case ${c} when 'full' then 3 when 'commercial-only' then 2 when 'local-only' then 1 else 0 end)`;
  // Level tags on the candidate, from object_tags or open review items (both aliased `x`).
  const levelled = (from: SQL, where: SQL) =>
    sql`select ${rank(column)} as r from ${from}
          join facet_values fv
            on fv.tenant_id = x.tenant_id and fv.facet = x.facet and fv.value = x.value
         where x.tenant_id = ${tenantId} and x.object_id = a.id
           and ${column} is not null and ${where}`;
  const trusted = sql`(fv.approved and (x.source <> 'model' or x.reviewed))`;
  const processed = sql`coalesce((
      select v.processed_at is not null from versions v
       where v.tenant_id = ${tenantId} and v.object_id = a.id
       order by v.seq desc limit 1), false)`;
  const byDefault = sql`(select ${rank(fallback)} from tenants d where d.id = ${tenantId})`;
  return sql`(case when not ${processed} then 0 else least(
      coalesce((select min(t.r) from (${levelled(sql`object_tags x`, trusted)}) t), ${byDefault}),
      coalesce((select min(u.r) from (
          ${levelled(sql`object_tags x`, sql`not ${trusted}`)}
          union all
          ${levelled(sql`tag_reviews x`, sql`x.resolved_at is null and x.reason <> 'primary'`)}
        ) u), ${top}))
    end)`;
}
