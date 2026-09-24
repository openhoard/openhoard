import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ACTIONS, Authorizer, type Action, type AuthzRequest } from "./authorize.js";
import { CORE_POLICIES, createCedarEngine, fromCedar, PolicyError } from "./cedar.js";

const request = (patch: Partial<AuthzRequest> = {}): AuthzRequest => ({
  principal: {
    userId: "u1",
    groupIds: ["g-sales"],
    tagGrants: [],
    tagWriteGrants: [],
    guest: false,
    active: true,
  },
  action: "read",
  resource: { id: "obj_1", ownerId: "user:u2", tags: ["client:acme"], zone: "indexed" },
  client: { id: "openhoard-web", trust: "first-party" },
  ...patch,
});
const withGrants = (
  tagGrants: string[],
  patch: Partial<AuthzRequest> = {},
  tagWriteGrants: string[] = [],
) => {
  const r = request(patch);
  return { ...r, principal: { ...r.principal, tagGrants, tagWriteGrants } };
};

describe("core rules", () => {
  const authz = new Authorizer(createCedarEngine());

  it("denies by default", () => {
    expect(authz.authorize(request())).toEqual({
      allow: false,
      reason: "no policy permits it",
      policies: [],
    });
  });

  it.each(["search", "read", "open"] as const)(
    "permits %s to a caller with a read grant on one of the object's tags",
    (action) => {
      expect(authz.authorize(withGrants(["client:acme"], { action }))).toEqual({
        allow: true,
        reason: "permitted by core/read-grant",
        policies: ["core/read-grant"],
      });
    },
  );

  it("needs a write grant to tag", () => {
    expect(authz.authorize(withGrants(["client:acme"], { action: "tag" })).allow).toBe(false);
    expect(authz.authorize(withGrants([], { action: "tag" }, ["client:acme"]))).toMatchObject({
      allow: true,
      policies: ["core/write-grant"],
    });
    // A write grant also lets you open.
    expect(authz.authorize(withGrants([], { action: "open" }, ["client:acme"]))).toMatchObject({
      allow: true,
      policies: ["core/read-grant"],
    });
  });

  it("permits the owner without a grant", () => {
    const r = request();
    const decision = authz.authorize({ ...r, principal: { ...r.principal, userId: "u2" } });
    expect(decision).toMatchObject({ allow: true, policies: ["core/owner"] });
  });

  it("does not treat a group or a look-alike user as the owner", () => {
    const r = request();
    const asGroup = { ...r, resource: { ...r.resource, ownerId: "group:u1" } };
    expect(authz.authorize(asGroup).allow).toBe(false);
    const bare = { ...r, resource: { ...r.resource, ownerId: "u1" } };
    expect(authz.authorize(bare).allow).toBe(false);
    const noOwner = { ...r, resource: { ...r.resource, ownerId: "" } };
    expect(authz.authorize(noOwner).allow).toBe(false);
  });

  it("forbids deprovisioned users even their own files and granted tags", () => {
    const r = withGrants(["client:acme"]);
    const decision = authz.authorize({
      ...r,
      principal: { ...r.principal, userId: "u2", active: false },
    });
    expect(decision).toEqual({
      allow: false,
      reason: "forbidden by core/inactive",
      policies: ["core/inactive"],
    });
  });

  it("names every permit that applied", () => {
    const r = withGrants(["client:acme"]);
    const decision = authz.authorize({ ...r, principal: { ...r.principal, userId: "u2" } });
    expect(decision.policies).toEqual(["core/owner", "core/read-grant"]);
  });

  it("takes ids and tags as data, never as policy text", () => {
    const tricky = 'x" || true || "';
    const resource = { id: tricky, ownerId: `user:${tricky}`, tags: [tricky, "ü:ñ"], zone: tricky };
    expect(authz.authorize(withGrants(['x"'], { resource })).allow).toBe(false);
    expect(authz.authorize(withGrants(["ü:ñ"], { resource })).policies).toEqual([
      "core/read-grant",
    ]);
    const owner = request({ resource });
    expect(
      authz.authorize({ ...owner, principal: { ...owner.principal, userId: tricky } }).policies,
    ).toEqual(["core/owner"]);
  });

  it("keeps ids of different kinds apart", () => {
    // A user, a group, a tag and an object that share a name are still different entities.
    const same = "g-hr";
    const hrPack = new Authorizer(
      createCedarEngine({
        "pack/hr": `permit (principal in OpenHoard::Group::"g-hr", action, resource);`,
      }),
    );
    const r = request({ resource: { id: same, ownerId: `user:${same}`, tags: [same], zone: "x" } });
    const namedLikeTheGroup = { ...r, principal: { ...r.principal, userId: same, groupIds: [] } };
    // Owner, because the owner is user:g-hr; but not a member of the group g-hr.
    expect(hrPack.authorize(namedLikeTheGroup).policies).toEqual(["core/owner"]);
    const other = {
      ...r,
      principal: { ...r.principal, groupIds: ["tag-looking", same.toUpperCase()] },
    };
    expect(hrPack.authorize(other).allow).toBe(false);
  });
});

