import { createHash } from "node:crypto";
import { facets, facetValues, queryRows, tenantPacks, tenants, type Tx } from "@openhoard/core-db";
import {
  allTagsMisuse,
  Authorizer,
  createCedarEngine,
  EXPOSURE,
  mostRestrictiveExposure,
  mostRestrictiveVisibility,
  policyEffect,
  PolicyError,
  VISIBILITY,
  type Action,
  type ClientTrust,
  type Exposure,
  type PolicyEngine,
  type Visibility,
} from "@openhoard/core-policy";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { validateRules, type TagRule } from "./rules.js";

/*
 * Packs (T-607): declarative bundles of vocabulary, visibility and exposure levels, tenant
 * defaults, tag rules and Cedar policies, with tests. A pack is data only: no code, no
 * capabilities, no network (see packs/README.md and the plugin manifest's `pack` type).
 *
 * Applying one is two steps, so an admin always sees what changes:
 *
 *   planPack()  → the diff against the tenant as it is, every loosening flagged, the tests'
 *                 results, and a plan hash bound to this tenant
 *   applyPack() → only with that hash, in a serializable transaction; if anything changed since,
 *                 it refuses and asks for a new plan. It refuses too if any test fails.
 *
 * Everything that reads the tenant's packs re-checks them against today's rules, and one that
 * no longer passes stops them (fail closed), naming the pack.
 *
 * The pack is copied (JSON round trip) once at the start of each, and that copy is what is
 * validated, hashed, planned, applied and stored, so nothing can change between them.
 *
 * A pack only adds and updates: vocabulary it no longer lists stays (grants and tags may use
 * it), and is reported. Its rules and policies replace the ones its earlier version brought.
 * Callers record the applied plan in the audit log (core/audit), as for grants.
 */

export interface PackValue {
  value: string;
  label: string;
  visibility?: Visibility;
  exposure?: Exposure;
}

export interface PackFacet {
  key: string;
  label: string;
  /** Tags of this facet may show on title-only cards (T-603). */
  public?: boolean;
  values: PackValue[];
}

/** One expected decision, checked with the pack's policies, the tenant's other packs' and core. */
export interface PolicyTest {
  name: string;
  action: Action;
  principal?: {
    guest?: boolean;
    active?: boolean;
    /** Tags the caller holds read grants on. */
    readGrants?: string[];
    writeGrants?: string[];
    owner?: boolean;
  };
  resource: {
    /** Trusted tags. */
    tags: string[];
    /** Extra tags only a model has guessed (forbids see them, permits don't). */
    unreviewedTags?: string[];
    zone?: string;
  };
  client?: ClientTrust | "first-party";
  /** `forbid`: denied by a forbid policy, not merely for want of a permit. */
  expect: "allow" | "deny" | "forbid";
}

/** Expected levels for a set of tags, resolved as they would be once the pack is applied. */
export interface LevelTest {
  name: string;
  tags: string[];
  expect: { visibility: Visibility; exposure: Exposure };
}

export interface Pack {
  pack_version: 1;
  name: string;
  version: string;
  description?: string;
  defaults?: { visibility: Visibility; exposure: Exposure };
  facets?: PackFacet[];
  rules?: TagRule[];
  /** Local id → Cedar text. Applied as `pack/<name>/<id>`. */
  policies?: Record<string, string>;
  tests?: { policies?: PolicyTest[]; levels?: LevelTest[] };
}

export type PackErrorCode = "invalid" | "tests-failed" | "stale-plan";

export class PackError extends Error {
  constructor(
    readonly code: PackErrorCode,
    message: string,
    readonly details: readonly string[] = [],
  ) {
    super(details.length ? `${message}:\n  - ${details.join("\n  - ")}` : message);
    this.name = "PackError";
  }
}

