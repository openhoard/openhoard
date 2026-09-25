import type { Tx } from "@openhoard/core-db";
import {
  addMember,
  createGroup,
  deleteGroup,
  getGroup,
  IdentityError,
  listGroups,
  membersOf,
  removeMember,
  updateGroup,
  type Group,
  type GroupQuery,
  type User,
} from "@openhoard/core-identity";
import {
  invalidFilter,
  invalidPath,
  invalidValue,
  notFound,
  ScimError,
  uniqueness,
} from "./errors.js";
import {
  eqConjunction,
  GROUP_SCHEMA,
  parsePath,
  pathName,
  type AttrPath,
  type Filter,
} from "./filter.js";
import { field, isObject, requireSchema, text, type Json } from "./json.js";
import { identityError, type Page } from "./shared.js";
import type { PatchOpName } from "./users.js";

/*
 * SCIM Groups (RFC 7643 section 4.2) over the directory. A SCIM group is an OpenHoard group of
 * source `scim`; its `id` is the OpenHoard id (`grp_…`), its `displayName` the group's name.
 *
 * - Members are users, by their SCIM id (`usr_…`). Membership in OpenHoard is direct, so a group
 *   as a member (a nested group) is refused (400): counting it would need nested resolution
 *   that doesn't exist yet, and ignoring it would silently leave people out. Entra doesn't
 *   provision nested groups anyway.
 * - A service account can't be added (the directory refuses: what a machine holds is decided in
 *   OpenHoard), nor a retired or unknown user.
 * - displayName is unique among SCIM groups, compared exactly: Entra matches groups by it.
 * - At most {@link MAX_MEMBER_CHANGES} member values per request; a group is returned with at
 *   most {@link MAX_MEMBERS_RETURNED} members (ask with `excludedAttributes=members`, as Entra
 *   does, for bigger ones).
 */

/** Most member values one request may name (a PATCH's operations together, a POST, a PUT). */
export const MAX_MEMBER_CHANGES = 1000;
/** Most members returned with groups in one response. */
export const MAX_MEMBERS_RETURNED = 10_000;

const USER_ID = /^usr_[0-9a-hjkmnp-tv-z]{26}$/;
const GROUP_ID = /^grp_[0-9a-hjkmnp-tv-z]{26}$/;

/** The SCIM resource for a group; `members` when they were asked for. */
export function groupResource(g: Group, base: string, members?: User[]): Json {
  return {
    schemas: [GROUP_SCHEMA],
    id: g.id,
    ...(g.externalId === null ? {} : { externalId: g.externalId }),
    displayName: g.name,
    ...(members === undefined
      ? {}
      : {
          members: members.map((m) => ({
            value: m.id,
            display: m.displayName,
            type: "User",
            $ref: `${base}/Users/${m.id}`,
          })),
        }),
    meta: {
      resourceType: "Group",
      created: g.createdAt.toISOString(),
      location: `${base}/Groups/${g.id}`,
    },
  };
}

/** A group's members, up to `budget.left` (shared by a list's groups), or tooMany (400). */
export async function loadMembers(
  tx: Tx,
  tenantId: string,
  groupId: string,
  budget: { left: number },
): Promise<User[]> {
  const out: User[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await membersOf(tx, tenantId, groupId, {
      limit: 5000,
      ...(after === undefined ? {} : { after }),
    });
    out.push(...page);
    if (out.length > budget.left) {
      throw new ScimError(
        400,
        `more than ${MAX_MEMBERS_RETURNED} members to return: ask with excludedAttributes=members`,
        "tooMany",
      );
    }
    if (page.length < 5000) break;
    after = page[page.length - 1]?.id;
  }
  budget.left -= out.length;
  return out;
}

/** The current SCIM group with this id, or a 404. */
export async function scimGroup(tx: Tx, tenantId: string, id: string): Promise<Group> {
  const g = GROUP_ID.test(id) ? await getGroup(tx, tenantId, id) : null;
  if (!g || g.source !== "scim") throw notFound("group");
  return g;
}

