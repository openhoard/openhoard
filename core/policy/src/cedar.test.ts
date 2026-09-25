import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  Authorizer,
  type Action,
  type AuthzRequest,
  type CredentialScope,
} from "./authorize.js";
import {
  allTagsMisuse,
  CORE_POLICIES,
  createCedarEngine,
  fromCedar,
  PolicyError,
  policyEffect,
  toCedar,
} from "./cedar.js";

const request = (patch: Partial<AuthzRequest> = {}): AuthzRequest => ({
  principal: {
    userId: "u1",
    groupIds: ["g-sales"],
    tagGrants: [],
    tagWriteGrants: [],
    objectGrants: [],
    objectWriteGrants: [],
    guest: false,
    active: true,
  },
  action: "read",
  resource: {
    id: "obj_1",
    ownerId: "user:u2",
    tags: ["client:acme"],
    allTags: [],
    zone: "indexed",
  },
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

describe("trusted and all tags", () => {
  const authz = new Authorizer(
    createCedarEngine({
      "pack/hr-no-guests": `forbid (principal, action, resource)
        when { principal.guest && resource.allTags.contains("department:hr") };`,
      "pack/handbook": `permit (principal, action == OpenHoard::Action::"read", resource)
        when { resource in OpenHoard::Tag::"kind:handbook" };`,
    }),
  );
  const guest = (resource: Partial<AuthzRequest["resource"]>) => {
    const r = withGrants(["client:acme"], { resource: { ...request().resource, ...resource } });
    return { ...r, principal: { ...r.principal, guest: true } };
  };

  it("lets a forbid see a model's unreviewed guess", () => {
    expect(authz.authorize(guest({})).allow).toBe(true);
    expect(authz.authorize(guest({ allTags: ["department:hr"] }))).toMatchObject({
      allow: false,
      kind: "forbid",
      policies: ["pack/hr-no-guests"],
    });
  });

  it("keeps a permit to the trusted tags", () => {
    const member = request({
      resource: { ...request().resource, tags: [], allTags: ["kind:handbook"] },
    });
    expect(authz.authorize(member).allow).toBe(false);
    const trusted = request({ resource: { ...request().resource, tags: ["kind:handbook"] } });
    expect(authz.authorize(trusted)).toMatchObject({ allow: true, policies: ["pack/handbook"] });
  });

  it("treats the trusted tags as part of all tags", () => {
    expect(authz.authorize(guest({ tags: ["client:acme", "department:hr"] })).allow).toBe(false);
  });

  it("refuses a malformed allTags", () => {
    const bad = request({
      resource: { ...request().resource, allTags: [""] },
    });
    expect(authz.authorize(bad)).toMatchObject({
      kind: "error",
      reason: "malformed request: resource.allTags",
    });
  });
});

describe("policyEffect", () => {
  it("reads a policy's effect", () => {
    expect(policyEffect("// a comment\npermit (principal, action, resource);")).toBe("permit");
    expect(policyEffect('@id("x") forbid (principal, action, resource);')).toBe("forbid");
    expect(policyEffect("permit (principal")).toBeNull();
  });
});

describe("allTagsMisuse", () => {
  it.each([
    'forbid (principal, action, resource) when { resource.allTags.contains("x") };',
    'forbid (principal, action, resource) when { principal.guest && (resource.allTags.containsAny(["a", "b"]) || resource.zone == "code") };',
    'forbid (principal, action, resource) when { if principal.guest then resource.allTags.contains("x") else false };',
    'forbid (principal, action, resource) when { !(!resource.allTags.contains("x")) };',
    'permit (principal, action, resource in OpenHoard::Tag::"x");',
  ])("accepts %s", (text) => {
    expect(allTagsMisuse(text)).toEqual([]);
  });

  it.each([
    ['permit (principal, action, resource) when { resource.allTags.contains("x") };', "a permit"],
    [
      'forbid (principal, action, resource) unless { resource.allTags.contains("public") };',
      "only in `when`",
    ],
    [
      'forbid (principal, action, resource) when { !resource.allTags.contains("public") };',
      "un-negated",
    ],
    ["forbid (principal, action, resource) when { resource.allTags.isEmpty() };", "with contains"],
    ["forbid (principal, action, resource) when { resource.allTags == [] };", "with contains"],
    [
      'forbid (principal, action, resource) when { if resource.allTags.contains("x") then false else true };',
      "only in `when`",
    ],
    [
      'forbid (principal, action, resource) when { ["x"].containsAll(resource.allTags) };',
      "with contains",
    ],
    [
      'permit (principal, action, resource) when { resource == OpenHoard::Object::"o" && OpenHoard::Object::"o".allTags.contains("a:b") };',
      "a permit",
    ],
    [
      'forbid (principal, action, resource) when { !(OpenHoard::Object::"o".allTags.contains("a:b")) };',
      "un-negated",
    ],
    [
      'forbid (principal, action, resource) when { OpenHoard::Object::"o".allTags.contains("a:b") };',
      "resource.allTags only",
    ],
    // A record that copies allTags, chosen by a guess: the guess "model:ok" lifts the forbid.
    [
      'forbid (principal, action, resource) when { (if resource.allTags.contains("model:ok") then {allTags: ["none"]} else {allTags: resource.allTags}).allTags.contains("sensitivity:secret") };',
      "resource.allTags only",
    ],
    [
      'forbid (principal, action, resource) when { {allTags: (if resource.allTags.contains("model:ok") then ["none"] else resource.allTags)}.allTags.contains("sensitivity:secret") };',
      "resource.allTags only",
    ],
    [
      'forbid (principal, action, resource) when { {allTags: resource.allTags}.allTags.contains("sensitivity:secret") };',
      "resource.allTags only",
    ],
    [
      'forbid (principal, action, resource) when { {tags: resource.allTags}.tags.contains("sensitivity:secret") };',
      "with contains",
    ],
  ])("refuses %s", (text, why) => {
    expect(allTagsMisuse(text).join(" ")).toContain(why);
    expect(() => createCedarEngine({ "pack/x": text })).toThrow("resource.allTags used where");
  });

  it("also reports a misuse inside what allTags is read from", () => {
    const text =
      'forbid (principal, action, resource) when { (if resource.allTags.contains("model:ok") then {allTags: ["none"]} else {allTags: resource.allTags}).allTags.contains("sensitivity:secret") };';
    expect(allTagsMisuse(text)).toEqual([
      "allTags may be read as resource.allTags only",
      "a forbid may use resource.allTags only in `when`, un-negated, with contains",
    ]);
  });
});

describe("core rules", () => {
  const authz = new Authorizer(createCedarEngine());

  it("denies by default", () => {
    expect(authz.authorize(request())).toEqual({
      allow: false,
      kind: "no-permit",
      reason: "no policy permits it",
      policies: [],
    });
  });

  it.each(["search", "read", "open"] as const)(
    "permits %s to a caller with a read grant on one of the object's tags",
    (action) => {
      expect(authz.authorize(withGrants(["client:acme"], { action }))).toEqual({
        allow: true,
        kind: "allow",
        reason: "permitted by core/read-grant",
        policies: ["core/read-grant"],
      });
    },
  );

  it("needs a write grant to tag", () => {
    expect(authz.authorize(withGrants(["client:acme"], { action: "tag" })).allow).toBe(false);
    expect(authz.authorize(withGrants([], { action: "tag" }, ["client:acme"]))).toMatchObject({
      allow: true,
      kind: "allow",
      policies: ["core/write-grant"],
    });
    // A write grant also lets you open.
    expect(authz.authorize(withGrants([], { action: "open" }, ["client:acme"]))).toMatchObject({
      allow: true,
      kind: "allow",
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
      kind: "forbid",
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
    const resource = {
      id: tricky,
      ownerId: `user:${tricky}`,
      tags: [tricky, "ü:ñ"],
      allTags: [],
      zone: tricky,
    };
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
    const r = request({
      resource: { id: same, ownerId: `user:${same}`, tags: [same], allTags: [], zone: "x" },
    });
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
    allTags: [],
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
      kind: "forbid",
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
      kind: "forbid",
      policies: ["pack/guests-no-tag"],
    });
  });

  it("can permit through group membership and tag hierarchy", () => {
    const hr = {
      id: "obj_3",
      ownerId: "user:u9",
      tags: ["department:hr"],
      allTags: [],
      zone: "indexed",
    };
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
      kind: "error",
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
      inScope: true,
      writeGranted: true,
      owner: true,
    });
    expect(decision).toEqual({
      allow: false,
      kind: "error",
      reason: "policy evaluation failed",
      policies: [],
    });
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
    // and dist loaded side by side) must not overwrite the first copy's policy sets with
    // different ones. The query string makes Vite load a separate instance.
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

  it("reads each policy text once, so a getter can't pass the checks with one text and run another", () => {
    let reads = 0;
    const tricky = {
      get "pack/x"() {
        reads++;
        // The first read is harmless; any later one would widen access by a model's guess.
        return reads === 1
          ? 'forbid (principal, action, resource) when { resource.allTags.contains("x:y") };'
          : 'permit (principal, action, resource) when { resource.allTags.contains("x:y") };';
      },
    };
    createCedarEngine(tricky);
    expect(reads).toBe(1);
    expect(() => createCedarEngine({ "pack/n": 1 as unknown as string })).toThrow(
      "policy text must be a string",
    );
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

  it("returns the same engine for the same policy set, in any order", () => {
    const a = {
      "pack/all": "permit (principal, action, resource);",
      "pack/guests": "forbid (principal, action, resource) when { principal.guest };",
    };
    const b = { "pack/guests": a["pack/guests"], "pack/all": a["pack/all"] };
    const first = createCedarEngine(a);
    const second = createCedarEngine(b);
    expect(second).toBe(first);
    const guest = { ...request(), principal: { ...request().principal, guest: true } };
    for (const r of [request(), guest]) {
      expect(new Authorizer(second).authorize(r)).toEqual(new Authorizer(first).authorize(r));
    }
    expect(new Authorizer(first).authorize(request()).allow).toBe(true);
    expect(new Authorizer(first).authorize(guest).allow).toBe(false);
    expect(createCedarEngine()).toBe(createCedarEngine({}));
    // Shared, so no caller can swap its evaluate for everyone else.
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("returns a different engine for a different policy set", () => {
    const base = { "pack/all": "permit (principal, action, resource);" };
    const engine = createCedarEngine(base);
    expect(createCedarEngine()).not.toBe(engine);
    // Same text under another id, and another text under the same id, are different sets.
    expect(createCedarEngine({ "pack/every": base["pack/all"] })).not.toBe(engine);
    const changed = createCedarEngine({
      "pack/all": 'permit (principal, action == OpenHoard::Action::"search", resource);',
    });
    expect(changed).not.toBe(engine);
    expect(new Authorizer(changed).authorize(request()).allow).toBe(false);
    expect(new Authorizer(engine).authorize(request()).allow).toBe(true);
  });

  it("does not cache a set that fails to build", () => {
    const broken = { "pack/typo": "forbid (principal, action, resource) when { principal.gest };" };
    const misuse = {
      "pack/x": 'permit (principal, action, resource) when { resource.allTags.contains("x") };',
    };
    for (let i = 0; i < 3; i++) {
      expect(() => createCedarEngine(broken)).toThrow("policies do not match the schema");
      expect(() => createCedarEngine(misuse)).toThrow("resource.allTags used where");
    }
  });
});

describe("groups sent to Cedar", () => {
  const authz = new Authorizer(
    createCedarEngine({
      "pack/hr": `permit (principal in OpenHoard::Group::"g-hr", action == OpenHoard::Action::"read", resource);`,
      "pack/banned": `forbid (principal in OpenHoard::Group::"g-banned", action, resource);`,
      "pack/contractors": `forbid (principal, action == OpenHoard::Action::"open", resource)
        when { principal in [OpenHoard::Group::"g-temp", OpenHoard::Group::"g-vendor"] };`,
    }),
  );
  // 500 groups the policies never mention, as a large tenant's caller may carry.
  const unrelated = Array.from({ length: 500 }, (_, i) => `g-team-${i}`);
  const inGroups = (groupIds: string[], patch: Partial<AuthzRequest> = {}) => {
    const r = withGrants(["client:acme"], patch);
    return { ...r, principal: { ...r.principal, groupIds } };
  };
  const noGrants = (groupIds: string[]) => {
    const r = request({ resource: { ...request().resource, tags: [] } });
    return { ...r, principal: { ...r.principal, groupIds } };
  };

  /*
   * Measured with 0, 200 and 1000 unrelated groups on the caller (plus g-hr), on the dev
   * container: before sending only named groups, 0.6, 2.5 and 11.8 ms per decision, because
   * every group went to Cedar as an entity; after, 0.3–0.5 ms at every size.
   */
  it("still permits through a named group among many unrelated ones", () => {
    expect(authz.authorize(noGrants([...unrelated, "g-hr"]))).toMatchObject({
      allow: true,
      policies: ["pack/hr"],
    });
    expect(authz.authorize(noGrants(unrelated)).allow).toBe(false);
  });

  it("still forbids through a named group among many unrelated ones", () => {
    expect(authz.authorize(inGroups(unrelated)).allow).toBe(true);
    expect(authz.authorize(inGroups([...unrelated, "g-banned"]))).toMatchObject({
      allow: false,
      kind: "forbid",
      policies: ["pack/banned"],
    });
  });

  it("sends only the caller's groups that the policies name", () => {
    const r = {
      ...inGroups(["g-a", "g-hr", "g-b"]),
      readGranted: false,
      writeGranted: false,
      inScope: true,
    };
    const uidOf = (e: { uid: unknown }) => e.uid as { type: string; id: string };
    const sent = toCedar({ ...r, owner: false }, new Set(["g-hr", "g-other"]));
    const groups = sent.entities.filter((e) => uidOf(e).type === "OpenHoard::Group");
    expect(groups.map((e) => uidOf(e).id)).toEqual(["g-hr"]);
    const user = sent.entities.find((e) => uidOf(e).type === "OpenHoard::User");
    expect(user?.parents).toEqual([{ type: "OpenHoard::Group", id: "g-hr" }]);
    expect(toCedar({ ...r, owner: false }, new Set()).entities.map((e) => uidOf(e).type)).toEqual([
      "OpenHoard::User",
      "OpenHoard::Tag",
      "OpenHoard::Object",
      "OpenHoard::Client",
    ]);
  });

  it("sees groups named in a condition, not only in the scope", () => {
    const open = { action: "open" as const };
    expect(authz.authorize(inGroups(unrelated, open)).allow).toBe(true);
    expect(authz.authorize(inGroups([...unrelated, "g-vendor"], open))).toMatchObject({
      allow: false,
      kind: "forbid",
      policies: ["pack/contractors"],
    });
  });
});

describe("fromCedar", () => {
  it("denies a failed evaluation", () => {
    expect(fromCedar({ type: "failure", errors: [], warnings: [] })).toEqual({
      allow: false,
      kind: "error",
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
    const write =
      p.tagWriteGrants.some((t) => tags.has(t)) || p.objectWriteGrants.includes(r.resource.id);
    const read =
      write || p.tagGrants.some((t) => tags.has(t)) || p.objectGrants.includes(r.resource.id);
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
      objectGrants: fc.uniqueArray(fc.constantFrom("obj_1", "obj_2", "g-hr"), { maxLength: 2 }),
      objectWriteGrants: fc.uniqueArray(fc.constantFrom("obj_1", "g-hr"), { maxLength: 1 }),
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
      allTags: fc.array(tag, { maxLength: 2 }),
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

describe("credential scope (T-111)", () => {
  const authz = new Authorizer(createCedarEngine());
  const scoped = (scope: CredentialScope, patch: Partial<AuthzRequest> = {}): AuthzRequest => {
    const r = withGrants(["client:acme"], patch, ["client:acme"]);
    return { ...r, principal: { ...r.principal, service: true, scope } };
  };

  it("allows only the actions and zone kinds a scope names, whatever the grants say", () => {
    const scope = { actions: ["search", "read"] as Action[], zones: ["indexed"] };
    expect(authz.authorize(scoped(scope))).toMatchObject({ allow: true });
    expect(authz.authorize(scoped(scope, { action: "tag" }))).toMatchObject({
      allow: false,
      kind: "forbid",
      policies: ["core/scope"],
    });
    const managed = scoped(scope);
    expect(
      authz.authorize({ ...managed, resource: { ...managed.resource, zone: "managed" } }),
    ).toMatchObject({ allow: false, policies: ["core/scope"] });
    // A scope never grants: no grant, no access, in scope or not.
    const bare = scoped(scope);
    expect(
      authz.authorize({
        ...bare,
        principal: { ...bare.principal, tagGrants: [], tagWriteGrants: [] },
      }),
    ).toMatchObject({ allow: false, kind: "no-permit" });
  });

  it("forbids an owner outside the scope too", () => {
    const r = scoped({ actions: ["read"], zones: ["indexed"] }, { action: "open" });
    expect(
      authz.authorize({ ...r, resource: { ...r.resource, ownerId: `user:${r.principal.userId}` } }),
    ).toMatchObject({ allow: false, policies: ["core/scope"] });
  });

  it("refuses a malformed scope or service flag", () => {
    const bad: unknown[] = [
      { actions: [], zones: ["indexed"] },
      { actions: ["delete"], zones: ["indexed"] },
      { actions: ["read"], zones: [] },
      { actions: "read", zones: ["indexed"] },
      null,
    ];
    for (const scope of bad) {
      expect(authz.authorize(scoped(scope as never))).toMatchObject({
        allow: false,
        kind: "error",
      });
    }
    const r = request();
    expect(
      authz.authorize({ ...r, principal: { ...r.principal, service: "yes" as never } }),
    ).toMatchObject({ allow: false, kind: "error" });
  });

  it("gives a service account without a scope nothing: it acts only through a key", () => {
    const r = withGrants(["client:acme"], {}, ["client:acme"]);
    const bare = { ...r, principal: { ...r.principal, service: true } };
    expect(authz.authorize(bare)).toMatchObject({ allow: false, policies: ["core/scope"] });
    // A person without a scope is unaffected.
    expect(authz.authorize(r)).toMatchObject({ allow: true });
  });

  it("limits to zone ids when the scope names them", () => {
    const scope = { actions: ["read"] as Action[], zones: ["indexed"], zoneIds: ["zon_a"] };
    const r = scoped(scope);
    const at = (zoneId?: string) =>
      authz.authorize({
        ...r,
        resource: { ...r.resource, ...(zoneId === undefined ? {} : { zoneId }) },
      });
    expect(at("zon_a")).toMatchObject({ allow: true });
    expect(at("zon_b")).toMatchObject({ allow: false, policies: ["core/scope"] });
    // A request that doesn't say which zone is out of scope.
    expect(at()).toMatchObject({ allow: false, policies: ["core/scope"] });
  });

  it("never allows outside the scope, whatever else holds (property)", () => {
    fc.assert(
      fc.property(
        fc.subarray([...ACTIONS], { minLength: 1 }),
        fc.subarray(["managed", "indexed", "local-only", "code"], { minLength: 1 }),
        fc.constantFrom(...ACTIONS),
        fc.constantFrom("managed", "indexed", "local-only", "code"),
        fc.boolean(),
        (actions, zones, action, zone, owner) => {
          const r = scoped({ actions, zones }, { action });
          const decision = authz.authorize({
            ...r,
            resource: {
              ...r.resource,
              zone,
              ownerId: owner ? `user:${r.principal.userId}` : "user:else",
            },
          });
          if (decision.allow) {
            expect(actions).toContain(action);
            expect(zones).toContain(zone);
          }
        },
      ),
    );
  });

  it("lets packs tell service accounts apart", () => {
    const engine = createCedarEngine({
      "pack/no-bots": "forbid (principal, action, resource) when { principal.service };",
    });
    const bots = new Authorizer(engine);
    expect(bots.authorize(scoped({ actions: ["read"], zones: ["indexed"] }))).toMatchObject({
      allow: false,
      policies: ["pack/no-bots"],
    });
    expect(bots.authorize(withGrants(["client:acme"]))).toMatchObject({ allow: true });
  });
});