const NAME = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;
const FACET = /^[a-z][a-z0-9-]{0,63}$/;
const VALUE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const TAG = /^[a-z][a-z0-9-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/;
const POLICY_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ACTIONS = ["search", "read", "open", "tag"];
const CLIENTS = ["first-party", "local", "commercial", "consumer"];
/** Control and format characters (newlines, bidi overrides, zero-width): not in labels. */
const INVISIBLE = /\p{C}/u;
const LIMITS = {
  facets: 100,
  values: 1000,
  rules: 1000,
  policies: 200,
  policyChars: 10_000,
  tests: 1000,
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isVisibility = (v: unknown) => (VISIBILITY as readonly unknown[]).includes(v);
const isExposure = (v: unknown) => (EXPOSURE as readonly unknown[]).includes(v);

/** What is wrong with a pack; empty when it is well-formed. Doesn't compile its policies. */
export function validatePack(input: unknown): string[] {
  const problems: string[] = [];
  const bad = (msg: string) => void problems.push(msg);
  /** Unknown keys are refused at every level: a typo must not silently drop a level. */
  const only = (o: Obj, at: string, keys: string[]) => {
    for (const k of Object.keys(o)) if (!keys.includes(k)) bad(`${at}: unknown field ${k}`);
  };
  const text = (v: unknown, max: number) =>
    typeof v === "string" && v.trim() !== "" && [...v].length <= max && !INVISIBLE.test(v);
  const tags = (v: unknown) =>
    Array.isArray(v) && v.every((t) => typeof t === "string" && TAG.test(t));
  const list = (v: unknown, at: string, max: number): Obj[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every(isObj)) {
      bad(`${at} must be a list of objects`);
      return [];
    }
    if (v.length > max) bad(`${at}: at most ${max}`);
    return v;
  };

  if (!isObj(input)) return ["a pack is an object"];
  const p = input;
  only(p, "pack", [
    "pack_version",
    "name",
    "version",
    "description",
    "defaults",
    "facets",
    "rules",
    "policies",
    "tests",
  ]);
  if (p.pack_version !== 1) bad("pack_version must be 1");
  if (typeof p.name !== "string" || !NAME.test(p.name)) bad("name must be a lower-case slug");
  if (typeof p.version !== "string" || !VERSION.test(p.version) || p.version.length > 64) {
    bad("version must be semver, at most 64 characters");
  }
  if (p.description !== undefined && !text(p.description, 280)) {
    bad("description must be 1 to 280 visible characters");
  }
  if (p.defaults !== undefined) {
    if (
      !isObj(p.defaults) ||
      !isVisibility(p.defaults.visibility) ||
      !isExposure(p.defaults.exposure)
    ) {
      bad("defaults needs a visibility and an exposure level");
    } else only(p.defaults, "defaults", ["visibility", "exposure"]);
  }

  const keys = new Set<string>();
  for (const [i, facet] of list(p.facets, "facets", LIMITS.facets).entries()) {
    const at = `facet ${typeof facet.key === "string" ? facet.key : i}`;
    only(facet, at, ["key", "label", "public", "values"]);
    if (typeof facet.key !== "string" || !FACET.test(facet.key)) bad(`${at}: key must be a slug`);
    else if (keys.has(facet.key)) bad(`${at}: listed twice`);
    else keys.add(facet.key);
    if (!text(facet.label, 200)) bad(`${at}: label must be 1 to 200 visible characters`);
    if (facet.public !== undefined && typeof facet.public !== "boolean") {
      bad(`${at}: public must be true or false`);
    }
    if (!Array.isArray(facet.values)) {
      bad(`${at}: values must be a list`);
      continue;
    }
    const values = new Set<string>();
    for (const [j, value] of list(facet.values, `${at} values`, LIMITS.values).entries()) {
      const vat = `${at} value ${typeof value.value === "string" ? value.value : j}`;
      only(value, vat, ["value", "label", "visibility", "exposure"]);
      if (typeof value.value !== "string" || !VALUE.test(value.value)) bad(`${vat}: not a slug`);
      else if (values.has(value.value)) bad(`${vat}: listed twice`);
      else values.add(value.value);
      if (!text(value.label, 200)) bad(`${vat}: label must be 1 to 200 visible characters`);
      if (value.visibility !== undefined && !isVisibility(value.visibility)) {
        bad(`${vat}: unknown visibility`);
      }
      if (value.exposure !== undefined && !isExposure(value.exposure)) {
        bad(`${vat}: unknown exposure`);
      }
    }
  }

  if (p.rules !== undefined) {
    problems.push(...validateRules(p.rules).map((m) => `rules: ${m}`));
    if (Array.isArray(p.rules) && p.rules.length > LIMITS.rules) {
      bad(`rules: at most ${LIMITS.rules}`);
    }
  }
  if (p.policies !== undefined) {
    if (!isObj(p.policies)) bad("policies must map ids to Cedar text");
    else {
      const entries = Object.entries(p.policies);
      if (entries.length > LIMITS.policies) bad(`policies: at most ${LIMITS.policies}`);
      for (const [id, body] of entries) {
        if (!POLICY_ID.test(id)) bad(`policy ${id}: id must be a slug`);
        if (typeof body !== "string" || body.trim() === "" || body.length > LIMITS.policyChars) {
          bad(`policy ${id}: needs Cedar text of at most ${LIMITS.policyChars} characters`);
        }
      }
    }
  }

  if (p.tests !== undefined) {
    if (!isObj(p.tests)) bad("tests must be an object");
    else {
      only(p.tests, "tests", ["policies", "levels"]);
      for (const [i, c] of list(p.tests.policies, "tests.policies", LIMITS.tests).entries()) {
        const at = `policy test ${typeof c.name === "string" ? c.name : i}`;
        only(c, at, ["name", "action", "principal", "resource", "client", "expect"]);
        if (!text(c.name, 200)) bad(`${at}: needs a name`);
        if (!ACTIONS.includes(c.action as string)) bad(`${at}: unknown action`);
        if (!["allow", "deny", "forbid"].includes(c.expect as string)) {
          bad(`${at}: expect allow, deny or forbid`);
        }
        if (c.client !== undefined && !CLIENTS.includes(c.client as string)) {
          bad(`${at}: unknown client`);
        }
        if (!isObj(c.resource)) bad(`${at}: needs a resource`);
        else {
          only(c.resource, `${at} resource`, ["tags", "unreviewedTags", "zone"]);
          if (!tags(c.resource.tags)) bad(`${at}: resource.tags must list facet:value tags`);
          if (c.resource.unreviewedTags !== undefined && !tags(c.resource.unreviewedTags)) {
            bad(`${at}: resource.unreviewedTags must list facet:value tags`);
          }
          if (c.resource.zone !== undefined && typeof c.resource.zone !== "string") {
            bad(`${at}: resource.zone must be a string`);
          }
        }
        if (c.principal !== undefined) {
          if (!isObj(c.principal)) bad(`${at}: principal must be an object`);
          else {
            only(c.principal, `${at} principal`, [
              "guest",
              "active",
              "readGrants",
              "writeGrants",
              "owner",
            ]);
            for (const k of ["guest", "active", "owner"]) {
              if (c.principal[k] !== undefined && typeof c.principal[k] !== "boolean") {
                bad(`${at}: principal.${k} must be true or false`);
              }
            }
            for (const k of ["readGrants", "writeGrants"]) {
              if (c.principal[k] !== undefined && !tags(c.principal[k])) {
                bad(`${at}: principal.${k} must list tags`);
              }
            }
          }
        }
      }
      for (const [i, c] of list(p.tests.levels, "tests.levels", LIMITS.tests).entries()) {
        const at = `level test ${typeof c.name === "string" ? c.name : i}`;
        only(c, at, ["name", "tags", "expect"]);
        if (!text(c.name, 200)) bad(`${at}: needs a name`);
        if (!tags(c.tags)) bad(`${at}: tags must list facet:value tags`);
        if (
          !isObj(c.expect) ||
          !isVisibility(c.expect.visibility) ||
          !isExposure(c.expect.exposure)
        ) {
          bad(`${at}: expect needs a visibility and an exposure`);
        } else only(c.expect, `${at} expect`, ["visibility", "exposure"]);
      }
    }
  }
  return problems;
}

/**
 * Copies the input (a JSON round trip, which also drops getters, prototypes and anything JSON
 * can't carry), checks the copy, and returns it typed; `invalid` with every problem otherwise.
 */
export function parsePack(input: unknown): Pack {
  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(input)) as unknown;
  } catch {
    throw new PackError("invalid", "a pack must be plain JSON");
  }
  const problems = validatePack(copy);
  if (problems.length) throw new PackError("invalid", "invalid pack", problems);
  return copy as Pack;
}