/** What a request does to a group's members, in the order its operations came. */
export class MemberPlan {
  /** Set by a replace (or remove of all): the members the group ends with, before adds. */
  replaceWith: Set<string> | null = null;
  readonly adds = new Set<string>();
  readonly removes = new Set<string>();
  #named = 0;

  #count(n: number) {
    this.#named += n;
    if (this.#named > MAX_MEMBER_CHANGES) {
      throw invalidValue(`at most ${MAX_MEMBER_CHANGES} member values per request`);
    }
  }

  replace(ids: string[]) {
    this.#count(ids.length);
    this.replaceWith = new Set(ids);
    this.adds.clear();
    this.removes.clear();
  }

  add(ids: string[]) {
    this.#count(ids.length);
    for (const id of ids) {
      if (this.replaceWith) this.replaceWith.add(id);
      else {
        this.adds.add(id);
        this.removes.delete(id);
      }
    }
  }

  remove(ids: string[]) {
    this.#count(ids.length);
    for (const id of ids) {
      if (this.replaceWith) this.replaceWith.delete(id);
      else {
        this.removes.add(id);
        this.adds.delete(id);
      }
    }
  }

  removeAll() {
    this.replace([]);
  }

  get empty(): boolean {
    return this.replaceWith === null && this.adds.size === 0 && this.removes.size === 0;
  }
}

/** The user ids in a members value: a list of `{"value": "usr_…"}` (or one such object). */
function memberIds(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.map((m) => {
    if (!isObject(m)) throw invalidValue('members must be a list of {"value": "<user id>"}');
    const id = text(field(m, "value"), "members.value");
    if (id === null) throw invalidValue('members must be a list of {"value": "<user id>"}');
    return id;
  });
}

/** The ids a `members[value eq "…"]` path names (several joined by or). */
function filteredIds(filter: Filter): string[] {
  if (filter.kind === "or") return [...filteredIds(filter.left), ...filteredIds(filter.right)];
  const eqs = eqConjunction(filter);
  const only = eqs?.length === 1 ? eqs[0] : undefined;
  if (
    only?.path.attr !== "value" ||
    only.path.sub !== undefined ||
    typeof only.value !== "string"
  ) {
    throw invalidFilter('members can be filtered by value eq "<user id>" only');
  }
  return [only.value];
}

/** Applies the plan to the group's members. */
export async function applyMembers(tx: Tx, tenantId: string, groupId: string, plan: MemberPlan) {
  let adds = [...plan.adds];
  let removes = [...plan.removes];
  if (plan.replaceWith !== null) {
    const current = new Set<string>();
    let after: string | undefined;
    for (;;) {
      const page = await membersOf(tx, tenantId, groupId, {
        limit: 5000,
        ...(after === undefined ? {} : { after }),
      });
      for (const u of page) current.add(u.id);
      if (page.length < 5000) break;
      after = page[page.length - 1]?.id;
    }
    const target = plan.replaceWith;
    removes = [...current].filter((id) => !target.has(id));
    adds = [...target].filter((id) => !current.has(id));
  }
  for (const id of removes) {
    // Anything that isn't a user id was never a member: nothing to remove.
    if (USER_ID.test(id)) await removeMember(tx, tenantId, groupId, id, "scim");
  }
  for (const id of adds) {
    if (GROUP_ID.test(id)) {
      throw invalidValue(
        `${id} is a group: nested groups aren't supported, a group's members are users`,
      );
    }
    if (!USER_ID.test(id)) throw invalidValue(`not a user id: ${id.slice(0, 64)}`);
    try {
      await addMember(tx, tenantId, groupId, id, "scim");
    } catch (e) {
      if (!(e instanceof IdentityError)) throw e;
      if (e.code === "invalid") throw invalidValue(e.message);
      throw invalidValue(`no current user ${id}`);
    }
  }
}

