import { createHash } from "node:crypto";
import {
  changedError,
  checkItem,
  checkUrl,
  CONNECTOR_API_VERSION,
  ConnectorError,
  defineConnector,
  isAbortError,
  isConnectorError,
  LIMITS,
  notFoundError,
  resyncError,
  type Connector,
  type ConnectorDescription,
  type ItemRef,
  type ReadResult,
  type SourceItem,
  type SyncEvent,
} from "@openhoard/sdk";
import type { GraphAuth } from "./auth.js";
import { graphClient, isForbidden, type GraphClient } from "./graph.js";
import { retryAfterMs } from "./http.js";
import { sitePath } from "./probe.js";

/*
 * The SharePoint connector (T-303): one site's document libraries, crawled in place through
 * Microsoft Graph.
 *
 * What it serves: every drive (document library) of the configured site. Each library is a
 * folder at the top, named after the library; its files and folders are below it. An item's
 * externalId is `<drive id>:<item id>`, which stays the same when the item is renamed or moved
 * within the library.
 *
 * How it crawls: library by library (in the order of their ids), through Graph's delta
 * enumeration from the beginning (`/drives/{id}/root/delta`), a page at a time. After each page
 * it yields a checkpoint holding the link to the next page, so a crawl killed anywhere goes on
 * from the last page whose items were recorded. The delta links a finished library ends with
 * are kept in the token and become the `done` cursor, which is what following changes (T-304)
 * starts from.
 *
 * Paths: delta gives each item its parent's id, not its path, and promises no order. The
 * connector keeps the folders it has seen (id → path) while it crawls a library. A parent it
 * hasn't seen (the feed gave a child first, or the crawl resumed mid-library with nothing
 * remembered) is asked for by id, with its ancestors, and yielded before the child: parents
 * always come before their children, and nothing needs to be kept between runs.
 *
 * What it doesn't do yet: follow changes (delta(), T-304), import permissions (aclImport(),
 * T-305: until then only the object's owner in OpenHoard sees a file), pace itself under
 * throttling beyond reporting it (T-306).
 */

export const SHAREPOINT_CONNECTOR_VERSION = "0.1.0";

export interface SharePointConnectorOptions {
  /** How it signs in to Graph (graphAuth()). */
  auth: GraphAuth;
  /**
   * The site: its id (`contoso.sharepoint.com,<guid>,<guid>`), or its host and path
   * (`contoso.sharepoint.com:/sites/finance`).
   */
  site: string;
  /** Items asked for per page (1 to 999). Default 200. A checkpoint follows each page. */
  pageSize?: number;
  /**
   * Where a file's bytes may be fetched from besides Graph itself: host names, or suffixes
   * starting with a dot. Default `[".sharepoint.com"]` (a national cloud has its own). Graph
   * answers a download with a link; one to any other host is not followed.
   */
  downloadHosts?: readonly string[];
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Milliseconds. Default `Date.now`. */
  now?: () => number;
}

const DESCRIPTION: ConnectorDescription = {
  apiVersion: CONNECTOR_API_VERSION,
  id: "connector-sharepoint",
  version: SHAREPOINT_CONNECTOR_VERSION,
  zoneKinds: ["indexed"],
  capabilities: { delta: false, aclImport: false, redirect: true },
  stableIds: true,
};

/** What is asked of Graph for each item: what an event is made of, and no more. */
const ITEM_FIELDS =
  "id,name,size,eTag,file,folder,package,root,deleted,parentReference,lastModifiedDateTime,lastModifiedBy,webUrl";
/** An id of Graph's as it may go into a URL and an externalId: no separator of either. */
const GRAPH_ID = /^[A-Za-z0-9!_.~-]{1,512}$/;
const MAX_DRIVES = 5000;
/** Pages of libraries followed for one site: far more than MAX_DRIVES needs. */
const MAX_DRIVE_PAGES = 100;

interface Drive {
  id: string;
  /** Its name as a folder at the top: the library's name, made unique. */
  name: string;
  webUrl: string | undefined;
}

