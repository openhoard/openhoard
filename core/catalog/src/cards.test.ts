import {
  auditEvents,
  blobs,
  facets,
  facetValues,
  newId,
  users,
  versions,
  objectTags,
  tenants,
  versionCards,
  type Database,
  type Tx,
} from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import {
  Authorizer,
  createCedarEngine,
  EXPOSURE,
  mayProcess,
  type AuthzPrincipal,
  type ClientTrust,
  type Exposure,
} from "@openhoard/core-policy";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActivityBuffer } from "./activity.js";
import { modelVocabulary, readCard, saveCard } from "./cards.js";
import { viewObject } from "./read.js";
import {
  applyInjectionFlag,
  clearInjectionReview,
  hasInjectionFlag,
  INJECTION_DETECTOR,
  injectionReviewOf,
  markNotInjection,
  reviewedNotInjection,
} from "./risk.js";
import { grantAdmin } from "@openhoard/core-identity";
import { applyRuleTags } from "./rules.js";
import { proposeTag } from "./tagging.js";
import { markProcessed, VIEW_TRANSACTION, viewObjects, type CardView } from "./visibility.js";

/*
 * T-405 and T-408 in the catalog: model cards stored per version, the summary on CardView only
 * where exposure allows it (never on a metadata-only card, never from a provider the file's
 * exposure no longer allows), and the detector's `risk:injection` flag.
 */

let authz: Authorizer;
let db: Database;
let t: SeededTenant;
const inTenant = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work);

beforeAll(async () => {
  authz = new Authorizer(createCedarEngine());
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  await inTenant(async (tx) => {
    await tx.insert(facets).values([
      { tenantId: t.tenantId, key: "level", label: "Level" },
      { tenantId: t.tenantId, key: "risk", label: "Risk" },
      { tenantId: t.tenantId, key: "kind", label: "Kind" },
    ]);
    await tx.insert(facetValues).values([
      ...EXPOSURE.map((exposure) => ({
        tenantId: t.tenantId,
        facet: "level",
        value: exposure,
        label: exposure,
        approved: true,
        exposure,
      })),
      {
        tenantId: t.tenantId,
        facet: "risk",
        value: "injection",
        label: "Possible prompt injection",
        approved: true,
        exposure: "metadata-only" as const,
      },
      { tenantId: t.tenantId, facet: "kind", value: "invoice", label: "Invoice", approved: true },
      { tenantId: t.tenantId, facet: "kind", value: "memo", label: "Memo", approved: false },
    ]);
    await tx
      .update(tenants)
      .set({ defaultVisibility: "discoverable", defaultExposure: "full" })
      .where(eq(tenants.id, t.tenantId));
    await markProcessed(tx, t.tenantId, { versionId: t.versionId, title: "Report 1.docx" });
  });
});
afterAll(() => db?.close());
beforeEach(async () => {
  await inTenant(async (tx) => {
    await tx.delete(versionCards).where(eq(versionCards.tenantId, t.tenantId));
    await tx
      .delete(objectTags)
      .where(and(eq(objectTags.tenantId, t.tenantId), eq(objectTags.facet, "level")));
    await tx
      .delete(objectTags)
      .where(and(eq(objectTags.tenantId, t.tenantId), eq(objectTags.facet, "risk")));
  });
});

const summarized = (providerKind: ClientTrust, summary = "An invoice from Acme for Q3.") => ({
  objectId: t.objectId,
  versionId: t.versionId,
  status: "summarized" as const,
  summary,
  providerId: `${providerKind}-model`,
  providerKind,
  model: "m-1",
  promptVersion: "openhoard-summary/1",
  filtered: 1,
  inputTokens: 100,
  outputTokens: 20,
});

const reader = (): AuthzPrincipal => ({
  userId: "usr_01k5xr3c8v0q6m2d4n7p9s1t3w",
  groupIds: [],
  tagGrants: [t.tag],
  tagWriteGrants: [],
  objectGrants: [],
  objectWriteGrants: [],
  guest: false,
  active: true,
});

async function cardFor(trust: "first-party" | ClientTrust): Promise<CardView | null> {
  const request = {
    principal: reader(),
    client: { id: `${trust}-app`, trust },
    activity: new ActivityBuffer(),
  };
  const view = await db.withTenant(
    t.tenantId,
    (tx) => viewObject(tx, t.tenantId, authz, request, t.objectId),
    VIEW_TRANSACTION,
  );
  return view as CardView | null;
}