/** Refuses a displayName another SCIM group has. */
async function checkUniqueName(tx: Tx, tenantId: string, name: string, self?: string) {
  const { groups } = await listGroups(tx, tenantId, { source: "scim", name }, { limit: 2 });
  if (groups.some((g) => g.id !== self)) uniquenessThrow();
}
const uniquenessThrow = (): never => {
  throw uniqueness("a group with that displayName or externalId exists");
};

function nameOf(v: unknown): string {
  const name = text(v, "displayName");
  if (name === null || name.trim() === "") throw invalidValue("displayName is required");
  // As the directory keeps it, so the uniqueness check compares what is stored.
  return name.trim();
}

/** Creates a SCIM group from a POST body, with its members. */
export async function createScimGroup(tx: Tx, tenantId: string, body: Json): Promise<Group> {
  requireSchema(body, GROUP_SCHEMA);
  const name = nameOf(field(body, "displayName"));
  const externalId = text(field(body, "externalId"), "externalId");
  const plan = new MemberPlan();
  const members = field(body, "members");
  if (members !== undefined && members !== null) plan.add(memberIds(members));
  await checkUniqueName(tx, tenantId, name);
  let g: Group;
  try {
    g = await createGroup(tx, tenantId, {
      name,
      source: "scim",
      ...(externalId === null ? {} : { externalId }),
    });
  } catch (e) {
    throw identityError(e, "a group with that displayName or externalId exists");
  }
  await applyMembers(tx, tenantId, g.id, plan);
  return g;
}

/** Replaces a SCIM group (PUT): name, externalId and members as given; absent ones go. */
export async function replaceScimGroup(tx: Tx, tenantId: string, id: string, body: Json) {
  requireSchema(body, GROUP_SCHEMA);
  const g = await scimGroup(tx, tenantId, id);
  const name = nameOf(field(body, "displayName"));
  const externalId = text(field(body, "externalId"), "externalId");
  const plan = new MemberPlan();
  const members = field(body, "members");
  plan.replace(members === undefined || members === null ? [] : memberIds(members));
  return save(tx, tenantId, g, { name, externalId }, plan);
}

/** Applies PATCH operations to a SCIM group. */
export async function patchScimGroup(
  tx: Tx,
  tenantId: string,
  id: string,
  ops: { op: PatchOpName; path: AttrPath | undefined; value: unknown }[],
): Promise<Group> {
  const g = await scimGroup(tx, tenantId, id);
  const next: { name: string; externalId: string | null } = {
    name: g.name,
    externalId: g.externalId,
  };
  const plan = new MemberPlan();
  const apply = (op: PatchOpName, path: AttrPath | undefined, value: unknown) => {
    if (path === undefined) {
      if (op === "remove") throw new ScimError(400, "remove needs a path", "noTarget");
      if (!isObject(value)) throw invalidValue("an operation without a path needs an object value");
      for (const [key, v] of Object.entries(value)) {
        if (/^urn:/i.test(key) && !/^urn:ietf:params:scim:schemas:core:2\.0:group:/i.test(key)) {
          continue;
        }
        apply(op, parsePath(key), v);
      }
      return;
    }
    if (path.schema !== undefined) return; // another schema's attribute: not kept
    const clear = op === "remove" || value === null;
    switch (path.attr) {
      case "displayname":
        if (clear) throw invalidValue("displayName is required");
        next.name = nameOf(value);
        return;
      case "externalid":
        next.externalId = clear ? null : text(value, "externalId");
        return;
      case "members":
        if (path.sub !== undefined) throw invalidPath(`can't change ${pathName(path)}`);
        if (path.filter !== undefined) {
          if (op !== "remove") throw invalidPath(`${op} members[…] isn't supported: use members`);
          plan.remove(filteredIds(path.filter));
          return;
        }
        if (op === "remove") {
          if (value === undefined || value === null) plan.removeAll();
          else plan.remove(memberIds(value));
          return;
        }
        if (op === "replace") plan.replace(value === null ? [] : memberIds(value));
        else plan.add(memberIds(value));
        return;
      case "id":
        // Repeating the group's own id is harmless (Okta's value objects include it).
        if (op !== "remove" && value === g.id) return;
        throw new ScimError(400, "id can't be changed", "mutability");
      case "meta":
        throw new ScimError(400, "meta can't be changed", "mutability");
      default:
        return; // attributes OpenHoard doesn't keep
    }
  };
  for (const { op, path, value } of ops) apply(op, path, value);
  return save(tx, tenantId, g, next, plan);
}

