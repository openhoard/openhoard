import {
  facets,
  facetValues,
  objectTags,
  tenants,
  versions,
  type Database,
  type Tx,
} from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import {
  Authorizer,
  createCedarEngine,
  EXPOSURE,
  type AuthzPrincipal,
  type Exposure,
  type Visibility,
} from "@openhoard/core-policy";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActivityBuffer } from "./activity.js";
import { openContent, viewObject } from "./read.js";
import { searchObjects } from "./search.js";
import {
  enrichmentExposure,
  markProcessed,
  VIEW_TRANSACTION,
  type CardView,
  type RecordedRequest,
} from "./visibility.js";

/*
 * T-604: exposure levels enforced on open and cards. "Done when: consumer client gets metadata
 * only for commercial-only tags." Exposure is resolved per object as visibility is (T-603):
 * trusted tags decide, most restrictive wins, else the tenant default; untrusted tags only
 * tighten; an unprocessed file is metadata-only.
 */

type Trust = "first-party" | "local" | "commercial" | "consumer";
const TRUSTS: readonly Trust[] = ["first-party", "local", "commercial", "consumer"];
/** The exposures each client's trust reaches. */
const REACHES: Record<Trust, readonly Exposure[]> = {
  "first-party": EXPOSURE,
  local: ["full", "commercial-only", "local-only"],
  commercial: ["full", "commercial-only"],
  consumer: ["full"],
};
let authz: Authorizer;
let db: Database;
let t: SeededTenant;
beforeAll(async () => {
  authz = new Authorizer(createCedarEngine());
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  await inTenant(async (tx) => {
    await tx.insert(facets).values({ tenantId: t.tenantId, key: "level", label: "Level" });
    await tx.insert(facetValues).values(
      EXPOSURE.map((exposure) => ({
        tenantId: t.tenantId,
        facet: "level",
        value: exposure,
        label: exposure,
        approved: true,
        exposure,
      })),
    );
    await tx.insert(facets).values({ tenantId: t.tenantId, key: "topic", label: "Topic" });
    await tx.insert(facetValues).values(
      ["budget", "layoffs"].map((value) => ({
        tenantId: t.tenantId,
        facet: "topic",
        value,
        label: value,
        approved: true,
      })),
    );
    await markProcessed(tx, t.tenantId, { versionId: t.versionId, title: "Report 1.docx" });
  });
});
afterAll(() => db?.close());
beforeEach(async () => {
  await inTenant(async (tx) => {
    await tx
      .delete(objectTags)
      .where(
        and(eq(objectTags.tenantId, t.tenantId), inArray(objectTags.facet, ["level", "topic"])),
      );
    await tx
      .update(tenants)
      .set({ defaultVisibility: "discoverable", defaultExposure: "full" })
      .where(eq(tenants.id, t.tenantId));
    await tx
      .update(versions)
      .set({ processedAt: sql`greatest(now(), ${versions.createdAt})` })
      .where(and(eq(versions.tenantId, t.tenantId), eq(versions.id, t.versionId)));
  });
});

const inTenant = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work);
const setDefault = (exposure: Exposure, visibility: Visibility = "discoverable") =>
  inTenant((tx) =>
    tx
      .update(tenants)
      .set({ defaultExposure: exposure, defaultVisibility: visibility })
      .where(eq(tenants.id, t.tenantId)),
  );
const tag = (exposure: Exposure, source: "rule" | "model" = "rule") =>
  inTenant((tx) =>
    tx.insert(objectTags).values({
      tenantId: t.tenantId,
      objectId: t.objectId,
      facet: "level",
      value: exposure,
      source,
      appliedBy: `${source}:test`,
      confidence: 1,
    }),
  );

const person = (more: Partial<AuthzPrincipal> = {}): AuthzPrincipal => ({
  userId: "usr_01k5xr3c8v0q6m2d4n7p9s1t3w",
  groupIds: [],
  tagGrants: [],
  tagWriteGrants: [],
  objectGrants: [],
  objectWriteGrants: [],
  guest: false,
  active: true,
  ...more,
});
const reader = () => person({ tagGrants: [t.tag] });

