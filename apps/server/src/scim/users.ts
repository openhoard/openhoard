import type { Tx } from "@openhoard/core-db";
import {
  createUser,
  emailKey,
  getUser,
  listUsers,
  retireUser,
  setProviderActive,
  updateUser,
  userNameKey,
  type EndedAccess,
  type StopOptions,
  type User,
  type UserChanges,
  type UserQuery,
} from "@openhoard/core-identity";
import { invalidFilter, invalidPath, invalidValue, notFound, ScimError } from "./errors.js";
import {
  eqConjunction,
  parsePath,
  pathName,
  USER_SCHEMA,
  type AttrPath,
  type Filter,
  type FilterValue,
} from "./filter.js";
import { bool, field, isObject, requireSchema, text, type Json } from "./json.js";
import { identityError, type Page } from "./shared.js";

/*
 * SCIM Users (RFC 7643 section 4.1) over the directory (core/identity). A SCIM user is an
 * OpenHoard user of source `scim`; its SCIM `id` is the OpenHoard id (`usr_…`). Local users,
 * service accounts and retired users don't exist here (404): SCIM manages its own, and never
 * adopts a local user (a clash on email is a 409 until an admin adopts them, out of scope).
 *
 * What OpenHoard keeps of a SCIM user, and how it maps:
 *
 * | SCIM                               | OpenHoard                                              |
 * | ---------------------------------- | ------------------------------------------------------ |
 * | userName (required)                | userName, unique regardless of case                    |
 * | externalId                         | externalId: map Entra's objectId, for sign-in (T-102)  |
 * | emails (primary, else type work)   | email; without one, userName if it is an address       |
 * | displayName                        | displayName; else name.formatted, else given + family  |
 * |                                    | name, else userName                                    |
 * | name.givenName, name.familyName    | givenName, familyName                                  |
 * | active                             | the provider disable (false ends their sessions)       |
 * | userType ("Member" or "Guest")     | kind: a guest never discovers files                    |
 *
 * Anything else (phone numbers, addresses, title, the enterprise extension, a password) is
 * accepted and dropped: OpenHoard keeps no more about people than it needs.
 *
 * `active` reports the identity provider's own switch only. An admin's lock is OpenHoard's
 * (core/identity), isn't reported, and isn't lifted by the provider setting active to true.
 * DELETE retires the user for good (retireUser: final, frees the email and userName; a new POST
 * then makes a new user with a new id).
 */

/** A user as SCIM sees it while a request changes it. */
export interface UserState {
  /** The user's own id, when changing one: a value object may repeat it (Okta does). */
  id?: string;
  userName: string | null;
  externalId: string | null;
  /** Given explicitly; when null, derived (see derive()). */
  displayName: string | null;
  givenName: string | null;
  familyName: string | null;
  /** name.formatted: not kept, only used to derive displayName. */
  formatted: string | null;
  /** Given explicitly (emails); when null, userName is used if it is an address. */
  email: string | null;
  active: boolean;
  guest: boolean;
}

const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+$/u.test(v) && emailKey(v) !== "";
const joinName = (given: string | null, family: string | null) =>
  [given, family].filter((p): p is string => p !== null && p.trim() !== "").join(" ") || null;

/** A stored user as state. An email that is just the userName counts as derived from it. */
export function stateOf(u: User): UserState {
  const derivedEmail =
    u.userName !== null && u.email !== null && emailKey(u.email) === emailKey(u.userName);
  return {
    id: u.id,
    userName: u.userName,
    externalId: u.externalId,
    displayName: u.displayName,
    givenName: u.givenName,
    familyName: u.familyName,
    formatted: null,
    email: derivedEmail ? null : u.email,
    active: u.providerDisabled === null,
    guest: u.kind === "guest",
  };
}

/** What state becomes in the directory. */
export interface Derived {
  userName: string;
  email: string;
  displayName: string;
  externalId: string | null;
  givenName: string | null;
  familyName: string | null;
  kind: "member" | "guest";
  active: boolean;
}

export function derive(s: UserState): Derived {
  if (s.userName === null || s.userName.trim() === "") {
    throw invalidValue("userName is required");
  }
  const email = s.email ?? (looksLikeEmail(s.userName) ? s.userName : null);
  if (email === null) {
    throw invalidValue(
      'a user needs an email: send emails (primary, or type "work"), or an email address as userName',
    );
  }
  return {
    userName: s.userName,
    email,
    displayName: s.displayName ?? s.formatted ?? joinName(s.givenName, s.familyName) ?? s.userName,
    externalId: s.externalId,
    givenName: s.givenName,
    familyName: s.familyName,
    kind: s.guest ? "guest" : "member",
    active: s.active,
  };
}