/** JSON with object keys sorted, so equal packs hash equally. For plain JSON values. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Obj)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The pack's policies under their applied ids, `pack/<name>/<id>`. */
export function packPolicies(pack: Pack): Record<string, string> {
  return Object.fromEntries(
    Object.entries(pack.policies ?? {}).map(([id, text]) => [`pack/${pack.name}/${id}`, text]),
  );
}

export interface PackTestResult {
  name: string;
  passed: boolean;
  detail: string;
}

/** What the tests run against, beyond the pack itself: the tenant as the pack would leave it. */
export interface PackTestContext {
  /** Tenant defaults when the pack sets none. Default: hidden, metadata-only. */
  defaults?: { visibility: Visibility; exposure: Exposure };
  /** Levels of the tenant's approved values, by tag; the pack's own values override them. */
  values?: ReadonlyMap<string, { visibility: Visibility | null; exposure: Exposure | null }>;
  /** Policies of the tenant's other packs, under their applied ids. */
  otherPolicies?: Readonly<Record<string, string>>;
}

/**
 * Runs a pack's tests: its policies compile and validate against the Cedar schema; each policy
 * test gets the expected decision from these policies, the other packs' and the core rules;
 * each level test resolves as expected from the pack's and the tenant's values and defaults.
 * A decision that is an error (a malformed test) fails, whatever was expected, and so does a
 * level test naming a tag nobody defines.
 */
