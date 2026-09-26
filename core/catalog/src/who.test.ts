import {
  addGrant,
  facets,
  facetValues,
  grants,
  newId,
  objects,
  objectTags,
  revokeGrant,
  type Database,
  type Tx,
} from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { createUser } from "@openhoard/core-identity";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExplainError, whoCanAccess } from "./explain.js";
import { VIEW_TRANSACTION } from "./visibility.js";

/* T-806 "who can see this": the grants that reach a file, named, as of now. */

let db: Database;
let t: SeededTenant;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
});
afterEach(() => db?.close());

const inTenant = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work);
const who = (objectId = t.objectId) =>
  db.withTenant(t.tenantId, (tx) => whoCanAccess(tx, t.tenantId, objectId), VIEW_TRANSACTION);

describe("whoCanAccess", () => {
  it("names the owner, every live grant on the file or its tags, and model-only tag grants apart", async () => {
    const bo = await inTenant((tx) =>
      createUser(tx, t.tenantId, { email: "bo@example.com", displayName: "Bo", source: "local" }),
    );
    const other = newId("object");
    const { direct, revoked, guessed } = await inTenant(async (tx) => {
      await tx.update(objects).set({ ownerId: `user:${t.userId}` });
      await tx.insert(objects).values({
        tenantId: t.tenantId,
        id: other,
        zoneId: t.zoneId,
        title: "Other",
        ownerId: `user:${bo.id}`,
      });
      // A tag only a model guessed: a grant on it reaches nobody yet.
      await tx.insert(facets).values({ tenantId: t.tenantId, key: "project", label: "Project" });
      await tx.insert(facetValues).values({
        tenantId: t.tenantId,
        facet: "project",
        value: "atlas",
        label: "Atlas",
        approved: true,
      });
      await tx.insert(objectTags).values({
        tenantId: t.tenantId,
        objectId: t.objectId,
        facet: "project",
        value: "atlas",
        source: "model",
        appliedBy: "model:m",
        confidence: 0.9,
      });
      const g = (principal: string, target: { tag: string } | { objectId: string }) =>
        addGrant(tx, t.tenantId, {
          principal,
          role: "read",
          target,
          grantedBy: "user:admin",
          expiresAt: null,
        });
      const direct = await g(`user:${bo.id}`, { objectId: t.objectId });
      const revoked = await g(`user:${bo.id}`, { tag: t.tag });
      await revokeGrant(tx, t.tenantId, revoked, "user:admin");
      const guessed = await g(`user:${bo.id}`, { tag: "project:atlas" });
      // On another file: not this one's business.
      await g(`user:${t.userId}`, { objectId: other });
      return { direct, revoked, guessed };
    });
    const got = await who();
    expect(got).toMatchObject({
      objectId: t.objectId,
      title: "Report 1.docx",
      ownerId: `user:${t.userId}`,
      ownerName: "Ana 1",
      deleted: false,
    });
    const names = got.grants.map((g) => [g.name, g.role, g.target]);
    expect(names).toEqual(
      expect.arrayContaining([
        ["Readers 1", "read", { tag: t.tag }],
        ["Bo", "read", { objectId: t.objectId }],
      ]),
    );
    expect(got.grants, JSON.stringify(got.grants)).toHaveLength(2);
    expect(got.grants.map((g) => g.grantId)).toContain(direct);
    expect(got.grants.map((g) => g.grantId)).not.toContain(revoked);
    expect(got.unreviewedTagGrants.map((g) => [g.grantId, g.target])).toEqual([
      [guessed, { tag: "project:atlas" }],
    ]);
    expect(got.levels.visibility).toBe("hidden");
  });

  it("names a principal that is gone by its id, and refuses an unknown file", async () => {
    // Written as an import would, for a user this tenant doesn't have (anymore).
    await inTenant((tx) =>
      tx.insert(grants).values({
        tenantId: t.tenantId,
        id: newId("grant"),
        principal: "user:usr_01k5xr3c8v0q6m2d4n7p9s1t3w",
        role: "write",
        objectId: t.objectId,
        grantedBy: "user:admin",
      }),
    );
    const got = await who();
    // The seeded owner (`user:owner-1`) isn't a user: no name.
    expect(got.ownerName).toBeNull();
    expect(got.grants.find((g) => g.role === "write")?.name).toBe(
      "user:usr_01k5xr3c8v0q6m2d4n7p9s1t3w",
    );
    await expect(who(newId("object"))).rejects.toThrow(ExplainError);
    await expect(inTenant((tx) => whoCanAccess(tx, t.tenantId, t.objectId))).rejects.toThrow(
      /VIEW_TRANSACTION/,
    );
  });
});