/** The email a SCIM `emails` value names: the primary one, else the "work" one, else none. */
function pickEmail(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const list = Array.isArray(v) ? v : [v];
  const entries = list.map((e) => {
    if (!isObject(e)) throw invalidValue("emails must be a list of objects");
    const primary = field(e, "primary");
    return {
      value: text(field(e, "value"), "emails.value"),
      type: text(field(e, "type"), "emails.type"),
      primary: primary === undefined || primary === null ? false : bool(primary, "emails.primary"),
    };
  });
  const chosen =
    entries.find((e) => e.primary && e.value !== null) ??
    entries.find((e) => e.type?.toLowerCase() === "work" && e.value !== null);
  return chosen?.value ?? null;
}

function userType(v: unknown): boolean {
  const t = text(v, "userType");
  if (t === null) return false;
  if (/^member$/i.test(t)) return false;
  if (/^guest$/i.test(t)) return true;
  throw invalidValue('userType must be "Member" or "Guest"');
}

/**
 * State from a POST or PUT body. `active` and `userType` default to `current` when absent (a PUT
 * never re-enables anyone, or makes a guest a member, by leaving something out); a POST passes
 * active and a member.
 */
export function stateFromBody(body: Json, current: { active: boolean; guest: boolean }): UserState {
  requireSchema(body, USER_SCHEMA);
  const name = field(body, "name");
  if (name !== undefined && name !== null && !isObject(name)) {
    throw invalidValue("name must be an object");
  }
  const part = (sub: string) => (isObject(name) ? text(field(name, sub), `name.${sub}`) : null);
  const active = field(body, "active");
  const kind = field(body, "userType");
  return {
    userName: text(field(body, "userName"), "userName"),
    externalId: text(field(body, "externalId"), "externalId"),
    displayName: text(field(body, "displayName"), "displayName"),
    givenName: part("givenName"),
    familyName: part("familyName"),
    formatted: part("formatted"),
    email: pickEmail(field(body, "emails")),
    active: active === undefined || active === null ? current.active : bool(active, "active"),
    guest: kind === undefined || kind === null ? current.guest : userType(kind),
  };
}

export type PatchOpName = "add" | "replace" | "remove";

/** Whether a value filter on `emails` picks the one email kept: type "work", or primary. */
function picksKeptEmail(filter: Filter): boolean {
  const eqs = eqConjunction(filter);
  if (eqs === null || eqs.length !== 1) {
    throw invalidFilter('emails can be filtered by type eq "work" or primary eq true only');
  }
  const [{ path, value }] = eqs as [{ path: AttrPath; value: FilterValue }];
  if (path.attr === "type" && typeof value === "string") return value.toLowerCase() === "work";
  if (path.attr === "primary" && typeof value === "boolean") return value;
  throw invalidFilter('emails can be filtered by type eq "work" or primary eq true only');
}

/**
 * Applies one PATCH operation to `s` (RFC 7644 section 3.5.2), as Entra sends them: op names in
 * any case, `active` as a string, `emails[type eq "work"].value`, `name.givenName`, and a value
 * object without a path whose keys may themselves be paths ("name.givenName").
 */
export function patchUser(
  s: UserState,
  op: PatchOpName,
  path: AttrPath | undefined,
  value: unknown,
) {
  if (path === undefined) {
    if (op === "remove") throw new ScimError(400, "remove needs a path", "noTarget");
    if (!isObject(value)) throw invalidValue("an operation without a path needs an object value");
    for (const [key, v] of Object.entries(value)) {
      // The enterprise extension and other schemas' objects: not kept.
      if (/^urn:/i.test(key) && !/^urn:ietf:params:scim:schemas:core:2\.0:user:/i.test(key)) {
        continue;
      }
      patchUser(s, op, parsePath(key), v);
    }
    return;
  }
  // Another schema's attribute (the enterprise extension): accepted, not kept.
  if (path.schema !== undefined) return;
  const clear = op === "remove" || value === null;
  const str = (name: string) => (clear ? null : text(value, name));
  switch (path.attr) {
    case "username": {
      const v = str("userName");
      if (v === null) throw invalidValue("userName is required");
      s.userName = v;
      return;
    }
    case "externalid":
      s.externalId = str("externalId");
      return;
    case "displayname":
      s.displayName = str("displayName");
      return;
    case "active":
      if (clear) throw invalidValue("active can't be removed");
      s.active = bool(value, "active");
      return;
    case "usertype":
      // Removing userType keeps the kind: making a guest a member by omission would loosen what
      // they see. The provider changes it by sending "Member".
      if (!clear) s.guest = userType(value);
      return;
    case "name":
      patchName(s, op, path, value);
      return;
    case "emails":
      patchEmails(s, op, path, value);
      return;
    case "id":
      // Repeating the user's own id is harmless (Okta's value objects include it).
      if (op !== "remove" && s.id !== undefined && value === s.id) return;
      throw new ScimError(400, "id can't be changed", "mutability");
    case "meta":
    case "groups":
      throw new ScimError(400, `${path.attr} can't be changed`, "mutability");
    default:
      // Attributes OpenHoard doesn't keep (phoneNumbers, addresses, title, roles, …).
      return;
  }
}

