import { beforeEach, describe, expect, it } from "vitest";
import {
  contentBytes,
  FakeGraph,
  generateTenant,
  MAX_SUBSCRIPTION_MINUTES,
  parseRange,
  rootId,
  type FakeTenant,
} from "../index.js";

const tenant: FakeTenant = generateTenant({ items: 1500 });
const AUTH = { authorization: "Bearer fake-graph-token" };

interface Page<T> {
  value: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}
interface DriveItem {
  id: string;
  name: string;
  size: number;
  eTag: string;
  file?: { mimeType: string };
  folder?: { childCount: number };
  deleted?: { state: string };
  parentReference: { id: string; driveId: string; path?: string };
}

/**
 * A minimal Graph client, written the way a connector would be: follows nextLinks, honours
 * Retry-After on 429/503, and keeps the deltaLink. It proves a connector can be tested fully
 * offline against the fake.
 */
class TestClient {
  sleeps: number[] = [];
  constructor(private readonly graph: FakeGraph) {}

  async get<T>(url: string, attempt = 0): Promise<T> {
    const res = await this.graph.fetch(url, { headers: AUTH });
    if ((res.status === 429 || res.status === 503) && attempt < 5) {
      this.sleeps.push(Number(res.headers.get("retry-after") ?? "1"));
      return this.get(url, attempt + 1);
    }
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async all<T>(url: string): Promise<{ items: T[]; deltaLink?: string }> {
    const items: T[] = [];
    let next: string | undefined = url;
    let deltaLink: string | undefined;
    while (next) {
      const page: Page<T> = await this.get<Page<T>>(next);
      items.push(...page.value);
      next = page["@odata.nextLink"];
      deltaLink = page["@odata.deltaLink"] ?? deltaLink;
    }
    return deltaLink === undefined ? { items } : { items, deltaLink };
  }
}

const hr = tenant.sites.find((s) => s.name === "hr");
if (!hr) throw new Error("fixture: no HR site");
const DRIVE = hr.driveId;

let graph: FakeGraph;
let client: TestClient;
beforeEach(() => {
  graph = new FakeGraph(tenant, { pageSize: 50 });
  client = new TestClient(graph);
});

describe("auth and errors", () => {
  it("rejects missing or wrong tokens with a Graph error body", async () => {
    for (const headers of [{}, { authorization: "Bearer nope" }]) {
      const res = await graph.fetch("/v1.0/sites", { headers });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "InvalidAuthenticationToken",
      );
    }
  });

  it("returns itemNotFound and invalidRequest like Graph", async () => {
    expect((await graph.fetch("/v1.0/drives/nope/root/children", { headers: AUTH })).status).toBe(
      404,
    );
    expect(
      (await graph.fetch(`/v1.0/drives/${DRIVE}/items/i-999999`, { headers: AUTH })).status,
    ).toBe(404);
    expect((await graph.fetch("/v1.0/sites/s-nope", { headers: AUTH })).status).toBe(404);
    const res = await graph.fetch("/v1.0/me/messages", { headers: AUTH });
    expect(res.status).toBe(400);
    expect(graph.requests.at(-1)).toEqual({
      method: "GET",
      path: "/v1.0/me/messages",
      status: 400,
    });
  });
});

