import { describe, expect, it, vi } from "vitest";
import {
  Authorizer,
  mayAdminister,
  type AuthzDecision,
  type AuthzRequest,
  type EngineRequest,
  type PolicyEngine,
} from "./authorize.js";
import { createCedarEngine, PolicyError } from "./cedar.js";

const request = (): AuthzRequest => ({
  principal: {
    userId: "u1",
    groupIds: ["g-sales"],
    tagGrants: ["client:acme"],
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
  client: { id: "claude", trust: "commercial" },
});

/** An engine that records what it was asked and allows everything. */
const recording = () => {
  const seen: EngineRequest[] = [];
  const engine: PolicyEngine = {
    evaluate(r): AuthzDecision {
      seen.push(r);
      return { allow: true, kind: "allow", reason: "test engine", policies: [] };
    },
  };
  return { engine, seen };
};

describe("Authorizer", () => {
  it("tells the engine whether the caller holds a grant on one of the object's tags", () => {
    const { engine, seen } = recording();
    const authz = new Authorizer(engine);
    const r = request();
    const grants = (tagGrants: string[], tagWriteGrants: string[] = []) => ({
      ...r,
      principal: { ...r.principal, tagGrants, tagWriteGrants },
    });
    authz.authorize(r);
    authz.authorize(grants(["client:other"]));
    authz.authorize({ ...r, resource: { ...r.resource, tags: [] } });
    authz.authorize(grants(["project:x", "client:acme"]));
    authz.authorize(grants([], ["client:acme"])); // a write grant implies read
    authz.authorize(grants(["client:acme"], ["client:other"]));
    authz.authorize(grants(["client:"])); // a grant matches a whole tag, not a prefix
    expect(seen.map((s) => [s.readGranted, s.writeGranted])).toEqual([
      [true, false],
      [false, false],
      [false, false],
      [true, false],
      [true, true],
      [true, false],
      [false, false],
    ]);
  });

  it("counts grants on the object itself, a write grant implying read", () => {
    const { engine, seen } = recording();
    const authz = new Authorizer(engine);
    const r = request();
    const direct = (objectGrants: string[], objectWriteGrants: string[] = []) => ({
      ...r,
      principal: { ...r.principal, tagGrants: [], objectGrants, objectWriteGrants },
    });
    authz.authorize(direct(["obj_1"]));
    authz.authorize(direct([], ["obj_1"]));
    authz.authorize(direct(["obj_2"], ["obj_3"]));
    authz.authorize(direct(["obj_"]));
    expect(seen.map((s) => [s.readGranted, s.writeGranted])).toEqual([
      [true, false],
      [true, true],
      [false, false],
      [false, false],
    ]);
  });

  it("tells the engine whether the caller owns the object", () => {
    const { engine, seen } = recording();
    const authz = new Authorizer(engine);
    const r = request();
    for (const ownerId of ["user:u1", "user:u2", "group:u1", "u1", "user:", "user:u1 ", ""]) {
      authz.authorize({ ...r, resource: { ...r.resource, ownerId } });
    }
    expect(seen.map((s) => s.owner)).toEqual([true, false, false, false, false, false, false]);
  });

  it("computes the facts itself, whatever the caller passes", () => {
    const { engine, seen } = recording();
    const smuggled = { ...request(), readGranted: true, writeGranted: true, owner: true };
    new Authorizer(engine).authorize({
      ...smuggled,
      principal: { ...smuggled.principal, tagGrants: [] },
    });
    expect(seen[0]).toMatchObject({ readGranted: false, writeGranted: false, owner: false });
  });

  it("returns the engine's decision", () => {
    const decision = {
      allow: false,
      kind: "forbid",
      reason: "forbidden by x",
      policies: ["x"],
    } as const;
    const authz = new Authorizer({ evaluate: () => decision });
    expect(authz.authorize(request())).toBe(decision);
  });

  it("denies, without the details, when the engine throws, and reports the error", () => {
    const onError = vi.fn();
    const boom = new Error("wasm trap at 0xdeadbeef");
    const authz = new Authorizer(
      {
        evaluate: () => {
          throw boom;
        },
      },
      { onError },
    );
    expect(authz.authorize(request())).toEqual({
      allow: false,
      kind: "error",
      reason: "policy engine error",
      policies: [],
    });
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it("still denies when the error reporter throws too", () => {
    const authz = new Authorizer(
      {
        evaluate: () => {
          throw new Error("engine");
        },
      },
      {
        onError: () => {
          throw new Error("logger");
        },
      },
    );
    expect(authz.authorize(request()).allow).toBe(false);
  });

  const r = request();
  it.each<[string, unknown]>([
    ["principal.userId", { ...r, principal: { ...r.principal, userId: "" } }],
    ["principal.userId", { ...r, principal: undefined }],
    ["principal.groupIds", { ...r, principal: { ...r.principal, groupIds: [""] } }],
    ["principal.groupIds", { ...r, principal: { ...r.principal, groupIds: "g-sales" } }],
    ["principal.tagGrants", { ...r, principal: { ...r.principal, tagGrants: [1] } }],
    // eslint-disable-next-line no-sparse-arrays -- a hole, which every() would skip
    ["principal.tagGrants", { ...r, principal: { ...r.principal, tagGrants: [, "x"] } }],
    ["principal.tagWriteGrants", { ...r, principal: { ...r.principal, tagWriteGrants: null } }],
    ["principal.objectGrants", { ...r, principal: { ...r.principal, objectGrants: [7] } }],
    [
      "principal.objectWriteGrants",
      { ...r, principal: { ...r.principal, objectWriteGrants: "obj_1" } },
    ],
    // eslint-disable-next-line no-sparse-arrays -- a hole, which every() would skip
    ["principal.groupIds", { ...r, principal: { ...r.principal, groupIds: ["g", , "h"] } }],
    ["principal.guest", { ...r, principal: { ...r.principal, guest: "no" } }],
    ["principal.active", { ...r, principal: { ...r.principal, active: 1 } }],
    ["principal.admin", { ...r, principal: { ...r.principal, admin: "yes" } }],
    ["action", { ...r, action: "share" }],
    ["action", { ...r, action: undefined }],
    ["resource.id", { ...r, resource: { ...r.resource, id: "" } }],
    ["resource.id", { ...r, resource: null }],
    ["resource.ownerId", { ...r, resource: { ...r.resource, ownerId: null } }],
    ["resource.tags", { ...r, resource: { ...r.resource, tags: [""] } }],
    ["resource.tags", { ...r, resource: { ...r.resource, tags: "client:acme" } }],
    ["resource.zone", { ...r, resource: { ...r.resource, zone: undefined } }],
    ["client.id", { ...r, client: undefined }],
    ["client.trust", { ...r, client: { ...r.client, trust: "trusted" } }],
    ["principal.userId", null],
  ])("denies a request with a bad %s without asking the engine", (field, bad) => {
    const { engine, seen } = recording();
    const decision = new Authorizer(engine).authorize(bad as AuthzRequest);
    expect(decision).toEqual({
      allow: false,
      kind: "error",
      reason: `malformed request: ${field}`,
      policies: [],
    });
    expect(seen).toEqual([]);
  });
});

describe("administration (T-106)", () => {
  const admin = { ...request().principal, admin: true };
  const app = { id: "openhoard-web", trust: "first-party" } as const;

  it("lets an active member marked admin administer, through OpenHoard's own app only", () => {
    expect(mayAdminister(admin, app)).toMatchObject({ allow: true, kind: "allow" });
    for (const trust of ["local", "commercial", "consumer"] as const) {
      expect(mayAdminister(admin, { id: "claude", trust })).toMatchObject({
        allow: false,
        kind: "forbid",
      });
    }
    // A key's or an AI client's scope is narrower than the person: not the admin.
    const scoped = { ...admin, scope: { actions: ["read" as const], zones: ["managed"] } };
    expect(mayAdminister(scoped, app)).toMatchObject({ allow: false, kind: "forbid" });
  });

  it("refuses anyone else, and anything malformed", () => {
    const p = request().principal;
    expect(mayAdminister(p, app)).toMatchObject({ allow: false, kind: "no-permit" });
    expect(mayAdminister({ ...admin, admin: "yes" } as never, app).allow).toBe(false);
    expect(mayAdminister({ ...admin, active: false }, app)).toMatchObject({ kind: "forbid" });
    expect(mayAdminister({ ...admin, guest: true }, app)).toMatchObject({ kind: "forbid" });
    expect(mayAdminister({ ...admin, service: true }, app)).toMatchObject({ kind: "forbid" });
    expect(mayAdminister(null as never, app)).toMatchObject({ allow: false, kind: "error" });
    expect(mayAdminister(admin, undefined as never).allow).toBe(false);
  });

  it("gives an admin nothing on files: authorize() and Cedar never see it", () => {
    const authz = new Authorizer(createCedarEngine());
    const r = request();
    const noGrants = { ...r.principal, tagGrants: [], admin: true };
    for (const action of ["search", "read", "open", "tag"] as const) {
      expect(authz.authorize({ ...r, action, principal: noGrants })).toMatchObject({
        allow: false,
        kind: "no-permit",
      });
    }
    // Nor can a pack rule reach it: the schema has no such attribute, so the rule is refused.
    expect(() =>
      createCedarEngine({
        "pack/admins": `permit (principal, action, resource) when { principal.admin };`,
      }),
    ).toThrow(PolicyError);
    const { engine, seen } = recording();
    new Authorizer(engine).authorize({ ...r, principal: noGrants });
    expect(seen[0]?.readGranted).toBe(false);
  });
});
