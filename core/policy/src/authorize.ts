import type { ClientTrust } from "./levels.js";

/*
 * Authorization (T-601, ADR-0007). Every access decision in OpenHoard goes through
 * Authorizer.authorize(). It follows spike S3's split:
 *
 * - Grants are data. Whether the caller holds a grant on one of the object's tags, or on the
 *   object itself, is a set lookup, computed here from grants loaded for the caller (core/db
 *   loadGrants, T-602); so is whether the caller owns the object.
 * - Rules are Cedar. The engine gets the request plus those facts and applies the core rules
 *   and any pack rules: permits for grants and owners, forbids, conditional permits.
 *
 * Everything fails closed: a malformed request, an engine error or a rule that errors while
 * evaluating is a deny, never an allow.
 */

/** What a caller can do to an object in M1 (read-only pilot). */
export const ACTIONS = ["search", "read", "open", "tag"] as const;
export type Action = (typeof ACTIONS)[number];

/** Who is asking, after sign-in resolved them: core/identity `resolvePrincipal()` builds it. */
export interface AuthzPrincipal {
  userId: string;
  groupIds: readonly string[];
  /**
   * Tags the user may read, directly or through groups (e.g. `client:acme`): search, read and
   * open objects carrying them.
   */
  tagGrants: readonly string[];
  /** Tags the user may also write (tag objects carrying them). A write grant implies read. */
  tagWriteGrants: readonly string[];
  /** Objects granted to the user directly (by id), for reading. */
  objectGrants: readonly string[];
  /** Objects granted to the user directly for writing too. Implies read. */
  objectWriteGrants: readonly string[];
  guest: boolean;
  /** False once deprovisioned. */
  active: boolean;
  /**
   * A service account (T-111): a machine, not a person. Like a guest, it never discovers what it
   * can't read. Absent: false.
   */
  service?: boolean;
  /**
   * What the credential the request came with allows (a service account's API key, T-111): only
   * these actions, on objects in these zones. Absent: everything the principal may do, for a
   * person; nothing at all for a service account, which acts only through a key. A request
   * outside it is forbidden by the core rule `core/scope`, whatever grants allow.
   */
  scope?: CredentialScope;
}

export interface CredentialScope {
  actions: readonly Action[];
  /** Zone kinds: `managed`, `indexed`, `local-only`, `code`. */
  zones: readonly string[];
  /**
   * When set, only these zones (ids) too: a connector's key for one SharePoint site, say. An
   * object whose zone id the request doesn't carry is then out of scope.
   */
  zoneIds?: readonly string[];
}

/**
 * The application the request comes through. OpenHoard's own apps are `first-party`; AI clients
 * carry the trust label an admin gave them on the allowlist.
 */
export interface AuthzClient {
  id: string;
  trust: "first-party" | ClientTrust;
}

export interface AuthzResource {
  id: string;
  /** The owner's principal, e.g. `user:u42`. */
  ownerId: string;
  /**
   * The tags grants may match: core/catalog's tagsForDecisions().grantable, which leaves out
   * unreviewed model tags, so a model's guess never widens access.
   */
  tags: readonly string[];
  /**
   * Every tag on the object, unreviewed model guesses included (tagsForDecisions().levels).
   * Rules that restrict (a pack's forbid) match these, so a guess that a file is sensitive
   * restricts it at once. Required: a caller that left it out would silently lose that.
   */
  allTags: readonly string[];
  /** The zone's kind: `managed`, `indexed`, `local-only`, `code`. */
  zone: string;
  /** The zone's id, for credentials scoped to zones (CredentialScope.zoneIds). */
  zoneId?: string;
}

export interface AuthzRequest {
  principal: AuthzPrincipal;
  action: Action;
  resource: AuthzResource;
  client: AuthzClient;
}

export interface AuthzDecision {
  allow: boolean;
  /**
   * What kind of decision: a permit, a forbid, no permit applying, or an error (a malformed
   * request, a failing engine or rule), which always denies.
   */
  kind: "allow" | "forbid" | "no-permit" | "error";
  /** A short explanation for logs, audit and "why can X see this?" (T-606). */
  reason: string;
  /** Ids of the policies that decided it: the permits for an allow, the forbids for a deny. */
  policies: readonly string[];
}

/** What an engine evaluates: the request, plus the facts authorize() derived from data. */
export interface EngineRequest extends AuthzRequest {
  /** The caller holds a read or write grant on one of the object's tags, or on the object. */
  readGranted: boolean;
  /** The caller holds a write grant on one of the object's tags, or on the object. */
  writeGranted: boolean;
  /** The object's owner is the caller. */
  owner: boolean;
  /** The request is within the credential's scope (always, for a principal with none). */
  inScope: boolean;
}

/** A rules engine. Cedar is the one we ship ({@link createCedarEngine}); tests may swap it. */
export interface PolicyEngine {
  evaluate(request: EngineRequest): AuthzDecision;
}

