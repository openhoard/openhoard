import {
  ACL_ROLES,
  CONNECTOR_API_VERSION,
  ZONE_KINDS,
  type AclEntry,
  type AclPrincipal,
  type ConnectorDescription,
  type ItemAcl,
  type ItemRef,
  type SourceItem,
} from "./connector.js";

/*
 * Checks on what a connector returns. A connector is plugin code: the runner checks every event,
 * ACL and URL before anything reaches the catalog, and the contract kit (testing/) checks the
 * same so an author finds out first. Each check returns what is wrong, or null, and never throws
 * on odd input: getters, proxies and prototypes aside, anything can arrive here.
 *
 * The limits follow the catalog's (core/catalog INGEST_LIMITS), so an item that passes can be
 * recorded; text may not hold NUL or lone surrogates, which PostgreSQL can't store.
 */

/** Longest accepted values, in characters (Unicode code points). */
export const LIMITS = {
  externalId: 2048,
  name: 1024,
  title: 1024,
  pathDepth: 1024,
  etag: 1024,
  contentVersion: 1024,
  mediaType: 255,
  url: 4096,
  /** Checkpoint tokens and cursors: a connector that needs more keeps its state itself. */
  token: 65_536,
  principalId: 1024,
} as const;

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;
const SCHEME = /^[a-z][a-z0-9+.-]{0,31}:$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** Whether `s` is a string PostgreSQL text can hold: no NUL, no lone surrogate. */
export function storableText(s: unknown): s is string {
  if (typeof s !== "string") return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) return false;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const text = (s: unknown, max: number, min = 1): s is string =>
  storableText(s) && s.length >= min && [...s].length <= max;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** What is wrong with a description, or an empty list. */
export function checkDescription(d: unknown): string[] {
  if (!isObject(d)) return ["describe() must return an object"];
  const problems: string[] = [];
  if (d.apiVersion !== CONNECTOR_API_VERSION) {
    problems.push(`apiVersion must be ${CONNECTOR_API_VERSION}`);
  }
  if (typeof d.id !== "string" || !SLUG.test(d.id)) problems.push("id must be a lower-case slug");
  if (typeof d.version !== "string" || !SEMVER.test(d.version)) {
    problems.push("version must be semver");
  }
  const kinds = d.zoneKinds;
  if (
    !Array.isArray(kinds) ||
    kinds.length === 0 ||
    !kinds.every((k) => (ZONE_KINDS as readonly unknown[]).includes(k)) ||
    new Set(kinds).size !== kinds.length
  ) {
    problems.push(`zoneKinds must be distinct values of ${ZONE_KINDS.join(", ")}`);
  }
  const caps = d.capabilities;
  if (
    !isObject(caps) ||
    typeof caps.delta !== "boolean" ||
    typeof caps.aclImport !== "boolean" ||
    typeof caps.redirect !== "boolean"
  ) {
    problems.push("capabilities must say delta, aclImport and redirect as booleans");
  }
  if (typeof d.stableIds !== "boolean") problems.push("stableIds must be a boolean");
  if (d.redirectSchemes !== undefined) {
    const s = d.redirectSchemes;
    if (
      !Array.isArray(s) ||
      !s.every((x) => typeof x === "string" && SCHEME.test(x) && !UNSAFE_SCHEMES.has(x))
    ) {
      problems.push("redirectSchemes must be lower-case schemes with their colon");
    }
  }
  return problems;
}

/** Schemes redirect() may never return: they run code or carry content, not a location. */
const UNSAFE_SCHEMES = new Set(["javascript:", "data:", "vbscript:", "blob:", "about:"]);

/**
 * What is wrong with an item, or null. Its `url` follows the rules of {@link checkUrl}, with the
 * schemes `description` declares (without one, `https:` only).
 */
