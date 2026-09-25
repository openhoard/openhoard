import {
  facets,
  facetValues,
  objects,
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
  decideRead,
  type AuthzDecision,
  type AuthzPrincipal,
  type AuthzRequest,
  type Visibility,
} from "@openhoard/core-policy";
import { and, eq } from "drizzle-orm";
import fc from "fast-check";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { blobIdOf, ingest, removeFromSource } from "./ingest.js";
import { listVersions, viewBySource, viewObject } from "./read.js";
import { markProcessed, VIEW_TRANSACTION, type ViewRequest } from "./visibility.js";

/* T-206: the catalog read API, behind policy. */

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
    await tx.insert(facets).values({ tenantId: t.tenantId, key: "sensitivity", label: "S" });
    const level = (value: string, visibility: Visibility) => ({
      tenantId: t.tenantId,
      facet: "sensitivity",
      value,
      label: value,
      approved: true,
      visibility,
      exposure: "full" as const,
    });
    await tx
      .insert(facetValues)
      .values([
        level("public", "readable"),
        level("internal", "discoverable"),
        level("restricted", "hidden"),
      ]);
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
  userId: "bo",
  groupIds: [],
  tagGrants: [],
  tagWriteGrants: [],
  objectGrants: [],
  objectWriteGrants: [],
  guest: false,
  active: true,
  ...more,
});
const reader = () => person({ userId: "ana", tagGrants: [t.tag] });
const request = (principal: AuthzPrincipal, trust: Trust = "first-party"): ViewRequest => ({
  principal,
  client: { id: "a-client", trust },
});
const snapshot = <T>(work: (tx: Tx) => Promise<T>, tenantId = t.tenantId) =>
  db.withTenant(tenantId, work, VIEW_TRANSACTION);
const item = () => ({ source: "sharepoint", externalId: t.externalId });
const setSensitivity = (value: string | null) =>
  db.withTenant(t.tenantId, async (tx) => {
    await tx.delete(objectTags).where(eq(objectTags.facet, "sensitivity"));
    if (value !== null) {
      await tx.insert(objectTags).values({
        tenantId: t.tenantId,
        objectId: t.objectId,
        facet: "sensitivity",
        value,
        source: "rule",
        appliedBy: "rule:x",
        confidence: 1,
      });
    }
  });

interface Ids {
  objectId: string;
  item: { source: string; externalId: string };
}
/** Every read, for one caller, through one authorizer. */
const readAll = (
  principal: AuthzPrincipal,
  gate: Authorizer = authz,
  ids: Ids = { objectId: t.objectId, item: item() },
  trust: Trust = "first-party",
  tenantId = t.tenantId,
) =>
  snapshot(
    async (tx) => ({
      object: await viewObject(tx, t.tenantId, gate, request(principal, trust), ids.objectId),
      bySource: await viewBySource(tx, t.tenantId, gate, request(principal, trust), ids.item),
      versions: await listVersions(tx, t.tenantId, gate, request(principal, trust), ids.objectId),
    }),
    tenantId,
  );
const NOTHING = { object: null, bySource: null, versions: null };

