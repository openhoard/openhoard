import type { PluginManifest } from "@openhoard/schemas";

/*
 * The connector interface, version 1 (T-301).
 *
 * A connector lets OpenHoard reach files and their permissions where they already live
 * (SharePoint, a bucket, a local folder) without moving them. It answers five questions, and the
 * core does everything else (recording items, deciding who sees what, auditing):
 *
 *   describe()   what it is and what it can do
 *   crawl()      every item in the source, resumable after a crash or kill
 *   delta()      what changed since last time
 *   read()       one item's bytes, exactly the version that was crawled, never newer ones
 *   aclImport()  who the source says may see an item, normalized for the core to map (T-305)
 *   redirect()   where to open an item in its own app (FR-20, open in the native app)
 *
 * A connector is untrusted plugin code: the core checks everything it returns (validate.ts) and
 * never lets it decide access. It runs as the tenant's service account with a key scoped to its
 * zones (T-111) once it runs outside the server; inside the server the sync runner (core/jobs)
 * drives it.
 *
 * Versioning: CONNECTOR_API_VERSION changes when this interface changes in a way an existing
 * connector or runner would get wrong. Additions a runner can do without (a new optional method,
 * a new optional field) keep the version; a connector says which version it implements in
 * describe(), and a runner refuses one it doesn't know.
 */

/** The version of this interface. See the header for what changes it. */
export const CONNECTOR_API_VERSION = 1 as const;

/** Where objects live (the Dev Plan's zones). A connector says which kinds it can serve. */
export const ZONE_KINDS = ["managed", "indexed", "local-only", "code"] as const;
export type ZoneKind = (typeof ZONE_KINDS)[number];

/** What a connector can do beyond crawl() and read(), which every connector has. */
export interface ConnectorCapabilities {
  /** delta() reports changes since a cursor. Without it every sync crawls everything again. */
  delta: boolean;
  aclImport: boolean;
  redirect: boolean;
}

export interface ConnectorDescription {
  /** The interface version it implements: {@link CONNECTOR_API_VERSION}. */
  apiVersion: typeof CONNECTOR_API_VERSION;
  /** Its name: the same as its manifest's `name` (`connector-fs`, `connector-sharepoint`). */
  id: string;
  /** Its own version (semver). */
  version: string;
  /** The zone kinds it may serve: a sync into a zone of another kind is refused. */
  zoneKinds: readonly ZoneKind[];
  capabilities: ConnectorCapabilities;
  /**
   * Whether an item keeps its externalId when it is renamed or moved. With it, a rename is a
   * rename (history, tags and permissions stay); without it, a rename is a delete and a create.
   */
  stableIds: boolean;
  /**
   * URL schemes redirect() may return besides `https:`, lower-case with the colon (`file:`,
   * `ms-word:`). Anything else it returns is refused.
   */
  redirectSchemes?: readonly string[];
}

/** Someone the source names, as the source identifies them. The core maps them (T-305). */
export interface SourceUser {
  /** The source's own id for them (an Entra object id, a uid). */
  id: string;
  email?: string;
  name?: string;
}

/**
 * One file or folder as the source reports it. Folders are reported so paths and parents can be
 * followed; the catalog records files.
 */
export interface SourceItem {
  /** The source's id for the item: stable across renames and moves when `stableIds`. */
  externalId: string;
  kind: "file" | "folder";
  /** The folder it is in (its externalId), or null at the top of what the connector serves. */
  parentId: string | null;
  /**
   * Names from the top of what the connector serves down to this item, its own name last. Never
   * joined into one string by the core: names may hold characters another system reads as a
   * separator.
   */
  path: readonly string[];
  /** A title the source keeps apart from the name (SharePoint's Title). Default: the name. */
  title?: string;
  /** Files: the media type the source reports. */
  mediaType?: string;
  /** Files: the exact size in bytes. Required for files. */
  size?: number;
  /** When the content or the item last changed, as the source says (ISO 8601). */
  modifiedAt?: string;
  /** Who last changed it, as the source says. */
  modifiedBy?: SourceUser;
  /**
   * Changes whenever anything reported here changes: content, name, parent, path (so moving or
   * renaming a folder changes the eTag of everything in it), media type. The sync runner skips
   * an item whose eTag it has already recorded.
   */
  etag: string;
  /**
   * Files: changes whenever the bytes change (it may change when they don't, as a touch does).
   * read() is asked for this version and refuses to return any other. Required for files.
   */
  contentVersion?: string;
  /** Where people find the item (a web URL, a file: URL): kept with it, and a hint for read(). */
  url?: string;
}

/**
 * What crawl() and delta() yield, in the source's order. The runner applies them in that order,
 * so a stale update is never applied after a newer one or a delete.
 *
 * - `item`: the item exists as described (created, changed, renamed or moved).
 * - `deleted`: the item is gone (or moved out of what the connector serves). A deleted folder's
 *   items are reported deleted too, each of them: the core keeps no tree to infer them from.
 * - `checkpoint`: everything yielded before it has been applied once the runner has saved the
 *   token. Passed back to the same method (crawl() or delta()), the token resumes right after
 *   it. Yield one at least every few hundred items so a killed crawl loses little.
 * - `done`: the last event. `cursor` is what delta() starts from next time: it must cover every
 *   change made after the crawl or delta began looking, even at items it had already yielded.
 */