export function checkItem(item: unknown, description?: ConnectorDescription): string | null {
  if (!isObject(item)) return "an item must be an object";
  if (!text(item.externalId, LIMITS.externalId)) return "externalId";
  if (item.kind !== "file" && item.kind !== "folder") return "kind must be file or folder";
  if (item.parentId !== null && !text(item.parentId, LIMITS.externalId)) {
    return "parentId must be an externalId or null";
  }
  if (item.parentId === item.externalId) return "an item can't be its own parent";
  const path = item.path;
  if (!Array.isArray(path) || path.length === 0 || path.length > LIMITS.pathDepth) {
    return "path must list 1 to 1024 names";
  }
  for (const name of path) {
    // No empty names, no `.` or `..`, no `/`: a name is one step, whatever joins them later.
    if (!text(name, LIMITS.name) || name === "." || name === ".." || name.includes("/")) {
      return "path holds a name that isn't one";
    }
  }
  if ((item.parentId === null) !== (path.length === 1)) {
    return "an item at the top has one name in its path, and no parent";
  }
  if (item.title !== undefined && !text(item.title, LIMITS.title)) return "title";
  if (!text(item.etag, LIMITS.etag)) return "etag";
  if (item.url !== undefined) {
    const problem = checkUrl(item.url, description);
    if (problem !== null) return `url: ${problem}`;
  }
  if (item.modifiedAt !== undefined) {
    if (typeof item.modifiedAt !== "string" || !ISO_TIME.test(item.modifiedAt)) {
      return "modifiedAt must be an ISO 8601 time";
    }
    if (Number.isNaN(Date.parse(item.modifiedAt))) return "modifiedAt must be a real time";
  }
  if (item.modifiedBy !== undefined) {
    const by = item.modifiedBy;
    if (
      !isObject(by) ||
      !text(by.id, LIMITS.principalId) ||
      (by.email !== undefined && !text(by.email, LIMITS.principalId)) ||
      (by.name !== undefined && !text(by.name, LIMITS.principalId))
    ) {
      return "modifiedBy";
    }
  }
  if (item.kind === "file") {
    if (typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 0) {
      return "a file's size must be a whole number of bytes";
    }
    if (!text(item.contentVersion, LIMITS.contentVersion)) return "a file needs a contentVersion";
    if (item.mediaType !== undefined && !text(item.mediaType, LIMITS.mediaType, 0)) {
      return "mediaType";
    }
  } else if (
    item.size !== undefined ||
    item.contentVersion !== undefined ||
    item.mediaType !== undefined
  ) {
    return "a folder has no size, contentVersion or mediaType";
  }
  return null;
}

const CODE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** What is wrong with an event, or null. `description` gives items' URL schemes (checkItem). */
export function checkEvent(e: unknown, description?: ConnectorDescription): string | null {
  if (!isObject(e)) return "an event must be an object";
  switch (e.type) {
    case "item":
      return checkItem(e.item, description);
    case "deleted":
      return text(e.externalId, LIMITS.externalId) ? null : "externalId";
    case "checkpoint":
      return text(e.token, LIMITS.token)
        ? null
        : "a checkpoint token must be 1 to 65,536 characters";
    case "done":
      return text(e.cursor, LIMITS.token) ? null : "a cursor must be 1 to 65,536 characters";
    case "warning":
      if (typeof e.code !== "string" || !CODE.test(e.code)) return "a warning's code is a slug";
      return e.externalId === undefined || text(e.externalId, LIMITS.externalId)
        ? null
        : "externalId";
    default:
      return "unknown event type";
  }
}

/** A reference to an item as crawled: what read(), aclImport() and redirect() take. */
export function refOf(item: SourceItem): ItemRef {
  return {
    externalId: item.externalId,
    ...(item.contentVersion === undefined ? {} : { contentVersion: item.contentVersion }),
    ...(item.size === undefined ? {} : { size: item.size }),
    ...(item.url === undefined ? {} : { url: item.url }),
    path: [...item.path],
  };
}

/** The item's title: its own, else its name. */
export function titleOf(item: SourceItem): string {
  return item.title ?? (item.path[item.path.length - 1] as string);
}

const LINK_SCOPES = new Set(["anyone", "organization", "specific"]);

function checkPrincipal(p: unknown): AclPrincipal {
  const bad = (why: string): never => {
    throw new TypeError(`invalid ACL principal: ${why}`);
  };
  if (!isObject(p)) return bad("not an object");
  switch (p.kind) {
    case "user":
      if (!text(p.id, LIMITS.principalId)) bad("user id");
      if (p.email !== undefined && !text(p.email, LIMITS.principalId)) bad("user email");
      return {
        kind: "user",
        id: p.id as string,
        ...(p.email === undefined ? {} : { email: lowerAscii(p.email as string) }),
      };
    case "group":
      if (!text(p.id, LIMITS.principalId)) bad("group id");
      return { kind: "group", id: p.id as string };
    case "guest":
      if (!text(p.email, LIMITS.principalId)) bad("guest email");
      if (p.id !== undefined && !text(p.id, LIMITS.principalId)) bad("guest id");
      return {
        kind: "guest",
        email: lowerAscii(p.email as string),
        ...(p.id === undefined ? {} : { id: p.id as string }),
      };
    case "link":
      if (!text(p.id, LIMITS.principalId)) bad("link id");
      if (typeof p.scope !== "string" || !LINK_SCOPES.has(p.scope)) bad("link scope");
      return { kind: "link", id: p.id as string, scope: p.scope as "anyone" };
    case "organization":
      return { kind: "organization" };
    default:
      return bad("unknown kind");
  }
}

