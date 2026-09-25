import { invalidValue } from "./errors.js";
import { GROUP_SCHEMA, USER_SCHEMA } from "./filter.js";
import type { Json } from "./json.js";

/*
 * The SCIM discovery documents (RFC 7644 section 4, RFC 7643 sections 5 to 7): what this
 * endpoint supports, and the attributes it keeps. Static: they describe the code, not a tenant.
 */

const SPC_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";
const RESOURCE_TYPE_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ResourceType";
const SCHEMA_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Schema";
export const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

/** Most resources in one page of a list (`count` above it is lowered to it). */
export const MAX_PAGE = 200;

export function serviceProviderConfig(base: string): Json {
  return {
    schemas: [SPC_SCHEMA],
    documentationUri: "https://github.com/openhoard/openhoard/blob/main/apps/server/README.md",
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_PAGE },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "OpenHoard SCIM token",
        description:
          "A per-tenant bearer token (ohscim.…) issued with `openhoard admin scim-token issue`.",
        primary: true,
      },
    ],
    meta: { resourceType: "ServiceProviderConfig", location: `${base}/ServiceProviderConfig` },
  };
}

const RESOURCE_TYPES = (base: string): Json[] => [
  {
    schemas: [RESOURCE_TYPE_SCHEMA],
    id: "User",
    name: "User",
    endpoint: "/Users",
    description: "People, provisioned by the tenant's identity provider",
    schema: USER_SCHEMA,
    meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/User` },
  },
  {
    schemas: [RESOURCE_TYPE_SCHEMA],
    id: "Group",
    name: "Group",
    endpoint: "/Groups",
    description: "Groups of people, with direct membership",
    schema: GROUP_SCHEMA,
    meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/Group` },
  },
];

type Attr = Json;
const attr = (
  name: string,
  more: Partial<{
    type: string;
    multiValued: boolean;
    required: boolean;
    caseExact: boolean;
    mutability: string;
    returned: string;
    uniqueness: string;
    subAttributes: Attr[];
    referenceTypes: string[];
    description: string;
  }> = {},
): Attr => ({
  name,
  type: "string",
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: "readWrite",
  returned: "default",
  uniqueness: "none",
  ...more,
});

const SCHEMAS = (base: string): Json[] => [
  {
    schemas: [SCHEMA_SCHEMA],
    id: USER_SCHEMA,
    name: "User",
    description: "User Account (the attributes OpenHoard keeps)",
    attributes: [
      attr("userName", { required: true, uniqueness: "server" }),
      attr("externalId", { caseExact: true }),
      attr("name", {
        type: "complex",
        subAttributes: [attr("givenName"), attr("familyName"), attr("formatted")],
      }),
      attr("displayName"),
      attr("userType", { description: '"Member" or "Guest"' }),
      attr("active", { type: "boolean" }),
      attr("emails", {
        type: "complex",
        multiValued: true,
        subAttributes: [attr("value"), attr("type"), attr("primary", { type: "boolean" })],
      }),
    ],
    meta: { resourceType: "Schema", location: `${base}/Schemas/${USER_SCHEMA}` },
  },
  {
    schemas: [SCHEMA_SCHEMA],
    id: GROUP_SCHEMA,
    name: "Group",
    description: "Group (direct members only)",
    attributes: [
      attr("displayName", { required: true, uniqueness: "server" }),
      attr("externalId", { caseExact: true }),
      attr("members", {
        type: "complex",
        multiValued: true,
        subAttributes: [
          attr("value", { mutability: "immutable", caseExact: true }),
          attr("$ref", { type: "reference", mutability: "immutable", referenceTypes: ["User"] }),
          attr("display", { mutability: "readOnly" }),
          attr("type", { mutability: "immutable" }),
        ],
      }),
    ],
    meta: { resourceType: "Schema", location: `${base}/Schemas/${GROUP_SCHEMA}` },
  },
];

const list = (resources: Json[]): Json => ({
  schemas: [LIST_SCHEMA],
  totalResults: resources.length,
  startIndex: 1,
  itemsPerPage: resources.length,
  Resources: resources,
});

/** GET /ResourceTypes[/:id]: the list, or one; null when there is none by that id. */
export function resourceTypes(base: string, id?: string): Json | null {
  const all = RESOURCE_TYPES(base);
  return id === undefined ? list(all) : (all.find((r) => r.id === id) ?? null);
}

/** GET /Schemas[/:id]. */
export function schemas(base: string, id?: string): Json | null {
  const all = SCHEMAS(base);
  return id === undefined ? list(all) : (all.find((s) => s.id === id) ?? null);
}

/**
 * `startIndex` and `count` (RFC 7644 section 3.4.2.4): 1-based, a startIndex under 1 is 1, a
 * negative count is 0, and a count over {@link MAX_PAGE} is lowered to it.
 */
export function pageOf(startIndex: string | undefined, count: string | undefined) {
  const int = (v: string | undefined, name: string, fallback: number) => {
    if (v === undefined || v === "") return fallback;
    if (!/^-?\d{1,15}$/.test(v)) throw invalidValue(`${name} must be a whole number`);
    return Number(v);
  };
  const start = Math.max(1, int(startIndex, "startIndex", 1));
  const n = Math.min(MAX_PAGE, Math.max(0, int(count, "count", 100)));
  return { startIndex: start, offset: start - 1, limit: n };
}