describe("sites, drives and items", () => {
  it("pages collections with absolute nextLinks", async () => {
    const first = await client.get<Page<{ id: string }>>("/v1.0/sites?$top=5");
    expect(first.value).toHaveLength(5);
    expect(first["@odata.nextLink"]).toMatch(/^http:\/\/graph\.test\/v1\.0\/sites\?/);
    const { items } = await client.all<{ id: string }>("/v1.0/sites?$top=5");
    expect(items.map((s) => s.id)).toEqual(tenant.sites.map((s) => s.id));
  });

  it("resolves a site's drive and root", async () => {
    const drive = await client.get<{ id: string }>(`/v1.0/sites/${hr.id}/drive`);
    expect(drive.id).toBe(DRIVE);
    expect((await client.all<{ id: string }>(`/v1.0/sites/${hr.id}/drives`)).items).toHaveLength(1);
    const root = await client.get<{ id: string; root: object }>(`/v1.0/drives/${DRIVE}/root`);
    expect(root.id).toBe(rootId(DRIVE));
    expect((await client.get<{ name: string }>(`/v1.0/sites/${hr.id}`)).name).toBe("hr");
    expect((await client.get<{ id: string }>(`/v1.0/drives/${DRIVE}`)).id).toBe(DRIVE);
  });

  it("walks the whole folder tree through children", async () => {
    const seen: DriveItem[] = [];
    const walk = async (url: string): Promise<void> => {
      for (const item of (await client.all<DriveItem>(url)).items) {
        seen.push(item);
        if (item.folder) await walk(`/v1.0/drives/${DRIVE}/items/${item.id}/children`);
      }
    };
    await walk(`/v1.0/drives/${DRIVE}/root/children`);
    const expected = tenant.items.filter((i) => i.driveId === DRIVE);
    expect(seen.map((i) => i.id).sort()).toEqual(expected.map((i) => i.id).sort());
    const file = seen.find((i) => i.file);
    const source = expected.find((i) => i.id === file?.id);
    expect(file?.size).toBe(source?.size);
    expect(file?.file?.mimeType).toBe(source?.mime);
    expect(file?.parentReference.driveId).toBe(DRIVE);
  });

  it("redirects the root item id to the root", async () => {
    const res = await graph.fetch(`/v1.0/drives/${DRIVE}/items/${rootId(DRIVE)}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(307);
    expect(
      (
        await graph.fetch(`/v1.0/drives/${DRIVE}/items/${rootId(DRIVE)}/children`, {
          headers: AUTH,
        })
      ).ok,
    ).toBe(true);
  });

  it("refuses to list children of a file or an item from another drive", async () => {
    const file = tenant.items.find((i) => i.driveId === DRIVE && i.kind === "file");
    const other = tenant.items.find((i) => i.driveId !== DRIVE);
    for (const id of [file?.id, other?.id]) {
      expect(
        (await graph.fetch(`/v1.0/drives/${DRIVE}/items/${id}/children`, { headers: AUTH })).status,
      ).toBe(404);
    }
  });
});

describe("permissions", () => {
  it("maps every ACL entry to a Graph permission", async () => {
    const shared = tenant.items.find((i) => i.acl.some((a) => a.principal === "anyone-with-link"));
    if (!shared) throw new Error("no link-shared item");
    const { items } = await client.all<Record<string, unknown>>(
      `/v1.0/drives/${shared.driveId}/items/${shared.id}/permissions`,
    );
    expect(items).toHaveLength(shared.acl.length);
    expect(
      items.some((p) => (p.link as { scope?: string } | undefined)?.scope === "anonymous"),
    ).toBe(true);
    expect(items.some((p) => (p.grantedToV2 as { group?: unknown } | undefined)?.group)).toBe(true);
    for (const p of items) expect(Array.isArray(p.roles)).toBe(true);
  });

  it("marks inherited permissions and describes guests as invitations", async () => {
    const guestShare = tenant.items.find((i) =>
      i.acl.some((a) => a.principal.startsWith("guest:")),
    );
    if (!guestShare) throw new Error("no guest share");
    const { items } = await client.all<Record<string, unknown>>(
      `/v1.0/drives/${guestShare.driveId}/items/${guestShare.id}/permissions`,
    );
    expect(items.some((p) => p.invitation)).toBe(true);
    expect(items.some((p) => p.inheritedFrom)).toBe(true);
    const own = items.filter((p) => !p.inheritedFrom);
    expect(own.length).toBe(guestShare.acl.filter((a) => !a.inherited).length);
  });
});

describe("content", () => {
  const file = tenant.items.find(
    (i) => i.driveId === DRIVE && i.kind === "file" && i.size < 500_000,
  );
  if (!file) throw new Error("fixture: no small HR file");

  it("redirects to a pre-authenticated URL that serves the exact bytes", async () => {
    const res = await graph.fetch(`/v1.0/drives/${DRIVE}/items/${file.id}/content`, {
      headers: AUTH,
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toMatch(/\/_download\//);
    const body = await graph.fetch(location);
    expect(body.headers.get("content-length")).toBe(String(file.size));
    const bytes = new Uint8Array(await body.arrayBuffer());
    expect(Buffer.from(bytes).equals(Buffer.from(await contentBytes(tenant, file)))).toBe(true);
  });

  it("serves byte ranges consistent with the full file", async () => {
    const location =
      (
        await graph.fetch(`/v1.0/drives/${DRIVE}/items/${file.id}/content`, { headers: AUTH })
      ).headers.get("location") ?? "";
    const full = await contentBytes(tenant, file);
    const res = await graph.fetch(location, { headers: { range: "bytes=100-199" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 100-199/${file.size}`);
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(full.subarray(100, 200)))).toBe(
      true,
    );
    expect(
      (await graph.fetch(location, { headers: { range: `bytes=${file.size}-` } })).status,
    ).toBe(416);
  });

  it("rejects tampered download URLs and URLs for an old version", async () => {
    const location =
      (
        await graph.fetch(`/v1.0/drives/${DRIVE}/items/${file.id}/content`, { headers: AUTH })
      ).headers.get("location") ?? "";
    expect((await graph.fetch(location.replace(/sig=[^&]+/, "sig=forged"))).status).toBe(401);
    graph.store.update(file.id, { size: file.size + 10 });
    expect((await graph.fetch(location)).status).toBe(404);
  });

  it("serves new content after an edit", async () => {
    const before = await contentBytes(tenant, file);
    graph.store.update(file.id, { size: file.size });
    const location =
      (
        await graph.fetch(`/v1.0/drives/${DRIVE}/items/${file.id}/content`, { headers: AUTH })
      ).headers.get("location") ?? "";
    const after = new Uint8Array(await (await graph.fetch(location)).arrayBuffer());
    expect(after.byteLength).toBe(before.byteLength);
    expect(Buffer.from(after).equals(Buffer.from(before))).toBe(false);
  });
});

