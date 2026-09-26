import { createHash } from "node:crypto";
import {
  facets,
  facetValues,
  queryRows,
  tenantPacks,
  tenants,
  zones,
  type Tx,
} from "@openhoard/core-db";
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
 * Removing one is the same two steps: planPackRemoval() and removePack().
 *
 * Everything that reads the tenant's packs re-checks them against today's rules, and one that
 * no longer passes stops them (fail closed), naming the pack. Two ways out stay open: planning
 * a fixed version of that same pack (its stored rules and policies are then all shown as
 * removed and the new ones as added, flagged), and removing it.
 *
 * The pack is copied (JSON round trip) once at the start of each, and that copy is what is
 * validated, hashed, planned, applied and stored, so nothing can change between them.
 *
 * A pack only adds and updates: vocabulary it no longer lists stays (grants and tags may use
 * it), and is reported. Its rules and policies replace the ones its earlier version brought.
 * Every other applied pack's tests run again against the tenant as the plan would leave it, so
 * one pack can't silently break another's guarantees.
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
  /** At most one value per object, e.g. `sensitivity` (T-409). */
  single?: boolean;
  values: PackValue[];
}

/** One expected decision, checked with the pack's policies, the tenant's other packs' and core. */
export interface PolicyTest {
  name: string;
  action: Action;
  principal?: {
    guest?: boolean;
    active?: boolean;
    /** A service account (T-111), acting through a key that allows every action and zone. */
    service?: boolean;
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
    /** A zone kind (core/db `zones.kind`): managed, indexed, local-only or code. Default indexed. */
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

export type PackErrorCode = "invalid" | "tests-failed" | "stale-plan" | "not-applied";

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
/** Semver 2.0: a pre-release is dot-separated, non-empty identifiers, numbers without leading 0s. */
const PRE_ID = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const VERSION = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(-${PRE_ID}(?:\\.${PRE_ID})*)?$`,
);
const FACET = /^[a-z][a-z0-9-]{0,63}$/;
const VALUE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const TAG = /^[a-z][a-z0-9-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/;
const POLICY_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ACTIONS = ["search", "read", "open", "tag"];
const CLIENTS = ["first-party", "local", "commercial", "consumer"];
/** Control and format characters (newlines, bidi overrides, zero-width): not in labels. */
const INVISIBLE = /\p{C}/u;
/**
 * Not in policy text either, except line breaks and tabs: a NUL or a bidi override in a Cedar
 * comment or string makes the diff an admin reviews render differently from what runs. Nor the
 * line and paragraph separators (U+2028, U+2029): a viewer may break the line there, while a
 * Cedar comment runs on to the next newline, hiding what looks like a policy after it.
 */
const POLICY_INVISIBLE = /[^\P{C}\n\r\t]|[\p{Zl}\p{Zp}]/u;
/** The zone kinds `resource.zone` can be (core/db `zones.kind`). */
export const ZONE_KINDS: readonly string[] = zones.kind.enumValues;
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
    only(facet, at, ["key", "label", "public", "single", "values"]);
    if (typeof facet.key !== "string" || !FACET.test(facet.key)) bad(`${at}: key must be a slug`);
    else if (keys.has(facet.key)) bad(`${at}: listed twice`);
    else keys.add(facet.key);
    if (!text(facet.label, 200)) bad(`${at}: label must be 1 to 200 visible characters`);
    if (facet.public !== undefined && typeof facet.public !== "boolean") {
      bad(`${at}: public must be true or false`);
    }
    if (facet.single !== undefined && typeof facet.single !== "boolean") {
      bad(`${at}: single must be true or false`);
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
      // Built-in vocabulary (core/db ensureBuiltInVocabulary()): a pack may list it, as it is.
      if (
        facet.key === "risk" &&
        value.value === "injection" &&
        (value.exposure !== "metadata-only" || value.visibility !== undefined)
      ) {
        bad(
          `${vat}: risk:injection is built-in vocabulary: exposure metadata-only, no visibility, and it can't be changed`,
        );
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
          continue;
        }
        if (POLICY_INVISIBLE.test(body)) {
          bad(`policy ${id}: control, format or separator characters (only line breaks and tabs)`);
        }
        for (const zone of zoneLiterals(body)) {
          if (!ZONE_KINDS.includes(zone)) {
            bad(
              `policy ${id}: resource.zone is never "${zone}" (zone kinds: ${ZONE_KINDS.join(", ")})`,
            );
          }
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
          if (c.resource.zone !== undefined && !ZONE_KINDS.includes(c.resource.zone as string)) {
            bad(`${at}: resource.zone must be a zone kind (${ZONE_KINDS.join(", ")})`);
          }
        }
        if (c.principal !== undefined) {
          if (!isObj(c.principal)) bad(`${at}: principal must be an object`);
          else {
            only(c.principal, `${at} principal`, [
              "guest",
              "active",
              "service",
              "readGrants",
              "writeGrants",
              "owner",
            ]);
            for (const k of ["guest", "active", "service", "owner"]) {
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

const ZONE_EQUALS = /resource\s*\.\s*zone\s*[!=]=\s*"((?:[^"\\]|\\.)*)"/g;
const EQUALS_ZONE = /"((?:[^"\\]|\\.)*)"\s*[!=]=\s*resource\s*\.\s*zone/g;
const ZONE_IN_SET = /\[([^\]]*)\]\s*\.\s*contains\s*\(\s*resource\s*\.\s*zone\s*\)/g;
const STRING_LITERAL = /"((?:[^"\\]|\\.)*)"/g;