describe("the catalog read API", () => {
  it("gives a reader the card, by id and by source item, and the versions newest first", async () => {
    const second = await db.withTenant(t.tenantId, async (tx) => {
      const r = await ingest(tx, t.tenantId, {
        source: "sharepoint",
        externalId: t.externalId,
        zoneId: t.zoneId,
        title: "Report 1.docx",
        ownerId: `user:${t.userId}`,
        content: await blobIdOf(new Uint8Array(32).fill(7), new TextEncoder().encode("v2")),
        mime: "application/pdf",
        authorId: "user:ana",
      });
      await markProcessed(tx, t.tenantId, { versionId: r.versionId, title: "Report 1.docx" });
      return r;
    });
    const all = await readAll(reader());
    expect(all.object).toMatchObject({ id: t.objectId, shape: "card", readable: true });
    expect(all.bySource).toEqual(all.object);
    expect(all.versions).toEqual([
      {
        id: second.versionId,
        seq: 2,
        mime: "application/pdf",
        size: 2,
        authorId: "user:ana",
        createdAt: expect.any(Date),
        processed: true,
        current: true,
      },
      expect.objectContaining({ id: t.versionId, seq: 1, current: false }),
    ]);
  });

  it("gives a non-reader of a discoverable file a title-only view and no versions", async () => {
    const all = await readAll(person());
    expect(all.object).toMatchObject({ shape: "title-only", requestAccess: true });
    expect(all.bySource).toEqual(all.object);
    expect(all.versions).toBeNull();
  });

  it("gives a non-reader of a readable file a card they can't open, no hidden tags, no versions", async () => {
    await setSensitivity("public");
    const all = await readAll(person());
    expect(all.object).toMatchObject({
      shape: "card",
      readable: false,
      tags: [],
      primaryTag: null,
    });
    expect(all.bySource).toEqual(all.object);
    expect(all.versions).toBeNull();
  });

  it("tells guests, and inactive people, nothing about what they can't read", async () => {
    for (const who of [person({ guest: true }), person({ active: false })]) {
      expect(await readAll(who)).toEqual(NOTHING);
    }
  });

  it("answers null alike for hidden, unprocessed, deleted, unknown and malformed", async () => {
    await setSensitivity("restricted");
    expect(await readAll(person())).toEqual(NOTHING);
    await setSensitivity(null);
    await db.withTenant(t.tenantId, (tx) =>
      tx.update(versions).set({ processedAt: null }).where(eq(versions.id, t.versionId)),
    );
    expect(await readAll(person())).toEqual(NOTHING);
    const odd: Ids[] = [
      {
        objectId: "obj_00000000000000000000000000",
        item: { source: "sharepoint", externalId: "no" },
      },
      { objectId: "obj_\0", item: { source: "sharepoint", externalId: "x\0y" } },
      { objectId: "not an id", item: { source: "", externalId: "x".repeat(5000) } },
    ];
    for (const ids of odd) expect(await readAll(reader(), authz, ids)).toEqual(NOTHING);
    await db.withTenant(t.tenantId, (tx) =>
      removeFromSource(tx, t.tenantId, "sharepoint", t.externalId),
    );
    expect(await readAll(reader())).toEqual(NOTHING);
  });

  it("keeps a restored file's earlier versions in its history", async () => {
    await db.withTenant(t.tenantId, (tx) =>
      removeFromSource(tx, t.tenantId, "sharepoint", t.externalId),
    );
    await db.withTenant(t.tenantId, async (tx) => {
      const r = await ingest(tx, t.tenantId, {
        source: "sharepoint",
        externalId: t.externalId,
        zoneId: t.zoneId,
        title: "Report 1.docx",
        ownerId: `user:${t.userId}`,
        content: await blobIdOf(new Uint8Array(32).fill(7), new TextEncoder().encode("back")),
      });
      expect(r.restored).toBe(true);
      await markProcessed(tx, t.tenantId, { versionId: r.versionId, title: "Report 1.docx" });
    });
    expect((await readAll(reader())).versions?.map((v) => v.seq)).toEqual([2, 1]);
  });

  it("never reads another tenant's objects, by argument or through row-level security", async () => {
    const other = await seedTenant(db, 2);
    const theirs: Ids = {
      objectId: other.objectId,
      item: { source: "sharepoint", externalId: other.externalId },
    };
    // Their ids, in our tenant's transaction.
    expect(await readAll(reader(), authz, theirs)).toEqual(NOTHING);
    // Our tenant and ids as arguments, in their transaction: row-level security answers.
    expect(await readAll(reader(), authz, undefined, "first-party", other.tenantId)).toEqual(
      NOTHING,
    );
  });

  it("refuses to read outside a snapshot the same way whether or not the object exists", async () => {
    await setSensitivity("restricted");
    const outside = (ids: Ids) =>
      Promise.all(
        [
          (tx: Tx): Promise<unknown> =>
            viewObject(tx, t.tenantId, authz, request(person()), ids.objectId),
          (tx: Tx) => viewBySource(tx, t.tenantId, authz, request(person()), ids.item),
          (tx: Tx) => listVersions(tx, t.tenantId, authz, request(person()), ids.objectId),
        ].map((read) =>
          db.withTenant(t.tenantId, read).then(
            () => "no error",
            (e: unknown) => (e instanceof Error ? e.message : String(e)),
          ),
        ),
      );
    const hidden = await outside({ objectId: t.objectId, item: item() });
    const unknown = await outside({
      objectId: "obj_00000000000000000000000000",
      item: { source: "sharepoint", externalId: "nope" },
    });
    expect(hidden).toEqual(unknown);
    expect(hidden.every((m) => m.includes("repeatable read"))).toBe(true);
  });

  it("decides every read as authorize() and decideRead() say (property)", async () => {
    const levels = ["public", "internal", "restricted", null] as const;
    const trusts: Trust[] = ["first-party", "local", "commercial", "consumer"];
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          allow: fc.boolean(),
          active: fc.boolean(),
          guest: fc.boolean(),
          sensitivity: fc.constantFrom(...levels),
          processed: fc.boolean(),
          deleted: fc.boolean(),
          trust: fc.constantFrom(...trusts),
        }),
        async (c) => {
          await setSensitivity(c.sensitivity);
          await db.withTenant(t.tenantId, async (tx) => {
            await tx
              .update(versions)
              .set({ processedAt: c.processed ? new Date() : null })
              .where(eq(versions.id, t.versionId));
            await tx
              .update(objects)
              .set({ deletedAt: c.deleted ? new Date() : null })
              .where(and(eq(objects.tenantId, t.tenantId), eq(objects.id, t.objectId)));
          });
          const asked: AuthzRequest[] = [];
          const gate = {
            authorize(input: AuthzRequest): AuthzDecision {
              asked.push(input);
              return {
                allow: c.allow,
                kind: c.allow ? "allow" : "no-permit",
                reason: "test",
                policies: [],
              };
            },
          } as unknown as Authorizer;
          const all = await readAll(
            person({ active: c.active, guest: c.guest }),
            gate,
            undefined,
            c.trust,
          );
          // Only ever `read`, and only ever about this object.
          expect(asked.every((a) => a.action === "read" && a.resource.id === t.objectId)).toBe(
            true,
          );
          // The oracle: what the levels say, given what authorize() said.
          const visibility: Visibility = !c.processed
            ? "hidden"
            : c.sensitivity === "public"
              ? "readable"
              : c.sensitivity === "restricted"
                ? "hidden"
                : "discoverable";
          const member = c.active && !c.guest;
          const shape =
            c.deleted || (!c.allow && !member)
              ? "none"
              : decideRead({
                  canRead: c.allow,
                  visibility,
                  exposure: "full",
                  clientTrust: c.trust,
                  wantsContent: false,
                }).shape;
          expect(all.object?.shape ?? "none").toBe(shape);
          expect(all.bySource).toEqual(all.object);
          if (all.object?.shape === "card") expect(all.object.readable).toBe(c.allow);
          expect(all.versions !== null).toBe(shape === "card" && c.allow);
        },
      ),
      { numRuns: 40 },
    );
  });
});
