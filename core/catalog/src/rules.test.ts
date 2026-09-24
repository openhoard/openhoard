import fc from "fast-check";
import { facets, facetValues, objectTags, tagReviews, type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyRuleTags, evaluateRules, globMatch, validateRules, type TagRule } from "./rules.js";
import { approveReview, proposeTag, rejectReview, tagsForDecisions } from "./tagging.js";

/* The rule tagger (T-403). */

const RULES: TagRule[] = [
  { id: "finance-folder", tag: "department:finance", when: { path: "Finance/**" } },
  { id: "spreadsheets", tag: "kind:spreadsheet", when: { extension: ["xlsx", "CSV"] } },
  { id: "images", tag: "kind:image", when: { mime: ["image/*"] } },
  { id: "hr-site", tag: "department:hr", when: { site: "HR Portal", extension: ["docx"] } },
  { id: "q-reports", tag: "kind:report", when: { path: "**/Q?-report*.pdf" } },
  {
    id: "clients",
    facet: "client",
    dictionary: { acme: ["Acme", "Acme Corp"], "globex-corp": ["Globex Corporation"] },
  },
];

describe("evaluateRules", () => {
  it.each<[string, Parameters<typeof evaluateRules>[1], string[]]>([
    ["a folder rule", { path: "Finance/2026/budget.docx" }, ["department:finance"]],
    ["the folder itself", { path: "finance" }, ["department:finance"]],
    ["not a folder named like it", { path: "Finance-old/x.docx" }, []],
    ["an extension, any case", { path: "Data/export.CsV" }, ["kind:spreadsheet"]],
    [
      "the title's extension when there is no path",
      { title: "Numbers.xlsx" },
      ["kind:spreadsheet"],
    ],
    ["a media type family", { mime: "image/png" }, ["kind:image"]],
    ["not a different family", { mime: "application/pdf" }, []],
    [
      "every condition of a rule",
      { site: "hr portal", path: "Docs/Handbook.docx" },
      ["department:hr"],
    ],
    ["not just some of them", { site: "HR Portal", path: "Docs/Handbook.pdf" }, []],
    ["? and * in a segment", { path: "Board/2026/Q3-report final.pdf" }, ["kind:report"]],
    ["not ? for two characters", { path: "Board/Q10-report.pdf" }, []],
    ["a dictionary term in the title", { title: "Kickoff with ACME" }, ["client:acme"]],
    [
      "a dictionary term in a folder name",
      { path: "Clients/Acme Corp/notes.txt" },
      ["client:acme"],
    ],
    [
      "a multi-word term, across punctuation",
      { title: "globex-corporation_q3" },
      ["client:globex-corp"],
    ],
    ["not part of a word", { title: "Acmeology primer" }, []],
    ["not words split across segments", { path: "Globex/Corporation/x.txt" }, []],
  ])("matches %s", (_, input, tags) => {
    expect(evaluateRules(RULES, input).map((r) => r.tag)).toEqual(tags);
  });

  it("names the rule behind each tag, once per tag, sorted", () => {
    const rules: TagRule[] = [
      ...RULES,
      { id: "finance-again", tag: "department:finance", when: { extension: ["xlsx"] } },
    ];
    expect(evaluateRules(rules, { path: "Finance/Acme/costs.xlsx" })).toEqual([
      { tag: "client:acme", rule: "clients" },
      { tag: "department:finance", rule: "finance-folder" },
      { tag: "kind:spreadsheet", rule: "spreadsheets" },
    ]);
  });

  it("matches Unicode words case-insensitively", () => {
    const rules: TagRule[] = [{ id: "d", facet: "client", dictionary: { muller: ["Müller AG"] } }];
    expect(evaluateRules(rules, { title: "Angebot MÜLLER ag 2026" })).toHaveLength(1);
  });

  it("matches decomposed (NFD) names, as macOS writes them, against composed rules and back", () => {
    const nfc = (s: string) => s.normalize("NFC");
    const nfd = (s: string) => s.normalize("NFD");
    const rules = (form: (s: string) => string): TagRule[] => [
      { id: "d", facet: "client", dictionary: { sg: [form("Société Générale")] } },
      { id: "compta", tag: "department:finance", when: { path: form("Comptabilité/**") } },
      { id: "site", tag: "department:hr", when: { site: form("Ressources Humaines") } },
      { id: "ext", tag: "kind:note", when: { extension: [form("tâche")] } },
    ];
    for (const [ruleForm, inputForm] of [
      [nfc, nfd],
      [nfd, nfc],
      [nfd, nfd],
    ] as const) {
      const got = evaluateRules(rules(ruleForm), {
        title: inputForm("Contrat SOCIÉTÉ GÉNÉRALE"),
        path: inputForm("Comptabilité/2026/liste.tâche"),
        site: inputForm("ressources humaines"),
      });
      expect(got.map((r) => r.tag)).toEqual([
        "client:sg",
        "department:finance",
        "department:hr",
        "kind:note",
      ]);
    }
    // A combining mark with no precomposed form stays inside its word.
    const marked: TagRule[] = [{ id: "m", facet: "client", dictionary: { x: ["q̇a"] } }];
    expect(evaluateRules(marked, { title: "Q̇A report" })).toHaveLength(1);
    expect(evaluateRules(marked, { title: "q a" })).toHaveLength(0);
  });
});