/**
 * The string literals a policy compares `resource.zone` with: `resource.zone == "x"`, `!=`,
 * either way round, and `["x", "y"].contains(resource.zone)`, outside comments, with Cedar's
 * escapes decoded. A text check, not a parse: it is there to catch mistakes such as
 * `resource.zone == "legal"`, which never matches (a zone's name isn't its kind), not to be a
 * boundary: other spellings, such as `resource["zone"]` or `like`, aren't checked.
 */
export function zoneLiterals(policy: string): string[] {
  const text = withoutComments(policy);
  const unquote = (s = "") =>
    s.replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\(.)/g, (_, hex?: string, c?: string) => {
      if (hex !== undefined) {
        const code = Number.parseInt(hex, 16);
        return code <= 0x10ffff ? String.fromCodePoint(code) : "";
      }
      return (
        ({ n: "\n", r: "\r", t: "\t", "0": "\0" } as Record<string, string>)[c ?? ""] ?? c ?? ""
      );
    });
  return [
    ...[...text.matchAll(ZONE_EQUALS), ...text.matchAll(EQUALS_ZONE)].map((m) => unquote(m[1])),
    ...[...text.matchAll(ZONE_IN_SET)].flatMap((m) =>
      [...(m[1] ?? "").matchAll(STRING_LITERAL)].map((l) => unquote(l[1])),
    ),
  ];
}

/** How many objects carry more than one value of `facet`. */
async function objectsWithSeveral(tx: Tx, tenantId: string, facet: string): Promise<number> {
  const [row] = await queryRows<{ n: number }>(
    tx,
    sql`select count(*)::int as n from (
          select 1 from object_tags where tenant_id = ${tenantId} and facet = ${facet}
          group by object_id having count(*) > 1) crowded`,
  );
  return row?.n ?? 0;
}

/** Cedar text with its `//` comments blanked, leaving string literals (which may hold `//`). */
function withoutComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else {
      out += c;
      if (c === '"') inString = true;
    }
  }
  return out;
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

type Levels = { visibility: Visibility; exposure: Exposure };
type NullableLevels = { visibility: Visibility | null; exposure: Exposure | null };
type LevelMap = ReadonlyMap<string, NullableLevels>;
const DEFAULT_LEVELS: Levels = { visibility: "hidden", exposure: "metadata-only" };

/**
 * Runs a pack's tests: its policies compile and validate against the Cedar schema; each policy
 * test gets the expected decision from these policies, the other packs' and the core rules;
 * each level test resolves as expected from the pack's and the tenant's values and defaults.
 * A decision that is an error (a malformed test) fails, whatever was expected, and so does a
 * level test naming a tag nobody defines.
 */
export function runPackTests(pack: Pack, context: PackTestContext = {}): PackTestResult[] {
  const compiled = compile({ ...context.otherPolicies, ...packPolicies(pack) });
  if (!compiled.authz) return [compiled.result];
  const levels = withPackValues(context.values, pack);
  const defaults = pack.defaults ?? context.defaults ?? DEFAULT_LEVELS;
  return [compiled.result, ...runSuite(compiled.authz, pack.tests, levels, defaults)];
}

/**
 * The one engine a plan's tests share: the core rules plus `policies`. Built once per plan,
 * for the planned pack's tests and every other pack's.
 */