/** What a client gets of the seeded file: its card, whether it opens, what was withheld. */
async function through(trust: Trust, principal = reader()) {
  const activity = new ActivityBuffer();
  const request: RecordedRequest = { principal, client: { id: `${trust}-app`, trust }, activity };
  const snapshot = <T>(work: (tx: Tx) => Promise<T>) =>
    db.withTenant(t.tenantId, work, VIEW_TRANSACTION);
  const card = await snapshot((tx) => viewObject(tx, t.tenantId, authz, request, t.objectId));
  const opened = await snapshot((tx) => openContent(tx, t.tenantId, authz, request, t.objectId));
  return {
    card: card as CardView | null,
    opened,
    events: activity.take().map((e) => e.type),
    withheld: activity.takeWithheld(),
  };
}

async function expectExposure(exposure: Exposure) {
  for (const trust of TRUSTS) {
    const allowed = REACHES[trust].includes(exposure);
    const got = await through(trust);
    expect(got.card, `${trust} at ${exposure}`).toMatchObject({
      shape: "card",
      readable: true,
      metadataOnly: !allowed,
    });
    expect(got.opened !== null, `${trust} opens at ${exposure}`).toBe(allowed);
    expect(got.events).toEqual(allowed ? ["view", "open"] : ["view"]);
    expect(got.withheld).toEqual(
      allowed
        ? []
        : [
            {
              actor: `user:${reader().userId}`,
              objectId: t.objectId,
              client: { id: `${trust}-app`, trust },
              exposure,
            },
          ],
    );
  }
}

describe("exposure on cards and open (T-604)", () => {
  it("gives a consumer client metadata only for a commercial-only tag, a commercial one the content", async () => {
    await tag("commercial-only");
    const consumer = await through("consumer");
    expect(consumer.card).toMatchObject({ shape: "card", readable: true, metadataOnly: true });
    expect(consumer.opened).toBeNull();
    expect(consumer.withheld).toMatchObject([{ exposure: "commercial-only" }]);
    const commercial = await through("commercial");
    expect(commercial.card).toMatchObject({ metadataOnly: false });
    expect(commercial.opened).toMatchObject({ blobId: t.blobId });
    expect(commercial.withheld).toEqual([]);
  });

  const defaults: readonly Exposure[] = ["full", "commercial-only", "metadata-only"];
  const tagged: readonly (Exposure | null)[] = [null, ...EXPOSURE];
  const matrix = defaults.flatMap((d) => tagged.map((level) => [d, level] as const));
  it.each(matrix)("tenant default %s, trusted tag %s: every client", async (fallback, level) => {
    await setDefault(fallback);
    if (level !== null) await tag(level);
    // A trusted tag decides, even over a stricter default; without one the default applies.
    await expectExposure(level ?? fallback);
  });

  it("lets an unreviewed model tag tighten, never loosen", async () => {
    await tag("full");
    await tag("local-only", "model");
    await expectExposure("local-only");
    await inTenant((tx) =>
      tx
        .delete(objectTags)
        .where(and(eq(objectTags.tenantId, t.tenantId), eq(objectTags.facet, "level"))),
    );
    await tag("commercial-only");
    await tag("full", "model");
    await expectExposure("commercial-only");
    // Reviewed, a model's tag is trusted: then it decides like any other.
    await inTenant((tx) =>
      tx
        .update(objectTags)
        .set({ reviewed: true })
        .where(and(eq(objectTags.tenantId, t.tenantId), eq(objectTags.source, "model"))),
    );
    await expectExposure("commercial-only");
  });

  it("keeps an unprocessed file's content from every AI client", async () => {
    await tag("full");
    await inTenant((tx) =>
      tx
        .update(versions)
        .set({ processedAt: null })
        .where(and(eq(versions.tenantId, t.tenantId), eq(versions.id, t.versionId))),
    );
    await expectExposure("metadata-only");
  });

  it("gives a non-reader's card of a readable file its summary only where exposure allows", async () => {
    await setDefault("commercial-only", "readable");
    const outsider = person();
    for (const trust of TRUSTS) {
      const got = await through(trust, outsider);
      expect(got.card, trust).toMatchObject({
        shape: "card",
        readable: false,
        metadataOnly: !REACHES[trust].includes("commercial-only"),
      });
      // A non-reader opens nothing, and nothing was withheld: the grants refused it first.
      expect(got.opened).toBeNull();
      expect(got.withheld).toEqual([]);
    }
  });
});

