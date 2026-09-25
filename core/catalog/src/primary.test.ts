import {
  facets,
  facetValues,
  objectTags,
  tagReviews,
  tenantPacks,
  type Database,
  type Tx,
} from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearPrimaryTag, primaryTagOf, proposePrimaryTag, setPrimaryTag } from "./primary.js";
import { applyRuleTags, validateRules, type TagRule } from "./rules.js";
import {
  approveReview,
  mergeReview,
  proposeTag,
  rejectReview,
  tagsForDecisions,
  TagError,
  type TagProposal,
} from "./tagging.js";

/* T-409: an object's primary tag (its home), and single-value facets. */

let db: Database;
let t: SeededTenant;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  await db.withTenant(t.tenantId, async (tx) => {
    await tx.insert(facets).values([
      { tenantId: t.tenantId, key: "project", label: "Project" },
      { tenantId: t.tenantId, key: "sensitivity", label: "Sensitivity", single: true },
    ]);
    const value = (facet: string, v: string, extra = {}) => ({
      tenantId: t.tenantId,
      facet,
      value: v,
      label: v,
      approved: true,
      ...extra,
    });
    await tx
      .insert(facetValues)
      .values([
        value("project", "apollo"),
        value("project", "gemini"),
        value("sensitivity", "internal"),
        value("sensitivity", "restricted", { visibility: "hidden", exposure: "local-only" }),
      ]);
  });
});
afterEach(() => db?.close());

const inTenant = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work);
const propose = (p: Partial<TagProposal> & { tag: string }) =>
  inTenant((tx) =>
    proposeTag(tx, t.tenantId, {
      objectId: t.objectId,
      source: "user",
      confidence: 1,
      ...p,
      appliedBy: p.appliedBy ?? `${p.source ?? "user"}:ana`,
    }),
  );
const home = () => inTenant((tx) => primaryTagOf(tx, t.tenantId, t.objectId));
const setHome = (tag: string, by = "user:ana") =>
  inTenant((tx) => setPrimaryTag(tx, t.tenantId, { objectId: t.objectId, tag, by }));
const tagsOn = () =>
  inTenant(async (tx) =>
    (await tx.select().from(objectTags).where(eq(objectTags.objectId, t.objectId)))
      .map(
        (r) =>
          `${r.facet}:${r.value} (${r.source}${r.primaryBy ? `, home by ${r.primaryBy}` : ""})`,
      )
      .sort(),
  );
const openItems = () =>
  inTenant((tx) => tx.select().from(tagReviews).where(isNull(tagReviews.resolvedAt)));

