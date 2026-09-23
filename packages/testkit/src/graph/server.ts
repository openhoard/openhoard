import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { contentStream } from "../tenant/content.js";
import type { FakeSite, FakeTenant, FakeUser } from "../tenant/types.js";
import {
  deletedItem,
  driveItem,
  driveResource,
  permissionResource,
  rootId,
  rootItem,
  siteResource,
} from "./resources.js";
import { TenantStore, type StoredItem } from "./store.js";

export interface FakeGraphOptions {
  /** Bearer token clients must send. Default `fake-graph-token`. */
  token?: string;
  /** Default page size for collections; clients may lower it with `$top`. Default 200. */
  pageSize?: number;
  /** Rate limit: at most `limit` requests per `windowMs`, then 429 with Retry-After. */
  throttle?: { limit: number; windowMs: number };
  /** Clock for rate limits and subscription expiry. Default `Date.now`. */
  now?: () => number;
  /** Delivers subscription validation requests and notifications. Default global `fetch`. */
  notify?: (url: string, init: RequestInit) => Promise<Response>;
}

export interface Subscription {
  id: string;
  resource: string;
  changeType: string;
  notificationUrl: string;
  clientState?: string;
  expirationDateTime: string;
}

export interface LoggedRequest {
  method: string;
  path: string;
  status: number;
}

/** Graph caps driveItem subscriptions at 42,300 minutes (about 29 days). */
export const MAX_SUBSCRIPTION_MINUTES = 42_300;
const MAX_PAGE_SIZE = 999;

/**
 * An in-process fake of the Microsoft Graph v1.0 endpoints a SharePoint/OneDrive connector
 * uses (T-015): sites, drives, items, children, content (302 to a pre-authenticated URL, with
 * Range support), permissions, delta with opaque tokens and resync, subscriptions with the
 * validation handshake, paging, bearer auth, rate limiting and fault injection.
 *
 * Call {@link FakeGraph.fetch} directly for fast in-process tests, or {@link FakeGraph.listen}
 * to serve it on 127.0.0.1 for code that needs a real URL. Nothing leaves the machine.
 */
export class FakeGraph {
  readonly store: TenantStore;
  readonly app = new Hono();
  readonly requests: LoggedRequest[] = [];
  readonly subscriptions = new Map<string, Subscription>();

  private readonly token: string;
  private readonly pageSize: number;
  private readonly now: () => number;
  private readonly notify: (url: string, init: RequestInit) => Promise<Response>;
  private readonly users: Map<string, FakeUser>;
  private readonly sites: Map<string, FakeSite>;
  private readonly signingKey = randomBytes(32);
  private readonly faults: { status: number; retryAfter?: number }[] = [];
  private readonly pending = new Set<Promise<unknown>>();
  private windowStart = 0;
  private windowCount = 0;
  /** Bumped by requireResync(); cursors from an older epoch get 410 resyncRequired. */
  private deltaEpoch = 0;
  private subscriptionCounter = 0;

  constructor(
    readonly tenant: FakeTenant,
    private readonly options: FakeGraphOptions = {},
  ) {
    this.store = new TenantStore(tenant);
    this.token = options.token ?? "fake-graph-token";
    this.pageSize = options.pageSize ?? 200;
    this.now = options.now ?? Date.now;
    this.notify = options.notify ?? ((url, init) => fetch(url, init));
    this.users = new Map(tenant.users.map((u) => [u.id, u]));
    this.sites = new Map(tenant.sites.map((s) => [s.driveId, s]));
    this.store.onChange((change) => this.notifySubscribers(change.driveId));
    this.routes();
  }

