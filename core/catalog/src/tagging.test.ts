import {
  facets,
  facetValues,
  grants,
  newId,
  objects,
  objectTags,
  tagReviews,
  type Database,
  type Tx,
} from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approveReview,
  listOpenReviews,
  mergeReview,
  proposeTag,
  rejectReview,
  tagsForDecisions,
  TagError,
  type TagProposal,
} from "./tagging.js";

/* T-406: new values are proposed, never auto-created; risky model tags wait for a person. */

let db: Database;
let t: SeededTenant;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  await db.withTenant(t.tenantId, async (tx) => {
    await tx
      .insert(facets)
      .values({ tenantId: t.tenantId, key: "sensitivity", label: "Sensitivity" });
    await tx.insert(facetValues).values([
      { tenantId: t.tenantId, facet: "client", value: "globex", label: "Globex", approved: true },
      {
        tenantId: t.tenantId,
        facet: "sensitivity",
        value: "restricted",
        label: "Restricted",
        approved: true,
        visibility: "hidden",
        exposure: "local-only",
      },
    ]);
  });
});
afterEach(() => db?.close());

const inTenant = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work);
const propose = (p: Partial<TagProposal>) =>
  inTenant((tx) =>
    proposeTag(tx, t.tenantId, {
      objectId: t.objectId,
      tag: "client:globex",
      source: "model",
      confidence: 0.9,
      ...p,
      // The applier is of the source's kind unless a test says otherwise.
      appliedBy: p.appliedBy ?? `${p.source ?? "model"}:small-tagger`,
    }),
  );
const tagsOn = () =>
  inTenant(async (tx) =>
    (await tx.select().from(objectTags).where(eq(objectTags.objectId, t.objectId)))
      .map((r) => `${r.facet}:${r.value}${r.reviewed ? " (reviewed)" : ""}`)
      .sort(),
  );
const value = (facet: string, v: string) =>
  inTenant(
    async (tx) =>
      (
        await tx
          .select()
          .from(facetValues)
          .where(and(eq(facetValues.facet, facet), eq(facetValues.value, v)))
      )[0],
  );
const reviews = () => inTenant((tx) => listOpenReviews(tx, t.tenantId));
const newObject = () =>
  inTenant(async (tx) => {
    const id = newId("object");
    await tx.insert(objects).values({
      tenantId: t.tenantId,
      id,
      zoneId: t.zoneId,
      title: "Other.docx",
      ownerId: "user:owner-1",
    });
    return id;
  });

