import { beforeAll, describe, expect, it } from "vitest";
import {
  AccessModel,
  assertNoLeaks,
  checkPair,
  generateTenant,
  InMemorySearch,
  runLeakHarness,
  tokenize,
  type FakeTenant,
  type SearchRequest,
  type SearchUnderTest,
} from "../index.js";

let tenant: FakeTenant;
let reference: InMemorySearch;
/** Every principal in the tenant: a caller with these sees everything (used to build leaks). */
let god: string[];

beforeAll(() => {
  tenant = generateTenant({ items: 3000 });
  reference = new InMemorySearch(tenant);
  god = [...new Set(tenant.items.flatMap((i) => i.acl.map((a) => a.principal)))];
});

const asGod = (r: SearchRequest): SearchRequest => ({ ...r, principals: god });

/** Deliberately broken engines, each leaking through one surface. */
const leaky: Record<string, () => SearchUnderTest> = {
  // Counts before filtering: "3 results" for a file you can't see.
  total: () => ({
    search: async (r) => ({
      ...(await reference.search(r)),
      total: (await reference.search(asGod(r))).total,
    }),
  }),
  // Facets over all matches.
  facets: () => ({
    search: async (r) => ({
      ...(await reference.search(r)),
      facets: (await reference.search(asGod(r))).facets ?? {},
    }),
  }),
  // Filters AFTER taking the top k, and returns unfiltered hits.
  results: () => ({ search: (r) => reference.search(asGod(r)) }),
  // Suggests titles from the whole index.
  autocomplete: () => ({
    search: (r) => reference.search(r),
    autocomplete: (r) => reference.autocomplete({ ...r, principals: god }),
  }),
  // Leaks another file's canary into a card: e.g. a summary built from the wrong file.
  text: () => ({
    search: async (r) => {
      const res = await reference.search(r);
      const secret = tenant.items.find(
        (i) => i.canary && !new AccessModel(tenant).canRead(r.userId, i),
      );
      const [first, ...rest] = res.hits;
      return first
        ? { ...res, hits: [{ ...first, card: { summary: `see also ${secret?.canary}` } }, ...rest] }
        : res;
    },
  }),
};

describe("runLeakHarness", () => {
  it("finds no leaks in the reference search", async () => {
    const report = await runLeakHarness({ tenant, target: reference });
    expect(report.users).toBe(12);
    expect(report.canaries).toBeGreaterThan(10);
    expect(report.probes).toBeGreaterThan(report.users * report.canaries);
    assertNoLeaks(report);
  });

  it.each(Object.keys(leaky))("catches an engine that leaks through %s", async (surface) => {
    const make = leaky[surface];
    if (!make) throw new Error("unknown surface");
    const report = await runLeakHarness({ tenant, target: make() });
    expect(report.leaks.length).toBeGreaterThan(0);
    expect(report.leaks.some((l) => l.surface === surface)).toBe(true);
    expect(() => assertNoLeaks(report)).toThrow(/permission leak/);
  });

  it("does not blame an engine that also returns loosely related, readable results", async () => {
    // Like vector or OR search: every query also returns the caller's best "invoice" matches.
    const loose: SearchUnderTest = {
      search: async (r) => {
        const exact = await reference.search(r);
        const fallback = await reference.search({ ...r, query: "invoice" });
        return {
          hits: [...exact.hits, ...fallback.hits],
          total: exact.total + fallback.total,
          facets: fallback.facets ?? {},
        };
      },
    };
    assertNoLeaks(await runLeakHarness({ tenant, target: loose }));
  });

  it("refuses to call an engine that finds nothing leak-free", async () => {
    const empty: SearchUnderTest = { search: () => Promise.resolve({ hits: [], total: 0 }) };
    const report = await runLeakHarness({ tenant, target: empty });
    expect(report.leaks).toEqual([]);
    expect(report.found).toBe(0);
    expect(() => assertNoLeaks(report)).toThrow(/returned none of the/);
  });

  it("refuses to probe as someone who has left, or an unknown user", async () => {
    const departed = tenant.users.find((u) => !u.active);
    if (!departed) throw new Error("fixture");
    await expect(
      runLeakHarness({ tenant, target: reference, users: [departed.id] }),
    ).rejects.toThrow(/has left/);
    await expect(runLeakHarness({ tenant, target: reference, users: ["u-nope"] })).rejects.toThrow(
      /unknown user/,
    );
  });

  it("probes a guest account by default", async () => {
    const seen: string[] = [];
    const spy: SearchUnderTest = {
      search: (r) => {
        seen.push(r.userId);
        return reference.search(r);
      },
    };
    await runLeakHarness({ tenant, target: spy, sampleUsers: 3 });
    const guests = new Set(tenant.users.filter((u) => u.guest).map((u) => u.id));
    expect(seen.some((id) => guests.has(id))).toBe(true);
  });
});

