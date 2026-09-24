import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  facets,
  facetValues,
  queryRows,
  tenantPacks,
  tenants,
  type Database,
  type Tx,
} from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { createCedarEngine } from "@openhoard/core-policy";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPLY_TRANSACTION,
  applyPack,
  canonicalJson,
  compareVersions,
  packPolicies,
  parsePack,
  planPack,
  planPackRemoval,
  removePack,
  runPackTests,
  tenantPolicies,
  tenantRules,
  validatePack,
  zoneLiterals,
  type Pack,
  type PackFacet,
} from "./packs.js";

// Counts engines built, to check a plan builds one.
vi.mock("@openhoard/core-policy", async (original) => {
  const m = await original<typeof import("@openhoard/core-policy")>();
  return { ...m, createCedarEngine: vi.fn(m.createCedarEngine) };
});
import { evaluateRules } from "./rules.js";

/* T-607: a pack applies only with a reviewed diff, and only when its tests pass. */

const STARTER = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../packs/general-business/pack.json", import.meta.url)),
    "utf8",
  ),
) as Pack;

let db: Database;
let t: SeededTenant;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
});
afterEach(() => db?.close());

const inTenant = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work);
const plan = (pack: unknown) => inTenant((tx) => planPack(tx, t.tenantId, pack));
const apply = (pack: unknown, planHash: string) =>
  db.withTenant(
    t.tenantId,
    (tx) => applyPack(tx, t.tenantId, pack, { planHash, by: "user:admin" }),
    APPLY_TRANSACTION,
  );
const small = (patch: Partial<Pack> = {}): Pack => ({
  pack_version: 1,
  name: "small",
  version: "1.0.0",
  facets: [
    {
      key: "sensitivity",
      label: "Sensitivity",
      values: [{ value: "secret", label: "Secret", visibility: "hidden", exposure: "local-only" }],
    },
  ],
  ...patch,
});

describe("the general business starter pack", () => {
  it("is a valid pack whose tests all pass", () => {
    expect(validatePack(STARTER)).toEqual([]);
    const results = runPackTests(STARTER);
    expect(results.filter((r) => !r.passed)).toEqual([]);
    expect(results.length).toBeGreaterThan(10);
  });

  it("applies with its reviewed diff, loosening flagged", async () => {
    const p = await plan(STARTER);
    expect(p).toMatchObject({ name: "general-business", version: "1.0.0", previous: null });
    const kinds = p.changes.map((c) => c.kind);
    expect(kinds).toContain("set-defaults");
    expect(kinds.filter((k) => k === "add-value").length).toBe(22);
    expect(p.warnings).toEqual(
      expect.arrayContaining([
        "tenant default goes from hidden/metadata-only to discoverable/commercial-only",
        "new facet sensitivity is public: its tags show on title-only cards",
      ]),
    );
    await apply(STARTER, p.planHash);

    const [tenant] = await inTenant((tx) =>
      tx.select().from(tenants).where(eq(tenants.id, t.tenantId)),
    );
    expect(tenant).toMatchObject({
      defaultVisibility: "discoverable",
      defaultExposure: "commercial-only",
    });
    const [restricted] = await inTenant((tx) =>
      tx.select().from(facetValues).where(eq(facetValues.value, "restricted")),
    );
    expect(restricted).toMatchObject({
      approved: true,
      visibility: "hidden",
      exposure: "metadata-only",
    });
    const [dept] = await inTenant((tx) =>
      tx.select().from(facets).where(eq(facets.key, "department")),
    );
    expect(dept?.public).toBe(true);
    // The seeded client facet keeps its value; the pack only adds.
    expect(
      await inTenant((tx) => tx.select().from(facetValues).where(eq(facetValues.facet, "client"))),
    ).toHaveLength(1);

    const policies = await inTenant((tx) => tenantPolicies(tx, t.tenantId));
    expect(Object.keys(policies).sort()).toEqual([
      "pack/general-business/consumer-ai-no-confidential",
      "pack/general-business/guests-no-hr-or-legal",
    ]);
    const rules = await inTenant((tx) => tenantRules(tx, t.tenantId));
    expect(evaluateRules(rules, { path: "Company/HR/2026/Review.docx" })).toEqual([
      { tag: "department:hr", rule: "general-business.hr-folder" },
      { tag: "sensitivity:confidential", rule: "general-business.hr-confidential" },
    ]);
    expect(evaluateRules(rules, { path: "Sales/Pipeline.xlsx" }).map((r) => r.tag)).toEqual([
      "department:sales",
      "kind:spreadsheet",
    ]);

    // Planning the same pack again finds nothing to do.
    const again = await plan(STARTER);
    expect(again.changes).toEqual([]);
    expect(again.previous).toBe("1.0.0");
  });
});