describe("delta", () => {
  const url = `/v1.0/drives/${DRIVE}/root/delta`;

  it("returns the whole drive first, then only what changed", async () => {
    const initial = await client.all<DriveItem>(url);
    const expected = tenant.items.filter((i) => i.driveId === DRIVE).map((i) => i.id);
    expect(
      initial.items
        .filter((i) => i.id !== rootId(DRIVE))
        .map((i) => i.id)
        .sort(),
    ).toEqual(expected.sort());
    expect(initial.deltaLink).toBeDefined();

    const [renamed, removed] = tenant.items.filter((i) => i.driveId === DRIVE && i.kind === "file");
    if (!renamed || !removed || !initial.deltaLink) throw new Error("fixture");
    graph.store.update(renamed.id, { name: "Renamed by test.docx" });
    graph.store.delete(removed.id);
    const added = graph.store.addFile(DRIVE, undefined, "New from test.txt", 12);

    const round = await client.all<DriveItem>(initial.deltaLink);
    expect(round.items.map((i) => i.id).sort()).toEqual([renamed.id, removed.id, added.id].sort());
    expect(round.items.find((i) => i.id === removed.id)?.deleted).toEqual({ state: "deleted" });
    expect(round.items.find((i) => i.id === renamed.id)?.name).toBe("Renamed by test.docx");

    const quiet = await client.all<DriveItem>(round.deltaLink ?? "");
    expect(quiet.items).toEqual([]);
  });

  it("never skips an item when others are deleted between pages", async () => {
    const first = await client.get<Page<DriveItem>>(`${url}?$top=20`);
    // Deleting a folder removes its children too, so skip items that are already gone.
    for (const item of first.value.slice(1, 6))
      if (graph.store.get(item.id)) graph.store.delete(item.id);
    const rest = await client.all<DriveItem>(first["@odata.nextLink"] ?? "");
    const seen = new Set([...first.value, ...rest.items].map((i) => i.id));
    const remaining = graph.store.inDrive(DRIVE).map((i) => i.id);
    for (const id of remaining) expect(seen.has(id)).toBe(true);
  });

  it("supports token=latest, rejects garbage and asks for a resync after requireResync()", async () => {
    const latest = await client.get<Page<DriveItem>>(`${url}?token=latest`);
    expect(latest.value).toEqual([]);
    expect((await graph.fetch(`${url}?token=%%%`, { headers: AUTH })).status).toBe(400);
    // No change in between: a token issued "now" must still be invalidated.
    graph.requireResync();
    const res = await graph.fetch(latest["@odata.deltaLink"] ?? "", { headers: AUTH });
    expect(res.status).toBe(410);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("resyncRequired");
    // A fresh full sync works again and yields a usable deltaLink.
    const fresh = await client.all<DriveItem>(url);
    expect((await graph.fetch(fresh.deltaLink ?? "", { headers: AUTH })).status).toBe(200);
  });

  it("keeps the first request's page size for the whole round", async () => {
    const sizes: number[] = [];
    let next: string | undefined = `${url}?$top=7`;
    while (next) {
      const page: Page<DriveItem> = await client.get<Page<DriveItem>>(next);
      sizes.push(page.value.length);
      next = page["@odata.nextLink"];
    }
    expect(sizes.length).toBeGreaterThan(2);
    expect(sizes.slice(1, -1).every((n) => n === 7)).toBe(true);
    expect(sizes[0]).toBe(8); // the root item, then 7
  });
});

