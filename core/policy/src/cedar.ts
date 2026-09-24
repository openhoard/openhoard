import { randomUUID } from "node:crypto";
import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import { deny, type AuthzDecision, type EngineRequest, type PolicyEngine } from "./authorize.js";

/*
 * The Cedar engine (ADR-0007, spike S3). Import path: the `/nodejs` build, because the root ESM
 * export prints an experimental-WASM warning in Node 24.
 */

/**
 * Entities and actions the rules can use. Tags are parents of objects, so rules can say
 * `resource in OpenHoard::Tag::"x"`. Facts computed from data rather than rules (grants,
 * ownership) arrive in the context, so no rule depends on entities the request doesn't carry.
 */
export const CEDAR_SCHEMA = `
namespace OpenHoard {
  entity Group;
  entity User in [Group] { guest: Bool, active: Bool };
  entity Tag;
  entity Client { trust: String };
  entity Object in [Tag] { zone: String };
  type RequestContext = {
    client: Client,
    readGranted: Bool,
    writeGranted: Bool,
    owner: Bool,
  };
  action search, read, open, tag
    appliesTo { principal: User, resource: Object, context: RequestContext };
}
`;

/**
 * The rules every tenant gets. Packs (T-607) add more; a pack's `forbid` always wins over these
 * permits, because Cedar denies when any forbid applies.
 */
export const CORE_POLICIES: Readonly<Record<string, string>> = {
  // Grants are data (see authorize.ts). A read grant covers finding, reading and opening; a
  // write grant covers those and tagging.
  "core/read-grant": `permit (principal,
    action in [OpenHoard::Action::"search", OpenHoard::Action::"read", OpenHoard::Action::"open"],
    resource) when { context.readGranted };`,
  "core/write-grant": `permit (principal, action == OpenHoard::Action::"tag", resource)
    when { context.writeGranted };`,
  "core/owner": `permit (principal, action, resource) when { context.owner };`,
  // Deprovisioned users are cut off before their sessions and tokens expire (T-104).
  "core/inactive": `forbid (principal, action, resource) unless { principal.active };`,
};

export class PolicyError extends Error {
  constructor(
    message: string,
    readonly details: readonly string[],
  ) {
    super(details.length ? `${message}:\n  - ${details.join("\n  - ")}` : message);
    this.name = "PolicyError";
  }
}

/**
 * Builds an engine for the core rules plus `policies` (id → Cedar text). Every policy is
 * validated strictly against {@link CEDAR_SCHEMA} here, so a broken rule fails when it is
 * loaded, not when a request happens to reach it.
 *
 * Each engine keeps one parsed policy set in Cedar's in-process cache for the life of the
 * process; build a new engine when the rules change, which is rare.
 */
export function createCedarEngine(policies: Readonly<Record<string, string>> = {}): PolicyEngine {
  const clash = Object.keys(policies).filter((id) => id.startsWith("core/"));
  if (clash.length) throw new PolicyError("policy ids reserved for the core rules", clash);
  const staticPolicies = { ...CORE_POLICIES, ...policies };

  const validation = cedar.validate({
    schema: CEDAR_SCHEMA,
    policies: { staticPolicies },
    validationSettings: { mode: "strict" },
  });
  if (validation.type === "failure") {
    throw new PolicyError("invalid policies", messages(validation.errors));
  }
  if (validation.validationErrors.length) {
    throw new PolicyError(
      "policies do not match the schema",
      validation.validationErrors.map((e) => `${e.policyId}: ${e.error.message}`),
    );
  }
  // Warnings are refused too: "policy is impossible" means a forbid that can never fire, and
  // the others (confusable or bidi characters) have no place in an access rule.
  const warnings = [
    ...validation.validationWarnings.map((w) => `${w.policyId}: ${w.error.message}`),
    ...messages(validation.otherWarnings),
  ];
  if (warnings.length) throw new PolicyError("policies with validation warnings", warnings);

  // Cedar's cache is shared by the whole process, including other copies of this module, so
  // the id must be unique across all of them, not just counted here.
  const setId = `openhoard-${randomUUID()}`;
  const schema = cedar.preparseSchema(setId, CEDAR_SCHEMA);
  const set = cedar.preparsePolicySet(setId, { staticPolicies });
  if (schema.type === "failure") throw new PolicyError("invalid schema", messages(schema.errors));
  if (set.type === "failure") throw new PolicyError("invalid policies", messages(set.errors));

  return {
    evaluate(request) {
      const answer = cedar.statefulIsAuthorized({
        ...toCedar(request),
        preparsedPolicySetId: setId,
        preparsedSchemaName: setId,
        validateRequest: true,
      });
      return fromCedar(answer);
    },
  };
}

const ns = "OpenHoard::";
const uid = (type: string, id: string) => ({ type: `${ns}${type}`, id });

/** The request as Cedar sees it, with only the entities this decision needs. */
export function toCedar(r: EngineRequest) {
  const tags = [...new Set(r.resource.tags)];
  const groups = [...new Set(r.principal.groupIds)];
  const entities: cedar.EntityJson[] = [
    {
      uid: uid("User", r.principal.userId),
      attrs: { guest: r.principal.guest, active: r.principal.active },
      parents: groups.map((g) => uid("Group", g)),
    },
    ...groups.map((g) => ({ uid: uid("Group", g), attrs: {}, parents: [] })),
    ...tags.map((t) => ({ uid: uid("Tag", t), attrs: {}, parents: [] })),
    {
      uid: uid("Object", r.resource.id),
      attrs: { zone: r.resource.zone },
      parents: tags.map((t) => uid("Tag", t)),
    },
    { uid: uid("Client", r.client.id), attrs: { trust: r.client.trust }, parents: [] },
  ];
  return {
    principal: uid("User", r.principal.userId),
    action: uid("Action", r.action),
    resource: uid("Object", r.resource.id),
    context: {
      client: { __entity: uid("Client", r.client.id) },
      readGranted: r.readGranted,
      writeGranted: r.writeGranted,
      owner: r.owner,
    },
    entities,
  };
}

/** Cedar's answer as a decision; anything but a clean evaluation is a deny. */
export function fromCedar(answer: cedar.AuthorizationAnswer): AuthzDecision {
  if (answer.type === "failure") return deny("policy evaluation failed");
  const { decision, diagnostics } = answer.response;
  // Cedar skips a policy that errors while evaluating. For a forbid that would turn a deny into
  // an allow, so any error denies the whole request.
  if (diagnostics.errors.length) {
    const ids = diagnostics.errors.map((e) => e.policyId);
    return deny(`policy error in ${ids.join(", ")}`, ids);
  }
  const ids = [...diagnostics.reason].sort();
  if (decision === "allow") {
    return { allow: true, kind: "allow", reason: `permitted by ${ids.join(", ")}`, policies: ids };
  }
  return ids.length
    ? deny(`forbidden by ${ids.join(", ")}`, ids, "forbid")
    : deny("no policy permits it", [], "no-permit");
}

const messages = (errors: readonly cedar.DetailedError[]) => errors.map((e) => e.message);