const setLevel = (exposure: Exposure) =>
  inTenant((tx) =>
    tx.insert(objectTags).values({
      tenantId: t.tenantId,
      objectId: t.objectId,
      facet: "level",
      value: exposure,
      source: "rule",
      appliedBy: "rule:test",
      confidence: 1,
    }),
  );

describe("stored cards", () => {
  it("upserts one row per version and reads it back", async () => {
    await inTenant((tx) => saveCard(tx, t.tenantId, summarized("local")));
    await inTenant((tx) => saveCard(tx, t.tenantId, summarized("local", "Second run.")));
    const rows = await inTenant((tx) => tx.select().from(versionCards));
    expect(rows).toHaveLength(1);
    expect(await inTenant((tx) => readCard(tx, t.tenantId, t.versionId))).toMatchObject({
      status: "summarized",
      summary: "Second run.",
      providerKind: "local",
      filtered: 1,
    });
    await inTenant((tx) =>
      saveCard(tx, t.tenantId, {
        objectId: t.objectId,
        versionId: t.versionId,
        status: "skipped",
        reason: "budget",
        promptVersion: "openhoard-summary/1",
      }),
    );
    expect(await inTenant((tx) => readCard(tx, t.tenantId, t.versionId))).toMatchObject({
      status: "skipped",
      reason: "budget",
    });
    expect(await inTenant((tx) => readCard(tx, t.tenantId, "nope"))).toBe(null);
    expect(await inTenant((tx) => readCard(tx, t.tenantId, "ver_01k5xr3c8v0q6m2d4n7p9s1t3w"))).toBe(
      null,
    );
  });

  it.each([
    ["ids", { objectId: "x" }],
    ["promptVersion", { promptVersion: "Bad Version" }],
    ["summary", { summary: "x".repeat(2_001) }],
    ["summary", { summary: "a\0b" }],
    ["providerId", { providerId: "Bad Id" }],
    ["providerKind", { providerKind: "cloud" }],
    ["model", { model: "" }],
    ["counts", { inputTokens: -1 }],
    ["status", { status: "maybe" }],
  ])("refuses a card with a bad %s before writing", async (what, over) => {
    await expect(
      inTenant((tx) =>
        saveCard(tx, t.tenantId, { ...summarized("local"), ...over } as Parameters<
          typeof saveCard
        >[2]),
      ),
    ).rejects.toThrow(`invalid card: ${what}`);
    await expect(
      inTenant((tx) =>
        saveCard(tx, t.tenantId, {
          objectId: t.objectId,
          versionId: t.versionId,
          status: "skipped",
          reason: "tired" as "budget",
          promptVersion: "p",
        }),
      ),
    ).rejects.toThrow("invalid card: reason");
  });

  it("offers models the approved vocabulary, never the risk facet", async () => {
    const vocab = await inTenant((tx) => modelVocabulary(tx, t.tenantId));
    const tags = vocab.map((v) => v.tag);
    expect(tags).toContain("kind:invoice");
    expect(tags).toContain(t.tag);
    expect(tags).not.toContain("kind:memo");
    expect(tags.some((x) => x.startsWith("risk:"))).toBe(false);
    expect(vocab.find((v) => v.tag === "kind:invoice")?.label).toBe("Invoice");
    expect(await inTenant((tx) => modelVocabulary(tx, t.tenantId, 2))).toHaveLength(2);
  });
});