describe("throttling and faults", () => {
  it("returns 429 with Retry-After past the limit and recovers after the window", async () => {
    let now = 1_000_000;
    const g = new FakeGraph(tenant, { throttle: { limit: 3, windowMs: 10_000 }, now: () => now });
    for (let i = 0; i < 3; i++)
      expect((await g.fetch("/v1.0/sites", { headers: AUTH })).status).toBe(200);
    const limited = await g.fetch("/v1.0/sites", { headers: AUTH });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("10");
    now += 10_000;
    expect((await g.fetch("/v1.0/sites", { headers: AUTH })).status).toBe(200);
  });

  it("applies faults to pre-authenticated downloads too", async () => {
    const file = tenant.items.find((i) => i.driveId === DRIVE && i.kind === "file");
    const res = await graph.fetch(`/v1.0/drives/${DRIVE}/items/${file?.id}/content`, {
      headers: AUTH,
    });
    graph.failNext(503, 1, 2);
    const failed = await graph.fetch(res.headers.get("location") ?? "");
    expect(failed.status).toBe(503);
    expect(failed.headers.get("retry-after")).toBe("2");
    expect((await graph.fetch(res.headers.get("location") ?? "")).status).toBe(200);
  });

  it("injects faults that a well-behaved client retries through", async () => {
    graph.failNext(503, 2, 3);
    const sites = await client.get<Page<unknown>>("/v1.0/sites");
    expect(sites.value.length).toBeGreaterThan(0);
    expect(client.sleeps).toEqual([3, 3]);
  });
});