/** Emails compare without case in the ASCII range only: nothing here maps other scripts. */
function lowerAscii(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

const principalKey = (p: AclPrincipal): string => {
  switch (p.kind) {
    case "user":
    case "group":
      return `${p.kind}:${p.id}`;
    case "guest":
      return `guest:${p.email}`;
    case "link":
      return `link:${p.id}`;
    case "organization":
      return "organization";
  }
};

/**
 * One entry per principal, sorted, in a form that compares equal whenever two sources say the
 * same thing: the strongest role wins; `inherited` only when every entry for the principal is;
 * an expiry only when every entry has one (the latest). A user's email and a guest's are
 * lower-cased in the ASCII range. Throws TypeError for an entry that isn't one.
 */
export function normalizeAcl(entries: readonly unknown[]): AclEntry[] {
  if (!Array.isArray(entries)) throw new TypeError("ACL entries must be an array");
  const byPrincipal = new Map<string, AclEntry>();
  for (const raw of entries) {
    if (!isObject(raw)) throw new TypeError("invalid ACL entry");
    const principal = checkPrincipal(raw.principal);
    if (!(ACL_ROLES as readonly unknown[]).includes(raw.role)) {
      throw new TypeError("invalid ACL role");
    }
    if (typeof raw.inherited !== "boolean") throw new TypeError("invalid ACL inherited flag");
    let expiresAt: string | undefined;
    if (raw.expiresAt !== undefined) {
      if (typeof raw.expiresAt !== "string" || !ISO_TIME.test(raw.expiresAt)) {
        throw new TypeError("invalid ACL expiry");
      }
      const t = Date.parse(raw.expiresAt);
      if (Number.isNaN(t)) throw new TypeError("invalid ACL expiry");
      expiresAt = new Date(t).toISOString();
    }
    const entry: AclEntry = {
      principal,
      role: raw.role as AclEntry["role"],
      inherited: raw.inherited,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
    const key = principalKey(principal);
    const seen = byPrincipal.get(key);
    byPrincipal.set(key, seen ? merge(seen, entry) : entry);
  }
  return [...byPrincipal.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, e]) => e);
}

