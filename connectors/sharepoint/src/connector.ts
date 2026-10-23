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
  type ItemAcl,
  type ItemRef,
  type ReadResult,
  type SourceItem,
  type SyncEvent,
} from "@openhoard/sdk";
import type { GraphAuth } from "./auth.js";
import { graphClient, isForbidden, type GraphClient } from "./graph.js";
import { retryAfterMs } from "./http.js";
import { pacer, sharedPacer, type Pacer } from "./pace.js";
import { aclEntriesOf } from "./permissions.js";
import { sitePath } from "./probe.js";
import {
  folderState,
  newStateId,
  type Folders,
  type FolderState,
  type LogLine,
  type SiteFolders,
} from "./state.js";
import { siteGroups, type SiteGroups } from "./sitegroups.js";
import { graphSubscriptions, type Subscriptions } from "./subscriptions.js";

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
 * hasn't seen (the feed gave a child first, or the crawl resumed mid-library) is asked for by
 * id, with its ancestors, and yielded before the child: parents always come before their
 * children.
 *
 * Following changes (T-304, with a `stateDir`): delta() asks each library's delta link for
 * what changed since, a whole round at a time, and yields it: items created, changed, renamed
 * or moved, and deletions. Graph says a folder was renamed or moved and nothing of what is in
 * it, whose paths changed too: the connector keeps each library's folders (state.ts), sees the
 * folder's name or place differ from what it kept, and asks Graph for everything under it, to
 * yield each with its new path. Anything that doesn't fit a round (too many changes, a library
 * added or removed, a link Graph no longer takes, kept folders that are missing, a cursor older
 * than `recrawlAfterDays`) means a crawl from the beginning (`resync`), whose reconcile also
 * mends whatever a delta missed: a folder renamed while a crawl was under way, a listing Graph
 * refused once, a deletion a crawl saw.
 *
 * Permissions (T-305): aclImport() gives an item's as Graph lists them (permissions.ts), for
 * the core to turn into grants, each SharePoint group's replaced by its members when the app
 * signs in with a certificate (sitegroups.ts). A delta is asked to mark the items whose sharing changed; a
 * folder so marked has everything under it mentioned again, as a moved one has.
 *
 * Requests keep to a budget shared by every source of the same app and tenant, and a throttle
 * is waited out in place when the wait is short (T-306: pace.ts, graph.ts).
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
  /**
   * Items asked for per page (1 to 999). A checkpoint follows each page, and a page's files are
   * recorded before it (a permissions list and a read each). Default: what the budget lets a
   * run record in a few minutes, 10 to 50.
   */
  pageSize?: number;
  /**
   * Where a file's bytes may be fetched from besides Graph itself: host names, or suffixes
   * starting with a dot. Default `[".sharepoint.com"]` (a national cloud has its own). Graph
   * answers a download with a link; one to any other host is not followed.
   */
  downloadHosts?: readonly string[];
  /**
   * A directory of this source's own, where the connector keeps each library's folders
   * between runs (state.ts). With it the connector follows changes (delta()); without it every
   * sync is a crawl.
   */
  stateDir?: string;
  /**
   * How old a crawl may be before changes are no longer followed from it and the site is
   * crawled again, in days. Default 7; 0 never.
   */
  recrawlAfterDays?: number;
  /**
   * Requests one library's round of changes may take (pages of the feed, and the listing of
   * renamed and moved folders) before the site is crawled instead. Default 1000.
   */
  roundRequests?: number;
  /**
   * False: the site's permissions are not read (aclImport()), and only the object's owner in
   * OpenHoard sees its files. Default true.
   */
  permissions?: boolean;
  /**
   * Graph's resource units a minute this app may spend in its tenant (pace.ts): the budget is
   * shared by every source signed in as the same app, and the first to start sets it. Default
   * 800, under Graph's smallest limits; 100 at least.
   */
  unitsPerMinute?: number;
  /**
   * How long one request may wait in place for Graph's throttling before the sync stops to
   * come back later, in ms. Default 60 s.
   */
  maxWaitMs?: number;
  /** How it waits (tests move their clock). Default: a timer. With `now`, it paces alone. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** What paces its requests, instead of the app's shared pacer (pace.ts). */
  pacer?: Pacer;
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
  capabilities: { delta: false, aclImport: true, redirect: true },
  stableIds: true,
};

/** What is asked of Graph for each item: what an event is made of, and no more. */
const ITEM_FIELDS =
  "id,name,size,eTag,file,folder,package,root,deleted,parentReference,lastModifiedDateTime,lastModifiedBy,createdBy,webUrl";
