import type { SourceAcl } from "@openhoard/sdk";
import type { FakeSite, FakeTenant, FakeUser } from "../tenant/types.js";
import type { StoredItem, Tombstone } from "./store.js";

/*
 * Microsoft Graph v1.0 resource shapes (driveItem, permission, site, drive), limited to the
 * fields connectors rely on. Field names follow the Graph documentation exactly.
 */

export const rootId = (driveId: string) => `${driveId}-root`;

export function siteResource(site: FakeSite, tenant: FakeTenant) {
  return {
    id: site.id,
    name: site.name,
    displayName: site.displayName,
    webUrl: site.webUrl,
    createdDateTime: new Date(Date.parse(tenant.now) - 6 * 365 * 86_400_000).toISOString(),
  };
}

export function driveResource(site: FakeSite) {
  return {
    id: site.driveId,
    name: "Documents",
    driveType: "documentLibrary",
    webUrl: `${site.webUrl}/Shared%20Documents`,
  };
}

export function identitySet(user: FakeUser | undefined) {
  return user
    ? { user: { id: user.id, displayName: user.displayName, email: user.upn } }
    : undefined;
}

export function rootItem(site: FakeSite, childCount: number) {
  return {
    id: rootId(site.driveId),
    name: "root",
    root: {},
    folder: { childCount },
    webUrl: `${site.webUrl}/Shared%20Documents`,
    parentReference: { driveId: site.driveId, driveType: "documentLibrary" },
  };
}

export function driveItem(
  item: StoredItem,
  site: FakeSite,
  users: Map<string, FakeUser>,
  childCount: number,
) {
  const parentPath = item.path.slice(0, item.path.lastIndexOf("/"));
  return {
    id: item.id,
    name: item.name,
    size: item.kind === "file" ? item.size : 0,
    eTag: item.etag,
    cTag: `"c:{${item.id}},${item.version}"`,
    createdDateTime: item.createdAt,
    lastModifiedDateTime: item.modifiedAt,
    webUrl: `${site.webUrl}/Shared%20Documents${encodePath(item.path)}`,
    createdBy: identitySet(users.get(item.createdBy)),
    lastModifiedBy: identitySet(users.get(item.modifiedBy)),
    parentReference: {
      driveId: item.driveId,
      driveType: "documentLibrary",
      id: item.parentId ?? rootId(item.driveId),
      path: `/drive/root:${parentPath}`,
      siteId: item.siteId,
    },
    ...(item.kind === "file" ? { file: { mimeType: item.mime } } : { folder: { childCount } }),
  };
}

export function deletedItem(t: Tombstone) {
  return {
    id: t.id,
    name: t.name,
    deleted: { state: "deleted" },
    parentReference: { driveId: t.driveId, id: t.parentId ?? rootId(t.driveId) },
  };
}

/** One Graph permission per ACL entry. Inherited entries name where they come from. */
export function permissionResource(
  entry: SourceAcl,
  index: number,
  item: StoredItem,
  tenant: FakeTenant,
  users: Map<string, FakeUser>,
) {
  const base = {
    id: `${item.id}-p${index}`,
    roles: [entry.role],
    ...(entry.expiresAt ? { expirationDateTime: entry.expiresAt } : {}),
    ...(entry.inherited
      ? { inheritedFrom: { driveId: item.driveId, id: item.parentId ?? rootId(item.driveId) } }
      : {}),
  };
  if (entry.principal === "anyone-with-link") {
    return {
      ...base,
      link: { scope: "anonymous", type: "view", webUrl: `https://share.test/${item.id}/${index}` },
    };
  }
  const [kind, id = ""] = splitOnce(entry.principal);
  if (kind === "group") {
    const group = tenant.groups.find((g) => g.id === id);
    return { ...base, grantedToV2: { group: { id, displayName: group?.displayName ?? id } } };
  }
  const user = kind === "guest" ? tenant.users.find((u) => u.upn === id) : users.get(id);
  return {
    ...base,
    grantedToV2: {
      user: { id: user?.id ?? id, displayName: user?.displayName ?? id, email: user?.upn ?? id },
    },
    ...(kind === "guest" ? { invitation: { email: id, signInRequired: true } } : {}),
  };
}

function splitOnce(s: string): [string, string | undefined] {
  const at = s.indexOf(":");
  return at === -1 ? [s, undefined] : [s.slice(0, at), s.slice(at + 1)];
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