describe("content canaries (T-501..T-503)", () => {
  /** Content tokens on the first 30 files; the even ones are "metadata only" to the caller. */
  const planted = () =>
    tenant.items
      .filter((i) => i.kind === "file")
      .slice(0, 30)
      .map((item, n) => ({ itemId: item.id, token: `secret-${(n + 0x10000000).toString(16)}` }));
  const metadataOnly = (itemId: string) =>
    planted().findIndex((c) => c.itemId === itemId) % 2 === 0;
  const visible = (userId: string, item: { id: string }) =>
    new AccessModel(tenant).canRead(userId, tenant.items.find((i) => i.id === item.id) as never) &&
    !metadataOnly(item.id);
  /** The reference, plus content tokens matched for whoever `allowed` lets. */
  const withContent = (allowed: (userId: string, itemId: string) => boolean): SearchUnderTest => ({
    search: async (r) => {
      const c = planted().find((p) => p.token === r.query);
      if (!c) return reference.search(r);
      const hit = allowed(r.userId, c.itemId) ? [{ id: c.itemId }] : [];
      return { hits: hit, total: hit.length, facets: {} };
    },
  });

  it("passes an engine that matches content only for callers who may have it", async () => {
    const report = await runLeakHarness({
      tenant,
      target: withContent((u, id) => visible(u, { id })),
      contentCanaries: planted(),
      contentVisible: visible,
    });
    assertNoLeaks(report);
    expect(report.readableContentProbes).toBeGreaterThan(0);
    expect(report.contentFound).toBe(report.readableContentProbes);
  });

  it("catches an engine that matches a metadata-only card on its content", async () => {
    const access = new AccessModel(tenant);
    const report = await runLeakHarness({
      tenant,
      target: withContent((u, id) =>
        access.canRead(u, tenant.items.find((i) => i.id === id) as never),
      ),
      contentCanaries: planted(),
      contentVisible: visible,
    });
    expect(report.leaks.some((l) => l.surface === "results")).toBe(true);
    expect(report.leaks.some((l) => l.surface === "total")).toBe(true);
    expect(() => assertNoLeaks(report)).toThrow(/permission leak/);
  });

  it("refuses an engine that matches no content at all", async () => {
    const report = await runLeakHarness({
      tenant,
      target: reference,
      contentCanaries: planted(),
      contentVisible: visible,
    });
    expect(report.contentFound).toBe(0);
    expect(() => assertNoLeaks(report)).toThrow(/none of the .* content tokens/);
    await expect(
      runLeakHarness({
        tenant,
        target: reference,
        contentCanaries: [{ itemId: "nope", token: "x" }],
      }),
    ).rejects.toThrow(/unknown item/);
  });
});

describe("checkPair", () => {
  it("reports only leaks of the owner's files to the other user", async () => {
    const access = new AccessModel(tenant);
    const canary = tenant.items.find((i) => i.canary);
    if (!canary) throw new Error("no canary");
    const owner = [...access.readersOf(canary)][0];
    const other = tenant.users.find((u) => u.active && !access.canRead(u.id, canary));
    if (!owner || !other) throw new Error("fixture missing");
    expect(await checkPair(tenant, reference, owner, other.id)).toEqual([]);
    const leaks = await checkPair(tenant, leaky.total?.() ?? reference, owner, other.id);
    expect(leaks.some((l) => l.itemId === canary.id)).toBe(true);
  });
});

describe("InMemorySearch", () => {
  it("matches all tokens, counts and facets only visible files", async () => {
    const hr = tenant.users.find((u) => u.active && u.department === "HR");
    if (!hr) throw new Error("no HR user");
    const access = new AccessModel(tenant);
    const res = await reference.search({
      userId: hr.id,
      principals: access.principalsOf(hr.id),
      query: "sensitivity:restricted",
    });
    const expected = tenant.items.filter(
      (i) =>
        i.kind === "file" &&
        i.labels.includes("sensitivity:restricted") &&
        access.canRead(hr.id, i),
    );
    expect(res.total).toBe(expected.length);
    expect(res.facets?.sensitivity?.restricted).toBe(expected.length);
    expect((await reference.search({ userId: hr.id, principals: [], query: "" })).total).toBe(0);
  });

  it("suggests only visible titles and nothing for an empty prefix", async () => {
    expect(
      await reference.autocomplete({ userId: "x", principals: [], prefix: "invoice" }),
    ).toEqual([]);
    expect(await reference.autocomplete({ userId: "x", principals: god, prefix: "" })).toEqual([]);
    expect(
      (await reference.autocomplete({ userId: "x", principals: god, prefix: "invoice" })).length,
    ).toBeGreaterThan(0);
  });

  it("tokenizes labels and canaries as whole tokens", () => {
    expect(tokenize("Acme Invoice client:acme canary-1a2b")).toEqual([
      "acme",
      "invoice",
      "client:acme",
      "canary-1a2b",
    ]);
  });
});
