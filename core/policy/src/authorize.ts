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

/** Who is asking, after SSO and SCIM resolved them (see core/identity `Subject`). */
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
  zone: string;
}

export interface AuthzRequest {
  principal: AuthzPrincipal;
  action: Action;
  resource: AuthzResource;
  client: AuthzClient;
}

export interface AuthzDecision {
  allow: boolean;
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

export const deny = (reason: string, policies: readonly string[] = []): AuthzDecision => ({
  allow: false,
  reason,
  policies,
});

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
  if (!(ACTIONS as readonly unknown[]).includes(r.action)) return "action";
  if (!res || !isId(res.id)) return "resource.id";
  if (typeof res.ownerId !== "string") return "resource.ownerId";
  if (!isStrings(res.tags) || !res.tags.every(isId)) return "resource.tags";
  if (typeof res.zone !== "string") return "resource.zone";
  if (!c || !isId(c.id)) return "client.id";
  if (!["first-party", "local", "commercial", "consumer"].includes(c.trust as string)) {
    return "client.trust";
  }
  return undefined;
}