describe("pack rules", () => {
  const RESTRICTED_NOT_TO_CONSUMER_AI = `forbid (principal, action == OpenHoard::Action::"open",
    resource in OpenHoard::Tag::"sensitivity:restricted")
    when { context.client.trust == "consumer" };`;
  const GUESTS_DO_NOT_TAG = `forbid (principal, action == OpenHoard::Action::"tag", resource)
    when { principal.guest };`;
  const HR_READS_HR = `permit (principal in OpenHoard::Group::"g-hr",
    action in [OpenHoard::Action::"search", OpenHoard::Action::"read"],
    resource in OpenHoard::Tag::"department:hr");`;
  const authz = new Authorizer(
    createCedarEngine({
      "pack/restricted-consumer": RESTRICTED_NOT_TO_CONSUMER_AI,
      "pack/guests-no-tag": GUESTS_DO_NOT_TAG,
      "pack/hr": HR_READS_HR,
    }),
  );
  const restricted = {
    id: "obj_2",
    ownerId: "user:u9",
    tags: ["client:acme", "sensitivity:restricted"],
    zone: "indexed",
  };

  it("a forbid beats a grant", () => {
    const consumer = withGrants(["client:acme"], {
      action: "open",
      resource: restricted,
      client: { id: "chatgpt", trust: "consumer" },
    });
    expect(authz.authorize(consumer)).toMatchObject({
      allow: false,
      policies: ["pack/restricted-consumer"],
    });
    // The same caller through a commercial client, or asking for a card, is allowed.
    expect(
      authz.authorize({ ...consumer, client: { id: "claude", trust: "commercial" } }).allow,
    ).toBe(true);
    expect(authz.authorize({ ...consumer, action: "read" }).allow).toBe(true);
  });

  it("uses the principal's attributes", () => {
    const r = withGrants([], { action: "tag" }, ["client:acme"]);
    expect(authz.authorize(r).allow).toBe(true);
    expect(authz.authorize({ ...r, principal: { ...r.principal, guest: true } })).toMatchObject({
      allow: false,
      policies: ["pack/guests-no-tag"],
    });
  });

  it("can permit through group membership and tag hierarchy", () => {
    const hr = { id: "obj_3", ownerId: "user:u9", tags: ["department:hr"], zone: "indexed" };
    const member = request({ resource: hr });
    const inHr = { ...member, principal: { ...member.principal, groupIds: ["g-sales", "g-hr"] } };
    expect(authz.authorize(inHr)).toMatchObject({ allow: true, policies: ["pack/hr"] });
    expect(authz.authorize({ ...inHr, action: "open" }).allow).toBe(false);
    expect(authz.authorize(member).allow).toBe(false);
  });

  it("denies when a rule errors while evaluating, instead of skipping it", () => {
    // Passes validation, then overflows at run time. Cedar alone would skip this forbid.
    const engine = createCedarEngine({
      "pack/overflows": `forbid (principal, action, resource)
        when { 9223372036854775807 + (if context.readGranted then 1 else 0) > 0 };`,
    });
    const decision = new Authorizer(engine).authorize(withGrants(["client:acme"]));
    expect(decision).toEqual({
      allow: false,
      reason: "policy error in pack/overflows",
      policies: ["pack/overflows"],
    });
  });
});

describe("request-time failures", () => {
  it("deny", () => {
    // Authorizer rejects this as malformed; straight to the engine, Cedar refuses the entity.
    const engine = createCedarEngine({ "pack/all": "permit (principal, action, resource);" });
    const r = request();
    const decision = engine.evaluate({
      ...r,
      principal: { ...r.principal, groupIds: [undefined as unknown as string] },
      readGranted: true,
      writeGranted: true,
      owner: true,
    });
    expect(decision).toEqual({ allow: false, reason: "policy evaluation failed", policies: [] });
  });
});