function compile(
  policies: Readonly<Record<string, string>>,
): { authz: Authorizer; result: PackTestResult } | { authz: null; result: PackTestResult } {
  try {
    const authz = new Authorizer(createCedarEngine(policies));
    return { authz, result: { name: "policies compile", passed: true, detail: "" } };
  } catch (e) {
    const detail = e instanceof PolicyError ? e.details.join("; ") : String(e);
    return { authz: null, result: { name: "policies compile", passed: false, detail } };
  }
}

/** The tenant's value levels with the pack's own values over them, as applying it leaves them. */
function withPackValues(values: LevelMap | undefined, pack: Pack): Map<string, NullableLevels> {
  const levels = new Map(values ?? []);
  for (const f of pack.facets ?? []) {
    for (const v of f.values) {
      levels.set(`${f.key}:${v.value}`, {
        visibility: v.visibility ?? null,
        exposure: v.exposure ?? null,
      });
    }
  }
  return levels;
}

/** One pack's policy and level tests. `prefix` names the pack when it isn't the one planned. */
function runSuite(
  authz: Authorizer,
  tests: Pack["tests"],
  levels: LevelMap,
  defaults: Levels,
  prefix = "",
): PackTestResult[] {
  const results: PackTestResult[] = [];
  for (const t of tests?.policies ?? []) {
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
        // A key as wide as can be, so the test sees the pack's rules, not a key's scope.
        ...(p.service === true
          ? { service: true, scope: { actions: ACTIONS as Action[], zones: ZONE_KINDS } }
          : {}),
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
      name: `${prefix}${t.name}`,
      passed,
      detail: passed
        ? decision.reason
        : `expected ${t.expect}, got ${decision.kind} (${decision.reason})`,
    });
  }
  for (const t of tests?.levels ?? []) {
    const name = `${prefix}${t.name}`;
    const unknown = t.tags.filter((tag) => !levels.has(tag));
    if (unknown.length) {
      results.push({ name, passed: false, detail: `unknown tags: ${unknown.join(", ")}` });
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
      name,
      passed,
      detail: passed
        ? ""
        : `expected ${t.expect.visibility}/${t.expect.exposure}, got ${got.visibility}/${got.exposure}`,
    });
  }
  return results;
}

/** One change applying (or removing) the pack would make, or something it would leave in place. */
export type PackChange =
  | { kind: "set-defaults"; from: Levels; to: Levels; loosens: boolean }
  | {
      kind: "add-facet";
      facet: string;
      label: string;
      public: boolean;
      single: boolean;
      loosens: boolean;
    }
  | {
      kind: "change-facet";
      facet: string;
      from: { label: string; public: boolean; single: boolean };
      to: { label: string; public: boolean; single: boolean };
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
  /** Applying the pack (planPack) or removing it (planPackRemoval). */
  action: "apply" | "remove";
  tenantId: string;
  name: string;
  /** The version applied by this plan; for a removal, the version removed. */
  version: string;
  /** The version applied now, if any. */
  previous: string | null;
  /** For a removal, the hash stored when the pack was applied. */
  contentHash: string;
  changes: PackChange[];
  /** Human-readable warnings: every loosening change, and a version going down. */
  warnings: string[];
  /**
   * The pack's tests, then every other applied pack's (named `<pack>: <test>`), all against the
   * tenant as the plan would leave it.
   */
  tests: PackTestResult[];
  /** What applyPack() or removePack() needs: a hash of this plan, bound to this tenant. */
  planHash: string;
}

/**
 * The diff applying `input` would make to the tenant, with every loosening flagged. Read-only.
 * Show it to an admin and pass its `planHash` to applyPack().
 */
export async function planPack(tx: Tx, tenantId: string, input: unknown): Promise<PackPlan> {
  return plan(tx, tenantId, parsePack(input));
}

type ValueRow = {
  label: string;
  approved: boolean;
  visibility: Visibility | null;
  exposure: Exposure | null;
};

async function tenantDefaults(tx: Tx, tenantId: string): Promise<Levels> {
  const [tenant] = await tx
    .select({ visibility: tenants.defaultVisibility, exposure: tenants.defaultExposure })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) throw new PackError("invalid", `no tenant ${tenantId}`);
  return tenant;
}

async function tenantValues(tx: Tx, tenantId: string): Promise<Map<string, ValueRow>> {
  const rows = await tx
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
    .orderBy(asc(facetValues.facet), asc(facetValues.value));
  return new Map(rows.map(({ facet, value, ...v }) => [`${facet}:${value}`, v]));
}

