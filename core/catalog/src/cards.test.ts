import {
  facets,
  facetValues,
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
  hasInjectionFlag,
  INJECTION_DETECTOR,
  RiskVocabularyError,
} from "./risk.js";
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

  it("fails closed without the vocabulary: no approved metadata-only risk:injection", async () => {
    const other = await seedTenant(db, 2);
    await expect(
      db.withTenant(other.tenantId, (tx) =>
        applyInjectionFlag(tx, other.tenantId, other.objectId, true),
      ),
    ).rejects.toBeInstanceOf(RiskVocabularyError);
    await db.withTenant(other.tenantId, async (tx) => {
      await tx.insert(facets).values({ tenantId: other.tenantId, key: "risk", label: "Risk" });
      await tx.insert(facetValues).values({
        tenantId: other.tenantId,
        facet: "risk",
        value: "injection",
        label: "x",
        approved: true,
        exposure: "local-only",
      });
    });
    await expect(
      db.withTenant(other.tenantId, (tx) =>
        applyInjectionFlag(tx, other.tenantId, other.objectId, true),
      ),
    ).rejects.toThrow("apply the starter pack");
    // Clearing needs no vocabulary.
    expect(
      await db.withTenant(other.tenantId, (tx) =>
        applyInjectionFlag(tx, other.tenantId, other.objectId, false),
      ),
    ).toBe("not-flagged");
  });
});