describe("subscriptions", () => {
  const expiry = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
  const create = (g: FakeGraph, body: Record<string, unknown>) =>
    g.fetch("/v1.0/subscriptions", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const request = {
    changeType: "updated",
    notificationUrl: "https://hooks.test/graph",
    resource: `/drives/${DRIVE}/root`,
    clientState: "s3cret",
    expirationDateTime: expiry(60),
  };

  it("completes the validation handshake and notifies on every change", async () => {
    const received: { url: string; body: string }[] = [];
    const g = new FakeGraph(tenant, {
      notify: (url, init) => {
        const token = new URL(url).searchParams.get("validationToken");
        received.push({ url, body: String(init.body) });
        return Promise.resolve(new Response(token ?? "", { status: token ? 200 : 202 }));
      },
    });
    const res = await create(g, request);
    expect(res.status).toBe(201);
    const sub = (await res.json()) as { id: string };

    const file = tenant.items.find((i) => i.driveId === DRIVE && i.kind === "file");
    g.store.update(file?.id ?? "", { name: "Changed.txt" });
    g.store.addFile(tenant.sites[0]?.driveId ?? "", undefined, "elsewhere.txt", 1); // other drive: no notification
    await g.flushNotifications();
    const notifications = received.filter((r) => !r.url.includes("validationToken"));
    expect(notifications).toHaveLength(1);
    const payload = JSON.parse(notifications[0]?.body ?? "{}") as {
      value: { subscriptionId: string; clientState: string }[];
    };
    expect(payload.value[0]).toMatchObject({ subscriptionId: sub.id, clientState: "s3cret" });

    expect(
      ((await (await g.fetch("/v1.0/subscriptions", { headers: AUTH })).json()) as Page<unknown>)
        .value,
    ).toHaveLength(1);
    const renewed = await g.fetch(`/v1.0/subscriptions/${sub.id}`, {
      method: "PATCH",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ expirationDateTime: expiry(120) }),
    });
    expect(renewed.status).toBe(200);
    expect((await g.fetch(`/v1.0/subscriptions/${sub.id}`, { headers: AUTH })).status).toBe(200);
    expect(
      (await g.fetch(`/v1.0/subscriptions/${sub.id}`, { method: "DELETE", headers: AUTH })).status,
    ).toBe(204);
    expect(
      (await g.fetch(`/v1.0/subscriptions/${sub.id}`, { method: "DELETE", headers: AUTH })).status,
    ).toBe(404);
  });

  it("rejects endpoints that fail validation, bad resources and bad expiry", async () => {
    const g = new FakeGraph(tenant, { notify: () => Promise.resolve(new Response("wrong")) });
    expect((await create(g, request)).status).toBe(400);
    const ok = new FakeGraph(tenant, {
      notify: (url) =>
        Promise.resolve(new Response(new URL(url).searchParams.get("validationToken"))),
    });
    expect((await create(ok, { ...request, resource: "/users/x/messages" })).status).toBe(400);
    expect((await create(ok, { ...request, notificationUrl: "ftp://x" })).status).toBe(400);
    expect((await create(ok, { ...request, expirationDateTime: expiry(-1) })).status).toBe(400);
    expect(
      (await create(ok, { ...request, expirationDateTime: expiry(MAX_SUBSCRIPTION_MINUTES + 5) }))
        .status,
    ).toBe(400);
    expect((await create(ok, { resource: request.resource })).status).toBe(400);
  });

  it("stops notifying once a subscription expires", async () => {
    let now = Date.now();
    const sent: string[] = [];
    const g = new FakeGraph(tenant, {
      now: () => now,
      notify: (url) => {
        sent.push(url);
        return Promise.resolve(new Response(new URL(url).searchParams.get("validationToken")));
      },
    });
    expect(
      (await create(g, { ...request, expirationDateTime: new Date(now + 60_000).toISOString() }))
        .status,
    ).toBe(201);
    now += 120_000;
    g.store.addFile(DRIVE, undefined, "late.txt", 1);
    await g.flushNotifications();
    expect(sent).toHaveLength(1); // only the validation request
  });
});