describe("planPack and applyPack", () => {
  it("refuses a plan that no longer matches the tenant or the pack", async () => {
    const p = await plan(small());
    // Someone edits the vocabulary after the review.
    await inTenant(async (tx) => {
      await tx.insert(facets).values({ tenantId: t.tenantId, key: "sensitivity", label: "Other" });
    });
    await expect(apply(small(), p.planHash)).rejects.toMatchObject({ code: "stale-plan" });
    const fresh = await plan(small());
    await expect(apply(small({ version: "1.0.1" }), fresh.planHash)).rejects.toMatchObject({
      code: "stale-plan",
    });
    expect((await apply(small(), fresh.planHash)).version).toBe("1.0.0");
  });

  it("refuses a pack whose tests fail, naming them", async () => {
    const failing = small({
      tests: {
        levels: [
          {
            name: "secret is readable",
            tags: ["sensitivity:secret"],
            expect: { visibility: "readable", exposure: "full" },
          },
        ],
      },
    });
    const p = await plan(failing);
    expect(p.tests.find((r) => r.name === "secret is readable")).toMatchObject({
      passed: false,
      detail: "expected readable/full, got hidden/local-only",
    });
    await expect(apply(failing, p.planHash)).rejects.toMatchObject({
      code: "tests-failed",
      message: expect.stringContaining("secret is readable"),
    });
  });

  it("refuses policies that don't compile, as a failed test", async () => {
    const broken = small({ policies: { oops: "permit (principal, action" } });
    const p = await plan(broken);
    expect(p.tests[0]).toMatchObject({ name: "policies compile", passed: false });
    await expect(apply(broken, p.planHash)).rejects.toMatchObject({ code: "tests-failed" });
    const reserved = small({
      policies: {
        "no-core": 'forbid (principal, action, resource) when { resource.zone == "code" };',
      },
    });
    expect(runPackTests(reserved).every((r) => r.passed)).toBe(true);
  });

  it("flags every loosening change to existing vocabulary", async () => {
    await inTenant(async (tx) => {
      await tx
        .insert(facets)
        .values({ tenantId: t.tenantId, key: "sensitivity", label: "Sensitivity" });
      await tx.insert(facetValues).values([
        {
          tenantId: t.tenantId,
          facet: "sensitivity",
          value: "secret",
          label: "Secret",
          approved: true,
          visibility: "hidden",
          exposure: "metadata-only",
        },
        { tenantId: t.tenantId, facet: "sensitivity", value: "proposed", label: "Proposed" },
      ]);
    });
    const loosen = small({
      facets: [
        {
          key: "sensitivity",
          label: "Sensitivity",
          public: true,
          values: [
            { value: "secret", label: "Secret", visibility: "discoverable" },
            { value: "proposed", label: "Proposed" },
          ],
        },
      ],
    });
    const p = await plan(loosen);
    expect(p.changes).toEqual([
      {
        kind: "change-facet",
        facet: "sensitivity",
        from: { label: "Sensitivity", public: false },
        to: { label: "Sensitivity", public: true },
        loosens: true,
      },
      {
        kind: "change-value",
        tag: "sensitivity:secret",
        from: { label: "Secret", levels: { visibility: "hidden", exposure: "metadata-only" } },
        to: { label: "Secret", levels: { visibility: "discoverable", exposure: null } },
        loosens: true,
      },
      {
        kind: "approve-value",
        tag: "sensitivity:proposed",
        label: "Proposed",
        levels: { visibility: null, exposure: null },
        loosens: true,
      },
    ]);
    expect(p.warnings).toEqual([
      "facet sensitivity becomes public: its tags show on title-only cards",
      "sensitivity:secret goes from hidden/metadata-only to discoverable/no exposure",
      "proposed value sensitivity:proposed becomes approved vocabulary: grants and trusted tags can use it",
    ]);
    // Tightening isn't flagged.
    const tighten = small({
      facets: [
        {
          key: "sensitivity",
          label: "Sensitivity",
          values: [
            { value: "secret", label: "Secret", visibility: "hidden", exposure: "metadata-only" },
          ],
        },
      ],
    });
    expect((await plan(tighten)).warnings).toEqual([]);
  });

  it("replaces its own rules and policies on upgrade and keeps vocabulary it dropped", async () => {
    const v1 = small({
      facets: [
        {
          key: "sensitivity",
          label: "Sensitivity",
          values: [
            { value: "secret", label: "Secret" },
            { value: "old", label: "Old" },
          ],
        },
      ],
      rules: [
        { id: "a", tag: "sensitivity:secret", when: { path: "Secret/**" } },
        { id: "b", tag: "sensitivity:old", when: { path: "Old/**" } },
      ],
      policies: { p1: 'forbid (principal, action, resource) when { resource.zone == "code" };' },
    });
    await apply(v1, (await plan(v1)).planHash);
    const v2 = small({
      version: "2.0.0",
      facets: [
        {
          key: "sensitivity",
          label: "Sensitivity",
          values: [{ value: "secret", label: "Secret" }],
        },
      ],
      rules: [
        { id: "a", tag: "sensitivity:secret", when: { path: "Top Secret/**" } },
        { id: "c", tag: "sensitivity:secret", when: { extension: ["key"] } },
      ],
      policies: { p2: "forbid (principal, action, resource) when { principal.guest };" },
    });
    const p = await plan(v2);
    expect(p.previous).toBe("1.0.0");
    expect(p.changes).toEqual([
      {
        kind: "keep-value",
        tag: "sensitivity:old",
        note: "no longer in the pack; left in place, since tags and grants may use it",
      },
      {
        kind: "set-rules",
        added: [{ id: "c", tag: "sensitivity:secret", when: { extension: ["key"] } }],
        removed: [{ id: "b", tag: "sensitivity:old", when: { path: "Old/**" } }],
        changed: [
          {
            from: { id: "a", tag: "sensitivity:secret", when: { path: "Secret/**" } },
            to: { id: "a", tag: "sensitivity:secret", when: { path: "Top Secret/**" } },
          },
        ],
        loosens: true,
      },
      {
        kind: "set-policies",
        added: [
          {
            id: "pack/small/p2",
            text: "forbid (principal, action, resource) when { principal.guest };",
          },
        ],
        removed: [
          {
            id: "pack/small/p1",
            text: 'forbid (principal, action, resource) when { resource.zone == "code" };',
          },
        ],
        changed: [],
        // A forbid removed: something may now be allowed.
        loosens: true,
      },
    ]);
    await apply(v2, p.planHash);
    expect(Object.keys(await inTenant((tx) => tenantPolicies(tx, t.tenantId)))).toEqual([
      "pack/small/p2",
    ]);
    expect((await inTenant((tx) => tenantRules(tx, t.tenantId))).map((r) => r.id)).toEqual([
      "small.a",
      "small.c",
    ]);
    const [row] = await inTenant((tx) =>
      tx.select().from(tenantPacks).where(eq(tenantPacks.name, "small")),
    );
    expect(row).toMatchObject({ version: "2.0.0", appliedBy: "user:admin" });
    expect(row?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses rules on facets that won't exist, and a bad approver", async () => {
    const orphan = small({ rules: [{ id: "x", tag: "nowhere:x", when: { path: "**" } }] });
    await expect(plan(orphan)).rejects.toMatchObject({
      code: "invalid",
      message: expect.stringContaining("unknown facet nowhere"),
    });
    const p = await plan(small());
    await expect(
      db.withTenant(
        t.tenantId,
        (tx) => applyPack(tx, t.tenantId, small(), { planHash: p.planHash, by: "admin" }),
        APPLY_TRANSACTION,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      inTenant((tx) =>
        applyPack(tx, t.tenantId, small(), { planHash: p.planHash, by: "user:admin" }),
      ),
    ).rejects.toThrow("serializable");
  });
});

describe("what the review sees", () => {
  it("flags every rule change: rule tags are trusted", async () => {
    const everything = small({
      facets: [
        {
          key: "sensitivity",
          label: "Sensitivity",
          values: [{ value: "public", label: "Public", visibility: "readable", exposure: "full" }],
        },
      ],
      rules: [{ id: "all-public", tag: "sensitivity:public", when: { path: "**" } }],
    });
    const p = await plan(everything);
    expect(p.warnings).toEqual(
      expect.arrayContaining([
        "new value sensitivity:public (readable/full) is looser than the tenant default",
        "tag rules change (added all-public, removed none, changed none): rule tags are trusted, so review what each tags",
      ]),
    );
    expect(p.changes).toContainEqual(
      expect.objectContaining({
        kind: "set-rules",
        added: [{ id: "all-public", tag: "sensitivity:public", when: { path: "**" } }],
      }),
    );
  });

  it("flags added permits but not added forbids", async () => {
    const forbid = small({
      facets: [],
      policies: { f: "forbid (principal, action, resource) when { principal.guest };" },
    });
    const pf = await plan(forbid);
    expect(pf.changes).toContainEqual(
      expect.objectContaining({ kind: "set-policies", loosens: false }),
    );
    expect(pf.warnings).toEqual([]);
    const permit = small({
      facets: [],
      policies: { p: 'permit (principal, action, resource) when { resource.zone == "code" };' },
    });
    expect((await plan(permit)).warnings).toEqual([
      "policies change so that more may be allowed (added pack/small/p, removed none, changed none): review each",
    ]);
  });

  it("binds the plan to the tenant", async () => {
    const other = await seedTenant(db, 2);
    const here = await plan(small());
    const there = await db.withTenant(other.tenantId, (tx) =>
      planPack(tx, other.tenantId, small()),
    );
    expect(here.changes).toEqual(there.changes);
    expect(here.planHash).not.toBe(there.planHash);
    await expect(
      db.withTenant(
        other.tenantId,
        (tx) =>
          applyPack(tx, other.tenantId, small(), { planHash: here.planHash, by: "user:admin" }),
        APPLY_TRANSACTION,
      ),
    ).rejects.toMatchObject({ code: "stale-plan" });
  });

  it("warns when the version goes down", async () => {
    const v2 = small({ version: "2.0.0" });
    await apply(v2, (await plan(v2)).planHash);
    expect((await plan(small({ version: "1.9.9" }))).warnings).toContain(
      "version goes down from 2.0.0 to 1.9.9",
    );
  });

  it("flags a value going from no level to a looser one", async () => {
    const add = small({
      facets: [{ key: "department", label: "Department", values: [{ value: "hr", label: "HR" }] }],
    });
    await apply(add, (await plan(add)).planHash);
    const open = small({
      name: "other",
      facets: [
        {
          key: "department",
          label: "Department",
          values: [{ value: "hr", label: "HR", visibility: "readable", exposure: "full" }],
        },
      ],
    });
    expect((await plan(open)).warnings).toContain(
      "department:hr goes from no visibility/no exposure to readable/full",
    );
  });

  it("warns on a pre-release after its release, and on changed content under one version", async () => {
    await apply(small(), (await plan(small())).planHash);
    expect((await plan(small({ version: "1.0.0-rc.1" }))).warnings).toContain(
      "version goes down from 1.0.0 to 1.0.0-rc.1",
    );
    expect((await plan(small({ version: "1.0.1-rc.1" }))).warnings).toEqual([]);
    const edited = small({ description: "Edited in place." });
    expect((await plan(edited)).warnings).toContain(
      "version 1.0.0 is already applied with different content",
    );
  });

  it("names a stored pack that no longer validates, and stops there", async () => {
    await apply(small(), (await plan(small())).planHash);
    await inTenant((tx) =>
      tx
        .update(tenantPacks)
        .set({
          content: {
            ...small(),
            policies: {
              p: 'permit (principal, action, resource) when { resource.allTags.contains("a:b") };',
            },
          },
        })
        .where(eq(tenantPacks.name, "small")),
    );
    await expect(inTenant((tx) => tenantPolicies(tx, t.tenantId))).rejects.toThrow(
      "stored pack small no longer validates",
    );
  });

  it("plans and applies one copy: getters and inherited fields don't slip through", async () => {
    let reads = 0;
    const loose: PackFacet[] = [
      {
        key: "sensitivity",
        label: "Sensitivity",
        values: [{ value: "secret", label: "Secret", visibility: "readable" }],
      },
    ];
    const tricky = {
      ...small(),
      get facets() {
        reads++;
        return reads === 1 ? small().facets : loose;
      },
    };
    const p = await plan(tricky);
    // Planning read the getter once; applying copies again and gets the other value.
    await expect(apply(tricky, p.planHash)).rejects.toMatchObject({ code: "stale-plan" });
    const inherited = Object.create({
      policies: { p: "permit (principal, action, resource);" },
    }) as object;
    Object.assign(inherited, small());
    expect((await plan(inherited)).changes.some((c) => c.kind === "set-policies")).toBe(false);
  });
});

describe("the tests of a pack", () => {
  it("fail on a malformed test instead of passing it as a deny", () => {
    const vacuous = small({
      policies: { all: "permit (principal, action, resource);" },
      tests: {
        policies: [
          {
            name: "looks denied",
            action: "read",
            principal: { guest: "yes" as unknown as boolean },
            resource: { tags: [] },
            expect: "deny",
          },
        ],
      },
    });
    expect(runPackTests(vacuous).find((r) => r.name === "looks denied")).toMatchObject({
      passed: false,
      detail: expect.stringContaining("got error"),
    });
    expect(validatePack(vacuous)).toContain(
      "policy test looks denied: principal.guest must be true or false",
    );
  });

  it("tell a forbid from a missing permit", () => {
    const pack = small({
      policies: { g: "forbid (principal, action, resource) when { principal.guest };" },
      tests: {
        policies: [
          { name: "no grant", action: "read", resource: { tags: [] }, expect: "forbid" },
          {
            name: "a guest",
            action: "read",
            principal: { guest: true },
            resource: { tags: [] },
            expect: "forbid",
          },
        ],
      },
    });
    const results = runPackTests(pack);
    expect(results.find((r) => r.name === "no grant")).toMatchObject({
      passed: false,
      detail: "expected forbid, got no-permit (no policy permits it)",
    });
    expect(results.find((r) => r.name === "a guest")?.passed).toBe(true);
  });

  it("run against the tenant: its other packs' policies, values and defaults", async () => {
    const guard = small({
      name: "guard",
      facets: [],
      policies: { g: "forbid (principal, action, resource) when { principal.guest };" },
    });
    await apply(guard, (await plan(guard)).planHash);
    const loose = small({
      name: "loose",
      facets: [],
      tests: {
        policies: [
          {
            name: "guests read granted files",
            action: "read",
            principal: { guest: true, readGrants: [t.tag] },
            resource: { tags: [t.tag] },
            expect: "allow",
          },
        ],
        levels: [
          {
            name: "seeded tag, tenant default",
            tags: [t.tag],
            expect: { visibility: "hidden", exposure: "metadata-only" },
          },
          {
            name: "typo",
            tags: ["client:acmee"],
            expect: { visibility: "hidden", exposure: "metadata-only" },
          },
        ],
      },
    });
    const p = await plan(loose);
    const byName = new Map(p.tests.map((r) => [r.name, r]));
    // The guard pack's forbid is part of the tenant, so this test fails there.
    expect(byName.get("guests read granted files")?.passed).toBe(false);
    expect(byName.get("seeded tag, tenant default")?.passed).toBe(true);
    expect(byName.get("typo")).toMatchObject({
      passed: false,
      detail: "unknown tags: client:acmee",
    });
  });
});

const corrupt = (name: string, policies: Record<string, string>) =>
  inTenant((tx) =>
    tx
      .update(tenantPacks)
      .set({ content: { pack_version: 1, name, version: "1.0.0", policies } })
      .where(eq(tenantPacks.name, name)),
  );
const MISUSE = 'permit (principal, action, resource) when { resource.allTags.contains("a:b") };';
const removal = (name: string) => inTenant((tx) => planPackRemoval(tx, t.tenantId, name));
const remove = (name: string, planHash: string) =>
  db.withTenant(
    t.tenantId,
    (tx) => removePack(tx, t.tenantId, name, { planHash, by: "user:admin" }),
    APPLY_TRANSACTION,
  );

describe("a value losing its level", () => {
  it("is flagged even when the default is as strict: the file's other tags then decide", async () => {
    // A file tagged x:a (hidden) and x:b (readable) is hidden. Drop x:a's levels and it is
    // readable, though x:a's "effective" level (the default, hidden) looks unchanged.
    const levels = (a: Partial<Record<"visibility" | "exposure", string>>): Pack =>
      small({
        facets: [
          {
            key: "x",
            label: "X",
            values: [
              { value: "a", label: "A", ...a } as PackFacet["values"][number],
              { value: "b", label: "B", visibility: "readable", exposure: "full" },
            ],
          },
        ],
      });
    const v1 = levels({ visibility: "hidden", exposure: "metadata-only" });
    await apply(v1, (await plan(v1)).planHash);
    const p = await plan({ ...levels({}), version: "1.0.1" });
    expect(p.changes).toEqual([
      {
        kind: "change-value",
        tag: "x:a",
        from: { label: "A", levels: { visibility: "hidden", exposure: "metadata-only" } },
        to: { label: "A", levels: { visibility: null, exposure: null } },
        loosens: true,
      },
    ]);
    expect(p.warnings).toEqual(["x:a goes from hidden/metadata-only to no visibility/no exposure"]);
  });
});

describe("a stored pack that no longer validates", () => {
  it("doesn't lock the tenant: its fixed version plans, replacing everything, flagged", async () => {
    const v1 = small({
      policies: { p1: "forbid (principal, action, resource) when { principal.guest };" },
    });
    await apply(v1, (await plan(v1)).planHash);
    await corrupt("small", { p: MISUSE });
    await expect(inTenant((tx) => tenantPolicies(tx, t.tenantId))).rejects.toThrow(
      "stored pack small no longer validates",
    );
    const fixed = small({
      version: "1.0.1",
      policies: { p: "forbid (principal, action, resource) when { principal.guest };" },
    });
    const p = await plan(fixed);
    expect(p.warnings[0]).toMatch(/^the applied small no longer validates \(p: a permit can't/);
    expect(p.changes).toContainEqual({
      kind: "set-policies",
      added: [{ id: "pack/small/p", text: fixed.policies?.p }],
      removed: [{ id: "pack/small/p", text: MISUSE }],
      changed: [],
      loosens: true,
    });
    await apply(fixed, p.planHash);
    expect(Object.keys(await inTenant((tx) => tenantPolicies(tx, t.tenantId)))).toEqual([
      "pack/small/p",
    ]);
  });

  it("stops planning another pack, naming every broken one", async () => {
    await apply(small(), (await plan(small())).planHash);
    await corrupt("seed-pack", { p: MISUSE });
    await expect(plan(small({ version: "1.0.1" }))).rejects.toThrow(
      "stored pack seed-pack no longer validates",
    );
    await corrupt("small", { q: MISUSE });
    await expect(inTenant((tx) => tenantPolicies(tx, t.tenantId))).rejects.toThrow(
      /stored packs seed-pack, small no longer validate:\n {2}- seed-pack: p: .*\n {2}- small: q: /,
    );
  });

  it("can be removed, even when another is broken too", async () => {
    await apply(small(), (await plan(small())).planHash);
    await corrupt("seed-pack", { p: MISUSE });
    await corrupt("small", { q: MISUSE });
    const p = await removal("small");
    expect(p).toMatchObject({ action: "remove", name: "small", version: "1.0.0" });
    expect(p.warnings).toEqual([
      expect.stringMatching(/^the applied small no longer validates/),
      "the applied seed-pack no longer validates, so its tests weren't run",
      // Removing a permit doesn't loosen anything, so no warning for that.
    ]);
    await remove("small", p.planHash);
    await remove("seed-pack", (await removal("seed-pack")).planHash);
    expect(await inTenant((tx) => tenantPolicies(tx, t.tenantId))).toEqual({});
  });
});

describe("planPackRemoval and removePack", () => {
  it("remove rules and policies, keep vocabulary, flag a removed forbid", async () => {
    const v1 = small({
      rules: [{ id: "a", tag: "sensitivity:secret", when: { path: "Secret/**" } }],
      policies: { f: "forbid (principal, action, resource) when { principal.guest };" },
    });
    await apply(v1, (await plan(v1)).planHash);
    const p = await removal("small");
    expect(p.changes).toEqual([
      {
        kind: "keep-value",
        tag: "sensitivity:secret",
        note: "stays when the pack is removed, since tags and grants may use it",
      },
      {
        kind: "set-rules",
        added: [],
        removed: [{ id: "a", tag: "sensitivity:secret", when: { path: "Secret/**" } }],
        changed: [],
        loosens: true,
      },
      {
        kind: "set-policies",
        added: [],
        removed: [
          {
            id: "pack/small/f",
            text: "forbid (principal, action, resource) when { principal.guest };",
          },
        ],
        changed: [],
        loosens: true,
      },
    ]);
    // A removal plan can't be used to apply, nor an apply plan to remove.
    await expect(apply(v1, p.planHash)).rejects.toMatchObject({ code: "stale-plan" });
    await expect(remove("small", (await plan(v1)).planHash)).rejects.toMatchObject({
      code: "stale-plan",
    });
    await remove("small", p.planHash);
    expect(await inTenant((tx) => tenantPolicies(tx, t.tenantId))).toEqual({});
    expect(await inTenant((tx) => tenantRules(tx, t.tenantId))).toEqual([]);
    expect(
      await inTenant((tx) =>
        tx.select().from(facetValues).where(eq(facetValues.facet, "sensitivity")),
      ),
    ).toHaveLength(1);
    await expect(removal("small")).rejects.toMatchObject({ code: "not-applied" });
  });

  it("refuse a stale plan, a weak transaction, and a removal that breaks another pack", async () => {
    const opener = small({
      name: "opener",
      facets: [],
      policies: { p: "permit (principal, action, resource) when { principal.guest };" },
    });
    const guard = small({
      name: "guard",
      facets: [],
      tests: {
        policies: [
          {
            name: "guests read",
            action: "read",
            principal: { guest: true },
            resource: { tags: [] },
            expect: "allow",
          },
        ],
      },
    });
    await apply(opener, (await plan(opener)).planHash);
    await apply(guard, (await plan(guard)).planHash);
    const p = await removal("opener");
    expect(p.tests.find((r) => r.name === "guard: guests read")?.passed).toBe(false);
    await expect(remove("opener", p.planHash)).rejects.toMatchObject({
      code: "tests-failed",
      message: expect.stringContaining("removing pack opener fails other packs' tests"),
    });
    const g = await removal("guard");
    await inTenant((tx) =>
      tx
        .update(tenantPacks)
        .set({ version: "1.0.1" })
        .where(and(eq(tenantPacks.tenantId, t.tenantId), eq(tenantPacks.name, "guard"))),
    );
    await expect(remove("guard", g.planHash)).rejects.toMatchObject({ code: "stale-plan" });
    await expect(
      inTenant((tx) =>
        removePack(tx, t.tenantId, "guard", { planHash: g.planHash, by: "user:admin" }),
      ),
    ).rejects.toThrow("removePack needs a serializable transaction");
  });
});

describe("the other packs' tests", () => {
  const guard = small({
    name: "guard",
    facets: [
      {
        key: "department",
        label: "Department",
        values: [{ value: "hr", label: "HR", visibility: "hidden", exposure: "local-only" }],
      },
    ],
    policies: {
      g: 'forbid (principal, action, resource) when { principal.guest && resource.allTags.contains("department:hr") };',
    },
    tests: {
      policies: [
        {
          name: "no grant, no HR",
          action: "read",
          resource: { tags: ["department:hr"] },
          expect: "deny",
        },
      ],
      levels: [
        {
          name: "HR is hidden",
          tags: ["department:hr"],
          expect: { visibility: "hidden", exposure: "local-only" },
        },
      ],
    },
  });

  it("run again, against the tenant the plan would leave, in the plan and its hash", async () => {
    await apply(guard, (await plan(guard)).planHash);
    const opener = small({
      name: "opener",
      facets: [
        {
          key: "department",
          label: "Department",
          values: [{ value: "hr", label: "HR", visibility: "readable", exposure: "full" }],
        },
      ],
      policies: {
        p: 'permit (principal, action == OpenHoard::Action::"read", resource) when { resource in OpenHoard::Tag::"department:hr" };',
      },
    });
    vi.mocked(createCedarEngine).mockClear();
    const p = await plan(opener);
    // One engine for the plan's tests, this pack's and the others'.
    expect(createCedarEngine).toHaveBeenCalledTimes(1);
    expect(p.tests).toEqual([
      { name: "policies compile", passed: true, detail: "" },
      {
        name: "guard: no grant, no HR",
        passed: false,
        detail: "expected deny, got allow (permitted by pack/opener/p)",
      },
      {
        name: "guard: HR is hidden",
        passed: false,
        detail: "expected hidden/local-only, got readable/full",
      },
    ]);
    await expect(apply(opener, p.planHash)).rejects.toMatchObject({
      code: "tests-failed",
      message: expect.stringContaining("guard: no grant, no HR"),
    });
    // A pack that keeps the guarantees applies.
    const fine = small({ name: "fine", facets: [] });
    const ok = await plan(fine);
    expect(ok.tests.map((r) => [r.name, r.passed])).toEqual([
      ["policies compile", true],
      ["guard: no grant, no HR", true],
      ["guard: HR is hidden", true],
    ]);
    await apply(fine, ok.planHash);
  });
});

describe("applyPack's writes", () => {
  const rowVersions = (facet: string) =>
    inTenant(async (tx) => {
      const rows = await queryRows<{ value: string; xmin: string }>(
        tx,
        sql`select value, xmin::text as xmin from facet_values where facet = ${facet} order by value`,
      );
      return new Map(rows.map((r) => [r.value, r.xmin]));
    });

  it("touch only the rows the plan changes", async () => {
    const values = (bLabel: string) =>
      small({
        facets: [
          {
            key: "sensitivity",
            label: "Sensitivity",
            values: [
              { value: "a", label: "A" },
              { value: "b", label: bLabel },
            ],
          },
        ],
      });
    await apply(values("B"), (await plan(values("B"))).planHash);
    const before = await rowVersions("sensitivity");
    const v2 = { ...values("Bee"), version: "1.0.1" };
    await apply(v2, (await plan(v2)).planHash);
    const after = await rowVersions("sensitivity");
    expect(after.get("a")).toBe(before.get("a"));
    expect(after.get("b")).not.toBe(before.get("b"));
    const [b] = await inTenant((tx) =>
      tx.select().from(facetValues).where(eq(facetValues.value, "b")),
    );
    expect(b?.label).toBe("Bee");
  });

  it("write large vocabularies in batches", async () => {
    const facet = (key: string, n: number): PackFacet => ({
      key,
      label: key,
      values: Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: `V${i}` })),
    });
    const big = small({ facets: [facet("one", 1000), facet("two", 700)] });
    await apply(big, (await plan(big)).planHash);
    expect((await rowVersions("one")).size).toBe(1000);
    expect((await rowVersions("two")).size).toBe(700);
    expect((await plan(big)).changes).toEqual([]);
  });
});

describe("policy tests and zones", () => {
  it("warn about test tags that won't be approved vocabulary", async () => {
    const typo = small({
      tests: {
        policies: [
          {
            name: "typo",
            action: "read",
            principal: { readGrants: ["sensitivity:secret", "client:acmee"] },
            resource: { tags: ["sensitivity:secret"], unreviewedTags: ["x:y"] },
            expect: "allow",
          },
        ],
      },
    });
    const p = await plan(typo);
    expect(p.warnings).toContain(
      `policy test "typo" uses tags that aren't approved vocabulary: x:y, client:acmee`,
    );
    expect(p.warnings.filter((w) => w.startsWith("policy test"))).toHaveLength(1);
  });

  it("find the literals a policy compares resource.zone with", () => {
    expect(
      zoneLiterals(
        'when { resource.zone == "code" || "legal" != resource . zone || ["a", "b\\"c"].contains(resource.zone) }',
      ),
    ).toEqual(["code", "legal", "a", 'b"c']);
  });
});

describe("compareVersions", () => {
  it.each([
    ["1.0.0-rc.10", "1.0.0-rc.2", 1],
    ["1.0.0-rc.2", "1.0.0-rc.10", -1],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta", -1],
    ["1.0.0-alpha.beta", "1.0.0-beta", -1],
    ["1.0.0-beta.11", "1.0.0-rc.1", -1],
    ["1.0.0-rc.1", "1.0.0", -1],
    ["1.0.0", "1.0.0", 0],
    ["10.0.0", "9.0.0", 1],
    ["1.0.0-99999999999999999999", "1.0.0-100000000000000000000", -1],
  ])("%s vs %s", (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });

  it("drive the version-goes-down warning", async () => {
    const rc10 = small({ version: "1.0.0-rc.10" });
    await apply(rc10, (await plan(rc10)).planHash);
    expect((await plan(small({ version: "1.0.0-rc.2" }))).warnings).toContain(
      "version goes down from 1.0.0-rc.10 to 1.0.0-rc.2",
    );
    expect((await plan(small({ version: "1.0.0-rc.11" }))).warnings).toEqual([]);
  });
});

describe("validatePack", () => {
  it.each<[string, unknown, string]>([
    [
      "a bidi override in policy text",
      small({ policies: { p: "// a‮ b\nforbid (principal, action, resource);" } }),
      "policy p: control or format characters (only line breaks and tabs)",
    ],
    [
      "a NUL in policy text",
      small({ policies: { p: "forbid (principal, action, resource);\u0000" } }),
      "policy p: control or format characters (only line breaks and tabs)",
    ],
    [
      "a zone name where a zone kind belongs",
      small({
        policies: { p: 'forbid (principal, action, resource) when { resource.zone == "legal" };' },
      }),
      'policy p: resource.zone is never "legal" (zone kinds: managed, indexed, local-only, code)',
    ],
    [
      "a test in a zone that isn't a kind",
      small({
        tests: {
          policies: [
            {
              name: "t",
              action: "read",
              resource: { tags: [], zone: "sharepoint" },
              expect: "deny",
            },
          ],
        },
      }),
      "policy test t: resource.zone must be a zone kind (managed, indexed, local-only, code)",
    ],
    ["a non-object", [], "a pack is an object"],
    ["an unknown field", { ...small(), code: "x" }, "pack: unknown field code"],
    ["the wrong version", { ...small(), pack_version: 2 }, "pack_version must be 1"],
    ["a bad name", { ...small(), name: "Small Pack" }, "name must be a lower-case slug"],
    [
      "a bad version",
      { ...small(), version: "1.0" },
      "version must be semver, at most 64 characters",
    ],
    [
      "bad defaults",
      { ...small(), defaults: { visibility: "open" } },
      "defaults needs a visibility and an exposure level",
    ],
    [
      "a duplicate facet",
      small({ facets: [...(small().facets ?? []), ...(small().facets ?? [])] }),
      "facet sensitivity: listed twice",
    ],
    [
      "a bad value",
      small({ facets: [{ key: "k", label: "K", values: [{ value: "Bad Value", label: "B" }] }] }),
      "facet k value Bad Value: not a slug",
    ],
    [
      "an unknown level",
      small({
        facets: [
          {
            key: "k",
            label: "K",
            values: [{ value: "v", label: "V", visibility: "open" as "hidden" }],
          },
        ],
      }),
      "facet k value v: unknown visibility",
    ],
    [
      "a bad rule",
      small({ rules: [{ id: "Bad" } as never] }),
      "rules: rule 0: id must be a lower-case slug",
    ],
    [
      "a bad policy id",
      small({ policies: { "Bad Id": "permit (principal, action, resource);" } }),
      "policy Bad Id: id must be a slug",
    ],
    [
      "a bad policy test",
      small({
        tests: {
          policies: [
            { name: "t", action: "delete" as "read", resource: { tags: [] }, expect: "allow" },
          ],
        },
      }),
      "policy test t: unknown action",
    ],
    [
      "a bad level test",
      small({
        tests: {
          levels: [
            { name: "l", tags: ["nope"], expect: { visibility: "hidden", exposure: "full" } },
          ],
        },
      }),
      "level test l: tags must list facet:value tags",
    ],
    [
      "a typo in a value's level",
      small({
        facets: [
          {
            key: "k",
            label: "K",
            values: [{ value: "v", label: "V", visiblity: "hidden" } as never],
          },
        ],
      }),
      "facet k value v: unknown field visiblity",
    ],
    [
      "an unknown key in defaults",
      { ...small(), defaults: { visibility: "hidden", exposure: "full", x: 1 } },
      "defaults: unknown field x",
    ],
    [
      "a typo in a test's principal",
      small({
        tests: {
          policies: [
            {
              name: "t",
              action: "read",
              principal: { readGrant: [] } as never,
              resource: { tags: [] },
              expect: "deny",
            },
          ],
        },
      }),
      "policy test t principal: unknown field readGrant",
    ],
    [
      "a label with a newline",
      small({ facets: [{ key: "k", label: "K\nX", values: [] }] }),
      "facet k: label must be 1 to 200 visible characters",
    ],
    [
      "a version too long",
      { ...small(), version: `1.0.0-${"x".repeat(60)}` },
      "version must be semver, at most 64 characters",
    ],
  ])("refuses %s", (_, pack, problem) => {
    expect(validatePack(pack)).toContain(problem);
    expect(() => parsePack(pack)).toThrow(problem);
  });
});

describe("helpers", () => {
  it("hashes canonically, whatever the key order", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: undefined, e: null }] })).toBe(
      '{"a":[{"d":2,"e":null}],"b":1}',
    );
  });

  it("prefixes policy ids with the pack name", () => {
    expect(Object.keys(packPolicies(STARTER))).toEqual([
      "pack/general-business/guests-no-hr-or-legal",
      "pack/general-business/consumer-ai-no-confidential",
    ]);
  });
});
