import { liveGrants, objects, zones, type LiveGrant, type Tx } from "@openhoard/core-db";
import {
  getUser,
  groupPrincipal,
  groupsOf,
  resolvePrincipal,
  userPrincipal,
  type User,
} from "@openhoard/core-identity";
import {
  decideRead,
  type Action,
  type Authorizer,
  type AuthzClient,
  type AuthzDecision,
  type ResultShape,
} from "@openhoard/core-policy";
import { and, eq } from "drizzle-orm";
import { tagsForDecisions } from "./tagging.js";
import { explainLevels, requireSnapshot, type LevelsExplanation } from "./visibility.js";

/*
 * "Why can X see this?" (T-606). Replays one decision the way the product makes it, with the
 * same principal resolution, grants, authorize() and levels, and names what decided it: the
 * policies and the grants or ownership behind an allow; every blocker behind a deny; the tags
 * behind the object's visibility.
 *
 * It answers for now. Questions about the past ("could X see this last Tuesday?") need the
 * history of memberships, tags and stops, which lives in the audit log (T-701), not here.
 *
 * FOR ADMINS AND OWNERS ONLY. An explanation shows what non-readers never see: the real title,
 * every tag (model guesses included), group names, grant ids, who granted and who locked an
 * account. A self-service "why can't I see this?" needs a redacted variant, not this.
 *
 * It reads in several statements, so it runs in one snapshot, like viewObjects():
 * `db.withTenant(tenant, work, VIEW_TRANSACTION)`.
 */

export interface ExplainRequest {
  userId: string;
  objectId: string;
  /** Defaults to `read`. */
  action?: Action;
  /** Defaults to OpenHoard's own web app. Pack rules can depend on the client's trust. */
  client?: AuthzClient;
}

/** A live grant that covers the action, and how the user holds it. */
export interface GrantReason {
  grantId: string;
  via: { kind: "user" } | { kind: "group"; groupId: string; name: string };
  role: "read" | "write";
  target: { tag: string } | { objectId: string };
  grantedBy: string;
  expiresAt: Date | null;
}

/** Something that stops the action, in the order the summary names them. */
export type Blocker =
  | { kind: "deleted" }
  | { kind: "locked"; by: string }
  | { kind: "provider-disabled"; by: string }
  | { kind: "retired"; by: string }
  | { kind: "forbidden"; policies: string[] }
  | { kind: "no-grant"; readable: boolean }
  | { kind: "policy-error"; reason: string };

export interface AccessExplanation {
  userId: string;
  objectId: string;
  action: Action;
  client: AuthzClient;
  /** What the product does: the policy decision, and the object not deleted. */
  allowed: boolean;
  /** authorize()'s own decision, as audit records it. */
  decision: AuthzDecision;
  /**
   * Live grants that cover this action (for `tag`, write grants only). On an allow through a
   * grant permit, these are what permitted it; on a deny, they didn't suffice.
   */
  coveringGrants: GrantReason[];
  /**
   * Live grants on tags the object carries only as unreviewed model guesses. They don't count
   * until a person reviews the tag: a model's guess never widens access.
   */
  unreviewedTagGrants: GrantReason[];
  owner: boolean;
  /** Everything that stops the action; empty for an allow. */
  blockers: Blocker[];
  user: { displayName: string; active: boolean; guest: boolean };
  object: {
    title: string;
    ownerId: string;
    zone: string;
    /** Tags grants may match. */
    grantableTags: string[];
    /** Tags only a model has proposed and nobody reviewed. */
    unreviewedTags: string[];
    deleted: boolean;
  };
  levels: LevelsExplanation;
  /** What the user gets in a listing: a card, a title-only card, or nothing. */
  view: ResultShape;
  /** Why the listing shows nothing, when it doesn't. */
  hiddenBecause: "deleted" | "not-a-member" | "unprocessed" | "hidden" | null;
  /** One to three sentences for people. */
  summary: string;
}

export class ExplainError extends Error {
  constructor(
    readonly code: "unknown-user" | "unknown-object",
    message: string,
  ) {
    super(message);
    this.name = "ExplainError";
  }
}

const FIRST_PARTY: AuthzClient = { id: "openhoard-web", trust: "first-party" };