/** An id of Graph's as it may go into a URL and an externalId: no separator of either. */
const GRAPH_ID = /^[A-Za-z0-9!_.~-]{1,512}$/;
const MAX_DRIVES = 5000;
/** Pages followed for a site's libraries or an item's permissions: far more than any has. */
const MAX_LIST_PAGES = 100;
/** Changes, or events, taken in one round for one library, at most: more means "crawl again". */
const MAX_ROUND = 100_000;
/**
 * Items one round may mention when each has its permissions asked for: all of them are asked
 * before the round's checkpoint, so a round is sized to what one run can record.
 */
const MAX_ROUND_PERMISSIONS = 500;
/** Graph's units a file costs when it is recorded: its permissions (5) and its read (3). */
const UNITS_A_FILE = 8;
/** How long the work between two checkpoints is sized to take, in minutes: well inside a run. */
const RUN_MINUTES = 4;
/** The least budget a connector takes: under it a single page can't fit a run. */
const MIN_UNITS_PER_MINUTE = 100;
/** Asks a delta to mark the items whose sharing changed (`@microsoft.graph.sharedChanged`). */
const SHARING_CHANGES = { prefer: "deltashowsharingchanges" };
const STATE_ID = /^[a-z0-9]{8,40}$/;

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const externalIdOf = (driveId: string, itemId: string) => `${driveId}:${itemId}`;
const isFolder = (raw: Raw) => isObject(raw.root) || isObject(raw.folder) || isObject(raw.package);

interface Drive {
  id: string;
  /** Its name as a folder at the top: the library's name, made unique. */
  name: string;
  webUrl: string | undefined;
}

/** The crawl's position: what a checkpoint token holds. A cursor is one between libraries. */
interface Position {
  v: 1;
  /** The site's id: a token made for another site is not used. */
  site: string;
  /** The library under way and the link to its next page; null between libraries. */
  drive: string | null;
  link: string | null;
  /** The libraries finished, with the delta link each ended with. */
  done: Record<string, string>;
  /** A crawl with a state directory: its log of folders. */
  log?: string;
  /** A cursor: the generation of kept folders it goes with, and when its crawl ended (ms). */
  gen?: string;
  crawled?: number;
}

/** The drive and item an externalId names, or undefined when it isn't one of this connector's. */
function parseExternalId(externalId: string): { drive: string; item: string } | undefined {
  const at = externalId.indexOf(":");
  const [drive, item] = [externalId.slice(0, at), externalId.slice(at + 1)];
  return at > 0 && GRAPH_ID.test(drive) && GRAPH_ID.test(item) ? { drive, item } : undefined;
}

const itemUrl = (drive: string, item: string) =>
  `/v1.0/drives/${encodeURIComponent(drive)}/items/${encodeURIComponent(item)}`;

const hashesOf = (raw: Raw): Raw =>
  isObject(raw.file) && isObject(raw.file.hashes) ? raw.file.hashes : {};

/** The kinds of content version, by what of Graph's they are made from. */
const VERSION_KINDS = {
  q: (raw: Raw) => str(hashesOf(raw).quickXorHash),
  s: (raw: Raw) => str(hashesOf(raw).sha256Hash),
  e: (raw: Raw) => str(raw.eTag),
} as const;
type VersionKind = keyof typeof VERSION_KINDS;

/**
 * The version of a file's bytes, from what Graph says of it: its content hash when it gives
 * one, else its eTag (which also changes on a rename: the bytes are then read again, never
 * missed). Never its cTag: SharePoint's delta feed leaves it out and an item asked for by id
 * has it. With `like`, the version of the same kind as that one (`q:…`, `s:…`, `e:…`), or
 * undefined when Graph doesn't give that any more: read() compares like with like.
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
  const { sha256Hash, quickXorHash } = hashesOf(raw);
  if (typeof sha256Hash === "string" && /^[0-9a-f]{64}$/i.test(sha256Hash)) {
    return `sha256:${sha256Hash.toLowerCase()}`;
  }
  return str(quickXorHash) === undefined ? undefined : `quickxor:${quickXorHash as string}`;
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

/**
 * The folders of one library seen so far: id → path, or null for one that can't be served. And
 * the folders placed since they were last written to the crawl log.
 */
interface Tree {
  paths: Map<string, readonly string[] | null>;
  met: LogLine[];
  /** Folders asked of Graph and yielded this run: the feed's own entry isn't yielded again. */
  fetched: Set<string>;
}

/** What a round may still ask of Graph. Spent, the round is a crawl's work. */
interface Budget {
  left: number;
  /** What running out means; a crawl again unless said otherwise. */
  over?: () => Error;
}
function spend(budget: Budget): void {
  if (budget.left-- <= 0) throw budget.over ? budget.over() : resyncError();
}

/** With a `stateDir`, the connector also keeps Graph's change notifications (subscriptions.ts). */
export type SharePointConnector = Connector & {
  subscriptions?: (notify: { url: string; clientState: string }) => Subscriptions;
};