export function runPackTests(pack: Pack, context: PackTestContext = {}): PackTestResult[] {
  let engine: PolicyEngine;
  try {
    engine = createCedarEngine({ ...context.otherPolicies, ...packPolicies(pack) });
  } catch (e) {
    const details = e instanceof PolicyError ? e.details.join("; ") : String(e);
    return [{ name: "policies compile", passed: false, detail: details }];
  }
  const authz = new Authorizer(engine);
  const results: PackTestResult[] = [{ name: "policies compile", passed: true, detail: "" }];
  for (const t of pack.tests?.policies ?? []) {
    const p = t.principal ?? {};
    const decision = authz.authorize({
      principal: {
        userId: "pack-test-user",
        groupIds: [],
        tagGrants: p.readGrants ?? [],
        tagWriteGrants: p.writeGrants ?? [],
        objectGrants: [],
        objectWriteGrants: [],
        guest: p.guest ?? false,
        active: p.active ?? true,
      },
      action: t.action,
      resource: {
        id: "pack-test-object",
        ownerId: p.owner ? "user:pack-test-user" : "user:someone-else",
        tags: t.resource.tags,
        allTags: [...t.resource.tags, ...(t.resource.unreviewedTags ?? [])],
        zone: t.resource.zone ?? "indexed",
      },
      client: { id: "pack-test-client", trust: t.client ?? "first-party" },
    });
    const got = decision.allow ? "allow" : "deny";
    const passed =
      decision.kind !== "error" &&
      (t.expect === "forbid" ? decision.kind === "forbid" : got === t.expect);
    results.push({
      name: t.name,
      passed,
      detail: passed
        ? decision.reason
        : `expected ${t.expect}, got ${decision.kind} (${decision.reason})`,
    });
  }
  const levels = new Map(context.values ?? []);
  for (const f of pack.facets ?? []) {
    for (const v of f.values) {
      levels.set(`${f.key}:${v.value}`, {
        visibility: v.visibility ?? null,
        exposure: v.exposure ?? null,
      });
    }
  }
  const defaults = pack.defaults ??
    context.defaults ?? { visibility: "hidden", exposure: "metadata-only" };
  for (const t of pack.tests?.levels ?? []) {
    const unknown = t.tags.filter((tag) => !levels.has(tag));
    if (unknown.length) {
      results.push({ name: t.name, passed: false, detail: `unknown tags: ${unknown.join(", ")}` });
      continue;
    }
    const values = t.tags.map((tag) => levels.get(tag));
    const got = {
      visibility: mostRestrictiveVisibility(
        values.flatMap((v) => (v?.visibility ? [v.visibility] : [])),
        defaults.visibility,
      ),
      exposure: mostRestrictiveExposure(
        values.flatMap((v) => (v?.exposure ? [v.exposure] : [])),
        defaults.exposure,
      ),
    };
    const passed = got.visibility === t.expect.visibility && got.exposure === t.expect.exposure;
    results.push({
      name: t.name,
      passed,
      detail: passed
        ? ""
        : `expected ${t.expect.visibility}/${t.expect.exposure}, got ${got.visibility}/${got.exposure}`,
    });
  }
  return results;
}

type Levels = { visibility: Visibility; exposure: Exposure };
type NullableLevels = { visibility: Visibility | null; exposure: Exposure | null };

/** One change applying the pack would make, or something it would leave in place. */
export type PackChange =
  | { kind: "set-defaults"; from: Levels; to: Levels; loosens: boolean }
  | { kind: "add-facet"; facet: string; label: string; public: boolean; loosens: boolean }
  | {
      kind: "change-facet";
      facet: string;
      from: { label: string; public: boolean };
      to: { label: string; public: boolean };
      loosens: boolean;
    }
  | { kind: "add-value"; tag: string; label: string; levels: NullableLevels; loosens: boolean }
  | { kind: "approve-value"; tag: string; label: string; levels: NullableLevels; loosens: true }
  | {
      kind: "change-value";
      tag: string;
      from: { label: string; levels: NullableLevels };
      to: { label: string; levels: NullableLevels };
      loosens: boolean;
    }
  | { kind: "keep-value"; tag: string; note: string }
  | {
      kind: "set-rules";
      added: TagRule[];
      removed: TagRule[];
      changed: { from: TagRule; to: TagRule }[];
      /** Rules tag files as trusted: any rule change can widen access or visibility. */
      loosens: true;
    }
  | {
      kind: "set-policies";
      added: { id: string; text: string }[];
      removed: { id: string; text: string }[];
      changed: { id: string; from: string; to: string }[];
      /** A permit added or changed, or a forbid removed or changed. */
      loosens: boolean;
    };