/** Explains one decision, as of now. */
export async function explainAccess(
  tx: Tx,
  tenantId: string,
  authz: Authorizer,
  request: ExplainRequest,
): Promise<AccessExplanation> {
  await requireSnapshot(tx, "explainAccess");
  const action = request.action ?? "read";
  const client = request.client ?? FIRST_PARTY;
  const [object] = await tx
    .select({
      title: objects.title,
      ownerId: objects.ownerId,
      deletedAt: objects.deletedAt,
      zone: zones.kind,
    })
    .from(objects)
    .innerJoin(zones, and(eq(zones.tenantId, objects.tenantId), eq(zones.id, objects.zoneId)))
    .where(and(eq(objects.tenantId, tenantId), eq(objects.id, request.objectId)));
  if (!object) throw new ExplainError("unknown-object", `no object ${request.objectId}`);
  // One clock for everything time-based (grant expiry), as the snapshot is one for the data.
  const now = new Date();
  const user = await getUser(tx, tenantId, request.userId);
  const principal = await resolvePrincipal(tx, tenantId, request.userId, now);
  if (!user || !principal) throw new ExplainError("unknown-user", `no user ${request.userId}`);
  const levels = await explainLevels(tx, tenantId, request.objectId);
  if (!levels) throw new ExplainError("unknown-object", `no levels for ${request.objectId}`);

  // The same split authorize()'s callers make: grants match only trusted or reviewed tags.
  const tags = await tagsForDecisions(tx, tenantId, request.objectId);
  const grantable = new Set(tags.grantable);
  const unreviewed = new Set(tags.levels.filter((t) => !grantable.has(t)));

  const resource = {
    id: request.objectId,
    ownerId: object.ownerId,
    tags: [...grantable].sort(),
    zone: object.zone,
  };
  const decision = authz.authorize({ principal, action, resource, client });
  const read =
    action === "read" ? decision : authz.authorize({ principal, action: "read", resource, client });
  const deleted = object.deletedAt !== null;

  const groupNames = new Map(
    (await groupsOf(tx, tenantId, request.userId)).map((g) => [g.id, g.name]),
  );
  const held = await liveGrants(
    tx,
    tenantId,
    [userPrincipal(request.userId), ...principal.groupIds.map(groupPrincipal)],
    now,
  );
  const counts = (g: LiveGrant) => action !== "tag" || g.role === "write";
  const covers = (g: LiveGrant, onTags: Set<string>) =>
    (g.objectId !== null && g.objectId === request.objectId) ||
    (g.tag !== null && onTags.has(g.tag));
  const reasonFor = (g: LiveGrant): GrantReason => {
    const groupId = g.principal.startsWith("group:") ? g.principal.slice("group:".length) : null;
    return {
      grantId: g.id,
      via:
        groupId === null
          ? { kind: "user" }
          : { kind: "group", groupId, name: groupNames.get(groupId) ?? groupId },
      role: g.role,
      target: g.objectId !== null ? { objectId: g.objectId } : { tag: g.tag as string },
      grantedBy: g.grantedBy,
      expiresAt: g.expiresAt,
    };
  };
  const coveringGrants = held.filter((g) => counts(g) && covers(g, grantable)).map(reasonFor);
  const unreviewedTagGrants = held
    .filter((g) => counts(g) && g.objectId === null && covers(g, unreviewed))
    .map(reasonFor);
  const owner = object.ownerId === userPrincipal(request.userId);

  const allowed = decision.allow && !deleted;
  const blockers = allowed
    ? []
    : blockersOf({
        decision,
        deleted,
        user,
        owner,
        coveringGrants,
        readable: read.allow && action === "tag",
      });

  const member = principal.active && !principal.guest;
  let view: ResultShape;
  let hiddenBecause: AccessExplanation["hiddenBecause"] = null;
  if (deleted) {
    view = "none";
    hiddenBecause = "deleted";
  } else if (!read.allow && !member) {
    view = "none";
    hiddenBecause = "not-a-member";
  } else {
    view = decideRead({
      canRead: read.allow,
      visibility: levels.visibility,
      exposure: levels.exposure,
      wantsContent: false,
    }).shape;
    if (view === "none") hiddenBecause = levels.processed ? "hidden" : "unprocessed";
  }

  const explanation: AccessExplanation = {
    userId: request.userId,
    objectId: request.objectId,
    action,
    client,
    allowed,
    decision,
    coveringGrants,
    unreviewedTagGrants,
    owner,
    blockers,
    user: { displayName: user.displayName, active: user.active, guest: user.kind === "guest" },
    object: {
      title: object.title,
      ownerId: object.ownerId,
      zone: object.zone,
      grantableTags: [...grantable].sort(),
      unreviewedTags: [...unreviewed].sort(),
      deleted,
    },
    levels,
    view,
    hiddenBecause,
    summary: "",
  };
  explanation.summary = summarize(explanation, read.allow);
  return explanation;
}