async function save(
  tx: Tx,
  tenantId: string,
  g: Group,
  next: { name: string; externalId: string | null },
  plan: MemberPlan,
): Promise<Group> {
  if (next.name !== g.name) await checkUniqueName(tx, tenantId, next.name, g.id);
  let saved: Group;
  try {
    saved = await updateGroup(
      tx,
      tenantId,
      g.id,
      {
        ...(next.name === g.name ? {} : { name: next.name }),
        ...(next.externalId === g.externalId ? {} : { externalId: next.externalId }),
      },
      "scim",
    );
  } catch (e) {
    throw identityError(e, "a group with that displayName or externalId exists");
  }
  if (!plan.empty) await applyMembers(tx, tenantId, g.id, plan);
  return saved;
}

/** Deletes a SCIM group: its memberships go and its grants are revoked (deleteGroup). */
export async function deleteScimGroup(tx: Tx, tenantId: string, id: string, actor: string) {
  const g = await scimGroup(tx, tenantId, id);
  await deleteGroup(tx, tenantId, g.id, "scim", actor);
}

/** A page of SCIM groups matching `filter` (eq on displayName, externalId or id, joined by and). */
export async function listScimGroups(
  tx: Tx,
  tenantId: string,
  filter: Filter | undefined,
  page: Page,
): Promise<{ total: number; groups: Group[] }> {
  const query: GroupQuery = { source: "scim" };
  const put = (key: keyof Omit<GroupQuery, "source">, value: string) => {
    if (query[key] !== undefined && query[key] !== value) return false;
    query[key] = value;
    return true;
  };
  const refuse = (path: AttrPath) =>
    invalidFilter(
      `can't filter groups by ${pathName(path)}: displayName, externalId, id and members only`,
    );
  for (const term of filter === undefined ? [] : andTerms(filter)) {
    let ok: boolean;
    if (term.kind === "has") {
      // members[value eq "usr_…"]: the groups that user is in.
      if (term.path.attr !== "members" || term.path.schema !== undefined) throw refuse(term.path);
      const [id, ...more] = filteredIds(term.path.filter);
      if (id === undefined || more.length > 0) throw refuse(term.path);
      ok = put("memberId", id);
    } else if (term.kind === "compare" && term.op === "eq") {
      const { path, value } = term;
      const members =
        path.attr === "members" && path.filter === undefined && (path.sub ?? "value") === "value";
      const key =
        path.schema !== undefined || path.filter !== undefined
          ? undefined
          : members
            ? ("memberId" as const)
            : path.sub !== undefined
              ? undefined
              : GROUP_FILTERS.get(path.attr);
      if (key === undefined) throw refuse(path);
      if (typeof value !== "string") {
        throw invalidFilter(`${pathName(path)} is compared with a string`);
      }
      ok = put(key, value);
    } else {
      throw invalidFilter("groups can be filtered with eq, joined by and, only");
    }
    if (!ok) return { total: 0, groups: [] };
  }
  return listGroups(tx, tenantId, query, page);
}

/** Group attributes a filter may compare, by lower-cased name (a Map: no inherited keys). */
const GROUP_FILTERS = new Map<string, "name" | "externalId" | "id">([
  ["displayname", "name"],
  ["externalid", "externalId"],
  ["id", "id"],
]);

/** The terms of a filter joined by `and`. */
function andTerms(filter: Filter): Filter[] {
  return filter.kind === "and" ? [...andTerms(filter.left), ...andTerms(filter.right)] : [filter];
}
