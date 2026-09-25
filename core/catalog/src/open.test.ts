import {
  blobs,
  facets,
  facetValues,
  objects,
  objectTags,
  tenants,
  type Database,
  type Tx,
} from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import {
  Authorizer,
  createCedarEngine,
  type AuthzPrincipal,
  type AuthzRequest,
} from "@openhoard/core-policy";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActivityBuffer } from "./activity.js";
import { blobIdOf, ingest } from "./ingest.js";
import { openContent } from "./read.js";
import {
  markProcessed,
  VIEW_TRANSACTION,
  viewObjects,
  type RecordedRequest,
  type ViewRequest,
} from "./visibility.js";

/* T-205: openContent(), the one way to the bytes, behind `read`, `open` and exposure. */

let authz: Authorizer;
beforeAll(() => {
  authz = new Authorizer(createCedarEngine());
});

let db: Database;
let t: SeededTenant;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  await db.withTenant(t.tenantId, async (tx) => {
    await tx.insert(facets).values({ tenantId: t.tenantId, key: "exposure", label: "E" });
    await tx.insert(facetValues).values({
      tenantId: t.tenantId,
      facet: "exposure",
      value: "local",
      label: "local",
      approved: true,
      visibility: "discoverable",
      exposure: "local-only",
    });
    await tx
      .update(tenants)
      .set({ defaultVisibility: "discoverable", defaultExposure: "full" })
      .where(eq(tenants.id, t.tenantId));
    await markProcessed(tx, t.tenantId, { versionId: t.versionId, title: "Report 1.docx" });
  });
});
afterEach(() => db?.close());

type Trust = ViewRequest["client"]["trust"];
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
/** The seeded file's owner (`user:owner-1`). */
const owner = () => person({ userId: "owner-1" });
const open = (
  principal: AuthzPrincipal,
  options: { trust?: Trust; versionId?: string; gate?: Authorizer; objectId?: string } = {},
) => {
  const activity = new ActivityBuffer();
  const request: RecordedRequest = {
    principal,
    client: { id: "a-client", trust: options.trust ?? "first-party" },
    activity,
  };
  return db
    .withTenant(
      t.tenantId,
      (tx: Tx) =>
        openContent(
          tx,
          t.tenantId,
          options.gate ?? authz,
          request,
          options.objectId ?? t.objectId,
          options.versionId === undefined ? {} : { versionId: options.versionId },
        ),
      VIEW_TRANSACTION,
    )
    .then((opened) => ({ opened, events: activity.take() }));
};
const saveVersion = async (n: number) => {
  const content = await blobIdOf(new Uint8Array(32).fill(7), new TextEncoder().encode(`v${n}`));
  return db.withTenant(t.tenantId, (tx) =>
    ingest(tx, t.tenantId, {
      source: "sharepoint",
      externalId: t.externalId,
      zoneId: t.zoneId,
      title: "Report 1.docx",
      ownerId: `user:${person().userId}`,
      content,
      mime: "text/csv",
    }),
  );
};