/** Every blocker, most fundamental first; lifting one alone may not be enough. */
function blockersOf(input: {
  decision: AuthzDecision;
  deleted: boolean;
  user: User;
  owner: boolean;
  coveringGrants: GrantReason[];
  readable: boolean;
}): Blocker[] {
  const { decision, user } = input;
  const out: Blocker[] = [];
  if (input.deleted) out.push({ kind: "deleted" });
  if (user.retired) out.push({ kind: "retired", by: user.retired.by });
  if (user.lock) out.push({ kind: "locked", by: user.lock.by });
  if (user.providerDisabled) out.push({ kind: "provider-disabled", by: user.providerDisabled.by });
  if (decision.kind === "forbid") {
    const forbids = decision.policies.filter((p) => p !== "core/inactive");
    if (forbids.length) out.push({ kind: "forbidden", policies: [...forbids] });
  } else if (decision.kind === "error") {
    // An engine error or a malformed request: a deny that says nothing about grants.
    out.push({ kind: "policy-error", reason: decision.reason });
  }
  // A missing grant blocks only when the policies denied (a pack may permit without one).
  if (!decision.allow && input.coveringGrants.length === 0 && !input.owner) {
    out.push({ kind: "no-grant", readable: input.readable });
  }
  return out;
}

const VERB: Record<Action, string> = { search: "find", read: "read", open: "open", tag: "tag" };

function describeGrant(g: GrantReason): string {
  const whose = g.via.kind === "user" ? "their own" : `group ${g.via.name}'s`;
  const on = "tag" in g.target ? `on ${g.target.tag}` : "on this file";
  const until = g.expiresAt ? `, until ${g.expiresAt.toISOString().slice(0, 10)}` : "";
  return `${whose} ${g.role} grant ${on}${until}`;
}

function describeBlocker(b: Blocker, action: Action): string {
  switch (b.kind) {
    case "deleted":
      return "the file is deleted";
    case "retired":
      return `their account was retired by ${b.by}`;
    case "locked":
      return `their account is locked by ${b.by}`;
    case "provider-disabled":
      return "their identity provider deactivated them";
    case "forbidden":
      return `forbidden by ${b.policies.join(", ")}`;
    case "policy-error":
      return `the policy engine couldn't decide (${b.reason})`;
    case "no-grant":
      return action === "tag"
        ? `no write grant covers it${b.readable ? " (they can read it)" : ""}`
        : "no grant covers it";
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function summarize(e: AccessExplanation, canRead: boolean): string {
  const who = e.user.displayName;
  const what = `"${e.object.title}"`;
  const verb = VERB[e.action];
  const parts: string[] = [];
  if (e.allowed) {
    const why: string[] = [];
    if (e.owner) why.push("they own it");
    const [first, ...rest] = e.coveringGrants;
    if (first && e.decision.policies.some((p) => p.endsWith("-grant"))) {
      why.push(
        `through ${describeGrant(first)}` + (rest.length ? ` (and ${rest.length} more)` : ""),
      );
    }
    parts.push(
      `${who} can ${verb} ${what}` +
        (why.length ? `: ${why.join(", and ")}.` : ` (${e.decision.reason}).`),
    );
    return parts.join(" ");
  }
  const reasons = e.blockers.map((b) => describeBlocker(b, e.action));
  parts.push(
    `${who} can't ${verb} ${what}: ${reasons[0] ?? e.decision.reason}` +
      (reasons.length > 1 ? `; also ${reasons.slice(1).join("; ")}` : "") +
      ".",
  );
  // A pending model tag is worth mentioning only when a missing grant is all that stands in
  // the way.
  const [pending] = e.unreviewedTagGrants;
  if (
    pending &&
    "tag" in pending.target &&
    e.blockers.length === 1 &&
    e.blockers[0]?.kind === "no-grant"
  ) {
    parts.push(
      capitalize(
        `${describeGrant(pending)} would, once a person reviews the model's ${pending.target.tag} tag.`,
      ),
    );
  }
  if (!canRead) {
    if (e.view === "title-only") parts.push(`They see its title card (${e.levels.visibility}).`);
    else if (e.view === "card") parts.push("They see its card, not its content.");
    else if (e.hiddenBecause === "not-a-member") {
      parts.push("It is hidden from them: only active members discover files.");
    } else if (e.hiddenBecause === "unprocessed") {
      parts.push("It is hidden until processing finishes.");
    } else if (e.hiddenBecause === "hidden") parts.push("It is hidden from them.");
  }
  return parts.join(" ");
}
