import type { FakeTenant, FakeUser } from "../tenant/types.js";

/*
 * SCIM 2.0 seed data (RFC 7643 resources, RFC 7644 list responses) for the fake tenant, so
 * user and group provisioning can be tested without a cloud identity provider.
 */

export const SCIM_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const SCIM_ENTERPRISE_USER = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
export const SCIM_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";

export interface ScimUser {
  schemas: string[];
  id: string;
  externalId: string;
  userName: string;
  name: { givenName: string; familyName: string; formatted: string };
  displayName: string;
  emails: { value: string; type: "work"; primary: true }[];
  userType: "Member" | "Guest";
  active: boolean;
  [SCIM_ENTERPRISE_USER]?: { department: string };
  meta: { resourceType: "User"; location: string };
}

export interface ScimGroup {
  schemas: string[];
  id: string;
  externalId: string;
  displayName: string;
  members: { value: string; type: "User"; $ref: string }[];
  meta: { resourceType: "Group"; location: string };
}

export interface ScimListResponse<T> {
  schemas: [typeof SCIM_LIST];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
}

/** SCIM resources for every user and group. `baseUrl` is the SCIM endpoint, e.g. `https://…/scim/v2`. */
export function scimSeed(
  tenant: FakeTenant,
  baseUrl = "https://idp.test/scim/v2",
): { users: ScimUser[]; groups: ScimGroup[] } {
  return {
    users: tenant.users.map((u) => scimUser(u, baseUrl)),
    groups: tenant.groups.map((g) => ({
      schemas: [SCIM_GROUP],
      id: g.id,
      externalId: `ext-${g.id}`,
      displayName: g.displayName,
      members: g.members.map((m) => ({
        value: m,
        type: "User" as const,
        $ref: `${baseUrl}/Users/${m}`,
      })),
      meta: { resourceType: "Group" as const, location: `${baseUrl}/Groups/${g.id}` },
    })),
  };
}

/** A page of resources as a SCIM ListResponse. `startIndex` is 1-based, as in RFC 7644. */
export function scimList<T>(
  resources: readonly T[],
  startIndex = 1,
  count = 100,
): ScimListResponse<T> {
  if (!Number.isInteger(startIndex) || startIndex < 1)
    throw new RangeError("startIndex is 1-based");
  const page = resources.slice(startIndex - 1, startIndex - 1 + Math.max(0, count));
  return {
    schemas: [SCIM_LIST],
    totalResults: resources.length,
    startIndex,
    itemsPerPage: page.length,
    Resources: page,
  };
}

function scimUser(u: FakeUser, baseUrl: string): ScimUser {
  const [givenName = u.displayName, ...rest] = u.displayName.replace(/ \(.*\)$/, "").split(" ");
  return {
    schemas: u.guest ? [SCIM_USER] : [SCIM_USER, SCIM_ENTERPRISE_USER],
    id: u.id,
    externalId: `ext-${u.id}`,
    userName: u.upn,
    name: { givenName, familyName: rest.join(" "), formatted: u.displayName },
    displayName: u.displayName,
    emails: [{ value: u.upn, type: "work", primary: true }],
    userType: u.guest ? "Guest" : "Member",
    active: u.active,
    ...(u.guest ? {} : { [SCIM_ENTERPRISE_USER]: { department: u.department } }),
    meta: { resourceType: "User", location: `${baseUrl}/Users/${u.id}` },
  };
}