export interface PackPlan {
  tenantId: string;
  name: string;
  version: string;
  /** The version applied now, if any. */
  previous: string | null;
  contentHash: string;
  changes: PackChange[];
  /** Human-readable warnings: every loosening change, and a version going down. */
  warnings: string[];
  tests: PackTestResult[];
  /** What applyPack() needs: a hash of this plan, bound to this tenant. */
  planHash: string;
}

/**
 * The diff applying `input` would make to the tenant, with every loosening flagged. Read-only.
 * Show it to an admin and pass its `planHash` to applyPack().
 */
export async function planPack(tx: Tx, tenantId: string, input: unknown): Promise<PackPlan> {
  return plan(tx, tenantId, parsePack(input));
}

async function plan(tx: Tx, tenantId: string, pack: Pack): Promise<PackPlan> {
  const contentHash = sha256(canonicalJson(pack));
  const changes: PackChange[] = [];
  const warnings: string[] = [];

  const [tenant] = await tx
    .select({ visibility: tenants.defaultVisibility, exposure: tenants.defaultExposure })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) throw new PackError("invalid", `no tenant ${tenantId}`);
  const defaultsAfter = pack.defaults ?? tenant;
  if (
    pack.defaults &&
    (pack.defaults.visibility !== tenant.visibility || pack.defaults.exposure !== tenant.exposure)
  ) {
    changes.push({
      kind: "set-defaults",
      from: tenant,
      to: pack.defaults,
      loosens: looser(tenant, pack.defaults),
    });
  }

  const currentFacets = new Map(
    (
      await tx
        .select({ key: facets.key, label: facets.label, public: facets.public })
        .from(facets)
        .where(eq(facets.tenantId, tenantId))
    ).map((f) => [f.key, f]),
  );
  const currentValues = new Map(
    (
      await tx
        .select({
          facet: facetValues.facet,
          value: facetValues.value,
          label: facetValues.label,
          approved: facetValues.approved,
          visibility: facetValues.visibility,
          exposure: facetValues.exposure,
        })
        .from(facetValues)
        .where(eq(facetValues.tenantId, tenantId))
        .orderBy(asc(facetValues.facet), asc(facetValues.value))
    ).map((v) => [`${v.facet}:${v.value}`, v]),
  );

  const [applied] = await tx
    .select({
      version: tenantPacks.version,
      content: tenantPacks.content,
      contentHash: tenantPacks.contentHash,
    })
    .from(tenantPacks)
    .where(and(eq(tenantPacks.tenantId, tenantId), eq(tenantPacks.name, pack.name)));
  const before = applied ? storedPack(pack.name, applied.content) : null;
  if (applied && compareVersions(pack.version, applied.version) < 0) {
    warnings.push(`version goes down from ${applied.version} to ${pack.version}`);
  }
  if (applied && applied.version === pack.version && applied.contentHash !== contentHash) {
    warnings.push(`version ${pack.version} is already applied with different content`);
  }
  const listed = new Set<string>();

  for (const f of pack.facets ?? []) {
    const cur = currentFacets.get(f.key);
    const pub = f.public ?? false;
    if (!cur) {
      changes.push({ kind: "add-facet", facet: f.key, label: f.label, public: pub, loosens: pub });
    } else if (cur.label !== f.label || cur.public !== pub) {
      changes.push({
        kind: "change-facet",
        facet: f.key,
        from: { label: cur.label, public: cur.public },
        to: { label: f.label, public: pub },
        loosens: pub && !cur.public,
      });
    }
    for (const v of f.values) {
      const tag = `${f.key}:${v.value}`;
      listed.add(tag);
      const levels: NullableLevels = {
        visibility: v.visibility ?? null,
        exposure: v.exposure ?? null,
      };
      const curValue = currentValues.get(tag);
      if (!curValue) {
        changes.push({
          kind: "add-value",
          tag,
          label: v.label,
          levels,
          // A tag whose level is looser than the default makes files more visible.
          loosens: looserThanDefault(levels, defaultsAfter),
        });
        continue;
      }
      const curLevels = { visibility: curValue.visibility, exposure: curValue.exposure };
      const sameLevels =
        curLevels.visibility === levels.visibility && curLevels.exposure === levels.exposure;
      if (!curValue.approved) {
        // Approving makes a proposed value count for grants and trusted tags.
        changes.push({ kind: "approve-value", tag, label: v.label, levels, loosens: true });
      } else if (curValue.label !== v.label || !sameLevels) {
        changes.push({
          kind: "change-value",
          tag,
          from: { label: curValue.label, levels: curLevels },
          to: { label: v.label, levels },
          // A missing level means the default, before and after.
          loosens: looser(effective(curLevels, tenant), effective(levels, defaultsAfter)),
        });
      }
    }
  }
  for (const f of before?.facets ?? []) {
    for (const v of f.values) {
      const tag = `${f.key}:${v.value}`;
      if (!listed.has(tag) && currentValues.has(tag)) {
        changes.push({
          kind: "keep-value",
          tag,
          note: "no longer in the pack; left in place, since tags and grants may use it",
        });
      }
    }
  }

  // Rules may only tag facets that exist once the pack is applied.
  const known = new Set([...currentFacets.keys(), ...(pack.facets ?? []).map((f) => f.key)]);
  const unknownFacets = (pack.rules ?? [])
    .map((r) => ("dictionary" in r ? r.facet : r.tag.slice(0, r.tag.indexOf(":"))))
    .filter((f) => !known.has(f));
  if (unknownFacets.length) {
    throw new PackError(
      "invalid",
      "rules tag facets that don't exist",
      [...new Set(unknownFacets)].map((f) => `unknown facet ${f}`),
    );
  }
  const rulesBefore = new Map((before?.rules ?? []).map((r) => [r.id, r]));
  const rulesAfter = new Map((pack.rules ?? []).map((r) => [r.id, r]));
  const ruleIds = diffIds(rulesBefore, rulesAfter, (a, b) => canonicalJson(a) === canonicalJson(b));
  if (ruleIds.added.length || ruleIds.removed.length || ruleIds.changed.length) {
    changes.push({
      kind: "set-rules",
      added: ruleIds.added.map((id) => rulesAfter.get(id) as TagRule),
      removed: ruleIds.removed.map((id) => rulesBefore.get(id) as TagRule),
      changed: ruleIds.changed.map((id) => ({
        from: rulesBefore.get(id) as TagRule,
        to: rulesAfter.get(id) as TagRule,
      })),
      loosens: true,
    });
  }

  const policiesBefore = new Map(Object.entries(before ? packPolicies(before) : {}));
  const policiesAfter = new Map(Object.entries(packPolicies(pack)));
  const policyIds = diffIds(policiesBefore, policiesAfter, (a, b) => a === b);
  if (policyIds.added.length || policyIds.removed.length || policyIds.changed.length) {
    // Text that doesn't parse counts as both, so it is flagged either way.
    const permits = (text: string | undefined) =>
      text !== undefined && policyEffect(text) !== "forbid";
    const forbids = (text: string | undefined) =>
      text !== undefined && policyEffect(text) !== "permit";
    changes.push({
      kind: "set-policies",
      added: policyIds.added.map((id) => ({ id, text: policiesAfter.get(id) as string })),
      removed: policyIds.removed.map((id) => ({ id, text: policiesBefore.get(id) as string })),
      changed: policyIds.changed.map((id) => ({
        id,
        from: policiesBefore.get(id) as string,
        to: policiesAfter.get(id) as string,
      })),
      loosens:
        policyIds.added.some((id) => permits(policiesAfter.get(id))) ||
        policyIds.removed.some((id) => forbids(policiesBefore.get(id))) ||
        policyIds.changed.some(
          (id) => forbids(policiesBefore.get(id)) || permits(policiesAfter.get(id)),
        ),
    });
  }

  // The tests run against the tenant as the pack would leave it.
  const others = await tenantPolicies(tx, tenantId, { except: pack.name });
  const values = new Map(
    [...currentValues]
      .filter(([, v]) => v.approved)
      .map(([tag, v]) => [tag, { visibility: v.visibility, exposure: v.exposure }]),
  );
  const tests = runPackTests(pack, { defaults: defaultsAfter, values, otherPolicies: others });
  warnings.push(...changes.flatMap((c) => ("loosens" in c && c.loosens ? [describe(c)] : [])));
  const planned = {
    tenantId,
    name: pack.name,
    version: pack.version,
    previous: applied?.version ?? null,
    contentHash,
    changes,
    warnings,
    tests,
  };
  return { ...planned, planHash: sha256(canonicalJson(planned)) };
}