function patchName(s: UserState, op: PatchOpName, path: AttrPath, value: unknown) {
  if (path.filter !== undefined) throw invalidPath("name is not multi-valued");
  const clear = op === "remove" || value === null;
  const set = (sub: string, v: unknown) => {
    const t = clear || v === null ? null : text(v, `name.${sub}`);
    if (sub === "givenname") s.givenName = t;
    else if (sub === "familyname") s.familyName = t;
    else if (sub === "formatted") s.formatted = t;
    // middleName, honorificPrefix, …: not kept.
  };
  if (path.sub !== undefined) return set(path.sub, value);
  if (clear) {
    s.givenName = null;
    s.familyName = null;
    s.formatted = null;
    return;
  }
  if (!isObject(value)) throw invalidValue("name must be an object");
  // A complex attribute's sub-attributes replace or add; those not given stay (RFC 7644 3.5.2.3).
  for (const [k, v] of Object.entries(value)) set(k.toLowerCase(), v);
}

function patchEmails(s: UserState, op: PatchOpName, path: AttrPath, value: unknown) {
  const clear = op === "remove" || value === null;
  if (path.filter !== undefined) {
    // emails[type eq "work"]…: only the kept email is kept; an operation on another is dropped.
    if (!picksKeptEmail(path.filter)) return;
    if (path.sub !== undefined && path.sub !== "value") return;
    if (clear) {
      s.email = null;
      return;
    }
    // emails[type eq "work"].value is the address; emails[type eq "work"] the whole entry.
    s.email =
      path.sub === "value" || !isObject(value)
        ? text(value, "emails.value")
        : text(field(value, "value"), "emails.value");
    return;
  }
  if (path.sub !== undefined) {
    if (path.sub !== "value") return;
    s.email = clear ? null : text(value, "emails.value");
    return;
  }
  if (clear) {
    s.email = null;
    return;
  }
  const picked = pickEmail(value);
  // add keeps the current email when the new ones name none to keep; replace takes their word.
  if (picked !== null || op === "replace") s.email = picked;
}

/** The SCIM resource for a user. */
export function userResource(u: User, base: string): Json {
  const formatted = joinName(u.givenName, u.familyName);
  const name = {
    ...(u.givenName === null ? {} : { givenName: u.givenName }),
    ...(u.familyName === null ? {} : { familyName: u.familyName }),
    ...(formatted === null ? {} : { formatted }),
  };
  return {
    schemas: [USER_SCHEMA],
    id: u.id,
    ...(u.externalId === null ? {} : { externalId: u.externalId }),
    userName: u.userName ?? u.email,
    ...(Object.keys(name).length === 0 ? {} : { name }),
    displayName: u.displayName,
    emails: u.email === null ? [] : [{ value: u.email, type: "work", primary: true }],
    userType: u.kind === "guest" ? "Guest" : "Member",
    active: u.providerDisabled === null,
    meta: {
      resourceType: "User",
      created: u.createdAt.toISOString(),
      location: `${base}/Users/${u.id}`,
    },
  };
}

/** The current SCIM user with this id, or a 404. */
export async function scimUser(tx: Tx, tenantId: string, id: string): Promise<User> {
  const u = /^usr_[0-9a-hjkmnp-tv-z]{26}$/.test(id) ? await getUser(tx, tenantId, id) : null;
  if (!u || u.source !== "scim" || u.retired !== null) throw notFound("user");
  return u;
}

/** Creates a SCIM user from a POST body. */
export async function createScimUser(tx: Tx, tenantId: string, body: Json, actor: string) {
  const d = derive(stateFromBody(body, { active: true, guest: false }));
  let u: User;
  try {
    u = await createUser(tx, tenantId, {
      email: d.email,
      displayName: d.displayName,
      kind: d.kind,
      source: "scim",
      userName: d.userName,
      ...(d.externalId === null ? {} : { externalId: d.externalId }),
      ...(d.givenName === null ? {} : { givenName: d.givenName }),
      ...(d.familyName === null ? {} : { familyName: d.familyName }),
    });
  } catch (e) {
    throw identityError(e, "a user with that userName, externalId or email exists");
  }
  if (!d.active) {
    await setProviderActive(tx, tenantId, u.id, false, actor);
    u = (await getUser(tx, tenantId, u.id)) as User;
  }
  return u;
}

