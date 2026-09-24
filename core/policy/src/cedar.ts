import { createHash } from "node:crypto";
import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import { deny, type AuthzDecision, type EngineRequest, type PolicyEngine } from "./authorize.js";

/*
 * The Cedar engine (ADR-0007, spike S3). Import path: the `/nodejs` build, because the root ESM
 * export prints an experimental-WASM warning in Node 24.
 */

/**
 * Entities and actions the rules can use. Facts computed from data rather than rules (grants,
 * ownership) arrive in the context, so no rule depends on entities the request doesn't carry.
 *
 * An object's tags come two ways, for the two kinds of rule:
 *
 * - `resource in OpenHoard::Tag::"x"`: the trusted tags only (rules, packs, people, reviewed
 *   model tags). Use it in permits: a model's guess must never widen access.
 * - `resource.allTags.contains("x")`: every tag, unreviewed model guesses included. Use it in
 *   forbids: a guess that a file is sensitive should restrict it at once.
 */
export const CEDAR_SCHEMA = `
namespace OpenHoard {
  entity Group;
  entity User in [Group] { guest: Bool, active: Bool };
  entity Tag;
  entity Client { trust: String };
  entity Object in [Tag] { zone: String, allTags: Set<String> };
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

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/*
 * Cedar's cache of parsed schemas and policy sets is shared by the whole process (other copies
 * of this module included) and has no way to free an entry. Ids are therefore derived from the
 * content: a copy that parses the same text under the same id stores the same thing, and the
 * same text is parsed once, not once per engine.
 */
let schemaName: string | undefined;
function preparsedSchema(): string {
  if (schemaName === undefined) {
    const name = `openhoard-schema-${sha256(CEDAR_SCHEMA)}`;
    const schema = cedar.preparseSchema(name, CEDAR_SCHEMA);
    if (schema.type === "failure") throw new PolicyError("invalid schema", messages(schema.errors));
    schemaName = name;
  }
  return schemaName;
}

/** Engines by the SHA-256 of their canonical policy set. Only sets that built are kept. */
const engines = new Map<string, PolicyEngine>();

/**
 * Builds an engine for the core rules plus `policies` (id → Cedar text). Every policy is
 * validated strictly against {@link CEDAR_SCHEMA} here, so a broken rule fails when it is
 * loaded, not when a request happens to reach it.
 *
 * Engines are cached by their policy set: the same set (the same ids and texts, in any order)
 * returns the same engine, validated once. Cedar cannot free a parsed set, so every distinct set
 * stays resident for the life of the process (roughly 25–400 KB each). Build an engine when the
 * rules change, which is rare, and share it; never build one per request.
 */
export function createCedarEngine(input: Readonly<Record<string, string>> = {}): PolicyEngine {
  // Read once: every check below, the cache key and Cedar see this copy, so a getter or a proxy
  // can't show the checks one text and Cedar another.
  const policies: Record<string, string> = Object.fromEntries(Object.entries(input));
  const clash = Object.keys(policies).filter((id) => id.startsWith("core/"));
  if (clash.length) throw new PolicyError("policy ids reserved for the core rules", clash);
  const notText = Object.keys(policies).filter((id) => typeof policies[id] !== "string");
  if (notText.length) throw new PolicyError("policy text must be a string", notText);
  const staticPolicies = { ...CORE_POLICIES, ...policies };
  const canonical = Object.keys(staticPolicies)
    .sort()
    .map((id) => [id, staticPolicies[id]]);
  const key = sha256(JSON.stringify(canonical));
  const cached = engines.get(key);
  if (cached) return cached;

  const misuse = Object.entries(policies).flatMap(([id, text]) =>
    allTagsMisuse(text).map((m) => `${id}: ${m}`),
  );
  if (misuse.length)
    throw new PolicyError("resource.allTags used where a guess could widen access", misuse);

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

  const groups = namedGroups(staticPolicies);
  const schema = preparsedSchema();
  // The content hash makes the id the same in every copy of this module for the same set, and
  // different for different sets.
  const setId = `openhoard-policies-${key}`;
  const set = cedar.preparsePolicySet(setId, { staticPolicies });
  if (set.type === "failure") throw new PolicyError("invalid policies", messages(set.errors));

  // Frozen: every caller asking for this set shares the object.
  const engine: PolicyEngine = Object.freeze({
    evaluate(request: EngineRequest) {
      const answer = cedar.statefulIsAuthorized({
        ...toCedar(request, groups),
        preparsedPolicySetId: setId,
        preparsedSchemaName: schema,
        validateRequest: true,
      });
      return fromCedar(answer);
    },
  });
  engines.set(key, engine);
  return engine;
}

const ns = "OpenHoard::";
const GROUP = `${ns}Group`;
const uid = (type: string, id: string) => ({ type: `${ns}${type}`, id });

/**
 * Every group the policies name, in their scope (`principal in OpenHoard::Group::"x"`) or in a
 * condition. Only these groups can change a decision: a group reaches a rule only as an entity
 * literal, because no attribute or context field in {@link CEDAR_SCHEMA} has the type Group and
 * groups have no parents. (A schema change that adds one must revisit this.) So a decision
 * sends only the caller's groups in this set; with hundreds of groups on a caller, sending them
 * all made each decision several times slower.
 */
function namedGroups(staticPolicies: Readonly<Record<string, string>>): ReadonlySet<string> {
  const found = new Set<string>();
  const walk = (node: unknown) => {
    if (typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    const obj = node as Json;
    if (obj.type === GROUP && typeof obj.id === "string") found.add(obj.id);
    for (const child of Object.values(obj)) walk(child);
  };
  for (const [id, text] of Object.entries(staticPolicies)) {
    const answer = cedar.policyToJson(text);
    // Validation has already parsed every policy; if this one can't be read, the set of groups
    // would be incomplete and a forbid on a group could be skipped, so refuse the engine.
    if (answer.type === "failure") {
      throw new PolicyError("invalid policies", [`${id}: ${messages(answer.errors).join("; ")}`]);
    }
    walk(answer.json);
  }
  return found;
}

/**
 * The request as Cedar sees it, with only the entities this decision needs: of the caller's
 * groups, only those in `named` (the groups the engine's policies mention).
 */
export function toCedar(r: EngineRequest, named: ReadonlySet<string>) {
  const tags = [...new Set(r.resource.tags)];
  // A value that isn't a string still goes to Cedar, which refuses it: leaving groups out must
  // not turn a malformed request into a well-formed one.
  const groups = [...new Set(r.principal.groupIds)].filter(
    (g) => typeof g !== "string" || named.has(g),
  );
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
      attrs: {
        zone: r.resource.zone,
        allTags: [...new Set([...r.resource.allTags, ...r.resource.tags])].sort(),
      },
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

type Json = Record<string, unknown>;

/** A policy's effect, or null if the text isn't one parsable policy. */
export function policyEffect(text: string): "permit" | "forbid" | null {
  const answer = cedar.policyToJson(text);
  if (answer.type === "failure") return null;
  const effect = (answer.json as unknown as Json).effect;
  return effect === "permit" || effect === "forbid" ? effect : null;
}
const SET_TESTS = new Set(["contains", "containsAll", "containsAny"]);

/**
 * Where `resource.allTags` may appear. It carries model guesses, so it may only make a forbid
 * fire: inside a forbid's `when`, not negated, as the set tested by contains / containsAll /
 * containsAny, and read straight off `resource`. Anywhere else (a permit, an `unless`, under
 * `!`, in an `if` condition, compared with `==`, `isEmpty()`, copied into a record) a guess
 * could lift a restriction or grant access. Returns what is wrong; empty when fine. Text that
 * doesn't parse is left to validation.
 */
export function allTagsMisuse(text: string): string[] {
  const answer = cedar.policyToJson(text);
  if (answer.type === "failure") return [];
  const policy = answer.json as unknown as Json;
  const problems: string[] = [];
  const forbid = policy.effect === "forbid";
  // polarity: true = may only make the policy apply more; null = anywhere else.
  const visit = (node: unknown, polarity: boolean | null, underSetTest: boolean) => {
    if (typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n, null, false);
      return;
    }
    const obj = node as Json;
    const dot = obj["."] as Json | undefined;
    // Any `.allTags`: on `resource`, an entity literal such as OpenHoard::Object::"o", or a
    // record built to look like one (`{allTags: ...}.allTags`, or an `if` choosing between
    // records), which could hide a guess from the rules below.
    if (dot && dot.attr === "allTags") {
      const left = dot.left as Json | undefined;
      const onResource =
        typeof left === "object" &&
        left !== null &&
        Object.keys(left).length === 1 &&
        left.Var === "resource";
      if (!onResource) {
        problems.push("allTags may be read as resource.allTags only");
        // What it's read from may itself hide a misuse; report that too.
        visit(left, null, false);
      }
      if (!forbid) problems.push("a permit can't test resource.allTags; use `resource in Tag`");
      else if (polarity !== true || !underSetTest) {
        problems.push(
          "a forbid may use resource.allTags only in `when`, un-negated, with contains",
        );
      }
      return;
    }
    for (const [op, arg] of Object.entries(obj)) {
      const a = arg as Json;
      if (op === "!") visit(a.arg, polarity === null ? null : !polarity, false);
      else if (op === "&&" || op === "||") {
        visit(a.left, polarity, false);
        visit(a.right, polarity, false);
      } else if (SET_TESTS.has(op)) {
        visit(a.left, polarity, true);
        visit(a.right, null, false);
      } else if (op === "if-then-else") {
        visit(a.if, null, false);
        visit(a.then, polarity, false);
        visit(a.else, polarity, false);
      } else if (typeof arg === "object" && arg !== null) {
        // Any other operator: nothing inside may touch allTags.
        for (const child of Object.values(arg as Json)) visit(child, null, false);
      }
    }
  };
  for (const c of (policy.conditions as Json[] | undefined) ?? []) {
    visit(c.body, c.kind === "when", false);
  }
  return [...new Set(problems)];
}
