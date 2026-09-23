/**
 * The search surface a permission-leak test drives. Everything a caller can observe is here:
 * results, the total count, facet counts, autocomplete and any card text. A leak through ANY
 * of them is a leak (threat model: "counts/facets/suggestions only over visible set").
 */
export interface SearchUnderTest {
  search(request: SearchRequest): Promise<SearchResponse>;
  /** Optional: title suggestions for a prefix. */
  autocomplete?(request: AutocompleteRequest): Promise<string[]>;
}

export interface Caller {
  userId: string;
  /** The caller's principal set, e.g. `["user:u-1", "group:g-hr"]`. */
  principals: readonly string[];
}

export interface SearchRequest extends Caller {
  query: string;
  limit?: number;
}

export interface AutocompleteRequest extends Caller {
  prefix: string;
  limit?: number;
}

export interface SearchHit {
  id: string;
  title?: string;
  /** Any card fields returned with the hit (summary, tags, owner...). All are scanned. */
  card?: Record<string, unknown>;
}

export interface SearchResponse {
  hits: SearchHit[];
  /** Total matches the caller is told about ("1,204 results"). */
  total: number;
  /** Facet counts: facet key → value → count. */
  facets?: Record<string, Record<string, number>>;
}

export type LeakSurface = "results" | "total" | "facets" | "autocomplete" | "text";

export interface Leak {
  userId: string;
  /** The query or prefix that exposed it. */
  probe: string;
  surface: LeakSurface;
  /** The item whose existence or content leaked. */
  itemId: string;
  detail: string;
}

export interface LeakReport {
  /** Probes sent (searches, control searches and autocompletes). */
  probes: number;
  users: number;
  canaries: number;
  /** Canary searches by a caller who may read that canary's file. */
  readableCanaryProbes: number;
  /** How many of those returned the file. Zero suggests a broken integration. */
  found: number;
  leaks: Leak[];
}