function merge(a: AclEntry, b: AclEntry): AclEntry {
  const rank = (r: AclEntry["role"]) => ACL_ROLES.indexOf(r);
  const expiresAt =
    a.expiresAt === undefined || b.expiresAt === undefined
      ? undefined
      : a.expiresAt > b.expiresAt
        ? a.expiresAt
        : b.expiresAt;
  // The principal as the fuller entry names it (a user with an email over one without); between
  // two as full, the one that sorts first, so the order entries come in doesn't matter.
  const [pa, pb] = [JSON.stringify(a.principal), JSON.stringify(b.principal)];
  const principal =
    pb.length > pa.length || (pb.length === pa.length && pb < pa) ? b.principal : a.principal;
  return {
    principal,
    role: rank(b.role) > rank(a.role) ? b.role : a.role,
    inherited: a.inherited && b.inherited,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

/** What is wrong with an ACL (including entries that aren't normalized), or null. */
export function checkAcl(acl: unknown): string | null {
  if (!isObject(acl)) return "an ACL must be an object";
  if (acl.basis !== "source" && acl.basis !== "configured" && acl.basis !== "owner-only") {
    return "basis must be source, configured or owner-only";
  }
  if (!Array.isArray(acl.entries)) return "entries must be an array";
  if (acl.basis === "owner-only" && acl.entries.length > 0) return "owner-only has no entries";
  let normalized: AclEntry[];
  try {
    normalized = normalizeAcl(acl.entries);
  } catch (e) {
    return (e as Error).message;
  }
  return JSON.stringify(normalized) === JSON.stringify(acl.entries)
    ? null
    : "entries are not normalized (normalizeAcl)";
}

/** An ACL the core can use: checked and normalized, or a TypeError. */
export function acceptAcl(acl: unknown): ItemAcl {
  if (!isObject(acl)) throw new TypeError("an ACL must be an object");
  const basis = acl.basis;
  if (basis !== "source" && basis !== "configured" && basis !== "owner-only") {
    throw new TypeError("invalid ACL basis");
  }
  if (!Array.isArray(acl.entries)) throw new TypeError("ACL entries must be an array");
  const entries = normalizeAcl(acl.entries);
  if (basis === "owner-only" && entries.length > 0) {
    throw new TypeError("an owner-only ACL has no entries");
  }
  return { basis, entries };
}

/**
 * What is wrong with a URL a connector gave (an item's `url`, what redirect() returned), or null:
 *
 * - absolute, at most 4,096 characters;
 * - `https:`, or a scheme `description` declares (`redirectSchemes`), and never one that runs
 *   code or carries content (`javascript:`, `data:`, `vbscript:`, `blob:`, `about:`), even
 *   declared;
 * - no user name or password;
 * - a `file:` URL that can only mean a local path. Opening `file://server/share/…` on Windows
 *   authenticates to that server (NTLM), so a connector could make people's machines send their
 *   credentials anywhere, and browsers and the Windows shell find a server in more spellings than
 *   the URL parser does: `file:////server/…`, `file://localhost//server/…`, backslashes
 *   (`file:\\\\server\\…`, `file:///\\\\server`), encoded slashes, `file:///?/UNC/…`, and slashes
 *   that only look like one (U+2215, U+FF0F). So a `file:` URL has no host, no path starting
 *   with `//`, no backslash anywhere, no `%5C` or `%2F`, no query or fragment (and no `?` or
 *   `%3F` starting the path), and a first path segment that is a drive (`/C:/`) or plain ASCII.
 *
 * Whatever passes is kept and used as {@link canonicalUrl} gives it (the parser's own text),
 * never as the connector wrote it.
 */
export function checkUrl(url: unknown, description?: ConnectorDescription): string | null {
  if (!text(url, LIMITS.url)) return "a URL must be text of at most 4,096 characters";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "not an absolute URL";
  }
  const allowed = new Set(["https:", ...(description?.redirectSchemes ?? [])]);
  if (UNSAFE_SCHEMES.has(parsed.protocol) || !allowed.has(parsed.protocol)) {
    return `scheme ${parsed.protocol} is not one the connector declared`;
  }
  if (parsed.username !== "" || parsed.password !== "") return "a URL must not carry credentials";
  if (parsed.protocol === "file:") {
    if (parsed.host !== "") return "a file: URL must not name a host";
    if (url.includes("\\")) return "a file: URL must not hold a backslash";
    if (parsed.pathname.startsWith("//")) return "a file: URL's path must not name a host";
    if (/%(5c|2f)/i.test(parsed.pathname)) return "a file: URL must not encode a slash";
    if (parsed.search !== "" || parsed.hash !== "" || /[?#]/.test(url)) {
      return "a file: URL must not have a query or fragment";
    }
    if (/^\/(\?|%3f)/i.test(parsed.pathname)) return "a file: URL's path must not start with ?";
    const first = parsed.pathname.split("/")[1] ?? "";
    let decoded: string;
    try {
      decoded = decodeURIComponent(first);
    } catch {
      return "a file: URL's path must decode";
    }
    if (!/^[A-Za-z]:$/.test(decoded) && !/^[\x20-\x7e]*$/.test(decoded)) {
      return "a file: URL's first folder must be a drive or plain ASCII";
    }
  }
  if ([...parsed.href].length > LIMITS.url) return "a URL must be at most 4,096 characters";
  return null;
}

/**
 * The URL as the parser writes it (`new URL(url).href`): what is stored and handed out, so what
 * was checked is what is used. Only for a URL {@link checkUrl} accepted.
 */
export function canonicalUrl(url: string): string {
  return new URL(url).href;
}

/** What is wrong with a URL redirect() returned, or null: {@link checkUrl}. */
export function checkRedirect(url: unknown, description: ConnectorDescription): string | null {
  return checkUrl(url, description);
}

/**
 * A URL redirect() returned, checked and as the parser writes it: what may be handed to anyone
 * (the open-in-native-app path, FR-20 and T-802, must use this, never the connector's text).
 * Throws TypeError for a URL {@link checkUrl} refuses.
 */
export function acceptRedirect(url: unknown, description: ConnectorDescription): string {
  const problem = checkUrl(url, description);
  if (problem !== null) throw new TypeError(`refused redirect URL: ${problem}`);
  return canonicalUrl(url as string);
}