export interface ApplyOptions {
  /** The planHash of the plan an admin reviewed. */
  planHash: string;
  /** Who approved it, e.g. `user:<id>`. */
  by: string;
}

/** Transaction settings for applyPack(): `db.withTenant(tenant, work, APPLY_TRANSACTION)`. */
export const APPLY_TRANSACTION = { isolationLevel: "serializable" } as const;

/**
 * Applies a pack, exactly as planned. Runs only in a SERIALIZABLE transaction
 * ({@link APPLY_TRANSACTION}), so no concurrent change to the vocabulary (a review approving a
 * value, a model proposing one) can slip in between the check and the writes; a conflict aborts
 * with SQLSTATE 40001 and the caller retries. Refuses (`stale-plan`) if planning again now gives
 * a different plan, and (`tests-failed`) if any of the pack's tests fails. Returns the plan.
 */
export async function applyPack(
  tx: Tx,
  tenantId: string,
  input: unknown,
  options: ApplyOptions,
): Promise<PackPlan> {
  if (!/^[a-z]+:.+$/s.test(options.by)) throw new PackError("invalid", "by must be a principal");
  const [level] = await queryRows<{ level: string }>(
    tx,
    sql`select current_setting('transaction_isolation') as level`,
  );
  if (level?.level !== "serializable") {
    throw new Error("applyPack needs a serializable transaction (APPLY_TRANSACTION)");
  }
  // Serializable isolation is what makes this safe: two applies, or an apply and a review,
  // that touch the same rows can't both commit.
  const pack = parsePack(input);
  const planned = await plan(tx, tenantId, pack);
  if (planned.planHash !== options.planHash) {
    throw new PackError("stale-plan", "the tenant or the pack changed since this plan; plan again");
  }
  const failed = planned.tests.filter((t) => !t.passed);
  if (failed.length) {
    throw new PackError(
      "tests-failed",
      `pack ${planned.name} failed its tests`,
      failed.map((t) => `${t.name}: ${t.detail}`),
    );
  }
  if (pack.defaults) {
    await tx
      .update(tenants)
      .set({ defaultVisibility: pack.defaults.visibility, defaultExposure: pack.defaults.exposure })
      .where(eq(tenants.id, tenantId));
  }
  for (const f of pack.facets ?? []) {
    await tx
      .insert(facets)
      .values({ tenantId, key: f.key, label: f.label, public: f.public ?? false })
      .onConflictDoUpdate({
        target: [facets.tenantId, facets.key],
        set: { label: f.label, public: f.public ?? false },
      });
    for (const v of f.values) {
      const row = {
        label: v.label,
        approved: true,
        visibility: v.visibility ?? null,
        exposure: v.exposure ?? null,
      };
      await tx
        .insert(facetValues)
        .values({ tenantId, facet: f.key, value: v.value, ...row })
        .onConflictDoUpdate({
          target: [facetValues.tenantId, facetValues.facet, facetValues.value],
          set: row,
        });
    }
  }
  const stored = {
    version: pack.version,
    content: pack,
    contentHash: planned.contentHash,
    appliedBy: options.by,
  };
  await tx
    .insert(tenantPacks)
    .values({ tenantId, name: pack.name, ...stored })
    .onConflictDoUpdate({
      target: [tenantPacks.tenantId, tenantPacks.name],
      set: { ...stored, appliedAt: sql`now()` },
    });
  return planned;
}