describe("openContent", () => {
  it("hands a reader the current version's blob, and records the open", async () => {
    const { opened, events } = await open(reader());
    expect(opened).toMatchObject({
      view: { id: t.objectId, shape: "card", readable: true },
      version: { id: t.versionId, seq: 1, current: true, processed: true },
      blobId: t.blobId,
      location: null,
    });
    expect(events).toEqual([
      {
        type: "open",
        actor: `user:${person().userId}`,
        objectId: t.objectId,
        versionId: t.versionId,
        client: { id: "a-client", trust: "first-party" },
      },
    ]);
  });

  it("opens an earlier version by id for its owner, and says it isn't the current one", async () => {
    const v2 = await saveVersion(2);
    const current = await open(reader());
    expect(current.opened?.version).toMatchObject({ id: v2.versionId, seq: 2, current: true });
    // Levels describe the current content: an earlier version is its owner's to open.
    expect((await open(reader(), { versionId: t.versionId })).opened).toBeNull();
    const first = await open(owner(), { versionId: t.versionId });
    expect(first.opened?.version).toMatchObject({ id: t.versionId, seq: 1, current: false });
    expect(first.opened?.blobId).toBe(t.blobId);
    expect(first.events.map((e) => e.versionId)).toEqual([t.versionId]);
  });

  it("opens an earlier version only through a first-party client, even for its owner", async () => {
    const saved = await saveVersion(2);
    await db.withTenant(t.tenantId, (tx) =>
      markProcessed(tx, t.tenantId, { versionId: saved.versionId, title: "Report 1.docx" }),
    );
    for (const trust of ["local", "commercial", "consumer"] as const) {
      const old = await open(owner(), { trust, versionId: t.versionId });
      expect(old.opened, trust).toBeNull();
      expect(old.events, trust).toEqual([]);
    }
    // The current version, named by id, is the current one: the levels describe it.
    const v2 = await open(reader(), { trust: "local" });
    expect(v2.opened).not.toBeNull();
    const byId = await open(reader(), { trust: "local", versionId: saved.versionId });
    expect(byId.opened?.version.current).toBe(true);
  });

  it("gives location for a managed zone's bytes", async () => {
    await db.withTenant(t.tenantId, (tx) =>
      tx
        .update(blobs)
        .set({ location: "s3://bucket/key" })
        .where(and(eq(blobs.tenantId, t.tenantId), eq(blobs.id, t.blobId))),
    );
    expect((await open(reader())).opened?.location).toBe("s3://bucket/key");
  });

  it("answers null, and records nothing, for everything it refuses, alike", async () => {
    const other = await seedTenant(db, 2);
    const refuseOpen = {
      authorize: (r: AuthzRequest) =>
        r.action === "open"
          ? { allow: false, kind: "forbid", reason: "pack", policies: [] }
          : authz.authorize(r),
    } as unknown as Authorizer;
    const cases = {
      // A member who can't read it sees its card (discoverable), but not the content.
      nonReader: await open(person()),
      openForbidden: await open(reader(), { gate: refuseOpen }),
      unknownObject: await open(reader(), { objectId: other.objectId }),
      malformedObject: await open(reader(), { objectId: "obj_nope" }),
      unknownVersion: await open(reader(), { versionId: other.versionId }),
      malformedVersion: await open(reader(), { versionId: "ver_\0" }),
      guest: await open(person({ guest: true })),
    };
    for (const [name, { opened, events }] of Object.entries(cases)) {
      expect(opened, name).toBeNull();
      expect(events, name).toEqual([]);
    }
    await db.withTenant(t.tenantId, (tx) =>
      tx.update(objects).set({ deletedAt: new Date() }).where(eq(objects.id, t.objectId)),
    );
    expect((await open(reader())).opened).toBeNull();
  });

  it("keeps content from AI clients the file's exposure doesn't allow, and records the AI read", async () => {
    await db.withTenant(t.tenantId, (tx) =>
      tx.insert(objectTags).values({
        tenantId: t.tenantId,
        objectId: t.objectId,
        facet: "exposure",
        value: "local",
        source: "rule",
        appliedBy: "rule:x",
        confidence: 1,
      }),
    );
    expect((await open(reader(), { trust: "commercial" })).opened).toBeNull();
    expect((await open(reader(), { trust: "consumer" })).opened).toBeNull();
    const local = await open(reader(), { trust: "local" });
    expect(local.opened?.blobId).toBe(t.blobId);
    expect(local.events[0]?.client).toEqual({ id: "a-client", trust: "local" });
    // The card stays: the same reader, through the same client, still sees the file.
    const [card] = await db.withTenant(
      t.tenantId,
      (tx) =>
        viewObjects(
          tx,
          t.tenantId,
          authz,
          { principal: reader(), client: { id: "a-client", trust: "commercial" } },
          [t.objectId],
        ),
      VIEW_TRANSACTION,
    );
    expect(card).toMatchObject({ shape: "card", readable: true });
  });

  it("needs a snapshot, and doesn't take content with search", async () => {
    const request: RecordedRequest = {
      principal: reader(),
      client: { id: "c", trust: "first-party" },
      activity: new ActivityBuffer(),
    };
    await expect(
      db.withTenant(t.tenantId, (tx) => openContent(tx, t.tenantId, authz, request, t.objectId)),
    ).rejects.toThrow(/repeatable read/);
    await expect(
      db.withTenant(
        t.tenantId,
        (tx) =>
          viewObjects(tx, t.tenantId, authz, request, [t.objectId], {
            search: true,
            content: true,
          }),
        VIEW_TRANSACTION,
      ),
    ).rejects.toThrow(TypeError);
  });
});