describe("the summary on cards", () => {
  it("shows a summary to a first-party reader and to AI clients the exposure reaches", async () => {
    await inTenant((tx) => saveCard(tx, t.tenantId, summarized("commercial")));
    expect((await cardFor("first-party"))?.summary).toBe("An invoice from Acme for Q3.");
    expect((await cardFor("commercial"))?.summary).toBe("An invoice from Acme for Q3.");
  });

  it("never puts a summary on a metadata-only card", async () => {
    await inTenant((tx) => saveCard(tx, t.tenantId, summarized("local")));
    await setLevel("local-only");
    for (const trust of ["commercial", "consumer"] as const) {
      const card = await cardFor(trust);
      expect(card).toMatchObject({ metadataOnly: true });
      expect(card).not.toHaveProperty("summary");
    }
    expect((await cardFor("local"))?.summary).toBe("An invoice from Acme for Q3.");
  });

  it.each(
    EXPOSURE.flatMap((exposure) =>
      (["local", "commercial", "consumer"] as const).map((kind) => [exposure, kind] as const),
    ),
  )(
    "at %s, a summary a %s provider wrote shows only if that provider may still have it",
    async (exposure, kind) => {
      await inTenant((tx) => saveCard(tx, t.tenantId, summarized(kind)));
      await setLevel(exposure);
      const card = await cardFor("first-party");
      if (mayProcess(exposure, kind)) expect(card?.summary).toBe("An invoice from Acme for Q3.");
      else expect(card).not.toHaveProperty("summary");
    },
  );

  it("shows no summary for skipped cards or empty summaries, nor on listings of other versions", async () => {
    await inTenant((tx) => saveCard(tx, t.tenantId, summarized("local", "")));
    expect(await cardFor("first-party")).not.toHaveProperty("summary");
    const views = await db.withTenant(
      t.tenantId,
      (tx) =>
        viewObjects(
          tx,
          t.tenantId,
          authz,
          { principal: reader(), client: { id: "app", trust: "first-party" } },
          [t.objectId],
        ),
      VIEW_TRANSACTION,
    );
    expect(views[0]).not.toHaveProperty("summary");
  });

  it("hides the summary of a file flagged risk:injection from everyone's cards", async () => {
    await inTenant((tx) => saveCard(tx, t.tenantId, summarized("local")));
    await inTenant((tx) => applyInjectionFlag(tx, t.tenantId, t.objectId, true));
    for (const trust of ["first-party", "local", "commercial", "consumer"] as const) {
      expect(await cardFor(trust), trust).not.toHaveProperty("summary");
    }
    expect(await cardFor("local")).toMatchObject({ metadataOnly: true });
    expect(await cardFor("first-party")).toMatchObject({ metadataOnly: false, readable: true });
  });
});

describe("a non-reader's card of a readable file", () => {
  it("carries the summary, unless a policy forbids them read", async () => {
    await inTenant((tx) => saveCard(tx, t.tenantId, summarized("local")));
    await inTenant((tx) =>
      tx.update(tenants).set({ defaultVisibility: "readable" }).where(eq(tenants.id, t.tenantId)),
    );
    try {
      const stranger: AuthzPrincipal = { ...reader(), tagGrants: [] };
      const viewWith = async (kind: "no-permit" | "forbid" | "error") => {
        const fake = {
          authorize: () => ({ allow: false, kind, reason: kind, policies: [] }),
        } as unknown as Authorizer;
        const [v] = await db.withTenant(
          t.tenantId,
          (tx) =>
            viewObjects(
              tx,
              t.tenantId,
              fake,
              { principal: stranger, client: { id: "app", trust: "first-party" } },
              [t.objectId],
            ),
          VIEW_TRANSACTION,
        );
        return v as CardView;
      };
      expect(await viewWith("no-permit")).toMatchObject({
        shape: "card",
        readable: false,
        metadataOnly: false,
        summary: "An invoice from Acme for Q3.",
      });
      for (const kind of ["forbid", "error"] as const) {
        const v = await viewWith(kind);
        expect(v, kind).toMatchObject({ shape: "card", readable: false, metadataOnly: true });
        expect(v, kind).not.toHaveProperty("summary");
      }
    } finally {
      await inTenant((tx) =>
        tx
          .update(tenants)
          .set({ defaultVisibility: "discoverable" })
          .where(eq(tenants.id, t.tenantId)),
      );
    }
  });
});

