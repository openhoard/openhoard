import { Random } from "../random.js";
import { AccessModel } from "../tenant/access.js";
import type { FakeItem, FakeTenant } from "../tenant/types.js";
import type { Caller, Leak, LeakReport, SearchResponse, SearchUnderTest } from "./types.js";

export interface LeakHarnessOptions {
  tenant: FakeTenant;
  target: SearchUnderTest;
  /**
   * Users to probe as. Default: a deterministic sample of `sampleUsers` active users that
   * always includes a guest, so external accounts are covered.
   */
  users?: readonly string[];
  /** Size of the default user sample. Default 12. */
  sampleUsers?: number;
  /** Extra free-text queries to scan, on top of every canary token. */
  queries?: readonly string[];
}

/** Queries every user runs besides the canary tokens: broad words that match many files. */
export const DEFAULT_QUERIES = ["canary", "invoice", "contract", "sensitivity:restricted"];

/**
 * Permission-leak harness (T-018). For every probe user it:
 *
 * 1. searches every canary token and checks that a user who may not read the canary's file
 *    gets no hit, a zero total, zero facet counts, and no trace of the token anywhere;
 * 2. runs broad queries and checks every hit is readable and no forbidden token appears;
 * 3. asks for autocomplete on canary prefixes and checks no suggestion carries a forbidden
 *    token.
 *
 * Canary tokens are unique to one restricted file, so ANY appearance of a forbidden token in
 * a response, or any non-zero count for it, is a leak by construction. No knowledge of the
 * engine's ranking or matching rules is needed.
 */
export async function runLeakHarness(options: LeakHarnessOptions): Promise<LeakReport> {
  const { tenant, target } = options;
  const access = new AccessModel(tenant);
  const canaries = tenant.items.filter((i): i is FakeItem & { canary: string } => !!i.canary);
  const users = options.users ?? sampleUsers(tenant, options.sampleUsers ?? 12);
  const queries = [...DEFAULT_QUERIES, ...(options.queries ?? [])];
  const byId = new Map(tenant.items.map((i) => [i.id, i]));
  const leaks: Leak[] = [];
  let probes = 0;

  for (const userId of users) {
    const caller: Caller = { userId, principals: access.principalsOf(userId) };
    const forbidden = new Map(
      canaries.filter((c) => !access.canRead(userId, c)).map((c) => [c.canary, c]),
    );

    const inspect = (probe: string, response: SearchResponse, target?: FakeItem) => {
      for (const hit of response.hits) {
        const item = byId.get(hit.id);
        if (!item || !access.canRead(userId, item)) {
          leaks.push({
            userId,
            probe,
            surface: "results",
            itemId: hit.id,
            detail: "hit the caller may not read",
          });
        }
      }
      if (target && !access.canRead(userId, target)) {
        if (response.total > 0) {
          leaks.push({
            userId,
            probe,
            surface: "total",
            itemId: target.id,
            detail: `total ${response.total}, expected 0`,
          });
        }
        const facetSum = Object.values(response.facets ?? {})
          .flatMap((f) => Object.values(f))
          .reduce((a, b) => a + b, 0);
        if (facetSum > 0) {
          leaks.push({
            userId,
            probe,
            surface: "facets",
            itemId: target.id,
            detail: `facet counts sum to ${facetSum}, expected 0`,
          });
        }
      }
      scanText(
        JSON.stringify({ hits: response.hits, facets: response.facets ?? {} }),
        forbidden,
        (item, token) =>
          leaks.push({
            userId,
            probe,
            surface: "text",
            itemId: item.id,
            detail: `response contains ${token}`,
          }),
      );
    };

    for (const canary of canaries) {
      probes++;
      inspect(canary.canary, await target.search({ ...caller, query: canary.canary }), canary);
    }
    for (const query of queries) {
      probes++;
      inspect(query, await target.search({ ...caller, query, limit: 100 }));
    }
    if (target.autocomplete) {
      const prefixes = new Set([
        "canary",
        ...canaries.map((c) => c.canary.slice(0, "canary-".length + 2)),
      ]);
      for (const prefix of prefixes) {
        probes++;
        const suggestions = await target.autocomplete({ ...caller, prefix, limit: 50 });
        scanText(suggestions.join("\n"), forbidden, (item, token) =>
          leaks.push({
            userId,
            probe: prefix,
            surface: "autocomplete",
            itemId: item.id,
            detail: `suggestion contains ${token}`,
          }),
        );
      }
    }
  }
  return { probes, users: users.length, canaries: canaries.length, leaks };
}

/**
 * Checks one pair: everything `ownerId` can read that `otherId` cannot must stay invisible to
 * `otherId`. Use it to pin a regression found for a specific pair of accounts.
 */
export async function checkPair(
  tenant: FakeTenant,
  target: SearchUnderTest,
  ownerId: string,
  otherId: string,
): Promise<Leak[]> {
  const report = await runLeakHarness({ tenant, target, users: [otherId], queries: [] });
  const access = new AccessModel(tenant);
  const owned = new Set(tenant.items.filter((i) => access.canRead(ownerId, i)).map((i) => i.id));
  return report.leaks.filter((l) => owned.has(l.itemId));
}

/** Throws a readable error listing the first leaks, for use in tests. */
export function assertNoLeaks(report: LeakReport): void {
  if (report.leaks.length === 0) return;
  const lines = report.leaks
    .slice(0, 10)
    .map(
      (l) => `  ${l.surface}: user ${l.userId}, probe "${l.probe}", item ${l.itemId}: ${l.detail}`,
    );
  const more = report.leaks.length > 10 ? `\n  …and ${report.leaks.length - 10} more` : "";
  throw new Error(
    `${report.leaks.length} permission leak(s) in ${report.probes} probes:\n${lines.join("\n")}${more}`,
  );
}

function sampleUsers(tenant: FakeTenant, count: number): string[] {
  const active = tenant.users.filter((u) => u.active);
  const rng = new Random(`${tenant.seed}:leak-users`);
  const guest = active.find((u) => u.guest);
  const others = rng.sample(
    active.filter((u) => u !== guest),
    Math.max(0, count - (guest ? 1 : 0)),
  );
  return [...(guest ? [guest] : []), ...others].map((u) => u.id);
}

function scanText(
  text: string,
  forbidden: ReadonlyMap<string, FakeItem>,
  report: (item: FakeItem, token: string) => void,
): void {
  if (!text.includes("canary-")) return;
  for (const [token, item] of forbidden) if (text.includes(token)) report(item, token);
}