export function sharepointConnector(options: SharePointConnectorOptions): SharePointConnector {
  const { pageSize: askedPageSize, unitsPerMinute, roundRequests = 1000 } = options;
  const recrawlAfterDays = options.recrawlAfterDays ?? 7;
  if (
    askedPageSize !== undefined &&
    !(Number.isSafeInteger(askedPageSize) && askedPageSize >= 1 && askedPageSize <= 999)
  ) {
    throw new RangeError("pageSize must be 1 to 999");
  }
  if (unitsPerMinute !== undefined && !(unitsPerMinute >= MIN_UNITS_PER_MINUTE)) {
    throw new RangeError(`unitsPerMinute must be ${MIN_UNITS_PER_MINUTE} or more`);
  }
  if (!(Number.isFinite(recrawlAfterDays) && recrawlAfterDays >= 0)) {
    throw new RangeError("recrawlAfterDays must be 0 or more");
  }
  if (!Number.isSafeInteger(roundRequests) || roundRequests < 1) {
    throw new RangeError("roundRequests must be 1 or more");
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
  const pacing = {
    ...(unitsPerMinute === undefined ? {} : { unitsPerMinute }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  };
  const client: GraphClient = graphClient({
    auth: options.auth,
    now,
    // One budget an app and tenant, whichever of its sources is asking. A connector given a
    // clock of its own (tests) paces by that clock, alone.
    pacer:
      options.pacer ??
      (options.now === undefined && options.sleep === undefined
        ? sharedPacer(options.auth.account ?? options.auth.graph, pacing)
        : pacer({ ...pacing, now })),
    ...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  /**
   * Files a page of a crawl holds: each is recorded before the page's checkpoint, some
   * {@link UNITS_A_FILE} units each, so a page is sized to take about {@link RUN_MINUTES} at a
   * tenth of the budget (a throttled run).
   */
  const pageSize =
    askedPageSize ??
    Math.min(
      50,
      Math.max(10, Math.floor((client.pacer.budget * 0.1 * RUN_MINUTES) / UNITS_A_FILE)),
    );
  /** Items a list of children is asked for at a time: a list costs the same whatever its size. */
  const listSize = askedPageSize ?? 200;
  const state: FolderState | undefined =
    options.stateDir === undefined ? undefined : folderState(options.stateDir);
  const importing = options.permissions !== false;
  const description: ConnectorDescription = {
    ...DESCRIPTION,
    capabilities: { ...DESCRIPTION.capabilities, delta: state !== undefined, aclImport: importing },
  };
  /** With permissions imported, a delta is asked to say whose sharing changed. */
  const feedHeaders = importing ? SHARING_CHANGES : undefined;

  let siteAsked: Promise<string> | undefined;
  /** The site's address as Graph gave it with its id. */
  let siteWebUrl: string | undefined;
  /** The site's id as Graph gives it. Asked once; a failure is asked again. */
  function siteId(signal: AbortSignal): Promise<string> {
    siteAsked ??= client
      .json(`${sitePathname}?$select=id,displayName,webUrl`, signal)
      .then((site) => {
        const id = str(site.id);
        if (id === undefined) throw new ConnectorError("retryable", "Graph's answer wasn't a site");
        siteWebUrl = str(site.webUrl);
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

  /**
   * Every page of a list Graph pages (a library's changes, a folder's children, a site's
   * libraries), within a budget of requests: a list that doesn't end, or loops, runs out of it.
   * `kept`: the first link is one a cursor held, and Graph not taking it any more means "crawl
   * again".
   */
  async function* pagesOf(
    first: string,
    budget: Budget,
    signal: AbortSignal,
    { kept = false, headers }: { kept?: boolean; headers?: Record<string, string> } = {},
  ): AsyncGenerator<{ value: unknown[]; next: string | undefined; delta: string | undefined }> {
    for (let link = first; ;) {
      spend(budget);
      const page = await client
        .json(link, signal, headers ? { headers } : {})
        .catch((e: unknown) => {
          if (kept && link === first && isConnectorError(e)) {
            if (e.code === "permanent" || e.code === "not-found") throw resyncError();
          }
          throw e;
        });
      if (!Array.isArray(page.value)) {
        throw new ConnectorError("retryable", "Graph's answer wasn't a page of items");
      }
      const next = str(page["@odata.nextLink"]);
      const delta = str(page["@odata.deltaLink"]);
      if (next !== undefined) {
        if (next === link)
          throw new ConnectorError("retryable", "Graph's next page is the page it gave");
        if (!client.owns(next)) {
          throw new ConnectorError(
            "permanent",
            "Graph gave a link that isn't Graph's: not followed",
          );
        }
      }
      yield { value: page.value as unknown[], next, delta: next === undefined ? delta : undefined };
      if (next === undefined) return;
      link = next;
    }
  }

  /** The site's libraries, in the order of their ids, each with a name no other has. */
  async function drivesOf(site: string, signal: AbortSignal): Promise<Drive[]> {
    const found: Drive[] = [];
    const first = `/v1.0/sites/${encodeURIComponent(site).replaceAll("%2C", ",")}/drives?$select=id,name,webUrl&$top=200`;
    const over = () => new ConnectorError("retryable", "Graph's list of libraries doesn't end");
    for await (const page of pagesOf(first, { left: MAX_LIST_PAGES, over }, signal)) {
      for (const raw of page.value) {
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
    const p = parsed as Partial<Record<keyof Position, unknown>>;
    const ok =
      isObject(parsed) &&
      p.v === 1 &&
      p.site === site &&
      isObject(p.done) &&
      // A link is followed with the app's token on: only one of Graph's own.
      Object.entries(p.done).every(
        ([id, l]) => GRAPH_ID.test(id) && typeof l === "string" && client.owns(l),
      ) &&
      ((p.drive === null && p.link === null) ||
        (typeof p.drive === "string" &&
          GRAPH_ID.test(p.drive) &&
          typeof p.link === "string" &&
          client.owns(p.link))) &&
      (p.log === undefined || (typeof p.log === "string" && STATE_ID.test(p.log))) &&
      (p.gen === undefined || (typeof p.gen === "string" && STATE_ID.test(p.gen))) &&
      (p.crawled === undefined || (typeof p.crawled === "number" && Number.isFinite(p.crawled)));
    if (!ok) throw resyncError();
    return parsed as Position;
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
    /** A person as Graph's identity set names them, or undefined when it names none. */
    const person = (set: unknown) => {
      const user = isObject(set) && isObject(set.user) ? set.user : {};
      const [id, email, name] = [str(user.id), str(user.email), str(user.displayName)];
      return id === undefined
        ? undefined
        : {
            id,
            ...(email === undefined ? {} : { email }),
            ...(name === undefined ? {} : { name }),
          };
    };
    const modifiedBy = person(raw.lastModifiedBy);
    const createdBy = person(raw.createdBy);
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
      ...(modifiedBy === undefined ? {} : { modifiedBy }),
      ...(createdBy === undefined ? {} : { createdBy }),
      ...(url !== undefined && checkUrl(url) === null ? { url } : {}),
    };
    // Nothing is yielded that the runner would refuse. An item it can't serve is warned of by
    // its id, which the runner takes as mentioned: it is there, and not taken for gone.
    return checkItem(item, description) === null
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
    budget?: Budget,
  ): Promise<readonly string[] | null> {
    const known = tree.paths.get(folderId);
    if (known !== undefined) return known;
    // Up from the folder to one that is known (or the top), then back down.
    const chain: { id: string; raw: Raw; parentId: string | null }[] = [];
    let base: readonly string[] | null = null;
    for (let id = folderId; ;) {
      if (
        !GRAPH_ID.test(id) ||
        chain.length >= LIMITS.pathDepth ||
        chain.some((c) => c.id === id)
      ) {
        break;
      }
      let raw: Raw;
      if (budget) spend(budget);
      try {
        raw = await client.json(`${itemUrl(drive.id, id)}?$select=${ITEM_FIELDS}`, signal);
      } catch (e) {
        // Gone since the page was made, or this one folder is refused: what is in it can't be
        // placed. (The app's token being refused is another matter, and stops the crawl.)
        if (!(isConnectorError(e) && e.code === "not-found") && !isForbidden(e)) throw e;
        break;
      }
      if (isObject(raw.root)) {
        chain.push({ id, raw, parentId: null });
        base = [];
        break;
      }
      const parentId = isObject(raw.parentReference) ? str(raw.parentReference.id) : undefined;
      if (parentId === undefined || !isFolder(raw)) break;
      chain.push({ id, raw, parentId });
      const above = tree.paths.get(parentId);
      if (above !== undefined) {
        base = above;
        break;
      }
      id = parentId;
    }
    let path = base;
    for (const link of chain.reverse()) {
      const name = link.parentId === null ? drive.name : str(link.raw.name);
      path =
        path === null || name === undefined || !nameIsOne(name) || path.length >= LIMITS.pathDepth
          ? null
          : [...path, name];
      tree.paths.set(link.id, path);
      if (path !== null) {
        tree.met.push([drive.id, link.id, link.parentId, name as string]);
        tree.fetched.add(link.id);
        out.push(eventOf(drive, link.raw, link.id, "folder", link.parentId, path));
      }
    }
    if (!tree.paths.has(folderId)) tree.paths.set(folderId, null);
    return tree.paths.get(folderId) ?? null;
  }

  /**
   * The events one live entry becomes, in a crawl or when following changes. A deleted one
   * becomes none here (a crawl never says a deletion: its reconcile removes what it didn't
   * see; a delta says its own after the live entries).
   */
  async function eventsOf(
    drive: Drive,
    tree: Tree,
    raw: unknown,
    signal: AbortSignal,
    budget?: Budget,
  ): Promise<SyncEvent[]> {
    const id = isObject(raw) ? str(raw.id) : undefined;
    // An entry that can't even be named is Graph misbehaving: not guessed around.
    if (!isObject(raw) || id === undefined || !GRAPH_ID.test(id)) {
      throw new ConnectorError("retryable", "Graph listed an item this connector can't name");
    }
    if (isObject(raw.deleted)) {
      tree.paths.delete(id);
      return [];
    }
    const externalId = externalIdOf(drive.id, id);
    if (isObject(raw.root)) {
      const path = [drive.name];
      tree.paths.set(id, path);
      tree.met.push([drive.id, id, null, drive.name]);
      return [eventOf(drive, raw, id, "folder", null, path)];
    }
    const kind = isObject(raw.file) ? "file" : isFolder(raw) ? "folder" : undefined;
    // Something that is neither (a link to another library's item): not served.
    if (kind === undefined) return [{ type: "warning", code: "unsupported-item", externalId }];
    if (kind === "file" && !(Number.isSafeInteger(raw.size) && (raw.size as number) >= 0)) {
      return [{ type: "warning", code: "invalid-item", externalId }];
    }
    const parentId = isObject(raw.parentReference) ? str(raw.parentReference.id) : undefined;
    const name = str(raw.name);
    const out: SyncEvent[] = [];
    const above =
      parentId === undefined ? null : await pathOf(drive, tree, parentId, out, signal, budget);
    if (
      above === null ||
      name === undefined ||
      !nameIsOne(name) ||
      above.length >= LIMITS.pathDepth
    ) {
      // It is there, and can't be served: its name isn't one, or its folder can't be placed.
      // Graph lists everything under such a folder too, each by its id, so each is warned of in
      // turn, none taken for gone.
      if (kind === "folder") tree.paths.set(id, null);
      out.push({
        type: "warning",
        code: above === null ? "unplaced-item" : "invalid-item",
        externalId,
      });
      return out;
    }
    const path = [...above, name];
    if (kind === "folder") {
      // Asked of Graph and yielded already this run: again only if it moved since.
      const yielded =
        tree.fetched.has(id) && JSON.stringify(tree.paths.get(id)) === JSON.stringify(path);
      tree.paths.set(id, path);
      tree.met.push([drive.id, id, parentId as string, name]);
      if (yielded) return out;
    }
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
    // With a state directory, the folders met are logged as the crawl goes, so the cursor it
    // ends with has every library's folders, however often the crawl was resumed. A token
    // from a crawl whose log isn't here (another node's, or lost) goes on keeping nothing, and
    // its cursor is one changes can't be followed from: the sync after it crawls again.
    let logged: SiteFolders | undefined;
    if (state && checkpoint === null) position.log = newStateId();
    else if (state && position.log !== undefined) logged = state.readLog(position.log);
    if (!state || (checkpoint !== null && !logged)) delete position.log;
    state?.keepOnlyLog(position.log ?? null);
    const drives = await drivesOf(site, signal);
    // The library the token was in the middle of is gone: its place means nothing now.
    if (position.drive !== null && !drives.some((d) => d.id === position.drive)) {
      throw resyncError();
    }
    const met: LogLine[] = [];
    /** A checkpoint at this position, with the folders met since the last one on disk first. */
    const checkpointAt = (next: Position): SyncEvent => {
      if (state && position.log !== undefined) {
        state.appendLog(position.log, met.splice(0));
        next.log = position.log;
      }
      position = next;
      return { type: "checkpoint", token: tokenOf(position) };
    };
    // The library the token was in the middle of goes first, so a library added meanwhile
    // doesn't take its place in the token; then the rest, in the order of their ids.
    const order = [
      ...drives.filter((d) => d.id === position.drive),
      ...drives.filter((d) => d.id !== position.drive),
    ];
    for (const drive of order) {
      if (position.done[drive.id] !== undefined) continue;
      const first =
        position.drive === drive.id && position.link !== null
          ? position.link
          : `/v1.0/drives/${encodeURIComponent(drive.id)}/root/delta?$select=${ITEM_FIELDS}&$top=${pageSize}`;
      // Resumed, folders are where the crawl placed them before, not where Graph has them now:
      // one renamed since is then seen to differ when the feed (or the first delta) gives it.
      const before = logged?.get(drive.id);
      const tree: Tree = before
        ? treeOf(drive, before, met)
        : { paths: new Map(), met, fetched: new Set() };
      // A link out of a token may have lapsed since: refused, it means "from the start". (And
      // the feed is asked for sharing changes from the start, so the link the crawl ends with
      // is one Graph follows them from.)
      const pages = pagesOf(first, { left: Infinity }, signal, {
        kept: position.drive === drive.id,
        ...(feedHeaders ? { headers: feedHeaders } : {}),
      });
      let delta: string | undefined;
      for await (const page of pages) {
        for (const raw of page.value) {
          for (const event of await eventsOf(drive, tree, raw, signal)) yield event;
          signal.throwIfAborted();
        }
        if (position.log === undefined) met.length = 0;
        if (page.next !== undefined) {
          yield checkpointAt({ ...position, drive: drive.id, link: page.next });
        }
        delta = page.delta;
      }
      if (delta === undefined || !client.owns(delta)) {
        throw new ConnectorError("retryable", "Graph's last page had no link to go on from");
      }
      yield checkpointAt({
        v: 1,
        site,
        drive: null,
        link: null,
        done: { ...position.done, [drive.id]: delta },
      });
    }
    // What following changes starts from: each library's delta link, of the libraries there
    // are, and (with a state directory) the folders the crawl met, as a generation of their own.
    const done: Record<string, string> = {};
    for (const drive of drives) done[drive.id] = position.done[drive.id] as string;
    const cursor: Position = { v: 1, site, drive: null, link: null, done };
    if (state && position.log !== undefined) {
      state.appendLog(position.log, met.splice(0));
      const kept = state.readLog(position.log);
      if (kept) {
        cursor.gen = newStateId();
        cursor.crawled = now();
        state.writeGeneration(cursor.gen, kept);
      }
    }
    yield { type: "done", cursor: tokenOf(cursor) };
  }

  /** A library's folders as paths: what is kept, read as the crawl's tree is. */
  function treeOf(drive: Drive, folders: Folders, met: LogLine[]): Tree {
    const paths = new Map<string, readonly string[] | null>();
    const pathOfKept = (id: string, depth: number): readonly string[] | null | undefined => {
      const known = paths.get(id);
      if (known !== undefined) return known;
      const folder = folders.get(id);
      // Not kept: left unknown, so it is asked for when something needs it.
      if (!folder) return undefined;
      let path: readonly string[] | null | undefined;
      if (folder.parent === null) path = [drive.name];
      else if (depth >= LIMITS.pathDepth)
        path = null; // a loop, or too deep
      else {
        const above = pathOfKept(folder.parent, depth + 1);
        path =
          above === undefined
            ? undefined
            : above === null || !nameIsOne(folder.name) || above.length >= LIMITS.pathDepth
              ? null
              : [...above, folder.name];
      }
      if (path !== undefined) paths.set(id, path);
      return path;
    };
    for (const id of folders.keys()) pathOfKept(id, 0);
    return { paths, met, fetched: new Set() };
  }

  /**
   * One library's changes since its delta link: every event they become, and the link to go
   * on from. `folders` (what is kept of the library) is brought up to date in place; `changed`
   * says whether what is kept differs from before.
   */
  async function roundOf(
    drive: Drive,
    link: string,
    folders: Folders,
    signal: AbortSignal,
  ): Promise<{ events: SyncEvent[]; link: string; changed: boolean }> {
    const budget: Budget = { left: roundRequests };
    // The whole round first: the same item may come more than once, and the last word counts.
    const last = new Map<string, Raw>();
    let next: string | undefined;
    const pages = pagesOf(link, budget, signal, {
      kept: true,
      ...(feedHeaders ? { headers: feedHeaders } : {}),
    });
    for await (const page of pages) {
      for (const raw of page.value) {
        const id = isObject(raw) ? str(raw.id) : undefined;
        if (!isObject(raw) || id === undefined || !GRAPH_ID.test(id)) {
          throw new ConnectorError("retryable", "Graph listed an item this connector can't name");
        }
        last.delete(id);
        last.set(id, raw);
        // Too much to take as changes: a crawl does it a page at a time, with checkpoints.
        if (last.size > MAX_ROUND) throw resyncError();
      }
      next = page.delta;
    }
    if (next === undefined || !client.owns(next)) {
      throw new ConnectorError("retryable", "Graph's last page had no link to go on from");
    }
    const events: SyncEvent[] = [];
    if (last.size === 0) return { events, link: next, changed: false };

    // What is kept, brought up to date: which folders are where now, and which of them were
    // renamed or moved (Graph says nothing of what is in those).
    let changed = false;
    const moved = new Set<string>();
    const gone = new Set<string>();
    const keep = (id: string, parent: string | null, name: string) => {
      const before = folders.get(id);
      if (before?.parent === parent && before.name === name) return;
      if (before) moved.add(id);
      folders.set(id, { parent, name });
      changed = true;
    };
    for (const [id, raw] of last) {
      if (isObject(raw.deleted)) {
        if (folders.delete(id)) gone.add(id);
        continue;
      }
      // Its sharing changed (the library's own, or a folder's): what is in it is mentioned
      // again, as for a moved folder, so the runner asks for each item's permissions again.
      if (
        importing &&
        isFolder(raw) &&
        String(raw["@microsoft.graph.sharedChanged"]).toLowerCase() === "true"
      ) {
        moved.add(id);
      }
      if (isObject(raw.root)) keep(id, null, drive.name);
      else if (isFolder(raw)) {
        const parent = isObject(raw.parentReference) ? str(raw.parentReference.id) : undefined;
        const name = str(raw.name);
        if (parent !== undefined && name !== undefined) keep(id, parent, name);
        else if (folders.delete(id)) changed = true;
      }
    }
    // A folder still kept inside one that was deleted: Graph said the folder went and nothing
    // of the files in it, which aren't kept. Only a crawl's reconcile can take them out.
    for (const folder of folders.values()) {
      if (folder.parent !== null && gone.has(folder.parent)) throw resyncError();
    }
    changed ||= gone.size > 0;

    const met: LogLine[] = [];
    const tree = treeOf(drive, folders, met);
    const cap = importing ? MAX_ROUND_PERMISSIONS : MAX_ROUND;
    const add = (more: SyncEvent[]) => {
      events.push(...more);
      // More than a round should hold (and, with permissions imported, ask for before its
      // checkpoint): a crawl's work, which yields a page at a time.
      if (events.length > cap) throw resyncError();
    };
    // Folders before files, the ones nearer the top first: parents before their children.
    const depth = (id: string) => tree.paths.get(id)?.length ?? Number.MAX_SAFE_INTEGER;
    const live = [...last].filter(([, raw]) => !isObject(raw.deleted));
    const ordered = [
      ...live.filter(([, raw]) => isFolder(raw)).sort((a, b) => depth(a[0]) - depth(b[0])),
      ...live.filter(([, raw]) => !isFolder(raw)),
    ];
    for (const [, raw] of ordered) {
      add(await eventsOf(drive, tree, raw, signal, budget));
      signal.throwIfAborted();
    }

    // Renamed or moved: everything under such a folder is somewhere else now, and is said so.
    // The ones nearer the top first, and a folder inside one already listed isn't listed twice.
    // One Graph refuses to list is said so (its contents stay where the catalog has them, until
    // the next crawl); one gone since the feed was read is said gone by the next round.
    const listed = new Set<string>();
    for (const top of [...moved].sort((a, b) => depth(a) - depth(b))) {
      if (listed.has(top) || !tree.paths.get(top)) continue;
      for (const pending = [top]; pending.length > 0;) {
        const folder = pending.shift() as string;
        listed.add(folder);
        const children = `${itemUrl(drive.id, folder)}/children?$select=${ITEM_FIELDS}&$top=${listSize}`;
        try {
          for await (const page of pagesOf(children, budget, signal)) {
            for (const child of page.value) {
              add(await eventsOf(drive, tree, child, signal, budget));
              const childId = isObject(child) ? str(child.id) : undefined;
              if (childId !== undefined && !listed.has(childId) && tree.paths.get(childId)) {
                pending.push(childId);
              }
            }
            signal.throwIfAborted();
          }
        } catch (e) {
          if (isForbidden(e)) {
            add([
              {
                type: "warning",
                code: "unlisted-folder",
                externalId: externalIdOf(drive.id, folder),
              },
            ]);
          } else if (!(isConnectorError(e) && e.code === "not-found")) throw e;
        }
      }
    }

    for (const [id, raw] of last) {
      if (isObject(raw.deleted)) add([{ type: "deleted", externalId: externalIdOf(drive.id, id) }]);
    }
    // Folders asked for by id on the way (ones the kept state didn't have) are kept from now.
    for (const line of met) keep(line[1], line[2], line[3]);
    return { events, link: next, changed };
  }

  async function* delta(cursor: string, signal: AbortSignal): AsyncGenerator<SyncEvent> {
    signal.throwIfAborted();
    if (!state) throw resyncError();
    const site = await siteId(signal);
    let position = positionOf(cursor, site);
    // Not a cursor, or one without its folders, or too old to go on from: crawl again.
    if (position.drive !== null || position.gen === undefined || position.crawled === undefined) {
      throw resyncError();
    }
    if (recrawlAfterDays > 0 && now() - position.crawled > recrawlAfterDays * 86_400_000) {
      throw resyncError();
    }
    const kept = state.readGeneration(position.gen);
    if (!kept) throw resyncError();
    // The runner saved this token: what was written for any other is nobody's now.
    state.keepOnly(position.gen);
    /** The generation this run wrote last, named by a checkpoint the runner has since saved. */
    let mine: string | undefined;
    const drives = await drivesOf(site, signal);
    // A library added or removed: its files are all new, or all gone. A crawl's business.
    const known = Object.keys(position.done);
    if (known.length !== drives.length || drives.some((d) => position.done[d.id] === undefined)) {
      throw resyncError();
    }
    for (const drive of drives) {
      const folders: Folders = new Map(kept.get(drive.id) ?? []);
      // The library was renamed: everything in it is somewhere else. A crawl's business.
      for (const top of folders.values()) {
        if (top.parent === null && top.name !== drive.name) throw resyncError();
      }
      const round = await roundOf(drive, position.done[drive.id] as string, folders, signal);
      for (const event of round.events) yield event;
      const next: Position = { ...position, done: { ...position.done, [drive.id]: round.link } };
      // Nothing changed: nothing but `done` is said, which carries the link to go on from.
      if (round.events.length === 0 && !round.changed) {
        position = next;
        continue;
      }
      if (round.changed) {
        kept.set(drive.id, folders);
        // The runner came back for more, so it saved the checkpoint naming this run's last
        // generation: the ones before it are nobody's.
        if (mine !== undefined) state.keepOnly(mine);
        // Written whole, under a new name, before the token that names it exists.
        mine = next.gen = newStateId();
        state.writeGeneration(mine, kept);
      }
      position = next;
      yield { type: "checkpoint", token: tokenOf(position) };
    }
    yield { type: "done", cursor: tokenOf(position) };
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
    if (ref.contentVersion === undefined) {
      throw new ConnectorError("permanent", "a read names the content version the crawl recorded");
    }
    const fields = "id,size,eTag,file,deleted";
    const { at, raw } = await itemNow(ref, fields, signal);
    // Like with like: the version of the kind the crawl recorded, from this answer.
    const version = contentVersionOf(raw, ref.contentVersion);
    const size = raw.size;
    if (!isObject(raw.file) || !Number.isSafeInteger(size)) {
      throw new ConnectorError("permanent", "the item is not a file");
    }
    if (version !== ref.contentVersion) throw changedError();
    // Before any bytes are asked for: nothing is left open when the caller stops here.
    if (ref.size !== undefined && ref.size !== size) throw changedError();

    // Graph answers with the bytes, or with a link to them that needs no token (and gets none).
    let response = await client
      .get(`${itemUrl(at.drive, at.item)}/content`, signal, { pass: [302] })
      .catch((e: unknown) => {
        // This one file's bytes are refused (a policy on it), not the app: passed over.
        if (isForbidden(e))
          throw new ConnectorError("permanent", "Graph refused this file's content");
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
      // SharePoint said so, not Graph, but it is the same app being told: its requests wait.
      client.pacer.throttled(wait ?? 30_000);
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

  /** Who SharePoint lets see an item (permissions.ts), for the core to match to its own. */
  async function aclImport(ref: ItemRef, signal: AbortSignal): Promise<ItemAcl> {
    signal.throwIfAborted();
    const at = parseExternalId(ref.externalId);
    if (!at) throw notFoundError("not an item of this source");
    const site = await siteId(signal);
    const permissions: unknown[] = [];
    // Refused, this one item (not the app): passed over, with what the source had granted on
    // it withdrawn; the rest of the site goes on. The same for a list that doesn't end.
    const over = () => new ConnectorError("permanent", "Graph's list of permissions doesn't end");
    try {
      const first = `${itemUrl(at.drive, at.item)}/permissions`;
      for await (const page of pagesOf(first, { left: MAX_LIST_PAGES, over }, signal)) {
        permissions.push(...page.value);
      }
    } catch (e) {
      if (isForbidden(e))
        throw new ConnectorError("permanent", "Graph refused this item's permissions");
      throw e;
    }
    const entries = aclEntriesOf(permissions, site);
    const groups = groupsOf();
    return {
      basis: "source",
      entries: groups ? await groups.expand(entries, site, signal) : entries,
    };
  }

  let groups: SiteGroups | undefined;
  /**
   * Who is in the site's SharePoint groups (sitegroups.ts), once the site is known: only with a
   * certificate, which SharePoint's own API requires. The token goes to the site's own address,
   * which must be on a host the source allows (`downloadHosts`, SharePoint's).
   */
  function groupsOf(): SiteGroups | undefined {
    if (groups || options.auth.credential !== "certificate" || siteWebUrl === undefined) {
      return groups;
    }
    if (client.owns(siteWebUrl) || !mayDownload(siteWebUrl) || !siteWebUrl.startsWith("https://")) {
      throw new ConnectorError(
        "permanent",
        "the site's address isn't on a SharePoint host this source allows (downloadHosts)",
      );
    }
    groups = siteGroups({
      auth: options.auth,
      webUrl: siteWebUrl,
      pacer: client.pacer,
      now,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }),
    });
    return groups;
  }

  return defineConnector({
    describe: () => description,
    crawl,
    ...(state ? { delta } : {}),
    ...(importing ? { aclImport } : {}),
    ...(options.stateDir === undefined
      ? {}
      : {
          subscriptions: (notify: { url: string; clientState: string }) =>
            graphSubscriptions({
              ...notify,
              client,
              stateDir: options.stateDir as string,
              drives: async (signal) =>
                (await drivesOf(await siteId(signal), signal)).map((d) => d.id),
              now,
            }),
        }),
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