describe("proposeTag", () => {
  it("applies a confident model tag from the approved vocabulary", async () => {
    expect(await propose({})).toEqual({ applied: true, tag: "client:globex" });
    expect(await tagsOn()).toEqual(["client:acme-1", "client:globex"]);
    expect(await reviews()).toEqual([]);
  });

  it.each(["rule", "pack", "user"] as const)(
    "applies a %s tag even when it sets levels or is unsure",
    async (source) => {
      expect(
        await propose({ source, tag: "sensitivity:restricted", confidence: 0.1 }),
      ).toMatchObject({
        applied: true,
      });
    },
  );

  it("files a new value for review instead of creating it, whoever proposes it", async () => {
    for (const source of ["model", "rule", "user"] as const) {
      const outcome = await propose({ source, tag: `client:initech-${source}`, label: "Initech" });
      expect(outcome).toMatchObject({ applied: false, reason: "new-value" });
      expect(await value("client", `initech-${source}`)).toMatchObject({
        approved: false,
        label: "Initech",
      });
    }
    expect(await tagsOn()).toEqual(["client:acme-1"]);
    expect((await reviews()).map((r) => r.value)).toEqual([
      "initech-model",
      "initech-rule",
      "initech-user",
    ]);
  });

  it("sends a model's value that sets visibility or exposure to review", async () => {
    expect(await propose({ tag: "sensitivity:restricted", confidence: 0.99 })).toMatchObject({
      applied: false,
      reason: "sensitive",
    });
    expect(await tagsOn()).toEqual(["client:acme-1"]);
  });

  it("sends a low-confidence model tag to review, at a threshold the caller can set", async () => {
    expect(await propose({ confidence: 0.5 })).toMatchObject({ reason: "low-confidence" });
    const strict = await inTenant((tx) =>
      proposeTag(
        tx,
        t.tenantId,
        { objectId: t.objectId, tag: "client:globex", source: "model", confidence: 0.9 },
        { minConfidence: 0.95 },
      ),
    );
    // Same object and tag, still open: the same item comes back.
    expect(strict).toMatchObject({ applied: false, reason: "low-confidence" });
    expect(await reviews()).toHaveLength(1);
  });

  it("files one open item per object and tag, however often it is proposed", async () => {
    const first = await propose({ tag: "client:new-co" });
    const again = await propose({ tag: "client:new-co", source: "user" });
    expect(again).toEqual(first);
    expect(await reviews()).toHaveLength(1);
  });

  it("sends a model's tag that a live grant names to review: it would widen access", async () => {
    await inTenant((tx) =>
      tx.insert(grants).values({
        tenantId: t.tenantId,
        id: "grt_00000000000000000000000001",
        principal: "group:globex-external",
        role: "read",
        facet: "client",
        value: "globex",
        grantedBy: "user:admin",
        expiresAt: null,
      }),
    );
    expect(await propose({ confidence: 0.99 })).toMatchObject({
      applied: false,
      reason: "sensitive",
    });
    // A rule may still apply it directly, here to another object.
    const other = await newObject();
    expect(
      await propose({ source: "rule", appliedBy: "rule:dict", confidence: 1, objectId: other }),
    ).toMatchObject({ applied: true });
  });

  it("refuses an applier of another kind than the source", async () => {
    await expect(propose({ source: "user", appliedBy: "model:x" })).rejects.toThrow(
      "appliedBy must be a user: principal",
    );
    const forged = inTenant((tx) =>
      tx.insert(objectTags).values({
        tenantId: t.tenantId,
        objectId: t.objectId,
        facet: "client",
        value: "globex",
        source: "user",
        appliedBy: "model:x",
        confidence: 1,
      }),
    );
    await expect(forged).rejects.toThrow();
  });

  it("does nothing for a tag the object already has", async () => {
    expect(await propose({ tag: t.tag, confidence: 0.1 })).toEqual({ applied: true, tag: t.tag });
    expect(await reviews()).toEqual([]);
  });

  it("refuses unknown facets, malformed tags and impossible confidences", async () => {
    await expect(propose({ tag: "project:apollo" })).rejects.toThrow("unknown facet: project");
    await expect(propose({ tag: "client" })).rejects.toThrow("a tag is facet:value");
    await expect(propose({ confidence: 1.5 })).rejects.toThrow("confidence must be in [0, 1]");
    await expect(propose({ confidence: Number.NaN })).rejects.toThrow("confidence");
    // The vocabulary's own rules still hold for proposed values.
    await expect(propose({ tag: "client:Not A Slug" })).rejects.toThrow("is not a value");
  });

  it.each<[string, Partial<TagProposal>, string]>([
    ["a value that isn't a slug", { tag: "client:Not A Slug" }, "invalid"],
    ["a value over 128 characters", { tag: `client:${"a".repeat(129)}` }, "invalid"],
    ["a value with NUL", { tag: "client:a\0b" }, "invalid"],
    ["a facet that isn't a key", { tag: "Client:acme" }, "invalid"],
    ["a label over 200 characters", { tag: "client:new-co", label: "x".repeat(201) }, "invalid"],
    ["a blank label", { tag: "client:new-co", label: "  " }, "invalid"],
    ["a label with NUL", { tag: "client:new-co", label: "New\0Co" }, "invalid"],
    ["an applier with NUL", { appliedBy: "model:\0" }, "invalid"],
    ["an unknown facet", { tag: "project:apollo" }, "unknown-facet"],
    ["an unknown object", { objectId: newId("object") }, "unknown-object"],
  ])("refuses %s with a TagError, and the transaction goes on", async (_, change, code) => {
    await inTenant(async (tx) => {
      const refused = await proposeTag(tx, t.tenantId, {
        objectId: t.objectId,
        tag: "client:globex",
        source: "model",
        confidence: 0.9,
        ...change,
      }).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(TagError);
      expect(refused).toMatchObject({ code });
      expect(
        await proposeTag(tx, t.tenantId, {
          objectId: t.objectId,
          tag: "client:globex",
          source: "model",
          confidence: 0.9,
        }),
      ).toMatchObject({ applied: true });
    });
    expect(await value("client", "new-co")).toBeUndefined();
  });
});