describe("metadata-only cards and search (T-604)", () => {
  const topic = (value: string, source: "rule" | "model") =>
    inTenant((tx) =>
      tx.insert(objectTags).values({
        tenantId: t.tenantId,
        objectId: t.objectId,
        facet: "topic",
        value,
        source,
        appliedBy: `${source}:test`,
        confidence: 1,
      }),
    );
  const search = (trust: Trust, query: string) =>
    db.withTenant(
      t.tenantId,
      (tx) =>
        searchObjects(
          tx,
          t.tenantId,
          authz,
          { principal: reader(), client: { id: `${trust}-app`, trust } },
          { query },
        ),
      VIEW_TRANSACTION,
    );

  it("shows, counts and matches no unreviewed model tag where the card is metadata only", async () => {
    await tag("commercial-only");
    await topic("budget", "rule");
    // A model read the content and said what it is about: content-derived, and unreviewed.
    await topic("layoffs", "model");
    const consumer = await through("consumer");
    expect(consumer.card?.metadataOnly).toBe(true);
    expect(consumer.card?.tags).toContain("topic:budget");
    expect(consumer.card?.tags).not.toContain("topic:layoffs");
    const commercial = await through("commercial");
    expect(commercial.card?.tags).toContain("topic:layoffs");

    // Facets count what each card shows.
    expect((await search("consumer", "")).facets.topic).toEqual({ budget: 1 });
    expect((await search("commercial", "")).facets.topic).toEqual({ budget: 1, layoffs: 1 });
    // Searching for the model's tag finds nothing through the consumer client.
    expect((await search("consumer", "topic:layoffs")).hits).toEqual([]);
    expect((await search("commercial", "topic:layoffs")).hits).toHaveLength(1);
    expect((await search("consumer", "topic:budget")).hits).toHaveLength(1);

    // Reviewed by a person, the tag is metadata, shown and matched everywhere.
    await inTenant((tx) =>
      tx
        .update(objectTags)
        .set({ reviewed: true })
        .where(and(eq(objectTags.tenantId, t.tenantId), eq(objectTags.value, "layoffs"))),
    );
    expect((await through("consumer")).card?.tags).toContain("topic:layoffs");
    expect((await search("consumer", "topic:layoffs")).hits).toHaveLength(1);
  });
});

describe("enrichmentExposure", () => {
  it("is what the tags say before the file is processed, not the unprocessed default", async () => {
    await inTenant((tx) =>
      tx
        .update(versions)
        .set({ processedAt: null })
        .where(and(eq(versions.tenantId, t.tenantId), eq(versions.id, t.versionId))),
    );
    const exposure = () =>
      db.withTenant(
        t.tenantId,
        (tx) => enrichmentExposure(tx, t.tenantId, t.objectId),
        VIEW_TRANSACTION,
      );
    // Unclassified, a permissive default is capped at commercial-only: no consumer provider.
    expect(await exposure()).toBe("commercial-only");
    await tag("full", "model");
    expect(await exposure()).toBe("commercial-only");
    await inTenant((tx) =>
      tx
        .delete(objectTags)
        .where(and(eq(objectTags.tenantId, t.tenantId), eq(objectTags.facet, "level"))),
    );
    // A stricter default stays.
    await setDefault("local-only");
    expect(await exposure()).toBe("local-only");
    await setDefault("commercial-only");
    expect(await exposure()).toBe("commercial-only");
    // A trusted tag decides, and lifts the cap.
    await tag("full");
    expect(await exposure()).toBe("full");
    // A model's guess that it is sensitive counts at once.
    await tag("local-only", "model");
    expect(await exposure()).toBe("local-only");
    expect(
      await db.withTenant(
        t.tenantId,
        (tx) => enrichmentExposure(tx, t.tenantId, "obj_00000000000000000000000000"),
        VIEW_TRANSACTION,
      ),
    ).toBeNull();
    expect(
      await db.withTenant(
        t.tenantId,
        (tx) => enrichmentExposure(tx, t.tenantId, "not an id"),
        VIEW_TRANSACTION,
      ),
    ).toBeNull();
    await expect(inTenant((tx) => enrichmentExposure(tx, t.tenantId, t.objectId))).rejects.toThrow(
      /repeatable read/,
    );
  });
});