describe("createCedarEngine", () => {
  it("refuses a forbid that can never apply", () => {
    let error: unknown;
    try {
      createCedarEngine({
        "pack/never": `forbid (principal in OpenHoard::Tag::"x", action, resource);`,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PolicyError);
    expect((error as PolicyError).message).toMatch(/validation warnings/);
    const details = (error as PolicyError).details;
    expect(details.length).toBeGreaterThan(0);
    for (const d of details) expect(d).toMatch(/^pack\/never: /);
  });

  it("keeps engines apart even across copies of this module", async () => {
    // Cedar's cache is per process; a second copy of this module (a bundler duplicate, or src
    // and dist loaded side by side) must not overwrite the first copy's policy sets. The query
    // string makes Vite load a separate instance.
    const closed = [createCedarEngine(), createCedarEngine(), createCedarEngine()];
    const path = "./cedar.js?copy";
    const copy = (await import(/* @vite-ignore */ path)) as typeof import("./cedar.js");
    for (let i = 0; i < 50; i++) {
      copy.createCedarEngine({ "pack/all": "permit (principal, action, resource);" });
    }
    for (const engine of closed)
      expect(new Authorizer(engine).authorize(request()).allow).toBe(false);
  });

  it("rejects policies that do not parse", () => {
    expect(() => createCedarEngine({ "pack/bad": "permit (principal, action" })).toThrow(
      PolicyError,
    );
  });

  it("rejects policies that do not match the schema, naming them", () => {
    let error: unknown;
    try {
      createCedarEngine({
        "pack/typo": `forbid (principal, action, resource) when { principal.gest };`,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PolicyError);
    expect((error as PolicyError).details).toEqual([expect.stringMatching(/^pack\/typo: /)]);
  });

  it("reserves core/ ids", () => {
    expect(() =>
      createCedarEngine({ "core/grant": CORE_POLICIES["core/grant"] as string }),
    ).toThrow("policy ids reserved for the core rules");
    expect(() =>
      createCedarEngine({ "core/new": "permit (principal, action, resource);" }),
    ).toThrow(PolicyError);
  });

  it("keeps engines independent", () => {
    const open = createCedarEngine({ "pack/all": "permit (principal, action, resource);" });
    const closed = createCedarEngine();
    expect(new Authorizer(open).authorize(request()).allow).toBe(true);
    expect(new Authorizer(closed).authorize(request()).allow).toBe(false);
  });
});

describe("fromCedar", () => {
  it("denies a failed evaluation", () => {
    expect(fromCedar({ type: "failure", errors: [], warnings: [] })).toEqual({
      allow: false,
      reason: "policy evaluation failed",
      policies: [],
    });
  });
});

/*
 * Property: for any caller, object, client and action, the Cedar engine with the core rules
 * and a representative pack decides exactly what this plain reference evaluator decides.
 */
describe("Cedar engine against a reference evaluator (property)", () => {
  const PACK = {
    "pack/restricted-consumer": `forbid (principal, action == OpenHoard::Action::"open",
      resource in OpenHoard::Tag::"sensitivity:restricted") when { context.client.trust == "consumer" };`,
    "pack/guests-no-tag": `forbid (principal, action == OpenHoard::Action::"tag", resource)
      when { principal.guest };`,
    "pack/hr": `permit (principal in OpenHoard::Group::"g-hr",
      action in [OpenHoard::Action::"search", OpenHoard::Action::"read"],
      resource in OpenHoard::Tag::"department:hr");`,
  };
  const authz = new Authorizer(createCedarEngine(PACK));

  const reference = (r: AuthzRequest): boolean => {
    const tags = new Set(r.resource.tags);
    const p = r.principal;
    if (!p.active) return false;
    if (r.action === "open" && tags.has("sensitivity:restricted") && r.client.trust === "consumer")
      return false;
    if (r.action === "tag" && p.guest) return false;
    const write = p.tagWriteGrants.some((t) => tags.has(t));
    const read = write || p.tagGrants.some((t) => tags.has(t));
    if (r.action === "tag" ? write : read) return true;
    if (r.resource.ownerId === `user:${p.userId}`) return true;
    return (
      p.groupIds.includes("g-hr") &&
      tags.has("department:hr") &&
      (r.action === "search" || r.action === "read")
    );
  };

  // Names overlap across kinds on purpose: a user and a tag both called g-hr, and so on.
  const tag = fc.constantFrom(
    "client:acme",
    "client:globex",
    "department:hr",
    "sensitivity:restricted",
    "sensitivity:internal",
    "g-hr",
  );
  const user = fc.constantFrom("u1", "u2", "g-hr", "obj_1");
  const arbitraryRequest: fc.Arbitrary<AuthzRequest> = fc.record({
    principal: fc.record({
      userId: user,
      groupIds: fc.uniqueArray(fc.constantFrom("g-hr", "g-sales", "g-all"), { maxLength: 3 }),
      tagGrants: fc.uniqueArray(tag, { maxLength: 3 }),
      tagWriteGrants: fc.uniqueArray(tag, { maxLength: 2 }),
      guest: fc.boolean(),
      active: fc.boolean(),
    }),
    action: fc.constantFrom<Action>(...ACTIONS),
    resource: fc.record({
      id: fc.constantFrom("obj_1", "obj_2"),
      ownerId: fc.oneof(
        user.map((u) => `user:${u}`),
        fc.constantFrom("group:g-hr", ""),
      ),
      tags: fc.array(tag, { maxLength: 4 }),
      zone: fc.constantFrom("indexed", "managed"),
    }),
    client: fc.record({
      id: fc.constantFrom("openhoard-web", "claude", "chatgpt"),
      trust: fc.constantFrom("first-party", "local", "commercial", "consumer"),
    }),
  });

  it("agrees on every decision", () => {
    fc.assert(
      fc.property(arbitraryRequest, (r) => {
        expect(authz.authorize(r).allow).toBe(reference(r));
      }),
      { numRuns: 2_000 },
    );
    // 2,000 Cedar evaluations take a few seconds under coverage on a CI runner.
  }, 60_000);
});