describe("the primary tag", () => {
  it("is one trusted tag a person picks, moves when they pick another, and can be cleared", async () => {
    expect(await home()).toBeNull();
    await propose({ tag: "project:apollo" });
    await propose({ tag: "project:gemini" });
    await setHome("project:apollo");
    expect(await home()).toEqual({ tag: "project:apollo", by: "user:ana" });
    await setHome("project:gemini", "user:bo");
    expect(await home()).toEqual({ tag: "project:gemini", by: "user:bo" });
    // A rule's tag (the seeded client:acme-1) can be the home too.
    await setHome("client:acme-1");
    expect(await home()).toMatchObject({ tag: "client:acme-1" });
    expect(await inTenant((tx) => clearPrimaryTag(tx, t.tenantId, t.objectId))).toBe(true);
    expect(await home()).toBeNull();
    expect(await inTenant((tx) => clearPrimaryTag(tx, t.tenantId, t.objectId))).toBe(false);
  });

  it("grants nothing by itself: decisions read the same tags", async () => {
    await propose({ tag: "project:apollo" });
    const before = await inTenant((tx) => tagsForDecisions(tx, t.tenantId, t.objectId));
    await setHome("project:apollo");
    expect(await inTenant((tx) => tagsForDecisions(tx, t.tenantId, t.objectId))).toEqual(before);
  });

  it("must be a tag the object carries as a trusted tag", async () => {
    await expect(setHome("project:apollo")).rejects.toMatchObject({ code: "not-on-object" });
    // A model's unreviewed guess is on the object, but no home.
    await propose({ tag: "project:apollo", source: "model", confidence: 0.9 });
    expect(await tagsOn()).toContain("project:apollo (model)");
    await expect(setHome("project:apollo")).rejects.toMatchObject({ code: "not-on-object" });
    // Only a person sets it here.
    await propose({ tag: "project:gemini" });
    for (const by of ["rule:x", "model:m", "ana"]) {
      await expect(setHome("project:gemini", by)).rejects.toBeInstanceOf(TagError);
    }
  });

  it("is held to one per object, on a trusted tag, by the database too", async () => {
    await propose({ tag: "project:apollo" });
    await propose({ tag: "project:gemini" });
    await setHome("project:apollo");
    const raw = (set: object, value: string) =>
      inTenant((tx) =>
        tx
          .update(objectTags)
          .set(set)
          .where(and(eq(objectTags.objectId, t.objectId), eq(objectTags.value, value))),
      );
    await expect(raw({ primaryBy: "user:bo" }, "gemini")).rejects.toThrow();
    await expect(raw({ source: "model", appliedBy: null }, "apollo")).rejects.toThrow();
    await expect(raw({ primaryBy: "model:m" }, "apollo")).rejects.toThrow();
  });

  it("goes with its tag", async () => {
    const rules: TagRule[] = [{ id: "apollo", tag: "project:apollo", when: { path: "Apollo/**" } }];
    const sync = (path: string) =>
      inTenant((tx) => applyRuleTags(tx, t.tenantId, t.objectId, rules, { path }));
    await sync("Apollo/Plan.docx");
    await setHome("project:apollo");
    const moved = await sync("Misc/Plan.docx");
    expect(moved).toMatchObject({ removed: ["project:apollo"], primary: null });
    expect(await home()).toBeNull();
  });

  it("stops being the home when a rule hands its tag back to the model", async () => {
    const rules: TagRule[] = [{ id: "apollo", tag: "project:apollo", when: { path: "Apollo/**" } }];
    const sync = (path: string) =>
      inTenant((tx) => applyRuleTags(tx, t.tenantId, t.objectId, rules, { path }));
    await propose({ tag: "project:apollo", source: "model", confidence: 0.9 });
    await sync("Apollo/Plan.docx");
    await setHome("project:apollo");
    expect(await sync("Misc/Plan.docx")).toMatchObject({ reverted: ["project:apollo"] });
    expect(await home()).toBeNull();
    expect(await tagsOn()).toContain("project:apollo (model)");
  });
});

