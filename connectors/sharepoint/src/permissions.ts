import {
  LIMITS,
  normalizeAcl,
  storableText,
  type AclEntry,
  type AclPrincipal,
  type AclRole,
} from "@openhoard/sdk";

/*
 * A drive item's permissions as Graph lists them (`/items/{id}/permissions`), in the connector
 * contract's terms (T-305). What each becomes:
 *
 * | Graph says                                          | entry                                  |
 * | --------------------------------------------------- | -------------------------------------- |
 * | `grantedToV2.user` (an Entra user)                  | user, by its object id, with its email |
 * | the same with an `invitation` (taken up)            | guest, by its id, with an email        |
 * | `grantedToV2.group` (an Entra group)                | group, by its object id                |
 * | `grantedToV2.siteGroup` (a SharePoint group)        | group, id `sitegroup:<site>:<id>`      |
 * | `grantedToV2.siteUser` that is everyone             | organization                           |
 * | `grantedToV2.siteUser` that is a person, with email | user, id `siteuser:<login>`            |
 * | `link` to view or edit, for anyone or the org       | link (`anyone`, `organization`)        |
 * | `link` to view or edit, for named people            | link (`specific`), and each of them    |
 * | anything else                                       | nothing                                |
 *
 * "Anything else" is the rule: an application, a device, an invitation nobody took up, a claim
 * that isn't a person's (a group's owners, a security group seen as a site user), what only
 * the older `grantedTo` fields say, a link of existing access, a link
 * that isn't to view or edit (upload only, review, embed) or that prevents download, a role
 * this doesn't know (limited access, view only: SharePoint's own ways of giving less than
 * the file). Each grants nothing, since what is given here is the file's content.
 *
 * Roles: `owner` (and SharePoint's full control) is owner, `write` is write, `read` is read; a
 * link's are its type. `inheritedFrom` makes an entry inherited; `expirationDateTime` is its
 * expiry (a date before 2000 is Graph's way of saying none; one that can't be read leaves the
 * permission out).
 *
 * The core decides what an entry is worth (core/jobs acl.ts): a SharePoint group's id is its
 * site's alone and matches no group there, and so grants nothing, until something can say who
 * is in it.
 */

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
/** Text that can be an id or an email in an entry (with room for a prefix), or undefined. */
const text = (v: unknown, room = 0): string | undefined =>
  storableText(v) && v !== "" && [...v].length <= LIMITS.principalId - room ? v : undefined;

const ROLES: Readonly<Record<string, AclRole>> = Object.freeze({
  read: "read",
  write: "write",
  owner: "owner",
  "sp.full control": "owner",
});
const RANK: Record<AclRole, number> = { read: 0, write: 1, owner: 2 };

/** The strongest role Graph's `roles` names, or undefined when it names none known. */
function roleOf(roles: unknown): AclRole | undefined {
  let best: AclRole | undefined;
  for (const name of Array.isArray(roles) ? roles : []) {
    const role =
      typeof name === "string" && Object.hasOwn(ROLES, name.toLowerCase())
        ? ROLES[name.toLowerCase()]
        : undefined;
    if (role !== undefined && (best === undefined || RANK[role] > RANK[best])) best = role;
  }
  return best;
}