/** The applied packs, re-checked: stored content that no longer validates is an error. */
async function appliedPacks(tx: Tx, tenantId: string, except?: string): Promise<Pack[]> {
  const rows = await tx
    .select({ name: tenantPacks.name, content: tenantPacks.content })
    .from(tenantPacks)
    .where(
      and(
        eq(tenantPacks.tenantId, tenantId),
        except === undefined ? undefined : ne(tenantPacks.name, except),
      ),
    )
    .orderBy(asc(tenantPacks.name));
  return rows.map((r) => storedPack(r.name, r.content));
}

/**
 * A stored pack, checked against today's rules. One that no longer passes stops everything that
 * reads the tenant's packs (fail closed), naming itself: re-plan it, fixed, or remove it.
 */
function storedPack(name: string, content: unknown): Pack {
  let pack: Pack;
  try {
    pack = parsePack(content);
  } catch (e) {
    const details = e instanceof PackError ? e.details : [String(e)];
    throw new PackError("invalid", `stored pack ${name} no longer validates`, details);
  }
  if (pack.name !== name)
    throw new PackError("invalid", `stored pack ${name} says it is ${pack.name}`);
  const misuse = Object.entries(pack.policies ?? {}).flatMap(([id, text]) =>
    allTagsMisuse(text).map((m) => `${id}: ${m}`),
  );
  if (misuse.length) {
    throw new PackError("invalid", `stored pack ${name} no longer validates`, misuse);
  }
  return pack;
}