describe("listen", () => {
  it("serves the same API over real HTTP on localhost", async () => {
    const server = await graph.listen();
    try {
      const res = await fetch(`${server.url}/v1.0/sites?$top=2`, { headers: AUTH });
      expect(res.status).toBe(200);
      const page = (await res.json()) as Page<unknown>;
      expect(page["@odata.nextLink"]?.startsWith(server.url)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("rejects instead of hanging when the port is taken", async () => {
    const server = await graph.listen();
    try {
      const port = Number(new URL(server.url).port);
      await expect(new FakeGraph(tenant).listen(port)).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await server.close();
    }
  });
});

describe("TenantStore", () => {
  it("renames update the paths of everything below", () => {
    const folder = tenant.items.find(
      (i) => i.kind === "folder" && tenant.items.some((c) => c.parentId === i.id),
    );
    if (!folder) throw new Error("no folder with children");
    graph.store.update(folder.id, { name: "Moved" });
    const child = graph.store.children(folder.driveId, folder.id)[0];
    expect(
      child?.path.startsWith(`${folder.path.slice(0, folder.path.lastIndexOf("/"))}/Moved/`),
    ).toBe(true);
  });

  it("rejects conflicting and invalid names, and bad parents", () => {
    const [a, b] = graph.store.children(DRIVE, undefined);
    if (!a || !b) throw new Error("fixture");
    expect(() => graph.store.update(a.id, { name: b.name.toUpperCase() })).toThrow(/conflict/);
    expect(() => graph.store.update(a.id, { name: "a/b" })).toThrow(RangeError);
    const file = graph.store.inDrive(DRIVE).find((i) => i.kind === "file");
    expect(() => graph.store.addFile(DRIVE, file?.id, "x.txt", 1)).toThrow(TypeError);
    expect(() => graph.store.addFile("d-nope", undefined, "x.txt", 1)).toThrow(RangeError);
    expect(() => graph.store.addFile(DRIVE, undefined, a.name, 1)).toThrow(/conflict/);
    expect(() => graph.store.update("i-nope", {})).toThrow(RangeError);
    const folder = graph.store.inDrive(DRIVE).find((i) => i.kind === "folder");
    expect(() => graph.store.update(folder?.id ?? "", { size: 1 })).toThrow(TypeError);
  });

  it("deletes folders recursively and records a tombstone for each item", () => {
    const folder = graph.store
      .inDrive(DRIVE)
      .find((i) => i.kind === "folder" && graph.store.children(DRIVE, i.id).length > 0);
    if (!folder) throw new Error("no folder with children");
    const before = graph.store.sequence;
    const count =
      graph.store.inDrive(DRIVE).filter((i) => i.path.startsWith(`${folder.path}/`)).length + 1;
    graph.store.delete(folder.id);
    expect(graph.store.changesSince(DRIVE, before).deleted).toHaveLength(count);
    expect(graph.store.get(folder.id)).toBeUndefined();
  });

  it("new files inherit the parent's permissions, and setAcl breaks inheritance", () => {
    const added = graph.store.addFile(DRIVE, undefined, "inherit.txt", 5);
    expect(added.acl.every((a) => a.inherited)).toBe(true);
    expect(added.acl.map((a) => a.principal)).toEqual(expect.arrayContaining([`group:g-hr`]));
    const changed = graph.store.setAcl(added.id, [{ principal: "user:u-0001", role: "owner" }]);
    expect(changed.acl).toEqual([
      { externalId: added.id, principal: "user:u-0001", role: "owner", inherited: false },
    ]);
    expect(tenant.items.find((i) => i.id === added.id)).toBeUndefined(); // source tenant untouched
  });

  it("setAcl on a folder re-derives what inheriting descendants get, and reports them changed", () => {
    const folder = graph.store
      .inDrive(DRIVE)
      .find(
        (f) =>
          f.kind === "folder" &&
          graph.store.children(DRIVE, f.id).some((c) => c.acl.some((a) => a.inherited)),
      );
    if (!folder) throw new Error("no folder with inheriting children");
    const child = graph.store
      .children(DRIVE, folder.id)
      .find((c) => c.acl.some((a) => a.inherited));
    if (!child) throw new Error("fixture");
    const shares = child.acl.filter((a) => !a.inherited);
    const before = graph.store.sequence;
    graph.store.setAcl(folder.id, [{ principal: "user:u-0001", role: "owner" }]);
    expect(child.acl).toEqual([
      { externalId: child.id, principal: "user:u-0001", role: "owner", inherited: true },
      ...shares,
    ]);
    const changed = graph.store.changesSince(DRIVE, before).items.map((i) => i.id);
    expect(changed).toEqual(expect.arrayContaining([folder.id, child.id]));
  });

  it("changes cTag only when content changes, and eTag on every change", async () => {
    const file = graph.store.inDrive(DRIVE).find((i) => i.kind === "file");
    if (!file) throw new Error("fixture");
    const get = async () =>
      (await (
        await graph.fetch(`/v1.0/drives/${DRIVE}/items/${file.id}`, { headers: AUTH })
      ).json()) as { eTag: string; cTag: string };
    const v1 = await get();
    graph.store.update(file.id, { name: "Only renamed.txt" });
    const v2 = await get();
    expect(v2.cTag).toBe(v1.cTag);
    expect(v2.eTag).not.toBe(v1.eTag);
    graph.store.update(file.id, { size: file.size + 1 });
    expect((await get()).cTag).not.toBe(v1.cTag);
  });
});

describe("parseRange", () => {
  it("handles open, suffix and clamped ranges", () => {
    expect(parseRange("bytes=0-", 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=-30", 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=5-100", 10)).toEqual({ start: 5, end: 9 });
  });

  it("ignores ranges it cannot serve (RFC 9110) and reports unsatisfiable ones", () => {
    for (const ignored of [undefined, "bytes=-", "bytes=5-2", "items=0-1", "bytes=0-1,3-4"]) {
      expect(parseRange(ignored, 10)).toBeUndefined();
    }
    expect(parseRange("bytes=10-", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=-5", 0)).toBe("unsatisfiable");
  });
});