describe("globMatch", () => {
  it.each<[string, string, boolean]>([
    ["**", "a/b/c", true],
    ["a/**/c", "a/c", true],
    ["a/**/c", "a/x/y/c", true],
    ["a/**/c", "a/x/y/d", false],
    ["*.pdf", "x.pdf", true],
    ["*.pdf", "dir/x.pdf", false],
    ["**/*.pdf", "dir/x.pdf", true],
    ["a*b*c", "aXXbYYc", true],
    ["a*b*c", "aXXbYY", false],
    ["", "", true],
    ["a", "", false],
  ])("%j against %j is %s", (pattern, path, ok) => {
    expect(globMatch(pattern, path)).toBe(ok);
  });

  it("agrees with a regular-expression reference (property)", () => {
    // A segment that is exactly ** spans segments, which the reference below can't express.
    const seg = fc.stringMatching(/^[ab*?]{0,4}$/).filter((x) => x !== "**");
    // Paths have at least one non-empty segment.
    const text = fc.stringMatching(/^[ab]{1,5}$/);
    const toRegex = (p: string) =>
      new RegExp(`^${p.replaceAll("?", "[^/]").replaceAll("*", "[^/]*")}$`);
    fc.assert(
      fc.property(
        fc.array(seg, { minLength: 1, maxLength: 3 }),
        fc.array(text, { minLength: 1, maxLength: 3 }),
        (p, t) => {
          const pattern = p.filter(Boolean).join("/");
          const path = t.filter(Boolean).join("/");
          expect(globMatch(pattern, path)).toBe(toRegex(p.filter(Boolean).join("/")).test(path));
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it("stays fast on patterns built to backtrack", () => {
    const started = performance.now();
    expect(globMatch("*a*a*a*a*a*a*a*b", "a".repeat(5_000))).toBe(false);
    expect(globMatch(`${"**/".repeat(30)}x`, `${"a/".repeat(2_000)}y`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("validateRules", () => {
  it("accepts well-formed rules", () => {
    expect(validateRules(RULES)).toEqual([]);
  });

  it.each<[string, unknown, RegExp]>([
    ["a non-list", {}, /must be a list/],
    ["a non-object", [7], /not an object/],
    ["a bad id", [{ id: "Bad Id", tag: "a:b", when: { path: "x" } }], /lower-case slug/],
    ["a duplicate id", [RULES[0], RULES[0]], /duplicate id/],
    ["a bad tag", [{ id: "r", tag: "no-colon", when: { path: "x" } }], /facet:value/],
    ["no conditions", [{ id: "r", tag: "a:b", when: {} }], /at least one condition/],
    ["an unknown condition", [{ id: "r", tag: "a:b", when: { owner: "x" } }], /unknown condition/],
    ["an empty path", [{ id: "r", tag: "a:b", when: { path: "" } }], /non-empty string/],
    [
      "a bad extension list",
      [{ id: "r", tag: "a:b", when: { extension: [] } }],
      /must list strings/,
    ],
    ["a missing when", [{ id: "r", tag: "a:b" }], /when must be an object/],
    ["a bad facet", [{ id: "d", facet: "Client", dictionary: { a: ["A"] } }], /facet key/],
    ["a bad dictionary", [{ id: "d", facet: "client", dictionary: ["a"] }], /map values/],
    ["a bad value", [{ id: "d", facet: "client", dictionary: { "A B": ["x"] } }], /value slug/],
    ["no terms", [{ id: "d", facet: "client", dictionary: { a: [] } }], /list of terms/],
    [
      "a term without words",
      [{ id: "d", facet: "client", dictionary: { a: ["--"] } }],
      /no letters/,
    ],
    [
      "an ignored exception",
      [{ id: "r", tag: "a:b", when: { path: "**" }, unless: { path: "Public/**" } }],
      /unknown field unless/,
    ],
    [
      "a stray field on a dictionary rule",
      [{ id: "d", facet: "client", dictionary: { a: ["A"] }, when: { path: "x" } }],
      /unknown field when/,
    ],
    [
      "a right-to-left override in a path",
      [{ id: "r", tag: "a:b", when: { path: "HR/\u202e**" } }],
      /visible characters/,
    ],
    [
      "an invisible character in a term",
      [{ id: "d", facet: "client", dictionary: { a: ["Ac\u200bme"] } }],
      /list of terms/,
    ],
  ])("reports %s", (_, rules, message) => {
    expect(validateRules(rules).join("\n")).toMatch(message);
  });
});

describe("applyRuleTags", () => {
  let db: Database;
  let t: SeededTenant;
  beforeEach(async () => {
    db = await openTestDatabase();
    t = await seedTenant(db, 1);
    await db.withTenant(t.tenantId, async (tx) => {
      await tx.insert(facets).values({ tenantId: t.tenantId, key: "kind", label: "Kind" });
      await tx.insert(facetValues).values({
        tenantId: t.tenantId,
        facet: "client",
        value: "acme",
        label: "Acme",
        approved: true,
      });
    });
  });
  afterEach(() => db?.close());

  const apply = (input: Parameters<typeof applyRuleTags>[4], rules = RULES) =>
    db.withTenant(t.tenantId, (tx) => applyRuleTags(tx, t.tenantId, t.objectId, rules, input));
  const tagsOn = () =>
    db.withTenant(t.tenantId, async (tx) =>
      (await tx.select().from(objectTags).where(eq(objectTags.objectId, t.objectId)))
        .map((r) => `${r.facet}:${r.value} (${r.source})`)
        .sort(),
    );

  it("applies approved tags as the rule, and files new values for review", async () => {
    const { outcomes, removed } = await apply({ path: "Clients/Acme/Finance.xlsx" });
    expect(outcomes).toEqual([
      { applied: true, tag: "client:acme", rule: "clients" },
      { applied: false, reviewId: expect.any(String), reason: "new-value", rule: "spreadsheets" },
    ]);
    // The seeded rule tag comes from a rule these rules don't have.
    expect(removed).toEqual(["client:acme-1"]);
    const tags = await db.withTenant(t.tenantId, (tx) =>
      tx.select().from(objectTags).where(eq(objectTags.value, "acme")),
    );
    expect(tags[0]).toMatchObject({ source: "rule", appliedBy: "rule:clients", confidence: 1 });
    const [review] = await db.withTenant(t.tenantId, (tx) => tx.select().from(tagReviews));
    expect(review).toMatchObject({
      facet: "kind",
      value: "spreadsheet",
      appliedBy: "rule:spreadsheets",
    });
  });

  it("takes off rule tags no rule gives any more, and leaves other sources' tags alone", async () => {
    await db.withTenant(t.tenantId, async (tx) => {
      await tx.insert(facets).values({ tenantId: t.tenantId, key: "department", label: "Dept" });
      await tx.insert(facetValues).values([
        { tenantId: t.tenantId, facet: "department", value: "hr", label: "HR", approved: true },
        { tenantId: t.tenantId, facet: "client", value: "globex", label: "G", approved: true },
      ]);
      await tx.insert(objectTags).values({
        tenantId: t.tenantId,
        objectId: t.objectId,
        facet: "client",
        value: "globex",
        source: "user",
        appliedBy: "user:ana",
        confidence: 1,
      });
    });
    const rules: TagRule[] = [
      ...RULES,
      { id: "hr", tag: "department:hr", when: { path: "HR/**" } },
      { id: "seeded", tag: "client:acme-1", when: { path: "**/Acme/**" } },
    ];
    expect((await apply({ path: "Clients/Acme/Plan.docx" }, rules)).removed).toEqual([]);
    expect(await tagsOn()).toEqual([
      "client:acme (rule)",
      "client:acme-1 (rule)",
      "client:globex (user)",
    ]);
    // Moved out of the client's folder: its client tags, and the grants on them, go.
    const moved = await apply({ path: "HR/Plan.docx" }, rules);
    expect(moved.outcomes).toEqual([{ applied: true, tag: "department:hr", rule: "hr" }]);
    expect(moved.removed).toEqual(["client:acme", "client:acme-1"]);
    expect(await tagsOn()).toEqual(["client:globex (user)", "department:hr (rule)"]);
    // Nothing matches: every rule tag goes, and only those.
    expect((await apply({ path: "Misc/Plan.docx" }, [])).removed).toEqual(["department:hr"]);
    expect(await tagsOn()).toEqual(["client:globex (user)"]);
  });

  describe("a restriction a model proposed first", () => {
    // HR/** gives sensitivity:restricted (hidden, local-only); a model guessed it too.
    const HR: TagRule[] = [{ id: "hr", tag: "sensitivity:restricted", when: { path: "HR/**" } }];
    beforeEach(() =>
      db.withTenant(t.tenantId, async (tx) => {
        await tx.insert(facets).values({ tenantId: t.tenantId, key: "sensitivity", label: "S" });
        await tx.insert(facetValues).values({
          tenantId: t.tenantId,
          facet: "sensitivity",
          value: "restricted",
          label: "Restricted",
          approved: true,
          visibility: "hidden",
          exposure: "local-only",
        });
      }),
    );
    const byModel = (tx: Parameters<typeof proposeTag>[0]) =>
      proposeTag(tx, t.tenantId, {
        objectId: t.objectId,
        tag: "sensitivity:restricted",
        source: "model",
        appliedBy: "model:small",
        confidence: 0.9,
      });
    const open = () =>
      db.withTenant(t.tenantId, async (tx) =>
        (await tx.select().from(tagReviews)).filter((r) => r.resolvedAt === null),
      );
    const decisions = () =>
      db.withTenant(t.tenantId, (tx) => tagsForDecisions(tx, t.tenantId, t.objectId));

    it("goes back to the model's unreviewed tag when the rule stops giving it", async () => {
      // The value got its levels after the model tagged the file, so the tag applied.
      await db.withTenant(t.tenantId, async (tx) => {
        await tx.insert(objectTags).values({
          tenantId: t.tenantId,
          objectId: t.objectId,
          facet: "sensitivity",
          value: "restricted",
          source: "model",
          appliedBy: "model:small",
          confidence: 0.8,
        });
      });
      await apply({ path: "HR/Pay.xlsx" }, HR);
      expect(await tagsOn()).toContain("sensitivity:restricted (rule)");
      expect((await decisions()).grantable).toContain("sensitivity:restricted");
      // Out of HR/: the rule's reason is gone, the model's guess isn't.
      const moved = await apply({ path: "Misc/Pay.xlsx" }, HR);
      expect(moved).toMatchObject({ removed: [], reverted: ["sensitivity:restricted"] });
      const [row] = await db.withTenant(t.tenantId, (tx) =>
        tx.select().from(objectTags).where(eq(objectTags.value, "restricted")),
      );
      expect(row).toMatchObject({
        source: "model",
        appliedBy: "model:small",
        confidence: expect.closeTo(0.8, 5),
        reviewed: false,
        modelAppliedBy: null,
        modelConfidence: null,
      });
      // It tightens levels again, and grants no longer match it.
      expect(await decisions()).toMatchObject({
        levels: expect.arrayContaining(["sensitivity:restricted"]),
      });
      expect((await decisions()).grantable).not.toContain("sensitivity:restricted");
    });

    it("follows the rule once a person rejected the model's guess", async () => {
      const outcome = await db.withTenant(t.tenantId, byModel);
      if (outcome.applied) throw new Error("expected a review");
      await apply({ path: "HR/Pay.xlsx" }, HR);
      await db.withTenant(t.tenantId, (tx) =>
        rejectReview(tx, t.tenantId, outcome.reviewId, "user:ana"),
      );
      // The rule's tag stays while it applies, and goes with it.
      expect(await tagsOn()).toContain("sensitivity:restricted (rule)");
      expect(await apply({ path: "Misc/Pay.xlsx" }, HR)).toMatchObject({
        removed: ["sensitivity:restricted"],
        reverted: [],
      });
      expect(await open()).toEqual([]);
    });

    it("leaves a model's pending item open, not approved by the rule", async () => {
      const outcome = await db.withTenant(t.tenantId, byModel);
      expect(outcome).toMatchObject({ applied: false, reason: "sensitive" });
      if (outcome.applied) return;
      await apply({ path: "HR/Pay.xlsx" }, HR);
      expect(await tagsOn()).toContain("sensitivity:restricted (rule)");
      expect((await open()).map((r) => r.id)).toEqual([outcome.reviewId]);
      // Moved out: the rule tag goes, the model's item still waits for a person (and tightens).
      expect(await apply({ path: "Misc/Pay.xlsx" }, HR)).toMatchObject({
        removed: ["sensitivity:restricted"],
        withdrawn: [],
      });
      expect((await open()).map((r) => r.id)).toEqual([outcome.reviewId]);
    });

    it("stays when a person approves the model's item while the rule gives it", async () => {
      const outcome = await db.withTenant(t.tenantId, byModel);
      if (outcome.applied) throw new Error("expected a review");
      await apply({ path: "HR/Pay.xlsx" }, HR);
      await db.withTenant(t.tenantId, (tx) =>
        approveReview(tx, t.tenantId, outcome.reviewId, "user:ana"),
      );
      expect(await tagsOn()).toContain("sensitivity:restricted (model)");
      expect(await apply({ path: "Misc/Pay.xlsx" }, HR)).toMatchObject({
        removed: [],
        reverted: [],
      });
      expect(await tagsOn()).toContain("sensitivity:restricted (model)");
    });
  });

  it("keeps a rule tag a person confirmed, as theirs", async () => {
    await apply({ path: "Clients/Acme/Plan.docx" });
    expect(await tagsOn()).toContain("client:acme (rule)");
    await db.withTenant(t.tenantId, (tx) =>
      proposeTag(tx, t.tenantId, {
        objectId: t.objectId,
        tag: "client:acme",
        source: "user",
        appliedBy: "user:ana",
        confidence: 1,
      }),
    );
    expect(await tagsOn()).toContain("client:acme (user)");
    expect((await apply({ path: "Misc/Plan.docx" })).removed).not.toContain("client:acme");
    expect(await tagsOn()).toContain("client:acme (user)");
  });

  it("withdraws a rule's open item once no rule gives its tag", async () => {
    const first = await apply({ path: "Finance.xlsx" });
    const waiting = first.outcomes.find((o) => !o.applied);
    if (waiting === undefined || waiting.applied) throw new Error("expected a review");
    // Still given: the item stays.
    expect((await apply({ path: "Other.xlsx" })).withdrawn).toEqual([]);
    const moved = await apply({ path: "Other.docx" });
    expect(moved.withdrawn).toEqual([waiting.reviewId]);
    const [item] = await db.withTenant(t.tenantId, (tx) =>
      tx.select().from(tagReviews).where(eq(tagReviews.id, waiting.reviewId)),
    );
    expect(item).toMatchObject({ decision: "withdrawn", resolvedBy: "rule:spreadsheets" });
    // Given again later: a fresh item.
    const again = await apply({ path: "Again.xlsx" });
    expect(again.outcomes.find((o) => !o.applied)).toMatchObject({ reason: "new-value" });
  });
});