describe("the injection flag", () => {
  it("adds the trusted flag, keeps it, and clears only its own", async () => {
    expect(await inTenant((tx) => applyInjectionFlag(tx, t.tenantId, t.objectId, false))).toBe(
      "not-flagged",
    );
    expect(await inTenant((tx) => applyInjectionFlag(tx, t.tenantId, t.objectId, true))).toBe(
      "flagged",
    );
    expect(await inTenant((tx) => applyInjectionFlag(tx, t.tenantId, t.objectId, true))).toBe(
      "already-flagged",
    );
    const [row] = await inTenant((tx) =>
      tx.select().from(objectTags).where(eq(objectTags.facet, "risk")),
    );
    expect(row).toMatchObject({ source: "rule", appliedBy: INJECTION_DETECTOR, confidence: 1 });
    expect(await inTenant((tx) => hasInjectionFlag(tx, t.tenantId, t.objectId))).toBe(true);
    expect(await inTenant((tx) => applyInjectionFlag(tx, t.tenantId, t.objectId, false))).toBe(
      "cleared",
    );
    expect(await inTenant((tx) => hasInjectionFlag(tx, t.tenantId, t.objectId))).toBe(false);
  });

  it("leaves a person's flag in place when the detector finds nothing", async () => {
    await inTenant((tx) =>
      proposeTag(tx, t.tenantId, {
        objectId: t.objectId,
        tag: "risk:injection",
        source: "user",
        appliedBy: "user:usr_01k5xr3c8v0q6m2d4n7p9s1t3w",
        confidence: 1,
      }),
    );
    expect(await inTenant((tx) => applyInjectionFlag(tx, t.tenantId, t.objectId, false))).toBe(
      "not-flagged",
    );
    expect(await inTenant((tx) => applyInjectionFlag(tx, t.tenantId, t.objectId, true))).toBe(
      "already-flagged",
    );
    expect(await inTenant((tx) => hasInjectionFlag(tx, t.tenantId, t.objectId))).toBe(true);
  });

  it("takes over a model's guess of the same tag as the detector's", async () => {
    await inTenant((tx) =>
      tx.insert(objectTags).values({
        tenantId: t.tenantId,
        objectId: t.objectId,
        facet: "risk",
        value: "injection",
        source: "model",
        appliedBy: "model:x",
        confidence: 0.9,
      }),
    );
    expect(await inTenant((tx) => applyInjectionFlag(tx, t.tenantId, t.objectId, true))).toBe(
      "flagged",
    );
    const [row] = await inTenant((tx) =>
      tx.select().from(objectTags).where(eq(objectTags.facet, "risk")),
    );
    expect(row).toMatchObject({ source: "rule", appliedBy: INJECTION_DETECTOR });
  });

  it("survives the rule tagger, which only syncs the rules' own tags", async () => {
    await inTenant((tx) => applyInjectionFlag(tx, t.tenantId, t.objectId, true));
    const sync = await inTenant((tx) =>
      applyRuleTags(tx, t.tenantId, t.objectId, [], { title: "Report 1.docx", mime: "text/plain" }),
    );
    // (The seeded rule tag goes: no rule gives it. The flag stays.)
    expect(sync.removed).not.toContain("risk:injection");
    expect(await inTenant((tx) => hasInjectionFlag(tx, t.tenantId, t.objectId))).toBe(true);
  });

  it("never depends on the tenant's vocabulary, and nobody can change the built-in value", async () => {
    const other = await seedTenant(db, 2);
    const inOther = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(other.tenantId, work);
    // No risk facet at all (a tenant from before migration 0046, or a test seed).
    expect(
      await inOther((tx) => applyInjectionFlag(tx, other.tenantId, other.objectId, true)),
    ).toBe("flagged");
    const value = () =>
      inOther((tx) => tx.select().from(facetValues).where(eq(facetValues.facet, "risk")));
    expect(await value()).toMatchObject([{ approved: true, exposure: "metadata-only" }]);
    // An admin or a pack loosening it, hiding it, or removing it: refused by the database.
    for (const change of [
      { exposure: "full" as const },
      { approved: false },
      { visibility: "hidden" as const },
    ]) {
      await expect(
        inOther((tx) => tx.update(facetValues).set(change).where(eq(facetValues.facet, "risk"))),
        JSON.stringify(change),
      ).rejects.toThrow();
    }
    await inOther((tx) =>
      tx.update(facetValues).set({ label: "Maybe injected" }).where(eq(facetValues.facet, "risk")),
    );
    const third = await seedTenant(db, 3);
    await expect(
      db.withTenant(third.tenantId, async (tx) => {
        await tx.insert(facets).values({ tenantId: third.tenantId, key: "risk", label: "Risk" });
        await tx.insert(facetValues).values({
          tenantId: third.tenantId,
          facet: "risk",
          value: "injection",
          label: "x",
          approved: true,
          exposure: "local-only",
        });
      }),
    ).rejects.toThrow();
    expect(await value()).toMatchObject([{ approved: true, exposure: "metadata-only" }]);
  });

  it("lets only an admin clear a flag, for the reviewed content, audited", async () => {
    const by = `user:${t.userId}`;
    await inTenant((tx) => applyInjectionFlag(tx, t.tenantId, t.objectId, true));
    // The owner or any other member: refused, nothing written.
    await expect(
      inTenant((tx) => markNotInjection(tx, t.tenantId, { objectId: t.objectId, by })),
    ).rejects.toMatchObject({ code: "not-admin" });
    expect(await inTenant((tx) => hasInjectionFlag(tx, t.tenantId, t.objectId))).toBe(true);
    await inTenant((tx) => grantAdmin(tx, t.tenantId, t.userId, "system:test"));
    try {
      expect(
        await inTenant((tx) => markNotInjection(tx, t.tenantId, { objectId: t.objectId, by })),
      ).toBe(true);
      expect(await inTenant((tx) => hasInjectionFlag(tx, t.tenantId, t.objectId))).toBe(false);
      expect(await inTenant((tx) => injectionReviewOf(tx, t.tenantId, t.objectId))).toMatchObject({
        reviewedBy: by,
        versionId: t.versionId,
        blobId: t.blobId,
      });
      expect(await inTenant((tx) => reviewedNotInjection(tx, t.tenantId, t.objectId))).toBe(true);
      // The detector says injection again for the same content: the decision stands.
      expect(await inTenant((tx) => applyInjectionFlag(tx, t.tenantId, t.objectId, true))).toBe(
        "not-flagged",
      );
      const audit = await inTenant((tx) =>
        tx.select().from(auditEvents).where(eq(auditEvents.action, "injection.review")),
      );
      expect(audit).toMatchObject([{ actor: by, object: t.objectId, decision: "allow" }]);

      // A new version with other content is judged again.
      const newer = newId("version");
      await inTenant(async (tx) => {
        await tx
          .insert(blobs)
          .values({ tenantId: t.tenantId, id: `b3t:${"e".repeat(64)}`, size: 9 });
        await tx.insert(versions).values({
          tenantId: t.tenantId,
          id: newer,
          objectId: t.objectId,
          seq: 2,
          blobId: `b3t:${"e".repeat(64)}`,
          mime: "text/plain",
        });
      });
      expect(await inTenant((tx) => reviewedNotInjection(tx, t.tenantId, t.objectId))).toBe(false);
      expect(await inTenant((tx) => applyInjectionFlag(tx, t.tenantId, t.objectId, true))).toBe(
        "flagged",
      );
      await inTenant((tx) => tx.delete(versions).where(eq(versions.id, newer)));

      expect(
        await inTenant((tx) => clearInjectionReview(tx, t.tenantId, { objectId: t.objectId, by })),
      ).toBe(true);
      expect(
        await inTenant((tx) => clearInjectionReview(tx, t.tenantId, { objectId: t.objectId, by })),
      ).toBe(false);
      expect(await inTenant((tx) => injectionReviewOf(tx, t.tenantId, "nope"))).toBe(null);
      await expect(
        inTenant((tx) => markNotInjection(tx, t.tenantId, { objectId: t.objectId, by: "model:x" })),
      ).rejects.toMatchObject({ code: "invalid" });
      await expect(
        inTenant((tx) => markNotInjection(tx, t.tenantId, { objectId: "x", by })),
      ).rejects.toMatchObject({ code: "invalid" });
      await expect(
        inTenant((tx) =>
          markNotInjection(tx, t.tenantId, { objectId: "obj_01k5xr3c8v0q6m2d4n7p9s1t3w", by }),
        ),
      ).rejects.toMatchObject({ code: "unknown-object" });
    } finally {
      // (revokeAdmin() refuses the tenant's last admin; the test puts the row back as it was.)
      await inTenant((tx) =>
        tx.update(users).set({ adminAt: null, adminBy: null }).where(eq(users.id, t.userId)),
      );
    }
  });
});
