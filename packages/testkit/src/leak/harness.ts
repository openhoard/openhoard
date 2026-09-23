import { Random } from "../random.js";
import { AccessModel } from "../tenant/access.js";
import type { FakeItem, FakeTenant } from "../tenant/types.js";
import type { Caller, Leak, LeakReport, SearchResponse, SearchUnderTest } from "./types.js";

export interface LeakHarnessOptions {
  tenant: FakeTenant;
  target: SearchUnderTest;
  /**
   * Active users to probe as. Default: a deterministic sample of `sampleUsers` active users that
   * always includes a guest, so external accounts are covered. People who have left cannot sign
   * in, so probing as them is refused.
   */
  users?: readonly string[];
  /** Size of the default user sample. Default 12. */
  sampleUsers?: number;
  /** Extra free-text queries to scan, on top of every canary token. */
  queries?: readonly string[];
}

/** Queries every user runs besides the canary tokens: broad words that match many files. */
export const DEFAULT_QUERIES = ["canary", "invoice", "contract", "sensitivity:restricted"];

type Canary = FakeItem & { canary: string };

/**
 * Permission-leak harness (T-018). For every probe user it:
 *
 * 1. searches every canary token. A caller who may not read the canary's file must get no hit
 *    for it and no trace of the token, and the total and facet counts must be no higher than
 *    for a CONTROL token of the same shape that was never planted. (The control makes the
 *    check fair to engines that match loosely, such as OR or vector search: whatever they
 *    return for a random token is the floor, and a forbidden file may not add to it.)
 * 2. runs broad queries and checks every hit is readable and no forbidden token appears;
 * 3. asks for autocomplete on canary prefixes and checks no suggestion carries a forbidden
 *    token.
 *
 * It also counts canaries the caller CAN read but the engine did not return. If an engine
 * finds none at all, the integration is probably broken (for example, principals in the wrong
 * format filter out everything), and a "no leaks" result would mean nothing;
 * {@link assertNoLeaks} fails in that case.
 */
export async function runLeakHarness(options: LeakHarnessOptions): Promise<LeakReport> {
  const { tenant, target } = options;
  const access = new AccessModel(tenant);
  const canaries = tenant.items.filter((i): i is Canary => !!i.canary);
  const users = options.users ?? sampleUsers(tenant, options.sampleUsers ?? 12);
  for (const id of users) {
    const user = tenant.users.find((u) => u.id === id);
    if (!user) throw new RangeError(`unknown user ${id}`);
    if (!user.active)
      throw new RangeError(`user ${id} has left and cannot sign in; probe active users only`);
  }
  const queries = [...DEFAULT_QUERIES, ...(options.queries ?? [])];
  const byId = new Map(tenant.items.map((i) => [i.id, i]));
  const controls = controlTokens(tenant, canaries);
  const leaks: Leak[] = [];
  let probes = 0;
  let readableCanaryProbes = 0;
  let found = 0;

  for (const userId of users) {
    const caller: Caller = { userId, principals: access.principalsOf(userId) };
    const forbidden = new Map(
      canaries.filter((c) => !access.canRead(userId, c)).map((c) => [c.canary, c]),
    );
    const leak = (probe: string, surface: Leak["surface"], itemId: string, detail: string) =>
      leaks.push({ userId, probe, surface, itemId, detail });

    const inspect = (probe: string, response: SearchResponse) => {
      for (const hit of response.hits) {
        const item = byId.get(hit.id);
        if (!item || !access.canRead(userId, item))
          leak(probe, "results", hit.id, "hit the caller may not read");
      }
      scanText(
        JSON.stringify({ hits: response.hits, facets: response.facets ?? {} }),
        forbidden,
        (item, token) => leak(probe, "text", item.id, `response contains ${token}`),
      );
    };

    for (const canary of canaries) {
      probes++;
      const response = await target.search({ ...caller, query: canary.canary });
      inspect(canary.canary, response);
      if (access.canRead(userId, canary)) {
        readableCanaryProbes++;
        if (response.hits.some((h) => h.id === canary.id)) found++;
        continue;
      }
      probes++;
      const control = await target.search({ ...caller, query: controls.get(canary.id) as string });
      if (response.total > control.total) {
        leak(
          canary.canary,
          "total",
          canary.id,
          `total ${response.total}, but ${control.total} for a never-planted token`,
        );
      }
      const sum = facetSum(response);
      const controlSum = facetSum(control);
      if (sum > controlSum) {
        leak(
          canary.canary,
          "facets",
          canary.id,
          `facet counts sum to ${sum}, but ${controlSum} for a never-planted token`,
        );
      }
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
          leak(prefix, "autocomplete", item.id, `suggestion contains ${token}`),
        );
      }
    }
  }
  return {
    probes,
    users: users.length,
    canaries: canaries.length,
    readableCanaryProbes,
    found,
    leaks,
  };
}

/**
 * Leaks of `ownerId`'s canary files to `otherId`: every restricted canary the owner can read
 * but the other user cannot must stay invisible to the other user. Use it to pin a regression
 * found for a specific pair of accounts.
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

/**
 * Throws a readable error listing the first leaks, for use in tests. Also throws when the
 * engine returned none of the canaries the callers could read: an engine that returns nothing
 * can't leak, but it isn't working either.
 */
export function assertNoLeaks(report: LeakReport): void {
  if (report.readableCanaryProbes > 0 && report.found === 0) {
    throw new Error(
      `the engine returned none of the ${report.readableCanaryProbes} canaries the callers may read; ` +
        "check the principal format and the index before trusting a leak-free result",
    );
  }
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

/** A never-planted `canary-xxxxxxxx` token per canary, deterministic for the tenant. */
function controlTokens(tenant: FakeTenant, canaries: readonly Canary[]): Map<string, string> {
  const planted = new Set(canaries.map((c) => c.canary));
  const rng = new Random(`${tenant.seed}:leak-controls`);
  const out = new Map<string, string>();
  for (const c of canaries) {
    let token: string;
    do token = `canary-${Array.from({ length: 8 }, () => rng.int(0, 15).toString(16)).join("")}`;
    while (planted.has(token));
    out.set(c.id, token);
  }
  return out;
}

function facetSum(response: SearchResponse): number {
  return Object.values(response.facets ?? {})
    .flatMap((f) => Object.values(f))
    .reduce((a, b) => a + b, 0);
}

function scanText(
  text: string,
  forbidden: ReadonlyMap<string, FakeItem>,
  report: (item: FakeItem, token: string) => void,
): void {
  if (!text.includes("canary-")) return;
  for (const [token, item] of forbidden) if (text.includes(token)) report(item, token);
}