describe("tagsForDecisions", () => {
  it("lets every tag tighten levels, but only trusted or reviewed ones match grants", async () => {
    await propose({ confidence: 0.9 }); // a confident model tag: applied, unreviewed
    const low = await propose({ tag: "sensitivity:restricted", confidence: 0.99 });
    if (low.applied) throw new Error("expected a review");
    await inTenant((tx) => approveReview(tx, t.tenantId, low.reviewId, "user:reviewer"));
    expect(await inTenant((tx) => tagsForDecisions(tx, t.tenantId, t.objectId))).toEqual({
      levels: ["client:acme-1", "client:globex", "sensitivity:restricted"],
      grantable: ["client:acme-1", "sensitivity:restricted"],
    });
  });
});

describe("the review inbox", () => {
  it("approving applies the tag as reviewed and adds the value to the vocabulary", async () => {
    const outcome = await propose({ tag: "client:initech", label: "Initech" });
    if (outcome.applied) throw new Error("expected a review");
    const now = new Date();
    await inTenant((tx) => approveReview(tx, t.tenantId, outcome.reviewId, "user:reviewer", now));
    expect(await tagsOn()).toEqual(["client:acme-1", "client:initech (reviewed)"]);
    expect(await value("client", "initech")).toMatchObject({ approved: true });
    expect(await reviews()).toEqual([]);
    const [item] = await inTenant((tx) =>
      tx.select().from(tagReviews).where(eq(tagReviews.id, outcome.reviewId)),
    );
    expect(item).toMatchObject({
      decision: "approved",
      resolvedBy: "user:reviewer",
      resolvedAt: now,
    });
  });

  it("rejecting applies nothing and leaves a proposed value unapproved", async () => {
    const outcome = await propose({ tag: "client:typo-co" });
    if (outcome.applied) throw new Error("expected a review");
    await inTenant((tx) => rejectReview(tx, t.tenantId, outcome.reviewId, "user:reviewer"));
    expect(await tagsOn()).toEqual(["client:acme-1"]);
    expect(await value("client", "typo-co")).toMatchObject({ approved: false });
    // Proposing it again opens a new item: the rejection is history, not a ban.
    const again = await propose({ tag: "client:typo-co" });
    expect(again).toMatchObject({ applied: false, reason: "new-value" });
    expect(!again.applied && again.reviewId).not.toBe(outcome.reviewId);
  });

  it("merging applies an existing value instead, and leaves the proposed one unapproved", async () => {
    const outcome = await propose({ tag: "client:globex-corp" });
    if (outcome.applied) throw new Error("expected a review");
    await inTenant((tx) =>
      mergeReview(tx, t.tenantId, outcome.reviewId, "globex", "user:reviewer"),
    );
    expect(await tagsOn()).toEqual(["client:acme-1", "client:globex (reviewed)"]);
    expect(await value("client", "globex-corp")).toMatchObject({ approved: false });
    const [item] = await inTenant((tx) =>
      tx.select().from(tagReviews).where(eq(tagReviews.id, outcome.reviewId)),
    );
    expect(item).toMatchObject({ decision: "merged", mergedInto: "globex" });
  });

  it("holds a tag with an open item until the item is decided, whoever proposes it again", async () => {
    const outcome = await propose({ tag: "client:new-co" });
    if (outcome.applied) throw new Error("expected a review");
    expect(await propose({ tag: "client:new-co", confidence: 0.99 })).toEqual(outcome);
    expect(
      await propose({ tag: "client:new-co", source: "rule", appliedBy: "rule:x", confidence: 1 }),
    ).toEqual(outcome);
    expect(await tagsOn()).toEqual(["client:acme-1"]);
    await inTenant((tx) => approveReview(tx, t.tenantId, outcome.reviewId, "user:reviewer"));
    expect(await tagsOn()).toEqual(["client:acme-1", "client:new-co (reviewed)"]);
  });

  it("lets a trusted source apply a tag a model's item waits on; only a person closes the item", async () => {
    const outcome = await propose({ confidence: 0.2 });
    if (outcome.applied) throw new Error("expected a review");
    // Another model's word changes nothing.
    expect(await propose({ confidence: 0.99 })).toEqual(outcome);
    expect(await propose({ source: "rule", appliedBy: "rule:x", confidence: 1 })).toEqual({
      applied: true,
      tag: "client:globex",
    });
    expect(await inTenant((tx) => tagsForDecisions(tx, t.tenantId, t.objectId))).toMatchObject({
      grantable: ["client:acme-1", "client:globex"],
    });
    // The rule may stop giving the tag; the model's guess waits for a person meanwhile.
    expect((await reviews()).map((r) => r.id)).toEqual([outcome.reviewId]);
    expect(await propose({ source: "user", appliedBy: "user:ana", confidence: 1 })).toEqual({
      applied: true,
      tag: "client:globex",
    });
    expect(await reviews()).toEqual([]);
    const [item] = await inTenant((tx) =>
      tx.select().from(tagReviews).where(eq(tagReviews.id, outcome.reviewId)),
    );
    expect(item).toMatchObject({ decision: "approved", resolvedBy: "user:ana" });
    const [row] = await inTenant((tx) =>
      tx.select().from(objectTags).where(eq(objectTags.value, "globex")),
    );
    expect(row).toMatchObject({ source: "user", appliedBy: "user:ana", modelConfidence: null });
    // A model's sensitive item too, for a person.
    const sensitive = await propose({ tag: "sensitivity:restricted", confidence: 0.99 });
    expect(sensitive).toMatchObject({ applied: false, reason: "sensitive" });
    expect(
      await propose({ tag: "sensitivity:restricted", source: "user", confidence: 1 }),
    ).toMatchObject({ applied: true });
    expect(await reviews()).toEqual([]);
  });

  it("hands a model's unreviewed tag to a trusted source that proposes it, so grants match it", async () => {
    expect(await propose({ confidence: 0.9 })).toMatchObject({ applied: true });
    const grantable = async () =>
      (await inTenant((tx) => tagsForDecisions(tx, t.tenantId, t.objectId))).grantable;
    expect(await grantable()).toEqual(["client:acme-1"]);
    expect(await propose({ source: "pack", appliedBy: "pack:general", confidence: 1 })).toEqual({
      applied: true,
      tag: "client:globex",
    });
    expect(await grantable()).toEqual(["client:acme-1", "client:globex"]);
    const [row] = await inTenant((tx) =>
      tx.select().from(objectTags).where(eq(objectTags.value, "globex")),
    );
    expect(row).toMatchObject({
      source: "pack",
      appliedBy: "pack:general",
      confidence: 1,
      // The model's guess, kept for when the pack no longer gives the tag.
      modelAppliedBy: "model:small-tagger",
      modelConfidence: expect.closeTo(0.9, 5),
    });
    // A model proposing a trusted tag again takes nothing back.
    await propose({ confidence: 0.8 });
    expect(await grantable()).toEqual(["client:acme-1", "client:globex"]);
  });

  it("rejecting takes off an unreviewed model tag that got on anyway", async () => {
    const outcome = await propose({ confidence: 0.2 });
    if (outcome.applied) throw new Error("expected a review");
    // As if a race or an older version had applied it.
    await inTenant((tx) =>
      tx.insert(objectTags).values({
        tenantId: t.tenantId,
        objectId: t.objectId,
        facet: "client",
        value: "globex",
        source: "model",
        appliedBy: "model:small-tagger",
        confidence: 0.2,
      }),
    );
    await inTenant((tx) => rejectReview(tx, t.tenantId, outcome.reviewId, "user:reviewer"));
    expect(await tagsOn()).toEqual(["client:acme-1"]);
  });

  it("rejecting a new value closes every open item proposing it", async () => {
    const other = await newObject();
    const a = await propose({ tag: "client:bogus" });
    const b = await propose({ tag: "client:bogus", objectId: other });
    if (a.applied || b.applied) throw new Error("expected reviews");
    expect(b.reviewId).not.toBe(a.reviewId);
    await inTenant((tx) => rejectReview(tx, t.tenantId, a.reviewId, "user:reviewer"));
    expect(await reviews()).toEqual([]);
    await expect(
      inTenant((tx) => approveReview(tx, t.tenantId, b.reviewId, "user:other-reviewer")),
    ).rejects.toThrow("already resolved");
    expect(await value("client", "bogus")).toMatchObject({ approved: false });
  });

  it("stamps decisions with the database's time by default", async () => {
    const outcome = await propose({ tag: "client:stamp" });
    if (outcome.applied) throw new Error("expected a review");
    await inTenant((tx) => rejectReview(tx, t.tenantId, outcome.reviewId, "user:reviewer"));
    const [item] = await inTenant((tx) =>
      tx.select().from(tagReviews).where(eq(tagReviews.id, outcome.reviewId)),
    );
    expect(item?.resolvedAt?.getTime()).toBeGreaterThanOrEqual(item?.createdAt.getTime() ?? 0);
  });

  it("never leaves an open item beside an applied tag when approve and propose race", async () => {
    for (let round = 0; round < 5; round++) {
      const tag = `client:race-${round}`;
      const outcome = await propose({ tag });
      if (outcome.applied) throw new Error("expected a review");
      await Promise.all([
        inTenant((tx) => approveReview(tx, t.tenantId, outcome.reviewId, "user:reviewer")),
        propose({ tag }),
        propose({ tag, source: "user", appliedBy: "user:ana", confidence: 1 }),
      ]);
      expect(await reviews()).toEqual([]);
      expect(await tagsOn()).toContain(`${tag} (reviewed)`);
    }
  });

  it("never deadlocks two reviewers rejecting one new value on different objects", async () => {
    const others = [await newObject(), await newObject()];
    for (let round = 0; round < 10; round++) {
      const tag = `client:bogus-${round}`;
      const [a, b] = await Promise.all(others.map((objectId) => propose({ tag, objectId })));
      if (!a || !b || a.applied || b.applied) throw new Error("expected reviews");
      const settled = await Promise.allSettled([
        inTenant((tx) => rejectReview(tx, t.tenantId, a.reviewId, "user:one")),
        inTenant((tx) => rejectReview(tx, t.tenantId, b.reviewId, "user:two")),
      ]);
      // One closes both; the other finds its item decided, and says so in a way a caller can tell.
      expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
      const [refused] = settled.flatMap((s) => (s.status === "rejected" ? [s.reason] : []));
      expect(refused).toBeInstanceOf(TagError);
      expect(refused).toMatchObject({ code: "already-resolved" });
      expect(await reviews()).toEqual([]);
    }
  });

  it("decides a review twice at once only once", async () => {
    for (let round = 0; round < 5; round++) {
      const outcome = await propose({ tag: `client:twice-${round}` });
      if (outcome.applied) throw new Error("expected a review");
      const settled = await Promise.allSettled([
        inTenant((tx) => approveReview(tx, t.tenantId, outcome.reviewId, "user:one")),
        inTenant((tx) => mergeReview(tx, t.tenantId, outcome.reviewId, "globex", "user:two")),
        inTenant((tx) => rejectReview(tx, t.tenantId, outcome.reviewId, "user:three")),
      ]);
      expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
      for (const s of settled) {
        if (s.status === "rejected") expect(s.reason).toMatchObject({ code: "already-resolved" });
      }
    }
  });

  it("refuses to resolve an item twice, or one that does not exist", async () => {
    const outcome = await propose({ tag: "client:twice" });
    if (outcome.applied) throw new Error("expected a review");
    await inTenant((tx) => rejectReview(tx, t.tenantId, outcome.reviewId, "user:a"));
    await expect(
      inTenant((tx) => approveReview(tx, t.tenantId, outcome.reviewId, "user:b")),
    ).rejects.toThrow("already resolved");
    await expect(
      inTenant((tx) => rejectReview(tx, t.tenantId, "rev_00000000000000000000000000", "user:b")),
    ).rejects.toThrow("no review item");
  });

  it("merges only into another approved value of the same facet", async () => {
    const outcome = await propose({ tag: "client:merge-me" });
    if (outcome.applied) throw new Error("expected a review");
    const merge = (into: string) =>
      inTenant((tx) => mergeReview(tx, t.tenantId, outcome.reviewId, into, "user:reviewer"));
    await expect(merge("nobody")).rejects.toThrow("not an approved value");
    await expect(merge("merge-me")).rejects.toThrow("into itself");
    await propose({ tag: "client:also-new" });
    await expect(merge("also-new")).rejects.toThrow("not an approved value");
    expect((await reviews()).map((r) => r.value)).toContain("merge-me");
  });

  it("lists open items oldest first, up to a limit", async () => {
    for (const v of ["a-co", "b-co", "c-co"]) await propose({ tag: `client:${v}` });
    expect((await reviews()).map((r) => r.value)).toEqual(["a-co", "b-co", "c-co"]);
    expect(await inTenant((tx) => listOpenReviews(tx, t.tenantId, 2))).toHaveLength(2);
  });
});