/** The crawl's position: what a checkpoint token holds. */
interface Position {
  v: 1;
  /** The site's id: a token made for another site is not used. */
  site: string;
  /** The library under way and the link to its next page; null between libraries. */
  drive: string | null;
  link: string | null;
  /** The libraries finished, with the delta link each ended with. */
  done: Record<string, string>;
}

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const externalIdOf = (driveId: string, itemId: string) => `${driveId}:${itemId}`;

/** The drive and item an externalId names, or undefined when it isn't one of this connector's. */
function parseExternalId(externalId: string): { drive: string; item: string } | undefined {
  const at = externalId.indexOf(":");
  if (at < 1) return undefined;
  const drive = externalId.slice(0, at);
  const item = externalId.slice(at + 1);
  return GRAPH_ID.test(drive) && GRAPH_ID.test(item) ? { drive, item } : undefined;
}

const itemUrl = (drive: string, item: string) =>
  `/v1.0/drives/${encodeURIComponent(drive)}/items/${encodeURIComponent(item)}`;

/** The kinds of content version, by what of Graph's they are made from. */
const VERSION_KINDS = {
  q: (raw: Raw) => str(hashesOf(raw).quickXorHash),
  s: (raw: Raw) => str(hashesOf(raw).sha256Hash),
  e: (raw: Raw) => str(raw.eTag),
} as const;
type VersionKind = keyof typeof VERSION_KINDS;

const hashesOf = (raw: Raw): Raw =>
  isObject(raw.file) && isObject(raw.file.hashes) ? raw.file.hashes : {};

/**
 * The version of a file's bytes, from what Graph says of it: its content hash when it gives
 * one, else its eTag (which also changes on a rename: the bytes are then read again, never
 * missed). Never its cTag: SharePoint's delta feed leaves it out and an item asked for by id
 * has it, so a version made from it at one place couldn't be compared at the other.
 *
 * With `like`, the version of the same kind as that one (`q:…`, `s:…`, `e:…`), or undefined
 * when Graph doesn't give that any more: read() compares like with like, whatever each answer
 * happens to hold.
 */
function contentVersionOf(raw: Raw, like?: string): string | undefined {
  const kinds = Object.keys(VERSION_KINDS) as VersionKind[];
  const wanted = like === undefined ? kinds : kinds.filter((k) => like.startsWith(`${k}:`));
  for (const kind of wanted) {
    const value = VERSION_KINDS[kind](raw);
    if (value !== undefined) return `${kind}:${value}`;
  }
  return undefined;
}

/** The source's own hash of the content, as ReadResult.contentId names it. */
function contentIdOf(raw: Raw): string | undefined {
  const hashes = hashesOf(raw);
  const sha256 = str(hashes.sha256Hash);
  if (sha256 !== undefined && /^[0-9a-f]{64}$/i.test(sha256)) {
    return `sha256:${sha256.toLowerCase()}`;
  }
  const quickXor = str(hashes.quickXorHash);
  return quickXor === undefined ? undefined : `quickxor:${quickXor}`;
}

/**
 * An eTag for the runner: changes when anything reported changes. Graph's own eTag doesn't
 * change for what is inside a renamed or moved folder, and the path does, so it is made of both.
 */
function etagOf(raw: Raw, path: readonly string[], contentVersion: string | undefined): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        str(raw.eTag) ?? "",
        contentVersion ?? "",
        str(raw.lastModifiedDateTime) ?? "",
        path,
      ]),
    )
    .digest("base64url");
}

/** The folders of one library seen so far: id → path, or null for one that can't be served. */
type Tree = Map<string, readonly string[] | null>;

