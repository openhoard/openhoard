import type { FakeItem, FakeTenant } from "../tenant/types.js";
import type {
  AutocompleteRequest,
  SearchHit,
  SearchRequest,
  SearchResponse,
  SearchUnderTest,
} from "./types.js";

const FACETS = ["client", "type", "sensitivity", "department"] as const;
const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}:-]*/gu;

/** Lower-cased search tokens. `client:acme` and `canary-1a2b3c4d` stay whole. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(TOKEN) ?? [];
}

/**
 * A small, CORRECT in-memory search over a fake tenant: the reference the leak harness and the
 * benchmarks compare real engines against. It applies the access filter before matching,
 * counting, faceting or suggesting, exactly as the architecture requires, so nothing about an
 * invisible item can influence any part of a response.
 *
 * Matching is AND over tokens from the item's name, labels and canary.
 */
export class InMemorySearch implements SearchUnderTest {
  private readonly postings = new Map<string, number[]>();
  private readonly items: FakeItem[];
  private readonly visibleTo: ReadonlySet<string>[];

  constructor(tenant: FakeTenant) {
    this.items = tenant.items.filter((i) => i.kind === "file");
    this.visibleTo = this.items.map(
      // A sharing link is not a principal: it never makes a file findable.
      (i) => new Set(i.acl.map((a) => a.principal).filter((p) => p !== "anyone-with-link")),
    );
    this.items.forEach((item, n) => {
      const text = [item.name, ...item.labels, item.canary ?? ""].join(" ");
      for (const token of new Set(tokenize(text))) {
        const list = this.postings.get(token);
        if (list) list.push(n);
        else this.postings.set(token, [n]);
      }
    });
  }

  search(request: SearchRequest): Promise<SearchResponse> {
    const matches = this.visibleMatches(request.principals, tokenize(request.query));
    const facets: Record<string, Record<string, number>> = Object.create(null);
    for (const n of matches) {
      for (const label of (this.items[n] as FakeItem).labels) {
        const [key, value] = splitLabel(label);
        if (!value || !(FACETS as readonly string[]).includes(key)) continue;
        const bucket: Record<string, number> = (facets[key] ??= Object.create(null));
        bucket[value] = (bucket[value] ?? 0) + 1;
      }
    }
    const hits: SearchHit[] = matches.slice(0, request.limit ?? 20).map((n) => {
      const item = this.items[n] as FakeItem;
      return { id: item.id, title: item.name, card: { tags: item.labels, path: item.path } };
    });
    return Promise.resolve({ hits, total: matches.length, facets });
  }

  autocomplete(request: AutocompleteRequest): Promise<string[]> {
    const prefix = request.prefix.toLowerCase();
    if (!prefix) return Promise.resolve([]);
    const seen = new Set<string>();
    const principals = new Set(request.principals);
    for (let n = 0; n < this.items.length && seen.size < (request.limit ?? 10); n++) {
      if (!this.canSee(n, principals)) continue;
      const title = (this.items[n] as FakeItem).name;
      if (tokenize(title).some((t) => t.startsWith(prefix))) seen.add(title);
    }
    return Promise.resolve([...seen]);
  }

  /** Indexes of visible items matching every token, in tenant order. */
  private visibleMatches(principals: readonly string[], tokens: string[]): number[] {
    if (tokens.length === 0) return [];
    const lists = tokens.map((t) => this.postings.get(t) ?? []).sort((a, b) => a.length - b.length);
    const rest = lists.slice(1).map((l) => new Set(l));
    const caller = new Set(principals);
    return (lists[0] ?? []).filter((n) => rest.every((s) => s.has(n)) && this.canSee(n, caller));
  }

  private canSee(n: number, principals: ReadonlySet<string>): boolean {
    for (const p of this.visibleTo[n] ?? []) if (principals.has(p)) return true;
    return false;
  }
}

function splitLabel(label: string): [string, string | undefined] {
  const at = label.indexOf(":");
  return at === -1 ? [label, undefined] : [label.slice(0, at), label.slice(at + 1)];
}