export interface AuthorizerOptions {
  /** Called with whatever an engine threw, for the log; the caller only sees a deny. */
  onError?: (error: unknown) => void;
}

export class Authorizer {
  constructor(
    private readonly engine: PolicyEngine,
    private readonly options: AuthorizerOptions = {},
  ) {}

  /** Decides one request. Never throws: anything unexpected is a deny. */
  authorize(request: AuthzRequest): AuthzDecision {
    const problem = malformed(request);
    if (problem) return deny(`malformed request: ${problem}`);
    const { principal, resource } = request;
    const write = new Set(principal.tagWriteGrants);
    const read = new Set([...principal.tagGrants, ...write]);
    const objectWrite = principal.objectWriteGrants.includes(resource.id);
    const objectRead = objectWrite || principal.objectGrants.includes(resource.id);
    const facts = {
      readGranted: objectRead || resource.tags.some((t) => read.has(t)),
      writeGranted: objectWrite || resource.tags.some((t) => write.has(t)),
      owner: resource.ownerId === `user:${principal.userId}`,
      inScope: withinScope(principal, request.action, resource),
    };
    try {
      return this.engine.evaluate({ ...request, ...facts });
    } catch (e) {
      // Details stay out of the decision, which may reach a client.
      try {
        this.options.onError?.(e);
      } catch {
        // A failing logger must not turn a deny into an exception.
      }
      return deny("policy engine error");
    }
  }
}

/**
 * Whether the request is within the credential's scope. A service account without one is out of
 * scope for everything: it acts through a key, and a principal rebuilt from its id alone (a job,
 * a session) must not get what the key never allowed.
 */
function withinScope(p: AuthzPrincipal, action: Action, resource: AuthzResource): boolean {
  const { scope } = p;
  if (scope === undefined) return p.service !== true;
  if (!scope.actions.includes(action) || !scope.zones.includes(resource.zone)) return false;
  if (scope.zoneIds === undefined) return true;
  return resource.zoneId !== undefined && scope.zoneIds.includes(resource.zoneId);
}

/** A deny; `kind` defaults to `error`, the fail-closed case. */
export const deny = (
  reason: string,
  policies: readonly string[] = [],
  kind: "forbid" | "no-permit" | "error" = "error",
): AuthzDecision => ({ allow: false, kind, reason, policies });

const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0;
/** A dense array of strings. `every()` skips holes, so this walks the indices instead. */
const isStrings = (v: unknown): v is readonly string[] => {
  if (!Array.isArray(v)) return false;
  for (let i = 0; i < v.length; i++) if (typeof v[i] !== "string") return false;
  return true;
};

/** Why a request cannot be evaluated, or undefined. Requests can come from parsed input. */
function malformed(r: AuthzRequest): string | undefined {
  const p = r?.principal as Partial<AuthzPrincipal> | undefined;
  const res = r?.resource as Partial<AuthzResource> | undefined;
  const c = r?.client as Partial<AuthzClient> | undefined;
  if (!p || !isId(p.userId)) return "principal.userId";
  if (!isStrings(p.groupIds) || !p.groupIds.every(isId)) return "principal.groupIds";
  if (!isStrings(p.tagGrants)) return "principal.tagGrants";
  if (!isStrings(p.tagWriteGrants)) return "principal.tagWriteGrants";
  if (!isStrings(p.objectGrants)) return "principal.objectGrants";
  if (!isStrings(p.objectWriteGrants)) return "principal.objectWriteGrants";
  if (typeof p.guest !== "boolean") return "principal.guest";
  if (typeof p.active !== "boolean") return "principal.active";
  if (p.service !== undefined && typeof p.service !== "boolean") return "principal.service";
  if (p.scope !== undefined) {
    const s = p.scope as Partial<CredentialScope> | null;
    const actions = s?.actions;
    if (!isStrings(actions) || actions.length === 0) return "principal.scope.actions";
    if (!actions.every((a) => (ACTIONS as readonly string[]).includes(a))) {
      return "principal.scope.actions";
    }
    if (!isStrings(s?.zones) || s.zones.length === 0) return "principal.scope.zones";
    if (s.zoneIds !== undefined && (!isStrings(s.zoneIds) || s.zoneIds.length === 0)) {
      return "principal.scope.zoneIds";
    }
  }
  if (!(ACTIONS as readonly unknown[]).includes(r.action)) return "action";
  if (!res || !isId(res.id)) return "resource.id";
  if (typeof res.ownerId !== "string") return "resource.ownerId";
  if (!isStrings(res.tags) || !res.tags.every(isId)) return "resource.tags";
  if (!isStrings(res.allTags) || !res.allTags.every(isId)) return "resource.allTags";
  if (typeof res.zone !== "string") return "resource.zone";
  if (res.zoneId !== undefined && typeof res.zoneId !== "string") return "resource.zoneId";
  if (!c || !isId(c.id)) return "client.id";
  if (!["first-party", "local", "commercial", "consumer"].includes(c.trust as string)) {
    return "client.trust";
  }
  return undefined;
}