export function sharepointConnector(options: SharePointConnectorOptions): Connector {
  const pageSize = options.pageSize ?? 200;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 999) {
    throw new RangeError("pageSize must be 1 to 999");
  }
  const sitePathname = sitePath(options.site); // refused now, not at the first sync
  const now = options.now ?? Date.now;
  const send = options.fetch ?? fetch;
  const downloadHosts = (options.downloadHosts ?? [".sharepoint.com"]).map((h) => h.toLowerCase());
  // A suffix has two names at least: ".com" would allow anyone's host.
  if (downloadHosts.some((h) => !/^\.?([a-z0-9-]+\.)+[a-z0-9-]+$/.test(h))) {
    throw new Error(
      "downloadHosts must be host names, or suffixes starting with a dot (.sharepoint.com)",
    );
  }
  const client: GraphClient = graphClient({
    auth: options.auth,
    now,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  let siteAsked: Promise<string> | undefined;
  /** The site's id as Graph gives it. Asked once; a failure is asked again. */
  function siteId(signal: AbortSignal): Promise<string> {
    siteAsked ??= client
      .json(`${sitePathname}?$select=id,displayName,webUrl`, signal)
      .then((site) => {
        const id = str(site.id);
        if (id === undefined) {
          throw new ConnectorError("retryable", "Graph's answer wasn't a site");
        }
        return id;
      })
      .catch((e: unknown) => {
        siteAsked = undefined;
        // Asking again won't find it: the configuration names a site there isn't.
        if (isConnectorError(e) && e.code === "not-found") {
          throw new ConnectorError("permanent", "Graph has no such site");
        }
        throw e;
      });
    return siteAsked;
  }

  /** The site's libraries, in the order of their ids, each with a name no other has. */
  async function drivesOf(site: string, signal: AbortSignal): Promise<Drive[]> {
    const found: Drive[] = [];
    let link: string | undefined =
      `/v1.0/sites/${encodeURIComponent(site).replaceAll("%2C", ",")}/drives?$select=id,name,webUrl&$top=200`;
    for (let pages = 0; link !== undefined; pages++) {
      if (pages >= MAX_DRIVE_PAGES) {
        throw new ConnectorError("retryable", "Graph's list of libraries doesn't end");
      }
      const page: Raw = await client.json(link, signal);
      if (!Array.isArray(page.value)) {
        throw new ConnectorError("retryable", "Graph's answer wasn't a list of libraries");
      }
      for (const raw of page.value as unknown[]) {
        const id = isObject(raw) ? str(raw.id) : undefined;
        if (!isObject(raw) || id === undefined || !GRAPH_ID.test(id)) {
          // Not passed over: a crawl without one of its libraries would take its files for gone.
          throw new ConnectorError("retryable", "Graph listed a library this connector can't name");
        }
        found.push({ id, name: str(raw.name) ?? id, webUrl: str(raw.webUrl) });
        if (found.length > MAX_DRIVES) {
          throw new ConnectorError(
            "permanent",
            "the site has more libraries than one source takes",
          );
        }
      }
      const next = str(page["@odata.nextLink"]);
      if (next !== undefined && next === link) {
        throw new ConnectorError("retryable", "Graph's next page is the page it gave");
      }
      link = next;
    }
    found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // A library is a folder at the top: its name must be one, and no other's.
    const names = new Map<string, number>();
    for (const d of found) {
      if (!nameIsOne(d.name)) d.name = d.id;
      names.set(d.name, (names.get(d.name) ?? 0) + 1);
    }
    for (const d of found) {
      if ((names.get(d.name) ?? 0) <= 1) continue;
      const told = `${d.name} (${d.id})`;
      d.name = nameIsOne(told) ? told : d.id;
    }
    return found;
  }

  const nameIsOne = (name: string) =>
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    checkItem({ externalId: "x", kind: "folder", parentId: null, path: [name], etag: "x" }) ===
      null;

  /** A token as text, refused when it is longer than a token may be. */
  function tokenOf(position: Position): string {
    const token = JSON.stringify(position);
    if ([...token].length > LIMITS.token) {
      throw new ConnectorError(
        "permanent",
        "the site has more libraries than one source can keep its place in",
      );
    }
    return token;
  }

  /** The position a token holds. One that isn't this site's, or isn't usable, means: again. */
  function positionOf(token: string, site: string): Position {
    let parsed: unknown;
    try {
      parsed = JSON.parse(token);
    } catch {
      throw resyncError();
    }
    if (!isObject(parsed) || parsed.v !== 1 || parsed.site !== site || !isObject(parsed.done)) {
      throw resyncError();
    }
    const { drive, link } = parsed;
    const midway = typeof drive === "string" && typeof link === "string";
    if (!midway && !(drive === null && link === null)) throw resyncError();
    const done: Record<string, string> = {};
    for (const [id, delta] of Object.entries(parsed.done)) {
      // A link is followed with the app's token on: only one of Graph's own.
      if (!GRAPH_ID.test(id) || typeof delta !== "string" || !client.owns(delta)) {
        throw resyncError();
      }
      done[id] = delta;
    }
    if (midway && (!GRAPH_ID.test(drive) || !client.owns(link))) throw resyncError();
    return { v: 1, site, drive: midway ? drive : null, link: midway ? link : null, done };
  }

  /** A folder event for a library's top, or an item's, from what Graph says of it. */
  function eventOf(
    drive: Drive,
    raw: Raw,
    id: string,
    kind: "file" | "folder",
    parentId: string | null,
    path: readonly string[],
  ): SyncEvent {
    const externalId = externalIdOf(drive.id, id);
    const contentVersion = kind === "file" ? contentVersionOf(raw) : undefined;
    const modified = Date.parse(str(raw.lastModifiedDateTime) ?? "");
    const by =
      isObject(raw.lastModifiedBy) && isObject(raw.lastModifiedBy.user)
        ? raw.lastModifiedBy.user
        : {};
    const byId = str(by.id);
    const url = parentId === null ? (drive.webUrl ?? str(raw.webUrl)) : str(raw.webUrl);
    const mediaType = isObject(raw.file) ? str(raw.file.mimeType) : undefined;
    const item: SourceItem = {
      externalId,
      kind,
      parentId: parentId === null ? null : externalIdOf(drive.id, parentId),
      path,
      etag: etagOf(raw, path, contentVersion),
      ...(kind === "file"
        ? {
            size: raw.size as number,
            ...(contentVersion === undefined ? {} : { contentVersion }),
            ...(mediaType !== undefined && [...mediaType].length <= LIMITS.mediaType
              ? { mediaType }
              : {}),
          }
        : {}),
      ...(Number.isFinite(modified) ? { modifiedAt: new Date(modified).toISOString() } : {}),
      ...(byId === undefined
        ? {}
        : {
            modifiedBy: {
              id: byId,
              ...(str(by.email) === undefined ? {} : { email: str(by.email) as string }),
              ...(str(by.displayName) === undefined ? {} : { name: str(by.displayName) as string }),
            },
          }),
      ...(url !== undefined && checkUrl(url) === null ? { url } : {}),
    };
    // Who changed it last is worth less than the item: left out when it can't be kept.
    if (checkItem(item, DESCRIPTION) !== null && item.modifiedBy !== undefined) {
      delete (item as { modifiedBy?: unknown }).modifiedBy;
    }
    // Nothing is yielded that the runner would refuse. An item it can't serve is warned of by
    // its id, which the runner takes as mentioned: it is there, and not taken for gone.
    return checkItem(item, DESCRIPTION) === null
      ? { type: "item", item }
      : { type: "warning", code: "invalid-item", externalId };
  }

  /**
   * The path of a folder by its id, asking Graph for the folders above an item the crawl
   * hasn't seen. Folders found that way are added to `out`, parents first, so they are yielded
   * before the item that needed them. Null: the folder can't be served (its name isn't one, it
   * is gone, or it is too deep), and neither can what is in it.
   */
  async function pathOf(
    drive: Drive,
    tree: Tree,
    folderId: string,
    out: SyncEvent[],
    signal: AbortSignal,
  ): Promise<readonly string[] | null> {
    const known = tree.get(folderId);
    if (known !== undefined) return known;
    // Up from the folder to one that is known (or the top), then back down.
    const chain: { id: string; raw: Raw; parentId: string | null }[] = [];
    let base: readonly string[] | null | undefined;
    for (let id = folderId; ;) {
      if (
        !GRAPH_ID.test(id) ||
        chain.length >= LIMITS.pathDepth ||
        chain.some((c) => c.id === id)
      ) {
        base = null;
        break;
      }
      let raw: Raw;
      try {
        raw = await client.json(`${itemUrl(drive.id, id)}?$select=${ITEM_FIELDS}`, signal);
      } catch (e) {
        // Gone since the page was made, or this one folder is refused: what is in it can't be
        // placed. (The app's token being refused is another matter, and stops the crawl.)
        if (!(isConnectorError(e) && e.code === "not-found") && !isForbidden(e)) throw e;
        base = null;
        break;
      }
      if (isObject(raw.root)) {
        chain.push({ id, raw, parentId: null });
        base = [];
        break;
      }
      const parentId = isObject(raw.parentReference) ? str(raw.parentReference.id) : undefined;
      if (parentId === undefined || !(isObject(raw.folder) || isObject(raw.package))) {
        base = null;
        break;
      }
      chain.push({ id, raw, parentId });
      const above = tree.get(parentId);
      if (above !== undefined) {
        base = above;
        break;
      }
      id = parentId;
    }
    let path: readonly string[] | null = base ?? null;
    for (const link of chain.reverse()) {
      const name = link.parentId === null ? drive.name : str(link.raw.name);
      path =
        path === null || name === undefined || !nameIsOne(name) || path.length >= LIMITS.pathDepth
          ? null
          : [...path, name];
      tree.set(link.id, path);
      if (path !== null) out.push(eventOf(drive, link.raw, link.id, "folder", link.parentId, path));
    }
    if (!tree.has(folderId)) tree.set(folderId, null);
    return tree.get(folderId) ?? null;
  }

  /** The events one entry of a delta page becomes. */
  async function eventsOf(
    drive: Drive,
    tree: Tree,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<SyncEvent[]> {
    const id = isObject(raw) ? str(raw.id) : undefined;
    if (!isObject(raw) || id === undefined || !GRAPH_ID.test(id)) {
      // Something is there and can't even be named, so it can't be said to be mentioned:
      // unknown, not gone. This crawl takes nothing for deleted.
      return [{ type: "warning", code: "unreadable" }];
    }
    const externalId = externalIdOf(drive.id, id);
    if (isObject(raw.deleted)) {
      // Not said as a deletion: a crawl's reconcile removes what it didn't see, behind the
      // runner's guard against removing too much, which a `deleted` event would go around.
      // (For T-304: an item yielded earlier in this crawl and deleted here stays until the
      // next crawl. Once delta() starts from this crawl's links, that deletion is behind them:
      // it must then be said here.)
      tree.delete(id);
      return [];
    }
    if (isObject(raw.root)) {
      const path = [drive.name];
      tree.set(id, path);
      return [eventOf(drive, raw, id, "folder", null, path)];
    }
    const kind = isObject(raw.file)
      ? "file"
      : isObject(raw.folder) || isObject(raw.package)
        ? "folder"
        : undefined;
    // Something that is neither (a link to another library's item): not served.
    if (kind === undefined) return [{ type: "warning", code: "unsupported-item", externalId }];
    if (kind === "file" && !(Number.isSafeInteger(raw.size) && (raw.size as number) >= 0)) {
      return [{ type: "warning", code: "invalid-item", externalId }];
    }
    const parentId = isObject(raw.parentReference) ? str(raw.parentReference.id) : undefined;
    const name = str(raw.name);
    const out: SyncEvent[] = [];
    const above = parentId === undefined ? null : await pathOf(drive, tree, parentId, out, signal);
    if (
      above === null ||
      name === undefined ||
      !nameIsOne(name) ||
      above.length >= LIMITS.pathDepth
    ) {
      // It is there, and can't be served: its name isn't one, or its folder can't be placed
      // (misnamed, too deep, gone or refused when asked for). Graph lists everything under
      // such a folder too, each by its id, so each is warned of in turn, none taken for gone.
      if (kind === "folder") tree.set(id, null);
      out.push({
        type: "warning",
        code: above === null ? "unplaced-item" : "invalid-item",
        externalId,
      });
      return out;
    }
    const path = [...above, name];
    if (kind === "folder") tree.set(id, path);
    out.push(eventOf(drive, raw, id, kind, parentId as string, path));
    return out;
  }

  async function* crawl(checkpoint: string | null, signal: AbortSignal): AsyncGenerator<SyncEvent> {
    signal.throwIfAborted();
    const site = await siteId(signal);
    let position: Position =
      checkpoint === null
        ? { v: 1, site, drive: null, link: null, done: {} }
        : positionOf(checkpoint, site);
    const drives = await drivesOf(site, signal);
    // The library the token was in the middle of is gone: its place means nothing now.
    if (position.drive !== null && !drives.some((d) => d.id === position.drive)) {
      throw resyncError();
    }
    // The library the token was in the middle of goes first, so a library added meanwhile
    // doesn't take its place in the token; then the rest, in the order of their ids.
    const order = [
      ...drives.filter((d) => d.id === position.drive),
      ...drives.filter((d) => d.id !== position.drive),
    ];
    for (const drive of order) {
      if (position.done[drive.id] !== undefined) continue;
      let link =
        position.drive === drive.id && position.link !== null
          ? position.link
          : `/v1.0/drives/${encodeURIComponent(drive.id)}/root/delta?$select=${ITEM_FIELDS}&$top=${pageSize}`;
      const tree: Tree = new Map();
      // A link out of a token may have lapsed since: refused, it means "from the start".
      let fromToken = position.drive === drive.id && position.link !== null;
      for (;;) {
        const page = await client.json(link, signal).catch((e: unknown) => {
          if (fromToken && isConnectorError(e) && ["permanent", "not-found"].includes(e.code)) {
            throw resyncError();
          }
          throw e;
        });
        fromToken = false;
        if (!Array.isArray(page.value)) {
          throw new ConnectorError("retryable", "Graph's answer wasn't a page of items");
        }
        for (const raw of page.value as unknown[]) {
          for (const event of await eventsOf(drive, tree, raw, signal)) yield event;
          signal.throwIfAborted();
        }
        const next = str(page["@odata.nextLink"]);
        const delta = str(page["@odata.deltaLink"]);
        if (next !== undefined) {
          if (next === link) {
            throw new ConnectorError("retryable", "Graph's next page is the page it gave");
          }
          if (!client.owns(next)) {
            throw new ConnectorError(
              "permanent",
              "Graph gave a link that isn't Graph's: not followed",
            );
          }
          position = { ...position, drive: drive.id, link: next };
          yield { type: "checkpoint", token: tokenOf(position) };
          link = next;
          continue;
        }
        if (delta === undefined || !client.owns(delta)) {
          throw new ConnectorError("retryable", "Graph's last page had no link to go on from");
        }
        position = {
          v: 1,
          site,
          drive: null,
          link: null,
          done: { ...position.done, [drive.id]: delta },
        };
        yield { type: "checkpoint", token: tokenOf(position) };
        break;
      }
    }
    // What following changes starts from: each library's delta link, of the libraries there are.
    const done: Record<string, string> = {};
    for (const drive of drives) done[drive.id] = position.done[drive.id] as string;
    yield { type: "done", cursor: tokenOf({ v: 1, site, drive: null, link: null, done }) };
  }

  /** What Graph says of one item now, for read() and redirect(). */
  async function itemNow(ref: ItemRef, fields: string, signal: AbortSignal) {
    const at = parseExternalId(ref.externalId);
    if (!at) throw notFoundError("not an item of this source");
    const raw = await client.json(`${itemUrl(at.drive, at.item)}?$select=${fields}`, signal);
    if (isObject(raw.deleted)) throw notFoundError();
    return { at, raw };
  }

  async function read(ref: ItemRef, signal: AbortSignal): Promise<ReadResult> {
    signal.throwIfAborted();
    const fields = "id,size,eTag,file,deleted";
    const { at, raw } = await itemNow(ref, fields, signal);
    // Like with like: the version of the kind the crawl recorded, from this answer.
    const version = contentVersionOf(raw, ref.contentVersion);
    const size = raw.size;
    if (!isObject(raw.file) || !Number.isSafeInteger(size)) {
      throw new ConnectorError("permanent", "the item is not a file");
    }
    if (
      version === undefined ||
      (ref.contentVersion !== undefined && ref.contentVersion !== version)
    ) {
      throw changedError();
    }
    // Before any bytes are asked for: nothing is left open when the caller stops here.
    if (ref.size !== undefined && ref.size !== size) throw changedError();

    // Graph answers with the bytes, or with a link to them that needs no token (and gets none).
    let response = await client
      .get(`${itemUrl(at.drive, at.item)}/content`, signal, { pass: [302] })
      .catch((e: unknown) => {
        // The item was just read: this one file's bytes are refused (a policy on it), not the
        // app. Passed over, with the rest of the site going on.
        if (isForbidden(e)) {
          throw new ConnectorError("permanent", "Graph refused this file's content");
        }
        throw e;
      });
    if (response.status === 302) {
      const location = response.headers.get("location") ?? "";
      await response.body?.cancel().catch(() => undefined);
      response = await download(location, signal);
    }
    const stream = response.body;
    const contentId = contentIdOf(raw);

    async function* body(): AsyncGenerator<Uint8Array> {
      let seen = 0;
      if (stream) {
        const reader = stream.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            seen += value.byteLength;
            if (seen > (size as number)) throw changedError();
            yield value;
          }
        } catch (e) {
          if (isAbortError(e, signal) || isConnectorError(e)) throw e;
          throw new ConnectorError("retryable", "the download was cut short", { cause: e });
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      }
      if (seen !== size) throw changedError();
      // The bytes are whole. Are they still the version asked for? Asked after, not assumed.
      const after = await itemNow(ref, fields, signal).catch((e: unknown) => {
        if (isConnectorError(e) && e.code === "not-found") throw changedError();
        throw e;
      });
      if (contentVersionOf(after.raw, version) !== version) throw changedError();
    }

    return {
      contentVersion: version,
      size: size as number,
      body: body(),
      ...(contentId === undefined ? {} : { contentId }),
    };
  }

  /** Whether a download link is one to fetch: Graph's own origin, or https at a host allowed. */
  function mayDownload(location: string): boolean {
    if (client.owns(location)) return true;
    if (checkUrl(location) !== null) return false;
    const host = new URL(location).hostname.toLowerCase();
    return downloadHosts.some((h) => (h.startsWith(".") ? host.endsWith(h) : host === h));
  }

  /** GETs a download link Graph gave, never with the token, following nothing further. */
  async function download(location: string, signal: AbortSignal): Promise<Response> {
    if (!mayDownload(location)) {
      throw new ConnectorError(
        "permanent",
        "Graph gave a download link to a host that isn't allowed (downloadHosts)",
      );
    }
    let response: Response;
    try {
      // As it was parsed for the check above, so nothing reads the text another way.
      response = await send(new URL(location).href, { redirect: "manual", signal });
    } catch (e) {
      if (isAbortError(e, signal)) throw e;
      throw new ConnectorError("retryable", "the download couldn't be reached", { cause: e });
    }
    const { status } = response;
    if (status === 200) return response;
    await response.body?.cancel().catch(() => undefined);
    // The link was for the bytes as they were: gone means they are others now.
    if (status === 404) throw changedError();
    const wait = retryAfterMs(response.headers.get("retry-after"), now());
    if (status === 429 || (status === 503 && wait !== undefined)) {
      throw new ConnectorError("throttled", `the download was asked to slow down (${status})`, {
        retryAfterMs: wait ?? 30_000,
      });
    }
    if (status >= 500 || status === 408) {
      throw new ConnectorError("retryable", `the download failed (${status})`);
    }
    // Refused, or sent elsewhere: trying again changes nothing. This file is passed over.
    throw new ConnectorError("permanent", `the download was refused (${status})`);
  }

  return defineConnector({
    describe: () => DESCRIPTION,
    crawl,
    read,
    async redirect(ref, signal) {
      signal.throwIfAborted();
      const { raw } = await itemNow(ref, "id,webUrl,deleted", signal);
      const url = str(raw.webUrl);
      if (url === undefined || checkUrl(url) !== null) {
        throw new ConnectorError("permanent", "Graph gave no address to open the item at");
      }
      return url;
    },
    async identity(signal) {
      return `sharepoint:${await siteId(signal)}`;
    },
  });
}