/** The levels of the approved values: the vocabulary the tests resolve against. */
function approvedLevels(values: ReadonlyMap<string, ValueRow>): Map<string, NullableLevels> {
  return new Map(
    [...values]
      .filter(([, v]) => v.approved)
      .map(([tag, v]) => [tag, { visibility: v.visibility, exposure: v.exposure }]),
  );
}

async function appliedRow(tx: Tx, tenantId: string, name: string) {
  const [row] = await tx
    .select({
      version: tenantPacks.version,
      content: tenantPacks.content,
      contentHash: tenantPacks.contentHash,
    })
    .from(tenantPacks)
    .where(and(eq(tenantPacks.tenantId, tenantId), eq(tenantPacks.name, name)));
  return row;
}

async function plan(tx: Tx, tenantId: string, pack: Pack): Promise<PackPlan> {
  const contentHash = sha256(canonicalJson(pack));
  const changes: PackChange[] = [];
  const warnings: string[] = [];

  const tenant = await tenantDefaults(tx, tenantId);
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
        .select({
          key: facets.key,
          label: facets.label,
          public: facets.public,
          single: facets.single,
        })
        .from(facets)
        .where(eq(facets.tenantId, tenantId))
    ).map((f) => [f.key, f]),
  );
  const currentValues = await tenantValues(tx, tenantId);

  const applied = await appliedRow(tx, tenantId, pack.name);
  const before = applied ? readStored(pack.name, applied.content) : null;
  if (before && !before.valid) {
    warnings.push(
      `the applied ${pack.name} no longer validates (${before.problems.join("; ")}): all its rules and policies are shown as removed, and this version's as added`,
    );
  }
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
    const single = f.single ?? false;
    if (!cur) {
      changes.push({
        kind: "add-facet",
        facet: f.key,
        label: f.label,
        public: pub,
        single,
        loosens: pub,
      });
    } else if (cur.label !== f.label || cur.public !== pub || cur.single !== single) {
      changes.push({
        kind: "change-facet",
        facet: f.key,
        from: { label: cur.label, public: cur.public, single: cur.single },
        to: { label: f.label, public: pub, single },
        loosens: pub && !cur.public,
      });
      if (single && !cur.single) {
        const crowded = await objectsWithSeveral(tx, tenantId, f.key);
        if (crowded > 0) {
          warnings.push(
            `facet ${f.key} becomes single-value, and ${crowded} object(s) carry more than one of its values: they keep them until a person chooses`,
          );
        }
      }
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
          // Both ways: as set (a level removed is the loosest, since the default only applies
          // to files no level tag covers, so a file's other tags then decide) and with the
          // default filling in (a level set looser than the default it replaces).
          loosens:
            looser(curLevels, levels) ||
            looser(effective(curLevels, tenant), effective(levels, defaultsAfter)),
        });
      }
    }
  }
  for (const tag of before?.valueTags ?? []) {
    if (!listed.has(tag) && currentValues.has(tag)) {
      changes.push({
        kind: "keep-value",
        tag,
        note: "no longer in the pack; left in place, since tags and grants may use it",
      });
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
  const wholesale = before?.valid === false;
  const rules = rulesChange(before?.rules ?? [], pack.rules ?? [], wholesale);
  if (rules) changes.push(rules);
  const policies = policiesChange(before?.policies ?? {}, packPolicies(pack), wholesale);
  if (policies) changes.push(policies);

  // The tests, this pack's and every other applied pack's, run against the tenant as the pack
  // would leave it. Another pack that no longer validates stops the plan (fail closed).
  const others = await appliedPacks(tx, tenantId, pack.name);
  const valuesAfter = withPackValues(approvedLevels(currentValues), pack);
  const compiled = compile({ ...policiesOf(others), ...packPolicies(pack) });
  const authz = compiled.authz;
  const tests = authz
    ? [
        compiled.result,
        ...runSuite(authz, pack.tests, valuesAfter, defaultsAfter),
        ...others.flatMap((o) =>
          runSuite(authz, o.tests, valuesAfter, defaultsAfter, `${o.name}: `),
        ),
      ]
    : [compiled.result];
  warnings.push(...unknownTestTags(pack, valuesAfter));
  warnings.push(...loosenings(changes));
  return seal({
    action: "apply",
    tenantId,
    name: pack.name,
    version: pack.version,
    previous: applied?.version ?? null,
    contentHash,
    changes,
    warnings,
    tests,
  });
}

/**
 * What removing the applied pack `name` would do: its rules and policies go, its vocabulary and
 * the tenant defaults stay (tags and grants may use them). Removing a forbid is flagged as
 * loosening. Every other applied pack's tests run against the tenant without it. Read-only.
 *
 * It works on a stored pack that no longer validates, which is the point: that pack stops
 * everything else (fail closed) until it is fixed or removed. Another stored pack that no
 * longer validates is reported in the warnings and its tests aren't run, so two broken packs
 * can still be removed one after the other.
 */
export async function planPackRemoval(tx: Tx, tenantId: string, name: string): Promise<PackPlan> {
  const warnings: string[] = [];
  const changes: PackChange[] = [];
  const tenant = await tenantDefaults(tx, tenantId);
  const applied = await appliedRow(tx, tenantId, name);
  if (!applied) throw new PackError("not-applied", `no pack ${name} is applied`);
  const before = readStored(name, applied.content);
  if (!before.valid) {
    warnings.push(`the applied ${name} no longer validates (${before.problems.join("; ")})`);
  }
  const currentValues = await tenantValues(tx, tenantId);
  for (const tag of before.valueTags) {
    if (currentValues.has(tag)) {
      changes.push({
        kind: "keep-value",
        tag,
        note: "stays when the pack is removed, since tags and grants may use it",
      });
    }
  }
  const rules = rulesChange(before.rules, [], false);
  if (rules) changes.push(rules);
  const policies = policiesChange(before.policies, {}, false);
  if (policies) changes.push(policies);

  const { packs: others, invalid } = await loadApplied(tx, tenantId, name);
  for (const i of invalid) {
    warnings.push(`the applied ${i.name} no longer validates, so its tests weren't run`);
  }
  const compiled = compile(policiesOf(others));
  const authz = compiled.authz;
  const values = approvedLevels(currentValues);
  const tests = authz
    ? [
        compiled.result,
        ...others.flatMap((o) => runSuite(authz, o.tests, values, tenant, `${o.name}: `)),
      ]
    : [compiled.result];
  warnings.push(...loosenings(changes));
  return seal({
    action: "remove",
    tenantId,
    name,
    version: applied.version,
    previous: applied.version,
    contentHash: applied.contentHash,
    changes,
    warnings,
    tests,
  });
}

function seal(planned: Omit<PackPlan, "planHash">): PackPlan {
  return { ...planned, planHash: sha256(canonicalJson(planned)) };
}

function loosenings(changes: PackChange[]): string[] {
  return changes.flatMap((c) => ("loosens" in c && c.loosens ? [describe(c)] : []));
}

/** Policy tests naming tags the tenant won't have: a typo there makes a test pass vacuously. */
function unknownTestTags(pack: Pack, vocabulary: LevelMap): string[] {
  return (pack.tests?.policies ?? []).flatMap((t) => {
    const tags = [
      ...t.resource.tags,
      ...(t.resource.unreviewedTags ?? []),
      ...(t.principal?.readGrants ?? []),
      ...(t.principal?.writeGrants ?? []),
    ];
    const unknown = [...new Set(tags.filter((tag) => !vocabulary.has(tag)))];
    return unknown.length
      ? [`policy test "${t.name}" uses tags that aren't approved vocabulary: ${unknown.join(", ")}`]
      : [];
  });
}

/** The rules diff; `wholesale` shows every rule as removed and re-added. */
function rulesChange(before: TagRule[], after: TagRule[], wholesale: boolean): PackChange | null {
  if (wholesale) {
    return before.length || after.length
      ? { kind: "set-rules", added: after, removed: before, changed: [], loosens: true }
      : null;
  }
  const rulesBefore = new Map(before.map((r) => [r.id, r]));
  const rulesAfter = new Map(after.map((r) => [r.id, r]));
  const ids = diffIds(rulesBefore, rulesAfter, (a, b) => canonicalJson(a) === canonicalJson(b));
  if (!ids.added.length && !ids.removed.length && !ids.changed.length) return null;
  return {
    kind: "set-rules",
    added: ids.added.map((id) => rulesAfter.get(id) as TagRule),
    removed: ids.removed.map((id) => rulesBefore.get(id) as TagRule),
    changed: ids.changed.map((id) => ({
      from: rulesBefore.get(id) as TagRule,
      to: rulesAfter.get(id) as TagRule,
    })),
    loosens: true,
  };
}

/** The policies diff (applied ids); `wholesale` shows every policy as removed and re-added. */
function policiesChange(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
  wholesale: boolean,
): PackChange | null {
  const policiesBefore = new Map(Object.entries(before));
  const policiesAfter = new Map(Object.entries(after));
  const ids = wholesale
    ? { added: [...policiesAfter.keys()].sort(), removed: [...policiesBefore.keys()].sort() }
    : diffIds(policiesBefore, policiesAfter, (a, b) => a === b);
  const changed = "changed" in ids ? ids.changed : [];
  if (!ids.added.length && !ids.removed.length && !changed.length) return null;
  // Text that doesn't parse counts as both, so it is flagged either way.
  const permits = (text: string | undefined) =>
    text !== undefined && policyEffect(text) !== "forbid";
  const forbids = (text: string | undefined) =>
    text !== undefined && policyEffect(text) !== "permit";
  return {
    kind: "set-policies",
    added: ids.added.map((id) => ({ id, text: policiesAfter.get(id) as string })),
    removed: ids.removed.map((id) => ({ id, text: policiesBefore.get(id) as string })),
    changed: changed.map((id) => ({
      id,
      from: policiesBefore.get(id) as string,
      to: policiesAfter.get(id) as string,
    })),
    loosens:
      wholesale ||
      ids.added.some((id) => permits(policiesAfter.get(id))) ||
      ids.removed.some((id) => forbids(policiesBefore.get(id))) ||
      changed.some((id) => forbids(policiesBefore.get(id)) || permits(policiesAfter.get(id))),
  };
}

export interface ApplyOptions {
  /** The planHash of the plan an admin reviewed. */
  planHash: string;
  /** Who approved it, e.g. `user:<id>`. */
  by: string;
}

/**
 * Transaction settings for applyPack() and removePack():
 * `db.withTenant(tenant, work, APPLY_TRANSACTION)`.
 */
export const APPLY_TRANSACTION = { isolationLevel: "serializable" } as const;

/** Rows per multi-row insert when applying a pack's vocabulary. */
const WRITE_BATCH = 500;

/**
 * Applies a pack, exactly as planned. Runs only in a SERIALIZABLE transaction
 * ({@link APPLY_TRANSACTION}), so no concurrent change to the vocabulary (a review approving a
 * value, a model proposing one) can slip in between the check and the writes; a conflict aborts
 * with SQLSTATE 40001 and the caller retries. Refuses (`stale-plan`) if planning again now gives
 * a different plan, and (`tests-failed`) if any test fails, the pack's own or another applied
 * pack's. Writes only the facets and values the plan changes. Returns the plan.
 */
export async function applyPack(
  tx: Tx,
  tenantId: string,
  input: unknown,
  options: ApplyOptions,
): Promise<PackPlan> {
  await checkApply(tx, options, "applyPack");
  // Serializable isolation is what makes this safe: two applies, or an apply and a review,
  // that touch the same rows can't both commit.
  const pack = parsePack(input);
  const planned = await plan(tx, tenantId, pack);
  checkPlan(planned, options.planHash);
  // Only a change: an unchanged row isn't rewritten, so it can't conflict with other work.
  if (pack.defaults && planned.changes.some((c) => c.kind === "set-defaults")) {
    await tx
      .update(tenants)
      .set({ defaultVisibility: pack.defaults.visibility, defaultExposure: pack.defaults.exposure })
      .where(eq(tenants.id, tenantId));
  }
  await writeVocabulary(tx, tenantId, pack, planned.changes);
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

/**
 * Removes an applied pack, exactly as planned by planPackRemoval(): its rules and policies stop
 * applying; its vocabulary stays. The same transaction and checks as applyPack(): refuses
 * (`stale-plan`) if planning again gives a different plan, and (`tests-failed`) if another
 * pack's tests fail without it. Callers record the plan in the audit log. Returns the plan.
 */
export async function removePack(
  tx: Tx,
  tenantId: string,
  name: string,
  options: ApplyOptions,
): Promise<PackPlan> {
  await checkApply(tx, options, "removePack");
  const planned = await planPackRemoval(tx, tenantId, name);
  checkPlan(planned, options.planHash);
  await tx
    .delete(tenantPacks)
    .where(and(eq(tenantPacks.tenantId, tenantId), eq(tenantPacks.name, name)));
  return planned;
}

async function checkApply(tx: Tx, options: ApplyOptions, what: string): Promise<void> {
  if (!/^[a-z]+:.+$/s.test(options.by)) throw new PackError("invalid", "by must be a principal");
  const [level] = await queryRows<{ level: string }>(
    tx,
    sql`select current_setting('transaction_isolation') as level`,
  );
  if (level?.level !== "serializable") {
    throw new Error(`${what} needs a serializable transaction (APPLY_TRANSACTION)`);
  }
}

function checkPlan(planned: PackPlan, planHash: string): void {
  if (planned.planHash !== planHash) {
    throw new PackError("stale-plan", "the tenant or the pack changed since this plan; plan again");
  }
  const failed = planned.tests.filter((t) => !t.passed);
  if (failed.length) {
    throw new PackError(
      "tests-failed",
      planned.action === "apply"
        ? `pack ${planned.name} failed its tests`
        : `removing pack ${planned.name} fails other packs' tests`,
      failed.map((t) => `${t.name}: ${t.detail}`),
    );
  }
}

/** Upserts the facets and values the plan adds, approves or changes, in multi-row batches. */
async function writeVocabulary(
  tx: Tx,
  tenantId: string,
  pack: Pack,
  changes: readonly PackChange[],
): Promise<void> {
  const facetByKey = new Map((pack.facets ?? []).map((f) => [f.key, f]));
  const valueByTag = new Map(
    (pack.facets ?? []).flatMap((f) => f.values.map((v) => [`${f.key}:${v.value}`, { f, v }])),
  );
  const facetRows = changes.flatMap((c) => {
    const f = c.kind === "add-facet" || c.kind === "change-facet" ? facetByKey.get(c.facet) : null;
    return f
      ? [
          {
            tenantId,
            key: f.key,
            label: f.label,
            public: f.public ?? false,
            single: f.single ?? false,
          },
        ]
      : [];
  });
  const valueRows = changes.flatMap((c) => {
    const hit =
      c.kind === "add-value" || c.kind === "approve-value" || c.kind === "change-value"
        ? valueByTag.get(c.tag)
        : null;
    if (!hit) return [];
    const { f, v } = hit;
    return [
      {
        tenantId,
        facet: f.key,
        value: v.value,
        label: v.label,
        approved: true,
        visibility: v.visibility ?? null,
        exposure: v.exposure ?? null,
      },
    ];
  });
  for (let i = 0; i < facetRows.length; i += WRITE_BATCH) {
    await tx
      .insert(facets)
      .values(facetRows.slice(i, i + WRITE_BATCH))
      .onConflictDoUpdate({
        target: [facets.tenantId, facets.key],
        set: { label: excluded("label"), public: excluded("public"), single: excluded("single") },
      });
  }
  for (let i = 0; i < valueRows.length; i += WRITE_BATCH) {
    await tx
      .insert(facetValues)
      .values(valueRows.slice(i, i + WRITE_BATCH))
      .onConflictDoUpdate({
        target: [facetValues.tenantId, facetValues.facet, facetValues.value],
        set: {
          label: excluded("label"),
          approved: excluded("approved"),
          visibility: excluded("visibility"),
          exposure: excluded("exposure"),
        },
      });
  }
}
const excluded = (column: string) => sql.raw(`excluded."${column}"`);

/** A stored pack that validates, or what is wrong with it. */
function checkStored(name: string, content: unknown): Pack | string[] {
  let pack: Pack;
  try {
    pack = parsePack(content);
  } catch (e) {
    if (e instanceof PackError && e.details.length) return [...e.details];
    return [e instanceof Error ? e.message : String(e)];
  }
  if (pack.name !== name) return [`it says it is ${pack.name}`];
  const misuse = Object.entries(pack.policies ?? {}).flatMap(([id, text]) =>
    allTagsMisuse(text).map((m) => `${id}: ${m}`),
  );
  return misuse.length ? misuse : pack;
}

/** The applied packs, re-checked, and the names and problems of those that no longer validate. */
async function loadApplied(tx: Tx, tenantId: string, except?: string) {
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
  const packs: Pack[] = [];
  const invalid: { name: string; problems: string[] }[] = [];
  for (const r of rows) {
    const checked = checkStored(r.name, r.content);
    if (Array.isArray(checked)) invalid.push({ name: r.name, problems: checked });
    else packs.push(checked);
  }
  return { packs, invalid };
}

/**
 * The applied packs, re-checked against today's rules. Any that no longer passes stops
 * everything that reads the tenant's packs (fail closed), and the error names every one: plan
 * a fixed version of it, or remove it (planPackRemoval()).
 */
async function appliedPacks(tx: Tx, tenantId: string, except?: string): Promise<Pack[]> {
  const { packs, invalid } = await loadApplied(tx, tenantId, except);
  if (invalid.length) {
    const names = invalid.map((i) => i.name).join(", ");
    throw new PackError(
      "invalid",
      invalid.length === 1
        ? `stored pack ${names} no longer validates`
        : `stored packs ${names} no longer validate`,
      invalid.flatMap((i) => i.problems.map((p) => `${i.name}: ${p}`)),
    );
  }
  return packs;
}

interface StoredPack {
  valid: boolean;
  problems: string[];
  rules: TagRule[];
  /** Under their applied ids. */
  policies: Record<string, string>;
  valueTags: string[];
}

/**
 * A stored pack for diffing against: checked when it still validates, and read leniently when
 * it doesn't, taking whatever rules, policies and values it has so the plan can show them all
 * as going. Never used to decide anything.
 */
function readStored(name: string, content: unknown): StoredPack {
  const checked = checkStored(name, content);
  if (!Array.isArray(checked)) {
    return {
      valid: true,
      problems: [],
      rules: checked.rules ?? [],
      policies: packPolicies(checked),
      valueTags: (checked.facets ?? []).flatMap((f) => f.values.map((v) => `${f.key}:${v.value}`)),
    };
  }
  const c = isObj(content) ? content : {};
  const objects = (v: unknown) => (Array.isArray(v) ? v.filter(isObj) : []);
  return {
    valid: false,
    problems: checked,
    rules: objects(c.rules).map((r, i) => ({
      ...r,
      id: typeof r.id === "string" ? r.id : `#${i}`,
    })) as unknown as TagRule[],
    policies: Object.fromEntries(
      Object.entries(isObj(c.policies) ? c.policies : {}).map(([id, text]) => [
        `pack/${name}/${id}`,
        typeof text === "string" ? text : String(JSON.stringify(text)),
      ]),
    ),
    valueTags: objects(c.facets).flatMap((f) =>
      typeof f.key === "string"
        ? objects(f.values).flatMap((v) =>
            typeof v.value === "string" ? [`${f.key as string}:${v.value}`] : [],
          )
        : [],
    ),
  };
}

const policiesOf = (packs: readonly Pack[]) =>
  Object.assign({}, ...packs.map(packPolicies)) as Record<string, string>;

/** The applied packs' Cedar policies, under their applied ids, for createCedarEngine(). */
export async function tenantPolicies(
  tx: Tx,
  tenantId: string,
  options: { except?: string } = {},
): Promise<Record<string, string>> {
  return policiesOf(await appliedPacks(tx, tenantId, options.except));
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

/**
 * Semver precedence (semver.org §11), negative when `a` is lower: a pre-release sorts before
 * its release; pre-release identifiers compare one by one, numeric ones numerically and before
 * alphanumeric ones, which compare in ASCII order; a shorter set that is equal so far is lower.
 * So 1.0.0-rc.2 < 1.0.0-rc.10 < 1.0.0.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const dash = v.indexOf("-");
    const core = (dash === -1 ? v : v.slice(0, dash)).split(".");
    return { core, pre: dash === -1 ? null : v.slice(dash + 1).split(".") };
  };
  const [va, vb] = [split(a), split(b)];
  for (let i = 0; i < 3; i++) {
    const d = compareNumeric(va.core[i] ?? "0", vb.core[i] ?? "0");
    if (d !== 0) return d;
  }
  if (va.pre === null || vb.pre === null) {
    return va.pre === vb.pre ? 0 : va.pre === null ? 1 : -1;
  }
  for (let i = 0; i < Math.min(va.pre.length, vb.pre.length); i++) {
    const [x, y] = [va.pre[i] ?? "", vb.pre[i] ?? ""];
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    const d = nx && ny ? compareNumeric(x, y) : nx ? -1 : ny ? 1 : x < y ? -1 : x > y ? 1 : 0;
    if (d !== 0) return d;
  }
  return va.pre.length - vb.pre.length;
}
/** Two digit strings as numbers of any size. */
function compareNumeric(x: string, y: string): number {
  const [a, b] = [x.replace(/^0+(?=\d)/, ""), y.replace(/^0+(?=\d)/, "")];
  return a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0;
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