/** The applied packs' Cedar policies, under their applied ids, for createCedarEngine(). */
export async function tenantPolicies(
  tx: Tx,
  tenantId: string,
  options: { except?: string } = {},
): Promise<Record<string, string>> {
  const packs = await appliedPacks(tx, tenantId, options.except);
  return Object.assign({}, ...packs.map(packPolicies)) as Record<string, string>;
}

/** The applied packs' tag rules, with ids prefixed by the pack name so they can't clash. */
export async function tenantRules(tx: Tx, tenantId: string): Promise<TagRule[]> {
  const packs = await appliedPacks(tx, tenantId);
  return packs.flatMap((pack) =>
    (pack.rules ?? []).map((rule) => ({ ...rule, id: `${pack.name}.${rule.id}` })),
  );
}

const VIS_RANK = (v: Visibility | null) => (v === null ? VISIBILITY.length : VISIBILITY.indexOf(v));
const EXP_RANK = (e: Exposure | null) => (e === null ? EXPOSURE.length : EXPOSURE.indexOf(e));
/** Whether `to` lets more through than `from` on either level (null: sets no level, loosest). */
function looser(from: NullableLevels, to: NullableLevels): boolean {
  return (
    VIS_RANK(to.visibility) > VIS_RANK(from.visibility) ||
    EXP_RANK(to.exposure) > EXP_RANK(from.exposure)
  );
}
/** Levels with a missing one read as the default it falls back to. */
function effective(levels: NullableLevels, defaults: Levels): Levels {
  return {
    visibility: levels.visibility ?? defaults.visibility,
    exposure: levels.exposure ?? defaults.exposure,
  };
}
/** A value's levels loosen files when they are set and looser than the default. */
function looserThanDefault(levels: NullableLevels, defaults: Levels): boolean {
  return (
    (levels.visibility !== null && VIS_RANK(levels.visibility) > VIS_RANK(defaults.visibility)) ||
    (levels.exposure !== null && EXP_RANK(levels.exposure) > EXP_RANK(defaults.exposure))
  );
}

function diffIds<T>(before: Map<string, T>, after: Map<string, T>, same: (a: T, b: T) => boolean) {
  const added = [...after.keys()].filter((k) => !before.has(k)).sort();
  const removed = [...before.keys()].filter((k) => !after.has(k)).sort();
  const changed = [...after.keys()]
    .filter((k) => before.has(k) && !same(before.get(k) as T, after.get(k) as T))
    .sort();
  return { added, removed, changed };
}

/** Semver precedence: a pre-release sorts before its release; pre-releases compare as text. */
function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const dash = v.indexOf("-");
    const core = (dash === -1 ? v : v.slice(0, dash)).split(".").map(Number);
    return { core, pre: dash === -1 ? null : v.slice(dash + 1) };
  };
  const [va, vb] = [split(a), split(b)];
  for (let i = 0; i < 3; i++) {
    const d = (va.core[i] ?? 0) - (vb.core[i] ?? 0);
    if (d !== 0) return d;
  }
  if (va.pre === vb.pre) return 0;
  if (va.pre === null) return 1;
  if (vb.pre === null) return -1;
  return va.pre < vb.pre ? -1 : 1;
}

function describe(c: PackChange): string {
  switch (c.kind) {
    case "set-defaults":
      return `tenant default goes from ${c.from.visibility}/${c.from.exposure} to ${c.to.visibility}/${c.to.exposure}`;
    case "add-facet":
      return `new facet ${c.facet} is public: its tags show on title-only cards`;
    case "change-facet":
      return `facet ${c.facet} becomes public: its tags show on title-only cards`;
    case "add-value":
      return `new value ${c.tag} (${lv(c.levels)}) is looser than the tenant default`;
    case "approve-value":
      return `proposed value ${c.tag} becomes approved vocabulary: grants and trusted tags can use it`;
    case "change-value":
      return `${c.tag} goes from ${lv(c.from.levels)} to ${lv(c.to.levels)}`;
    case "set-rules":
      return `tag rules change (added ${ruleIds(c.added)}, removed ${ruleIds(c.removed)}, changed ${ruleIds(c.changed.map((x) => x.to))}): rule tags are trusted, so review what each tags`;
    case "set-policies":
      return `policies change so that more may be allowed (added ${names(c.added)}, removed ${names(c.removed)}, changed ${names(c.changed)}): review each`;
    default:
      return c.kind;
  }
}
const lv = (l: NullableLevels) =>
  `${l.visibility ?? "no visibility"}/${l.exposure ?? "no exposure"}`;
const ruleIds = (rules: TagRule[]) => (rules.length ? rules.map((r) => r.id).join(", ") : "none");
const names = (xs: { id: string }[]) => (xs.length ? xs.map((x) => x.id).join(", ") : "none");