export type SyncEvent =
  | { type: "item"; item: SourceItem }
  | { type: "deleted"; externalId: string }
  | { type: "checkpoint"; token: string }
  | { type: "done"; cursor: string };

/** Which item, and which of its versions, a caller means. Built from what a crawl reported. */
export interface ItemRef {
  externalId: string;
  /** read(): the contentVersion the caller expects; any other is refused. */
  contentVersion?: string;
  /** The size the caller expects, when it knows. */
  size?: number;
  /** The item's url as last reported: a hint for finding it, never trusted alone. */
  url?: string;
  /** The item's path as last reported: a hint, like `url`. */
  path?: readonly string[];
}

/** An item's bytes, as read() returns them. */
export interface ReadResult {
  /** The version the bytes are: always the one asked for. */
  contentVersion: string;
  size: number;
  /**
   * The bytes. It must throw (a ConnectorError `changed`) at its end if the item changed while
   * it was read, and stop when the signal read() was given aborts.
   */
  body: AsyncIterable<Uint8Array>;
  /** The source's own hash of the content (`sha256:…`, `quickxor:…`), when it has one. */
  contentId?: string;
}

/** A role on an item, strongest last. */
export const ACL_ROLES = ["read", "write", "owner"] as const;
export type AclRole = (typeof ACL_ROLES)[number];

/**
 * Who a permission is for, by the source's own ids. The core maps these to its users and groups
 * (T-305); until it can, a permission grants nothing.
 */
export type AclPrincipal =
  | { kind: "user"; id: string; email?: string }
  | { kind: "group"; id: string }
  /** Someone from outside the organization, known by email (an invitation). */
  | { kind: "guest"; email: string; id?: string }
  /** A sharing link: whoever holds it, within `scope`. */
  | { kind: "link"; id: string; scope: "anyone" | "organization" | "specific" }
  /** Everyone in the organization (SharePoint's "Everyone except external users"). */
  | { kind: "organization" };

export interface AclEntry {
  principal: AclPrincipal;
  role: AclRole;
  /** True when it comes from a folder or site above the item rather than the item itself. */
  inherited: boolean;
  /** When it lapses (ISO 8601), if the source says. */
  expiresAt?: string;
}

/** An item's permissions as the source reports them. */
export interface ItemAcl {
  /** Normalized ({@link normalizeAcl} in validate.ts): one entry per principal, sorted. */
  entries: readonly AclEntry[];
  /**
   * Where the entries come from:
   * - `source`: the source's own permissions;
   * - `configured`: the source has none a connector can read portably (a local folder), and these
   *   are the default the admin configured for the connection;
   * - `owner-only`: neither: only the object's owner in OpenHoard may see it. `entries` is empty.
   */
  basis: "source" | "configured" | "owner-only";
}

/**
 * The contract every connector implements (interface v1). Every method takes an AbortSignal
 * and must stop soon after it aborts, rejecting with the signal's reason (or an AbortError).
 * Failures are ConnectorErrors (errors.ts), whose code tells the runner what to do next.
 */
export interface Connector {
  describe(): ConnectorDescription;
  /**
   * Every item, parents before their children, ending with `done`. `checkpoint` null starts
   * from the beginning; a token from a `checkpoint` event resumes after it. A token it can't
   * use any more throws `resync`: the runner starts again from null.
   */
  crawl(checkpoint: string | null, signal: AbortSignal): AsyncIterable<SyncEvent>;
  /**
   * The changes since `cursor` (a `done` cursor, or a delta's `checkpoint` token), in order,
   * parents before children, ending with `done`. Nothing but `done` when nothing changed. A
   * cursor it can't use any more throws `resync`: the runner crawls everything again.
   */
  delta?(cursor: string, signal: AbortSignal): AsyncIterable<SyncEvent>;
  /**
   * An item's bytes, exactly the version `ref.contentVersion` names. When the item is now
   * another version it refuses (`changed`) rather than return newer bytes, which belong to the
   * next version; `not-found` when it is gone. The content ContentSource contract (core/catalog)
   * rests on this.
   */
  read(ref: ItemRef, signal: AbortSignal): Promise<ReadResult>;
  /** An item's permissions, normalized. `not-found` when it is gone. */
  aclImport?(ref: ItemRef, signal: AbortSignal): Promise<ItemAcl>;
  /**
   * A URL that opens the item in its own app or site (FR-20): `https:`, or a scheme listed in
   * `redirectSchemes`. `not-found` when it is gone.
   */
  redirect?(ref: ItemRef, signal: AbortSignal): Promise<string>;
  /** Releases what it holds (connections, files). Optional. */
  close?(): Promise<void>;
}

/** Identity helper that gives connector authors type checking and one greppable entry point. */
export function defineConnector<C extends Connector>(connector: C): C {
  return connector;
}

type Capability = PluginManifest["capabilities"][number];

/**
 * The manifest capabilities a connector with this description needs declared and approved:
 * `source:crawl` and `read:content` always, and one per optional capability.
 */
export function manifestCapabilities(description: ConnectorDescription): Capability[] {
  const caps: Capability[] = ["source:crawl", "read:content"];
  if (description.capabilities.delta) caps.push("source:delta");
  if (description.capabilities.aclImport) caps.push("import:acl");
  if (description.capabilities.redirect) caps.push("source:redirect");
  return caps;
}