describe("a model's proposal of the home", () => {
  const byModel = (tag: string) =>
    inTenant((tx) =>
      proposePrimaryTag(tx, t.tenantId, {
        objectId: t.objectId,
        tag,
        appliedBy: "model:small",
        confidence: 0.8,
      }),
    );

  it("waits for a person, who approves it", async () => {
    await propose({ tag: "project:apollo" });
    const outcome = await byModel("project:apollo");
    if (outcome.primary) throw new Error("expected a review");
    expect(await home()).toBeNull();
    // One open proposal per object: a later one gets it back.
    expect(await byModel("client:acme-1")).toEqual(outcome);
    await inTenant((tx) => approveReview(tx, t.tenantId, outcome.reviewId, "user:ana"));
    expect(await home()).toEqual({ tag: "project:apollo", by: "user:ana" });
    expect(await byModel("project:apollo")).toEqual({ primary: true });
  });

  it("changes nothing about the tag when rejected, and can't be merged", async () => {
    await propose({ tag: "project:apollo" });
    const outcome = await byModel("project:apollo");
    if (outcome.primary) throw new Error("expected a review");
    await expect(
      inTenant((tx) => mergeReview(tx, t.tenantId, outcome.reviewId, "gemini", "user:ana")),
    ).rejects.toMatchObject({ code: "invalid" });
    await inTenant((tx) => rejectReview(tx, t.tenantId, outcome.reviewId, "user:ana"));
    expect(await home()).toBeNull();
    expect(await tagsOn()).toContain("project:apollo (user)");
    expect(await openItems()).toEqual([]);
  });

  it("needs the tag to be trusted when proposed and when approved", async () => {
    await expect(byModel("project:apollo")).rejects.toMatchObject({ code: "not-on-object" });
    const rules: TagRule[] = [{ id: "apollo", tag: "project:apollo", when: { path: "Apollo/**" } }];
    const sync = (path: string) =>
      inTenant((tx) => applyRuleTags(tx, t.tenantId, t.objectId, rules, { path }));
    await sync("Apollo/Plan.docx");
    const outcome = await byModel("project:apollo");
    if (outcome.primary) throw new Error("expected a review");
    await sync("Misc/Plan.docx");
    await expect(
      inTenant((tx) => approveReview(tx, t.tenantId, outcome.reviewId, "user:ana")),
    ).rejects.toMatchObject({ code: "not-on-object" });
  });

  it("withdraws a waiting proposal whose tag left the object when the model proposes again", async () => {
    const rules: TagRule[] = [{ id: "apollo", tag: "project:apollo", when: { path: "Apollo/**" } }];
    await inTenant((tx) =>
      applyRuleTags(tx, t.tenantId, t.objectId, rules, { path: "Apollo/Plan.docx" }),
    );
    const stale = await byModel("project:apollo");
    if (stale.primary) throw new Error("expected a review");
    await inTenant((tx) => applyRuleTags(tx, t.tenantId, t.objectId, rules, { path: "Misc/x" }));
    await propose({ tag: "project:gemini" });
    const fresh = await byModel("project:gemini");
    expect(fresh).toMatchObject({ primary: false, tag: "project:gemini" });
    const [old] = await inTenant((tx) =>
      tx.select().from(tagReviews).where(eq(tagReviews.id, stale.reviewId)),
    );
    expect(old).toMatchObject({ decision: "withdrawn", resolvedBy: "model:small" });
  });

  it("refuses odd appliers, reviewers and objects before writing", async () => {
    await propose({ tag: "project:apollo" });
    const long = `model:${"x".repeat(1100)}`;
    await expect(
      inTenant((tx) =>
        proposePrimaryTag(tx, t.tenantId, {
          objectId: t.objectId,
          tag: "project:apollo",
          appliedBy: long,
          confidence: 1,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      inTenant((tx) =>
        proposePrimaryTag(tx, t.tenantId, {
          objectId: "obj_00000000000000000000000000",
          tag: "project:apollo",
          confidence: 1,
        }),
      ),
    ).rejects.toMatchObject({ code: "unknown-object" });
    const outcome = await byModel("project:apollo");
    if (outcome.primary) throw new Error("expected a review");
    await expect(
      inTenant((tx) => approveReview(tx, t.tenantId, outcome.reviewId, "user:")),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("doesn't stand in the way of tagging, or tighten levels", async () => {
    await propose({ tag: "project:apollo" });
    const outcome = await byModel("project:apollo");
    expect(outcome.primary).toBe(false);
    // A model's own item for another tag, and a person's tag, go on as before.
    expect(
      await propose({ tag: "sensitivity:internal", source: "model", confidence: 0.9 }),
    ).toEqual({ applied: true, tag: "sensitivity:internal" });
    expect(await propose({ tag: "project:gemini" })).toMatchObject({ applied: true });
  });
});

describe("rules that give the home", () => {
  const RULES: TagRule[] = [
    { id: "apollo", tag: "project:apollo", when: { path: "Projects/Apollo/**" }, primary: true },
    { id: "gemini", tag: "project:gemini", when: { path: "**/Gemini/**" }, primary: true },
    { id: "clients", tag: "client:acme-1", when: { path: "**/Acme/**" } },
  ];
  const sync = (path: string, rules = RULES) =>
    inTenant((tx) => applyRuleTags(tx, t.tenantId, t.objectId, rules, { path }));

  it("carry a folder layout over, and follow the file when it moves", async () => {
    expect((await sync("Projects/Apollo/Acme/Plan.docx")).primary).toEqual({
      tag: "project:apollo",
      by: "rule:apollo",
    });
    // Both match: the first primary rule in the list wins.
    expect((await sync("Projects/Apollo/Gemini/Plan.docx")).primary).toMatchObject({
      tag: "project:apollo",
    });
    expect((await sync("Archive/Gemini/Plan.docx")).primary).toEqual({
      tag: "project:gemini",
      by: "rule:gemini",
    });
    // No primary rule matches any more: the rule's home goes.
    expect((await sync("Archive/Acme/Plan.docx")).primary).toBeNull();
    expect(await home()).toBeNull();
  });

  it("never replace or clear a home a person chose", async () => {
    await sync("Projects/Apollo/Acme/Plan.docx");
    await setHome("client:acme-1");
    expect((await sync("Projects/Apollo/Acme/Plan.docx")).primary).toEqual({
      tag: "client:acme-1",
      by: "user:ana",
    });
    expect((await sync("Archive/Gemini/Acme/Plan.docx")).primary).toMatchObject({
      by: "user:ana",
    });
  });

  it("give no home while the rule's tag waits in review", async () => {
    const rules: TagRule[] = [
      { id: "new", tag: "project:mercury", when: { path: "Mercury/**" }, primary: true },
    ];
    const r = await sync("Mercury/Plan.docx", rules);
    expect(r.outcomes).toMatchObject([{ applied: false, reason: "new-value" }]);
    expect(r.primary).toBeNull();
  });

  it("are checked: primary is true or false", () => {
    expect(
      validateRules([{ id: "a", tag: "project:x", when: { path: "**" }, primary: true }]),
    ).toEqual([]);
    expect(
      validateRules([{ id: "a", tag: "project:x", when: { path: "**" }, primary: 1 }]),
    ).toEqual(["a: primary must be true or false"]);
  });
});

describe("single-value facets", () => {
  it("send a second value from anyone but a person to review", async () => {
    await propose({ tag: "sensitivity:internal", source: "rule", appliedBy: "rule:hr" });
    expect(
      await propose({ tag: "sensitivity:restricted", source: "rule", appliedBy: "rule:legal" }),
    ).toMatchObject({ applied: false, reason: "conflict" });
    // A model's second value goes to review too, for whichever reason comes first.
    await inTenant((tx) => tx.delete(tagReviews));
    expect(
      await propose({ tag: "sensitivity:restricted", source: "model", confidence: 0.99 }),
    ).toMatchObject({ applied: false, reason: "sensitive" });
    expect(await tagsOn()).toEqual(["client:acme-1 (rule)", "sensitivity:internal (rule)"]);
  });

  it("let a person's value replace the other when it loosens nothing, home and all", async () => {
    await propose({ tag: "sensitivity:internal", source: "rule", appliedBy: "rule:hr" });
    await setHome("sensitivity:internal", "user:bo");
    expect(await propose({ tag: "sensitivity:restricted" })).toMatchObject({ applied: true });
    // The home moves with it, as the person's who replaced the value.
    expect(await tagsOn()).toEqual([
      "client:acme-1 (rule)",
      "sensitivity:restricted (user, home by user:ana)",
    ]);
  });

  it("send a person's value that would loosen a level to review, and keep the other meanwhile", async () => {
    await propose({ tag: "sensitivity:restricted", source: "rule", appliedBy: "rule:hr" });
    const waiting = await propose({ tag: "sensitivity:internal" });
    expect(waiting).toMatchObject({ applied: false, reason: "conflict" });
    if (waiting.applied) return;
    expect(await tagsOn()).toContain("sensitivity:restricted (rule)");
    // A reviewer must say they replace it.
    await expect(
      inTenant((tx) => approveReview(tx, t.tenantId, waiting.reviewId, "user:lead")),
    ).rejects.toMatchObject({ code: "conflict" });
    await inTenant((tx) =>
      approveReview(tx, t.tenantId, waiting.reviewId, "user:lead", { replace: true }),
    );
    expect(await tagsOn()).toEqual(["client:acme-1 (rule)", "sensitivity:internal (user)"]);
  });

  it("let a person settle a file that carries several values, if that loosens nothing", async () => {
    // Several values from before the facet became single-value.
    await inTenant((tx) =>
      tx.insert(objectTags).values(
        ["internal", "restricted"].map((value) => ({
          tenantId: t.tenantId,
          objectId: t.objectId,
          facet: "sensitivity",
          value,
          source: "user" as const,
          appliedBy: "user:bo",
          confidence: 1,
        })),
      ),
    );
    expect(await propose({ tag: "sensitivity:internal" })).toMatchObject({
      applied: false,
      reason: "conflict",
    });
    expect(await propose({ tag: "sensitivity:restricted" })).toMatchObject({ applied: true });
    expect(await tagsOn()).toEqual(["client:acme-1 (rule)", "sensitivity:restricted (user)"]);
  });

  it("replace the other value when a person approves the one waiting", async () => {
    await propose({ tag: "sensitivity:internal", source: "rule", appliedBy: "rule:hr" });
    const waiting = await propose({
      tag: "sensitivity:restricted",
      source: "rule",
      appliedBy: "rule:legal",
    });
    if (waiting.applied) throw new Error("expected a review");
    await inTenant((tx) =>
      approveReview(tx, t.tenantId, waiting.reviewId, "user:ana", { replace: true }),
    );
    // The reviewer's choice, so the rule leaving later takes nothing off.
    expect(await tagsOn()).toEqual(["client:acme-1 (rule)", "sensitivity:restricted (user)"]);
  });

  it("refuse an approval that would silently replace a value set after the item was filed", async () => {
    const waiting = await propose({
      tag: "sensitivity:internal",
      source: "model",
      appliedBy: "model:m",
      confidence: 0.4,
    });
    expect(waiting).toMatchObject({ reason: "low-confidence" });
    if (waiting.applied) return;
    await propose({ tag: "sensitivity:restricted", appliedBy: "user:bo" });
    await expect(
      inTenant((tx) => approveReview(tx, t.tenantId, waiting.reviewId, "user:ana")),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      inTenant((tx) => mergeReview(tx, t.tenantId, waiting.reviewId, "internal", "user:ana")),
    ).rejects.toBeInstanceOf(TagError);
    expect(await tagsOn()).toContain("sensitivity:restricted (user)");
    // Replacing needs a person as the reviewer.
    await expect(
      inTenant((tx) =>
        approveReview(tx, t.tenantId, waiting.reviewId, "system:sweep", { replace: true }),
      ),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("keep rules from raising a person's choice again, and let the first rule win", async () => {
    const rules: TagRule[] = [
      { id: "legal", tag: "sensitivity:restricted", when: { path: "Legal/**" } },
      { id: "internal", tag: "sensitivity:internal", when: { path: "**" } },
    ];
    const sync = (path: string) =>
      inTenant((tx) => applyRuleTags(tx, t.tenantId, t.objectId, rules, { path }));
    // Two rules match: only the first proposes, so they never take turns replacing each other.
    const both = await sync("Legal/Contract.docx");
    expect(both).toMatchObject({ skipped: ["sensitivity:internal"] });
    expect(await tagsOn()).toContain("sensitivity:restricted (rule)");
    expect(await openItems()).toEqual([]);
    // A person's value stands: the rules propose nothing for that facet.
    await propose({ tag: "sensitivity:internal", appliedBy: "user:ana" }).then(async (o) => {
      if (!o.applied) {
        await inTenant((tx) =>
          approveReview(tx, t.tenantId, o.reviewId, "user:lead", { replace: true }),
        );
      }
    });
    const again = await sync("Legal/Contract.docx");
    expect(again.skipped).toEqual(["sensitivity:internal", "sensitivity:restricted"]);
    expect(await openItems()).toEqual([]);
    expect(await tagsOn()).toContain("sensitivity:internal (user)");
  });

  it("keep a rule's own approved value, and move a file from one rule's value to another's", async () => {
    await inTenant((tx) =>
      tx.insert(facetValues).values({
        tenantId: t.tenantId,
        facet: "sensitivity",
        value: "secret",
        label: "Secret",
        approved: false,
      }),
    );
    const rules: TagRule[] = [
      { id: "vault", tag: "sensitivity:secret", when: { path: "Vault/**" } },
      { id: "hr", tag: "sensitivity:internal", when: { path: "HR/**" } },
      { id: "legal", tag: "sensitivity:restricted", when: { path: "Legal/**" } },
    ];
    const sync = (path: string) =>
      inTenant((tx) => applyRuleTags(tx, t.tenantId, t.objectId, rules, { path }));
    const first = await sync("Vault/a.docx");
    const item = first.outcomes[0];
    if (!item || item.applied) throw new Error("expected a review");
    await inTenant((tx) => approveReview(tx, t.tenantId, item.reviewId, "user:ana"));
    expect(await sync("Vault/a.docx")).toMatchObject({ skipped: [], removed: [] });
    expect(await tagsOn()).toContain("sensitivity:secret (rule)");
    // Moving: the old rule's value goes before the new rule's is proposed, so nothing conflicts.
    const moved = await sync("HR/a.docx");
    expect(moved.outcomes).toEqual([{ applied: true, tag: "sensitivity:internal", rule: "hr" }]);
    expect(await sync("Legal/a.docx")).toMatchObject({
      outcomes: [{ applied: true, tag: "sensitivity:restricted" }],
      removed: ["sensitivity:internal"],
    });
    expect(await openItems()).toEqual([]);
  });

  it("settle a conflict once the other value is gone, and withdraw items for values replaced", async () => {
    await propose({ tag: "sensitivity:restricted", source: "rule", appliedBy: "rule:hr" });
    const conflict = await propose({ tag: "sensitivity:internal", appliedBy: "user:ana" });
    if (conflict.applied) throw new Error("expected a review");
    // Someone clears the way (here, straight in the table); proposing again now applies.
    await inTenant((tx) => tx.delete(objectTags).where(eq(objectTags.value, "restricted")));
    expect(await propose({ tag: "sensitivity:internal", appliedBy: "user:ana" })).toMatchObject({
      applied: true,
    });
    const [closed] = await inTenant((tx) =>
      tx.select().from(tagReviews).where(eq(tagReviews.id, conflict.reviewId)),
    );
    expect(closed).toMatchObject({ decision: "withdrawn", resolvedBy: "user:ana" });
    // A model's item waiting on a value that a person's tighter choice replaces is withdrawn.
    await inTenant((tx) => tx.delete(objectTags).where(eq(objectTags.value, "internal")));
    await propose({ tag: "sensitivity:internal", source: "rule", appliedBy: "rule:hr" });
    await inTenant((tx) =>
      tx.insert(tagReviews).values({
        tenantId: t.tenantId,
        id: "rev_00000000000000000000000001",
        objectId: t.objectId,
        facet: "sensitivity",
        value: "internal",
        reason: "primary",
        source: "model",
        appliedBy: "model:m",
        confidence: 0.9,
      }),
    );
    await propose({ tag: "sensitivity:restricted", appliedBy: "user:bo" });
    expect(await openItems()).toEqual([]);
  });

  it("count a value a pack's policy names as loosening when taken off", async () => {
    await inTenant(async (tx) => {
      await tx.insert(facets).values({
        tenantId: t.tenantId,
        key: "department",
        label: "Department",
        single: true,
      });
      await tx.insert(facetValues).values(
        ["hr", "sales"].map((value) => ({
          tenantId: t.tenantId,
          facet: "department",
          value,
          label: value,
          approved: true,
        })),
      );
      await tx.insert(tenantPacks).values({
        tenantId: t.tenantId,
        name: "guard",
        version: "1.0.0",
        content: {
          pack_version: 1,
          name: "guard",
          version: "1.0.0",
          policies: {
            p: 'forbid (principal, action, resource) when { principal.guest && resource.allTags.contains("department:hr") };',
          },
        },
        contentHash: "1".repeat(64),
        appliedBy: "user:admin",
      });
    });
    await propose({ tag: "department:hr", source: "rule", appliedBy: "rule:hr" });
    expect(await propose({ tag: "department:sales" })).toMatchObject({
      applied: false,
      reason: "conflict",
    });
  });

  it("move the home onto a value a person picks even if a model put it there", async () => {
    await inTenant((tx) =>
      tx.insert(objectTags).values([
        {
          tenantId: t.tenantId,
          objectId: t.objectId,
          facet: "sensitivity",
          value: "internal",
          source: "user",
          appliedBy: "user:bo",
          confidence: 1,
          primaryBy: "user:bo",
        },
        {
          tenantId: t.tenantId,
          objectId: t.objectId,
          facet: "sensitivity",
          value: "restricted",
          source: "model",
          appliedBy: "model:m",
          confidence: 0.9,
        },
      ]),
    );
    expect(await propose({ tag: "sensitivity:restricted" })).toMatchObject({ applied: true });
    expect(await tagsOn()).toContain("sensitivity:restricted (user, home by user:ana)");
  });

  it("don't limit other facets", async () => {
    await propose({ tag: "project:apollo", source: "rule", appliedBy: "rule:a" });
    expect(
      await propose({ tag: "project:gemini", source: "rule", appliedBy: "rule:g" }),
    ).toMatchObject({ applied: true });
  });
});
