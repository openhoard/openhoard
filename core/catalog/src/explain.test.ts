import {
  addGrant,
  objects,
  objectTags,
  tenants,
  type Database,
  type GrantInput,
  type Tx,
} from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import {
  createServiceAccount,
  createUser,
  lockUser,
  userPrincipal,
} from "@openhoard/core-identity";
import {
  Authorizer,
  createCedarEngine,
  type AuthzPrincipal,
  type PolicyEngine,
} from "@openhoard/core-policy";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  explainAccess,
  ExplainError,
  type AccessExplanation,
  type ExplainRequest,
} from "./explain.js";
import { markProcessed, VIEW_TRANSACTION } from "./visibility.js";

/* T-606: every explanation names the grant, ownership, policy or stop that decided it. */

const authz = new Authorizer(createCedarEngine());
let db: Database;
let t: SeededTenant;

beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
});
afterEach(() => db?.close());

const inTenant = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work);

/**
 * The done-when, checked on every explanation: an allow names the policies and exactly what
 * they rest on (the listed grants alone still allow, and nothing without them), and a deny
 * names at least one blocker.
 */
function namesWhatDecided(e: AccessExplanation, engine: Authorizer) {
  if (!e.allowed) {
    expect(e.blockers.length, e.summary).toBeGreaterThan(0);
    return;
  }
  expect(e.blockers).toEqual([]);
  expect(e.decision.policies.length, e.summary).toBeGreaterThan(0);
  const only = (grants: AccessExplanation["coveringGrants"], ownerId: string) => {
    const pick = (kind: "tag" | "object", role: "read" | "write") =>
      grants.flatMap((g) =>
        g.role !== role
          ? []
          : kind === "tag" && "tag" in g.target
            ? [g.target.tag]
            : kind === "object" && "objectId" in g.target
              ? [g.target.objectId]
              : [],
      );
    const principal: AuthzPrincipal = {
      userId: e.userId,
      groupIds: [],
      tagGrants: pick("tag", "read"),
      tagWriteGrants: pick("tag", "write"),
      objectGrants: pick("object", "read"),
      objectWriteGrants: pick("object", "write"),
      guest: e.user.guest,
      active: e.user.active,
    };
    return engine.authorize({
      principal,
      action: e.action,
      resource: {
        id: e.objectId,
        ownerId,
        tags: e.object.grantableTags,
        allTags: [...e.object.grantableTags, ...e.object.unreviewedTags],
        zone: e.object.zone,
      },
      client: e.client,
    }).allow;
  };
  if (e.decision.policies.some((p) => p.endsWith("-grant"))) {
    expect(e.coveringGrants.length).toBeGreaterThan(0);
    expect(only(e.coveringGrants, "user:nobody"), "the listed grants suffice").toBe(true);
  }
  if (e.decision.policies.includes("core/owner")) {
    expect(e.owner).toBe(true);
    expect(only([], e.object.ownerId), "ownership suffices").toBe(true);
  }
  expect(only([], "user:nobody"), "nothing else allows it").toBe(false);
}

async function explain(
  request: Partial<ExplainRequest> = {},
  engine: Authorizer = authz,
): Promise<AccessExplanation> {
  const e = await db.withTenant(
    t.tenantId,
    (tx) =>
      explainAccess(tx, t.tenantId, engine, {
        userId: t.userId,
        objectId: t.objectId,
        ...request,
      }),
    VIEW_TRANSACTION,
  );
  namesWhatDecided(e, engine);
  return e;
}
const newUser = (name: string, kind: "member" | "guest" = "member") =>
  inTenant((tx) =>
    createUser(tx, t.tenantId, {
      email: `${name}@example.com`,
      displayName: name,
      source: "local",
      kind,
    }),
  );
const grant = (input: Partial<GrantInput> & { principal: string }) =>
  inTenant((tx) =>
    addGrant(tx, t.tenantId, {
      role: "read",
      target: { tag: t.tag },
      grantedBy: "user:admin",
      ...input,
    }),
  );

