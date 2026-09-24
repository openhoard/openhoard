import fc from "fast-check";
import { facets, facetValues, objectTags, tagReviews, type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyRuleTags, evaluateRules, globMatch, validateRules, type TagRule } from "./rules.js";

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

  it("applies approved tags as the rule, and files new values for review", async () => {
    const outcomes = await db.withTenant(t.tenantId, (tx) =>
      applyRuleTags(tx, t.tenantId, t.objectId, RULES, { path: "Clients/Acme/Finance.xlsx" }),
    );
    expect(outcomes).toEqual([
      { applied: true, tag: "client:acme", rule: "clients" },
      { applied: false, reviewId: expect.any(String), reason: "new-value", rule: "spreadsheets" },
    ]);
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
});