/**
 * What a deactivation or deletion ended, for the request's audit record (T-104): the provider
 * cut someone off, and the record says what went with it.
 */
export function endedDetail(
  how: "deactivated" | "retired",
  ended: EndedAccess,
): Record<string, number | boolean> {
  return {
    [how]: true,
    sessionsEnded: ended.sessions,
    oauthGrantsRevoked: ended.oauthGrants,
    oauthCodesUsedUp: ended.oauthCodes,
  };
}

/**
 * Writes `next` over the user `current`: only what changed. `options.onEnded` hears what a
 * deactivation ended (sessions, OAuth grants and codes).
 */
export async function saveUser(
  tx: Tx,
  tenantId: string,
  current: User,
  next: UserState,
  actor: string,
  options: StopOptions = {},
): Promise<User> {
  const d = derive(next);
  const changes: UserChanges = {};
  if (d.email !== current.email) changes.email = d.email;
  if (d.displayName !== current.displayName) changes.displayName = d.displayName;
  if (d.userName !== current.userName) changes.userName = d.userName;
  if (d.externalId !== current.externalId) changes.externalId = d.externalId;
  if (d.givenName !== current.givenName) changes.givenName = d.givenName;
  if (d.familyName !== current.familyName) changes.familyName = d.familyName;
  if (d.kind !== current.kind) changes.kind = d.kind;
  try {
    await updateUser(tx, tenantId, current.id, changes, "scim");
    await setProviderActive(tx, tenantId, current.id, d.active, actor, options);
  } catch (e) {
    throw identityError(e, "another user has that userName, externalId or email");
  }
  return (await getUser(tx, tenantId, current.id)) as User;
}

/** Retires a SCIM user (DELETE): for good. `options.onEnded` hears what it ended. */
export async function deleteScimUser(
  tx: Tx,
  tenantId: string,
  id: string,
  actor: string,
  options: StopOptions = {},
) {
  const u = await scimUser(tx, tenantId, id);
  await retireUser(tx, tenantId, u.id, actor, options);
}

/** A page of SCIM users matching `filter` (eq, joined by and). */
export async function listScimUsers(
  tx: Tx,
  tenantId: string,
  filter: Filter | undefined,
  page: Page,
): Promise<{ total: number; users: User[] }> {
  const query = filter === undefined ? {} : userQuery(filter);
  if (query === null) return { total: 0, users: [] };
  return listUsers(tx, tenantId, { ...query, source: "scim" }, page);
}

/**
 * The directory query for a filter, or null when it can match nobody (the same attribute
 * compared with two different values).
 */
function userQuery(filter: Filter): UserQuery | null {
  const eqs = eqConjunction(filter);
  if (eqs === null) {
    throw invalidFilter("users can be filtered with eq, joined by and, only");
  }
  const q: Record<string, string | boolean> = {};
  let none = false;
  const put = (
    key: keyof UserQuery,
    v: string | boolean,
    same: (a: never, b: never) => boolean,
  ) => {
    const had = q[key];
    if (had !== undefined && !same(had as never, v as never)) none = true;
    q[key] = v;
  };
  const exact = (a: unknown, b: unknown) => a === b;
  for (const { path, value } of eqs) {
    const where = pathName(path);
    if (path.schema !== undefined) throw invalidFilter(`can't filter users by ${where}`);
    const str = () => {
      if (typeof value !== "string") throw invalidFilter(`${where} is compared with a string`);
      return value;
    };
    const emails =
      path.attr === "emails" &&
      (path.sub === undefined || path.sub === "value") &&
      (path.filter === undefined || picksKeptEmail(path.filter));
    if (path.attr === "emails" && path.filter !== undefined && !emails) {
      none = true; // an email of a type OpenHoard doesn't keep
      continue;
    }
    if (path.filter !== undefined && path.attr !== "emails") {
      throw invalidFilter(`can't filter users by ${where}`);
    }
    if (path.attr === "username" && path.sub === undefined) {
      put("userName", str(), (a: string, b: string) => userNameKey(a) === userNameKey(b));
    } else if (path.attr === "externalid" && path.sub === undefined) {
      put("externalId", str(), exact);
    } else if (path.attr === "id" && path.sub === undefined) {
      put("id", str(), exact);
    } else if (emails) {
      put("email", str(), (a: string, b: string) => emailKey(a) === emailKey(b));
    } else if (path.attr === "displayname" && path.sub === undefined) {
      put("displayName", str(), exact);
    } else if (path.attr === "active" && path.sub === undefined) {
      if (typeof value !== "boolean") throw invalidFilter("active is compared with true or false");
      put("providerActive", value, exact);
    } else {
      throw invalidFilter(
        `can't filter users by ${where}: userName, externalId, id, emails, displayName and active only`,
      );
    }
  }
  return none ? null : (q as UserQuery);
}