describe("explainAccess", () => {
  it("names the group grant behind a read", async () => {
    const e = await explain();
    expect(e).toMatchObject({
      allowed: true,
      decision: { policies: ["core/read-grant"] },
      owner: false,
      coveringGrants: [
        {
          via: { kind: "group", groupId: t.groupId, name: "Readers 1" },
          role: "read",
          target: { tag: t.tag },
          expiresAt: null,
        },
      ],
      unreviewedTagGrants: [],
    });
    expect(e.coveringGrants[0]?.grantId).toMatch(/^grt_/);
    expect(e.summary).toBe(
      `Ana 1 can read "Report 1.docx": through group Readers 1's read grant on ${t.tag}.`,
    );
  });

  it("names ownership, and a direct grant on the file with its expiry", async () => {
    const bo = await newUser("Bo");
    await inTenant((tx) =>
      tx
        .update(objects)
        .set({ ownerId: userPrincipal(bo.id) })
        .where(eq(objects.id, t.objectId)),
    );
    const owned = await explain({ userId: bo.id });
    expect(owned).toMatchObject({
      allowed: true,
      owner: true,
      decision: { policies: ["core/owner"] },
    });
    expect(owned.summary).toContain("they own it");

    const cy = await newUser("Cy");
    const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await grant({
      principal: userPrincipal(cy.id),
      target: { objectId: t.objectId },
      expiresAt: until,
    });
    const direct = await explain({ userId: cy.id });
    expect(direct).toMatchObject({
      allowed: true,
      coveringGrants: [
        { via: { kind: "user" }, target: { objectId: t.objectId }, expiresAt: until },
      ],
    });
    expect(direct.summary).toContain(
      `their own read grant on this file, until ${until.toISOString().slice(0, 10)}`,
    );
  });

  it("counts only write grants for tagging, and says the user can still read", async () => {
    const e = await explain({ action: "tag" });
    expect(e).toMatchObject({
      allowed: false,
      coveringGrants: [],
      blockers: [{ kind: "no-grant", readable: true }],
    });
    expect(e.summary).toBe(
      `Ana 1 can't tag "Report 1.docx": no write grant covers it (they can read it).`,
    );
    await grant({ principal: `group:${t.groupId}`, role: "write" });
    const w = await explain({ action: "tag" });
    expect(w).toMatchObject({ allowed: true, decision: { policies: ["core/write-grant"] } });
    expect(w.coveringGrants.map((g) => g.role)).toEqual(["write"]);
  });

  it("reports a deleted file as not allowed, whatever the policy says", async () => {
    await inTenant((tx) =>
      tx.update(objects).set({ deletedAt: new Date() }).where(eq(objects.id, t.objectId)),
    );
    const e = await explain();
    expect(e).toMatchObject({
      allowed: false,
      decision: { allow: true },
      blockers: [{ kind: "deleted" }],
      view: "none",
      hiddenBecause: "deleted",
    });
    expect(e.summary).toMatch(/^Ana 1 can't read "Report 1.docx": the file is deleted\./);
  });

  it("says a policy error is one, not a missing grant", async () => {
    const broken: PolicyEngine = {
      evaluate: () => {
        throw new Error("boom");
      },
    };
    const e = await explain({}, new Authorizer(broken));
    expect(e.blockers).toEqual([{ kind: "policy-error", reason: "policy engine error" }]);
    expect(e.summary).toContain("the policy engine couldn't decide (policy engine error)");
  });

  it("names the stop behind a deny, and every other blocker too", async () => {
    await inTenant((tx) => lockUser(tx, t.tenantId, t.userId, "user:admin"));
    const e = await explain();
    expect(e).toMatchObject({
      allowed: false,
      decision: { policies: ["core/inactive"] },
      blockers: [{ kind: "locked", by: "user:admin" }],
      user: { active: false },
      view: "none",
      hiddenBecause: "not-a-member",
    });
    expect(e.summary).toBe(
      `Ana 1 can't read "Report 1.docx": their account is locked by user:admin. ` +
        "It is hidden from them: only active members discover files.",
    );
    // Locked and no grant: unlocking alone won't do.
    const bo = await newUser("Bo");
    await inTenant((tx) => lockUser(tx, t.tenantId, bo.id, "user:admin"));
    const both = await explain({ userId: bo.id });
    expect(both.blockers.map((b) => b.kind)).toEqual(["locked", "no-grant"]);
    expect(both.summary).toContain("locked by user:admin; also no grant covers it.");
  });

  it("points at a grant waiting on an unreviewed model tag", async () => {
    await inTenant((tx) =>
      tx
        .update(objectTags)
        .set({ source: "model", appliedBy: "model:tagger", reviewed: false })
        .where(eq(objectTags.objectId, t.objectId)),
    );
    const e = await explain();
    expect(e).toMatchObject({
      allowed: false,
      coveringGrants: [],
      blockers: [{ kind: "no-grant" }],
      unreviewedTagGrants: [{ via: { kind: "group", name: "Readers 1" }, target: { tag: t.tag } }],
      object: { grantableTags: [], unreviewedTags: [t.tag] },
    });
    expect(e.summary).toContain(
      `Group Readers 1's read grant on ${t.tag} would, once a person reviews the model's ${t.tag} tag.`,
    );
  });

  it("names a pack's forbid, and a missing grant next to it", async () => {
    const strict = new Authorizer(
      createCedarEngine({
        "pack/no-guests": "forbid (principal, action, resource) when { principal.guest };",
      }),
    );
    const guest = await newUser("Vendor", "guest");
    await grant({ principal: userPrincipal(guest.id) });
    const e = await explain({ userId: guest.id }, strict);
    expect(e).toMatchObject({
      allowed: false,
      decision: { policies: ["pack/no-guests"] },
      blockers: [{ kind: "forbidden", policies: ["pack/no-guests"] }],
      coveringGrants: [{}],
    });
    expect(e.summary).toContain("forbidden by pack/no-guests.");
    const other = await newUser("Otto", "guest");
    const both = await explain({ userId: other.id }, strict);
    expect(both.blockers.map((b) => b.kind)).toEqual(["forbidden", "no-grant"]);
  });

  it("says what a non-reader sees, from the object's levels", async () => {
    const bo = await newUser("Bo");
    const hidden = await explain({ userId: bo.id });
    expect(hidden).toMatchObject({ view: "none", levels: { processed: false } });
    expect(hidden.summary).toContain("hidden until processing finishes");

    await inTenant(async (tx) => {
      await markProcessed(tx, t.tenantId, { versionId: t.versionId, title: "Report 1.docx" });
      await tx
        .update(tenants)
        .set({ defaultVisibility: "discoverable" })
        .where(eq(tenants.id, t.tenantId));
    });
    const discoverable = await explain({ userId: bo.id });
    expect(discoverable).toMatchObject({
      view: "title-only",
      levels: {
        visibility: "discoverable",
        defaults: { visibility: "discoverable" },
        contributions: [],
      },
    });
    expect(discoverable.summary).toContain("They see its title card (discoverable).");
  });

  it("refuses unknown users and objects, and reads only in one snapshot", async () => {
    const run = (r: Partial<ExplainRequest>) =>
      db.withTenant(
        t.tenantId,
        (tx) =>
          explainAccess(tx, t.tenantId, authz, { userId: t.userId, objectId: t.objectId, ...r }),
        VIEW_TRANSACTION,
      );
    await expect(run({ userId: "usr_01aaaaaaaaaaaaaaaaaaaaaaaa" })).rejects.toMatchObject({
      code: "unknown-user",
    });
    await expect(run({ objectId: "obj_01aaaaaaaaaaaaaaaaaaaaaaaa" })).rejects.toBeInstanceOf(
      ExplainError,
    );
    await expect(
      inTenant((tx) =>
        explainAccess(tx, t.tenantId, authz, { userId: t.userId, objectId: t.objectId }),
      ),
    ).rejects.toThrow("repeatable read");
  });

  it("explains a service account through its key's scope, and refuses it without one", async () => {
    const bot = await inTenant((tx) =>
      createServiceAccount(tx, t.tenantId, { displayName: "Export", by: "user:admin" }),
    );
    await grant({ principal: userPrincipal(bot.id) });
    await inTenant((tx) =>
      markProcessed(tx, t.tenantId, { versionId: t.versionId, title: "Report 1.docx" }),
    );
    const bare = await explain({ userId: bot.id });
    expect(bare).toMatchObject({
      allowed: false,
      user: { service: true },
      blockers: [{ kind: "forbidden", policies: ["core/scope"] }],
    });
    const scoped = await explain({
      userId: bot.id,
      scope: { actions: ["read"], zones: ["indexed"] },
    });
    expect(scoped).toMatchObject({ allowed: true });
    const elsewhere = await explain({
      userId: bot.id,
      scope: { actions: ["read"], zones: ["indexed"], zoneIds: ["zon_00000000000000000000000000"] },
    });
    expect(elsewhere).toMatchObject({ allowed: false });
  });
});