/** SharePoint's claims for everyone, and everyone except external users. */
const EVERYONE = /^c:0(\(\.s\|true|-\.f\|rolemanager\|spo-grid-all-users)/i;
/** A person's claim: an Entra account signed in by membership. */
const PERSON = /^i:0#\.f\|membership\|/i;
/** A Microsoft 365 group's owners, which is not the group. */
const OWNERS_ONLY = /\|federateddirectoryclaimprovider\|[^|]*_o$/i;

/**
 * Who an identity set is, or undefined for what is nobody here. `site` is the site's id: a
 * SharePoint group's id means something in its site only.
 */
function principalOf(set: unknown, site: string, invited?: string): AclPrincipal | undefined {
  if (!isObject(set)) return undefined;
  const { user, group, siteUser, siteGroup } = set;
  const login = isObject(siteUser) ? text(siteUser.loginName, "siteuser:".length) : undefined;
  if (isObject(siteUser) && siteUser.loginName !== undefined) {
    // The claim says it is less than the group Graph names beside it: not the group. And a
    // claim that can't be read can't be told from one.
    const claim = siteUser.loginName;
    if (login === undefined || (typeof claim === "string" && OWNERS_ONLY.test(claim))) {
      return undefined;
    }
  }
  if (isObject(group)) {
    const id = text(group.id);
    if (id !== undefined) return { kind: "group", id };
  }
  if (isObject(user)) {
    const id = text(user.id);
    const email = text(user.email);
    // An invitation someone took up is that account, by its id: a guest, known by the
    // account's own address when Graph gives it, else the one invited.
    if (id !== undefined && invited !== undefined) {
      return { kind: "guest", email: email ?? invited, id };
    }
    if (id !== undefined) return { kind: "user", id, ...(email ? { email } : {}) };
  }
  if (isObject(siteGroup)) {
    const id = text(siteGroup.id, `sitegroup:${site}:`.length);
    if (id !== undefined) return { kind: "group", id: `sitegroup:${site}:${id}` };
  }
  if (login !== undefined && isObject(siteUser)) {
    if (EVERYONE.test(login)) return { kind: "organization" };
    const email = text(siteUser.email);
    // Only a person's claim is a person: a group's may carry the group's address.
    if (PERSON.test(login) && email !== undefined) {
      return { kind: "user", id: `siteuser:${login}`, email };
    }
  }
  // (An invitation nobody has taken up yet names nobody: SharePoint gives it nothing either.)
  return undefined;
}

const LINK_SCOPES: Readonly<Record<string, "anyone" | "organization" | "specific">> = Object.freeze(
  { anonymous: "anyone", organization: "organization", users: "specific" },
);
const LINK_ROLES: Readonly<Record<string, AclRole>> = Object.freeze({
  view: "read",
  edit: "write",
});

/** One entry, as the contract takes it, or undefined when it wouldn't. */
function checked(entry: AclEntry): AclEntry | undefined {
  try {
    return normalizeAcl([entry])[0];
  } catch {
    return undefined;
  }
}

/**
 * The entries Graph's permissions come to, normalized. A permission that makes no sense, or
 * that the contract can't hold, is left out (it grants nothing), never guessed at.
 */
export function aclEntriesOf(permissions: readonly unknown[], site: string): AclEntry[] {
  const entries: AclEntry[] = [];
  const add = (principal: AclPrincipal | undefined, role: AclRole, rest: Partial<AclEntry>) => {
    const entry = principal && checked({ principal, role, inherited: false, ...rest });
    if (entry) entries.push(entry);
  };
  for (const raw of permissions) {
    if (!isObject(raw)) continue;
    const said = raw.expirationDateTime;
    const expiry = typeof said === "string" ? Date.parse(said) : NaN;
    // An expiry that can't be read is not "never": the permission is left out.
    if (said !== undefined && said !== null && !Number.isFinite(expiry)) continue;
    const rest = {
      inherited: isObject(raw.inheritedFrom),
      // (Graph gives year 1 for "never".)
      ...(Number.isFinite(expiry) && expiry >= Date.UTC(2000, 0, 1)
        ? { expiresAt: new Date(expiry).toISOString() }
        : {}),
    };
    if (isObject(raw.link)) {
      const { scope: saidScope, type } = raw.link;
      const scope =
        typeof saidScope === "string" && Object.hasOwn(LINK_SCOPES, saidScope)
          ? LINK_SCOPES[saidScope]
          : undefined;
      const role =
        typeof type === "string" && Object.hasOwn(LINK_ROLES, type) ? LINK_ROLES[type] : undefined;
      const id = text(raw.id);
      // (A link of existing access gives nobody anything they didn't have; one that isn't to
      // view or edit, or that keeps the file from being downloaded, gives less than the file.)
      if (scope === undefined || role === undefined || id === undefined) continue;
      if (raw.link.preventsDownload === true) continue;
      add({ kind: "link", id, scope }, role, rest);
      if (scope !== "specific") continue;
      // A link for named people is how SharePoint shares with them: each is named here too.
      const named = Array.isArray(raw.grantedToIdentitiesV2) ? raw.grantedToIdentitiesV2 : [];
      for (const set of named as unknown[]) add(principalOf(set, site), role, rest);
      continue;
    }
    const role = roleOf(raw.roles);
    if (role === undefined) continue;
    const invited = isObject(raw.invitation) ? text(raw.invitation.email) : undefined;
    // (Only the current fields: the older ones can't say what kind of claim an identity is.)
    add(principalOf(raw.grantedToV2, site, invited), role, rest);
  }
  return normalizeAcl(entries);
}