  /** Sends a request to the fake without a network hop. Relative URLs resolve against it. */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const request =
      typeof input === "string" && input.startsWith("/") ? `http://graph.test${input}` : input;
    return Promise.resolve(this.app.request(request, init));
  }

  /** The next `count` requests fail with `status` (e.g. 503), optionally with Retry-After. */
  failNext(status: number, count = 1, retryAfterSeconds?: number): void {
    for (let i = 0; i < count; i++) {
      this.faults.push({
        status,
        ...(retryAfterSeconds === undefined ? {} : { retryAfter: retryAfterSeconds }),
      });
    }
  }

  /** Invalidates every delta token issued so far: clients get 410 resyncRequired. */
  requireResync(): void {
    this.deltaEpoch++;
  }

  /** Resolves once every queued subscription notification has been delivered (or failed). */
  async flushNotifications(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** Serves the fake on 127.0.0.1. `port` 0 picks a free port. */
  listen(port = 0): Promise<{ url: string; close: () => Promise<void> }> {
    return new Promise((resolve, reject) => {
      const server = serve(
        { fetch: this.app.fetch, hostname: "127.0.0.1", port },
        (info: AddressInfo) => {
          resolve({
            url: `http://127.0.0.1:${info.port}`,
            close: () =>
              new Promise<void>((done, fail) => server.close((e) => (e ? fail(e) : done()))),
          });
        },
      );
      server.once("error", reject); // e.g. EADDRINUSE: fail instead of hanging
    });
  }

  // ── Routing ──────────────────────────────────────────────────────────────────────────

  private routes(): void {
    const app = this.app;
    app.use(async (c, next) => {
      await next();
      this.requests.push({
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status: c.res.status,
      });
    });

    // Faults and rate limits apply to every request, downloads included, so retry and resume
    // logic can be tested end to end.
    app.use(async (c, next) => {
      const fault = this.faults.shift();
      if (fault) {
        if (fault.retryAfter !== undefined) c.header("Retry-After", String(fault.retryAfter));
        return graphError(
          c,
          fault.status,
          fault.status === 429 ? "TooManyRequests" : "serviceNotAvailable",
          "injected fault",
        );
      }
      const limited = this.rateLimit();
      if (limited !== undefined) {
        c.header("Retry-After", String(limited));
        return graphError(c, 429, "TooManyRequests", "Too many requests");
      }
      return next();
    });

    // Pre-authenticated download URLs need no bearer token, like the real ones.
    app.get("/_download/:drive/:item", (c) => this.download(c));

    app.use("/v1.0/*", async (c, next) => {
      const auth = c.req.header("authorization") ?? "";
      if (!safeEqual(auth, `Bearer ${this.token}`)) {
        return graphError(
          c,
          401,
          "InvalidAuthenticationToken",
          "Access token is empty or invalid.",
        );
      }
      return next();
    });

    app.get("/v1.0/sites", (c) =>
      this.page(
        c,
        this.tenant.sites.map((s) => siteResource(s, this.tenant)),
      ),
    );
    app.get("/v1.0/sites/:site", (c) => {
      const site = this.tenant.sites.find((s) => s.id === c.req.param("site"));
      return site ? c.json(siteResource(site, this.tenant)) : notFound(c);
    });
    app.get("/v1.0/sites/:site/drives", (c) => {
      const site = this.tenant.sites.find((s) => s.id === c.req.param("site"));
      return site ? this.page(c, [driveResource(site)]) : notFound(c);
    });
    app.get("/v1.0/sites/:site/drive", (c) => {
      const site = this.tenant.sites.find((s) => s.id === c.req.param("site"));
      return site ? c.json(driveResource(site)) : notFound(c);
    });
    app.get("/v1.0/drives/:drive", (c) => {
      const site = this.sites.get(c.req.param("drive"));
      return site ? c.json(driveResource(site)) : notFound(c);
    });
    app.get("/v1.0/drives/:drive/root", (c) => {
      const site = this.sites.get(c.req.param("drive"));
      return site
        ? c.json(rootItem(site, this.store.children(site.driveId, undefined).length))
        : notFound(c);
    });
    app.get("/v1.0/drives/:drive/root/children", (c) => this.children(c, undefined));
    app.get("/v1.0/drives/:drive/root/delta", (c) => this.delta(c));
    app.get("/v1.0/drives/:drive/items/:item", (c) => {
      const found = this.item(c);
      if (!found) return notFound(c);
      if (found === "root") return c.redirect(`/v1.0/drives/${c.req.param("drive")}/root`, 307);
      return c.json(this.toDriveItem(found));
    });
    app.get("/v1.0/drives/:drive/items/:item/children", (c) =>
      this.children(c, c.req.param("item")),
    );
    app.get("/v1.0/drives/:drive/items/:item/permissions", (c) => {
      const found = this.item(c);
      if (!found || found === "root") return notFound(c);
      return this.page(
        c,
        found.acl.map((a, i) => permissionResource(a, i, found, this.tenant, this.users)),
      );
    });
    app.get("/v1.0/drives/:drive/items/:item/content", (c) => {
      const found = this.item(c);
      if (!found || found === "root" || found.kind !== "file") return notFound(c);
      const url = new URL(c.req.url);
      const sig = this.sign(`${found.driveId}/${found.id}/${found.version}`);
      return c.redirect(
        `${url.origin}/_download/${found.driveId}/${found.id}?v=${found.version}&sig=${sig}`,
        302,
      );
    });

    app.post("/v1.0/subscriptions", (c) => this.createSubscription(c));
    app.get("/v1.0/subscriptions", (c) => this.page(c, [...this.subscriptions.values()]));
    app.get("/v1.0/subscriptions/:id", (c) => {
      const s = this.subscriptions.get(c.req.param("id"));
      return s ? c.json(s) : notFound(c);
    });
    app.patch("/v1.0/subscriptions/:id", async (c) => {
      const s = this.subscriptions.get(c.req.param("id"));
      if (!s) return notFound(c);
      const body = (await c.req.json().catch(() => ({}))) as { expirationDateTime?: string };
      const problem = this.checkExpiry(body.expirationDateTime);
      if (problem) return graphError(c, 400, "InvalidRequest", problem);
      s.expirationDateTime = new Date(Date.parse(body.expirationDateTime as string)).toISOString();
      return c.json(s);
    });
    app.delete("/v1.0/subscriptions/:id", (c) =>
      this.subscriptions.delete(c.req.param("id")) ? c.body(null, 204) : notFound(c),
    );

    app.notFound((c) =>
      graphError(
        c,
        400,
        "invalidRequest",
        `Unsupported request: ${c.req.method} ${new URL(c.req.url).pathname}`,
      ),
    );
  }

  // ── Handlers ─────────────────────────────────────────────────────────────────────────

  private item(c: Context): StoredItem | "root" | undefined {
    const drive = c.req.param("drive");
    const id = c.req.param("item");
    if (drive && id === rootId(drive) && this.sites.has(drive)) return "root";
    const item = id ? this.store.get(id) : undefined;
    return item && item.driveId === drive ? item : undefined;
  }

  private children(c: Context, parent: string | undefined): Response {
    const drive = c.req.param("drive") ?? "";
    if (!this.sites.has(drive)) return notFound(c);
    const parentId = parent === rootId(drive) ? undefined : parent;
    if (parentId !== undefined) {
      const p = this.store.get(parentId);
      if (!p || p.driveId !== drive || p.kind !== "folder") return notFound(c);
    }
    return this.page(
      c,
      this.store.children(drive, parentId).map((i) => this.toDriveItem(i)),
    );
  }

  /**
   * Delta (GET /drives/{id}/root/delta). Without a token: the whole drive, then a deltaLink.
   * With a token: items changed and deleted since it. `token=latest` skips straight to a
   * deltaLink for "now". Pages walk items by id, so deletes during paging never skip items;
   * anything changed after the first page arrives in the next delta round.
   */
  private delta(c: Context): Response {
    const drive = c.req.param("drive") ?? "";
    const site = this.sites.get(drive);
    if (!site) return notFound(c);
    const origin = new URL(c.req.url).origin;
    const epoch = this.deltaEpoch;
    const link = (cursor: Omit<DeltaCursor, "epoch">) =>
      `${origin}/v1.0/drives/${drive}/root/delta?token=${encodeCursor({ ...cursor, epoch })}`;
    const raw = c.req.query("token");
    if (raw === "latest") {
      return c.json({ value: [], "@odata.deltaLink": link({ since: this.store.sequence }) });
    }

    let cursor: DeltaCursor;
    try {
      cursor = raw === undefined ? { since: -1, epoch } : decodeCursor(raw);
    } catch {
      return graphError(c, 400, "invalidRequest", "Invalid delta token");
    }
    if (cursor.epoch !== epoch) {
      return graphError(
        c,
        410,
        "resyncRequired",
        "Resync required. Replace any local items with the server's version.",
      );
    }
    const snapshot = cursor.snapshot ?? this.store.sequence;
    // The page size chosen on the first request sticks for the whole round, as in Graph.
    const top = cursor.top ?? this.top(c);
    const { items, deleted } = this.store.changesSince(drive, cursor.since);
    const visible = items
      .filter((i) => i.changeSeq <= snapshot)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .filter((i) => cursor.after === undefined || i.id > cursor.after);
    const pageItems = visible.slice(0, top);
    const value: unknown[] = pageItems.map((i) => this.toDriveItem(i));
    if (cursor.after === undefined) {
      if (cursor.since < 0) {
        value.unshift(rootItem(site, this.store.children(drive, undefined).length));
      } else {
        value.push(...deleted.filter((t) => t.changeSeq <= snapshot).map(deletedItem));
      }
    }
    const last = pageItems.at(-1);
    if (visible.length > top && last) {
      return c.json({
        value,
        "@odata.nextLink": link({ since: cursor.since, snapshot, after: last.id, top }),
      });
    }
    return c.json({ value, "@odata.deltaLink": link({ since: snapshot }) });
  }

  private download(c: Context): Response {
    const item = this.store.get(c.req.param("item") ?? "");
    const version = c.req.query("v");
    const sig = c.req.query("sig") ?? "";
    if (!item || item.driveId !== c.req.param("drive") || String(item.version) !== version)
      return notFound(c);
    if (!safeEqual(sig, this.sign(`${item.driveId}/${item.id}/${item.version}`))) {
      return graphError(c, 401, "unauthenticated", "Invalid or expired download URL");
    }
    const headers = { "content-type": item.mime, "accept-ranges": "bytes", etag: item.etag };
    const range = parseRange(c.req.header("range"), item.size);
    if (range === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${item.size}` },
      });
    }
    if (range) {
      return new Response(contentStream(this.tenant, item, range), {
        status: 206,
        headers: {
          ...headers,
          "content-length": String(range.end - range.start + 1),
          "content-range": `bytes ${range.start}-${range.end}/${item.size}`,
        },
      });
    }
    return new Response(contentStream(this.tenant, item), {
      status: 200,
      headers: { ...headers, "content-length": String(item.size) },
    });
  }

  private async createSubscription(c: Context): Promise<Response> {
    const body = (await c.req.json().catch(() => undefined)) as Partial<Subscription> | undefined;
    if (!body?.notificationUrl || !body.resource || !body.changeType) {
      return graphError(
        c,
        400,
        "InvalidRequest",
        "notificationUrl, resource and changeType are required",
      );
    }
    if (!/^https?:\/\//.test(body.notificationUrl))
      return graphError(c, 400, "InvalidRequest", "notificationUrl must be http(s)");
    const drive = /^\/?(?:me\/)?drives\/([^/]+)\/root$/.exec(body.resource)?.[1];
    if (!drive || !this.sites.has(drive))
      return graphError(c, 400, "InvalidRequest", `Unsupported resource: ${body.resource}`);
    const problem = this.checkExpiry(body.expirationDateTime);
    if (problem) return graphError(c, 400, "InvalidRequest", problem);

    // Validation handshake: the endpoint must echo the token as text/plain within the call.
    const validationToken = randomBytes(12).toString("hex");
    const url = `${body.notificationUrl}${body.notificationUrl.includes("?") ? "&" : "?"}validationToken=${encodeURIComponent(validationToken)}`;
    const echoed = await this.notify(url, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "",
    })
      .then(async (r) => (r.ok ? r.text() : undefined))
      .catch(() => undefined);
    if (echoed !== validationToken) {
      return graphError(
        c,
        400,
        "InvalidRequest",
        "Subscription validation request failed. Response must exactly match validationToken query parameter.",
      );
    }
    const subscription: Subscription = {
      id: `sub-${++this.subscriptionCounter}`,
      resource: body.resource,
      changeType: body.changeType,
      notificationUrl: body.notificationUrl,
      ...(body.clientState === undefined ? {} : { clientState: body.clientState }),
      expirationDateTime: new Date(Date.parse(body.expirationDateTime as string)).toISOString(),
    };
    this.subscriptions.set(subscription.id, subscription);
    return c.json(subscription, 201);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────

  private notifySubscribers(driveId: string): void {
    const now = this.now();
    for (const s of this.subscriptions.values()) {
      if (!s.resource.includes(`drives/${driveId}/root`) || Date.parse(s.expirationDateTime) <= now)
        continue;
      const payload = {
        value: [
          {
            subscriptionId: s.id,
            subscriptionExpirationDateTime: s.expirationDateTime,
            changeType: s.changeType,
            resource: s.resource,
            tenantId: this.tenant.id,
            ...(s.clientState === undefined ? {} : { clientState: s.clientState }),
          },
        ],
      };
      const delivery = this.notify(s.notificationUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
        // Drain the body so the connection is released rather than held until GC.
        .then((r) => r.body?.cancel())
        .catch(() => undefined);
      this.pending.add(delivery);
      void delivery.finally(() => this.pending.delete(delivery));
    }
  }

  private checkExpiry(value: string | undefined): string | undefined {
    const at = value === undefined ? Number.NaN : Date.parse(value);
    if (Number.isNaN(at)) return "expirationDateTime is required and must be a date";
    const now = this.now();
    if (at <= now) return "expirationDateTime must be in the future";
    if (at - now > MAX_SUBSCRIPTION_MINUTES * 60_000)
      return `expirationDateTime is more than ${MAX_SUBSCRIPTION_MINUTES} minutes away`;
    return undefined;
  }

  /** Seconds to wait when the rate limit is exceeded, otherwise undefined. */
  private rateLimit(): number | undefined {
    const limit = this.options.throttle;
    if (!limit) return undefined;
    const now = this.now();
    if (now - this.windowStart >= limit.windowMs) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    if (++this.windowCount <= limit.limit) return undefined;
    return Math.max(1, Math.ceil((this.windowStart + limit.windowMs - now) / 1000));
  }

  private top(c: Context): number {
    const raw = c.req.query("$top");
    const n = raw === undefined ? this.pageSize : Number(raw);
    return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_PAGE_SIZE) : this.pageSize;
  }

  /** Offset-paged collection with an absolute @odata.nextLink, like Graph. */
  private page(c: Context, all: unknown[]): Response {
    const top = this.top(c);
    const skip = Number(c.req.query("$skiptoken") ?? 0);
    const offset = Number.isInteger(skip) && skip >= 0 ? skip : 0;
    const value = all.slice(offset, offset + top);
    if (offset + top >= all.length) return c.json({ value });
    const next = new URL(c.req.url);
    next.searchParams.set("$skiptoken", String(offset + top));
    next.searchParams.set("$top", String(top));
    return c.json({ value, "@odata.nextLink": next.toString() });
  }

  private toDriveItem(item: StoredItem) {
    const site = this.sites.get(item.driveId) as FakeSite;
    const childCount =
      item.kind === "folder" ? this.store.children(item.driveId, item.id).length : 0;
    return driveItem(item, site, this.users, childCount);
  }

  private sign(value: string): string {
    return createHmac("sha256", this.signingKey).update(value).digest("base64url");
  }
}

interface DeltaCursor {
  /** Changes after this sequence number; -1 means "everything". */
  since: number;
  /** requireResync() epoch the cursor was issued in. */
  epoch: number;
  /** Sequence number frozen at the first page of a round. */
  snapshot?: number;
  /** Last item id already returned in this round. */
  after?: string;
  /** Page size for the round. */
  top?: number;
}

function encodeCursor(cursor: DeltaCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(raw: string): DeltaCursor {
  const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  const c = parsed as DeltaCursor;
  if (typeof c !== "object" || c === null || !Number.isInteger(c.since))
    throw new Error("bad cursor");
  if (c.snapshot !== undefined && !Number.isInteger(c.snapshot)) throw new Error("bad cursor");
  if (c.after !== undefined && typeof c.after !== "string") throw new Error("bad cursor");
  if (!Number.isInteger(c.epoch)) throw new Error("bad cursor");
  if (c.top !== undefined && !(Number.isInteger(c.top) && c.top > 0)) throw new Error("bad cursor");
  return c;
}

/**
 * Interprets a Range header per RFC 9110 section 14: a satisfiable single range gives 206,
 * an unsatisfiable one ("bytes=500-" on a 100-byte file) gives 416, and anything the server
 * does not support or cannot parse (multiple ranges, reversed ranges, other units) is ignored,
 * so the whole file is sent with 200.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return undefined;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  if (m[2] !== "" && Number(m[2]) < start) return undefined; // reversed: invalid, so ignored
  if (start >= size) return "unsatisfiable";
  return { start, end: m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1) };
}

function graphError(c: Context, status: number, code: string, message: string): Response {
  return c.json(
    {
      error: {
        code,
        message,
        innerError: {
          date: new Date().toISOString(),
          "request-id": randomBytes(8).toString("hex"),
        },
      },
    },
    status as 400,
  );
}

function notFound(c: Context): Response {
  return graphError(c, 404, "itemNotFound", "The resource could not be found.");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
