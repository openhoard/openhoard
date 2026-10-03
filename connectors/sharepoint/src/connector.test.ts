import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  checkEvent,
  errorCode,
  manifestCapabilities,
  refOf,
  type Connector,
  type SourceItem,
  type SyncEvent,
} from "@openhoard/sdk";
import { contentBytes } from "@openhoard/testkit";
import { beforeEach, describe, expect, it } from "vitest";
import { graphAuth } from "./auth.js";
import { sharepointConnector, type SharePointConnectorOptions } from "./connector.js";
import { AUTHORITY, CLIENT_ID, fakes, GRAPH, SECRET, type Fakes } from "./testing/fakes.js";

/*
 * T-303: the connector crawls one site's libraries through the fake Graph (whose delta feed is
 * shaped as Graph documents it: no parent paths, no cTag), with checkpoints it resumes from.
 */

let f: Fakes;
let site: Fakes["tenant"]["sites"][0];
const never = new AbortController().signal;

beforeEach(() => {
  f = fakes({ items: 600, maxFileBytes: 4096 });
  f.entra.registerApp({ clientId: CLIENT_ID, secret: SECRET, appRoles: ["Sites.Selected"] });
  site = f.tenant.sites[0] as typeof site;
  f.entra.grantSite(CLIENT_ID, site.id);
});

function connector(over: Partial<SharePointConnectorOptions> = {}): Connector {
  const send = over.fetch ?? f.fetch;
  return sharepointConnector({
    auth: graphAuth({
      tenant: f.tenant.domain,
      clientId: CLIENT_ID,
      credential: { kind: "secret", secret: SECRET },
      authority: AUTHORITY,
      graph: GRAPH,
      fetch: send,
      now: () => f.clock.now,
    }),
    site: site.id,
    fetch: send,
    now: () => f.clock.now,
    pageSize: 10,
    ...over,
  });
}

async function collect(
  c: Connector,
  checkpoint: string | null = null,
  signal: AbortSignal = never,
): Promise<SyncEvent[]> {
  const out: SyncEvent[] = [];
  for await (const e of c.crawl(checkpoint, signal)) out.push(e);
  return out;
}
const itemsOf = (events: SyncEvent[]) => events.flatMap((e) => (e.type === "item" ? [e.item] : []));
const failure = (work: Promise<unknown>) =>
  work.then(
    () => undefined,
    (e: unknown) => e as Error & { retryAfterMs?: number },
  );
/** What the site holds, as the fake's store has it now. */
const inSite = () => f.graph.store.inDrive(site.driveId);
const namesOf = (path: string) => path.split("/").filter((n) => n !== "");
/** A `fetch` that changes the JSON of Graph's delta pages on the way back. */
const rewriting =
  (
    change: (page: { value: Record<string, unknown>[] } & Record<string, unknown>) => void,
  ): typeof fetch =>
  async (input, init) => {
    const response = await f.fetch(input, init);
    if (!String(input).includes("/root/delta") || !response.ok) return response;
    const page = (await response.json()) as Parameters<typeof change>[0];
    change(page);
    return new Response(JSON.stringify(page), { status: 200 });
  };

describe("what it is", () => {
  it("describes itself as its manifest does", () => {
    const description = connector().describe();
    expect(description).toMatchObject({
      apiVersion: 1,
      id: "connector-sharepoint",
      zoneKinds: ["indexed"],
      capabilities: { delta: false, aclImport: false, redirect: true },
      stableIds: true,
    });
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("../openhoard.plugin.json", import.meta.url)), "utf8"),
    ) as { name: string; version: string; capabilities: string[] };
    expect(manifest.name).toBe(description.id);
    expect(manifest.version).toBe(description.version);
    for (const needed of manifestCapabilities(description)) {
      expect(manifest.capabilities).toContain(needed);
    }
  });

  it("is refused at once for a site that isn't one, or a page size Graph doesn't take", () => {
    expect(() => connector({ site: "a/b" })).toThrow(/not a site/);
    expect(() => connector({ pageSize: 0 })).toThrow(RangeError);
    expect(() => connector({ pageSize: 1000 })).toThrow(RangeError);
  });

  it("is the site, whatever it is called in the configuration", async () => {
    const url = new URL(site.webUrl);
    const byPath = connector({ site: `${url.host}:${url.pathname}` });
    expect(await byPath.identity?.(never)).toBe(`sharepoint:${site.id}`);
    expect(await connector().identity?.(never)).toBe(`sharepoint:${site.id}`);
    expect(itemsOf(await collect(byPath))).toHaveLength(inSite().length + 1);
  });
});

describe("a crawl", () => {
  it("yields every item of the site, the library at the top, parents before children", async () => {
    const events = await collect(connector());
    const description = connector().describe();
    for (const e of events) expect(checkEvent(e, description), JSON.stringify(e)).toBeNull();

    const items = itemsOf(events);
    const stored = inSite();
    expect(items).toHaveLength(stored.length + 1);
    const top = items[0] as SourceItem;
    expect(top).toMatchObject({
      externalId: `${site.driveId}:${site.driveId}-root`,
      kind: "folder",
      parentId: null,
      path: ["Documents"],
    });

    const seen = new Set<string>();
    const byId = new Map(items.map((i) => [i.externalId, i]));
    for (const item of items) {
      if (item.parentId !== null) expect(seen.has(item.parentId), item.externalId).toBe(true);
      seen.add(item.externalId);
    }
    for (const s of stored) {
      const item = byId.get(`${site.driveId}:${s.id}`) as SourceItem;
      expect(item.path, s.path).toEqual(["Documents", ...namesOf(s.path)]);
      expect(item.kind).toBe(s.kind);
      expect(item.parentId).toBe(`${site.driveId}:${s.parentId ?? `${site.driveId}-root`}`);
      expect(item.modifiedAt).toBe(new Date(s.modifiedAt).toISOString());
      expect(item.url).toMatch(/^https:\/\//);
      if (s.kind === "file") {
        expect(item.size).toBe(s.size);
        expect(item.mediaType).toBe(s.mime);
        expect(item.contentVersion).toMatch(/^q:/);
        expect(item.modifiedBy?.id).toBe(s.modifiedBy);
      } else {
        expect(item.size).toBeUndefined();
        expect(item.contentVersion).toBeUndefined();
      }
    }

    // A checkpoint after each page, and the cursor following changes will start from.
    const checkpoints = events.filter((e) => e.type === "checkpoint");
    expect(checkpoints.length).toBeGreaterThanOrEqual(Math.ceil(stored.length / 10));
    const last = events.at(-1) as { type: "done"; cursor: string };
    expect(last.type).toBe("done");
    const cursor = JSON.parse(last.cursor) as { site: string; done: Record<string, string> };
    expect(cursor.site).toBe(site.id);
    expect(cursor.done[site.driveId]).toContain(`/drives/${site.driveId}/root/delta?token=`);
    // Nothing but this site was asked for.
    expect(f.sent.some((s) => s.url.includes(f.tenant.sites[1]?.driveId as string))).toBe(false);
  });

  it("is the same twice, and says what changed after a folder was renamed", async () => {
    const first = itemsOf(await collect(connector()));
    expect(itemsOf(await collect(connector()))).toEqual(first);

    const found = inSite().find(
      (i) => i.kind === "folder" && inSite().some((c) => c.parentId === i.id && c.kind === "file"),
    ) as { id: string; name: string; path: string };
    // As it was: the store's own item changes under the rename.
    const folder = { id: found.id, name: found.name, path: found.path };
    f.graph.store.update(folder.id, { name: `${folder.name} (renamed)` });
    const second = new Map(itemsOf(await collect(connector())).map((i) => [i.externalId, i]));
    let below = 0;
    for (const before of first) {
      const after = second.get(before.externalId) as SourceItem;
      const moved =
        before.path.length > namesOf(folder.path).length &&
        before.path.slice(1, namesOf(folder.path).length + 1).join("/") ===
          namesOf(folder.path).join("/");
      if (moved) {
        below++;
        // Same item, another place: its eTag says so, and its bytes are the ones recorded.
        expect(after.etag).not.toBe(before.etag);
        expect(after.path).not.toEqual(before.path);
        expect(after.contentVersion).toBe(before.contentVersion);
      } else {
        expect(after).toEqual(before);
      }
    }
    expect(below).toBeGreaterThan(1);
  });

  it("goes on from any checkpoint, with nothing remembered, and misses nothing", async () => {
    const paged = () => connector({ pageSize: 7 });
    const whole = await collect(paged());
    const all = new Set(itemsOf(whole).map((i) => i.externalId));
    const at = whole.flatMap((e, i) => (e.type === "checkpoint" ? [i] : []));
    expect(at.length).toBeGreaterThan(3);
    for (const index of [at[0], at[Math.floor(at.length / 2)], at.at(-2), at.at(-1)] as number[]) {
      const token = (whole[index] as { token: string }).token;
      const before = itemsOf(whole.slice(0, index)).map((i) => i.externalId);
      const resumed = await collect(paged(), token);
      const description = connector().describe();
      for (const e of resumed) expect(checkEvent(e, description)).toBeNull();
      const after = itemsOf(resumed);
      // Parents still come first: the folders above what is left are asked for and yielded.
      const seen = new Set<string>();
      for (const item of after) {
        if (item.parentId !== null) expect(seen.has(item.parentId), item.externalId).toBe(true);
        seen.add(item.externalId);
      }
      expect(new Set([...before, ...after.map((i) => i.externalId)])).toEqual(all);
      // And what it yields is what the whole crawl yielded for those items.
      const original = new Map(itemsOf(whole).map((i) => [i.externalId, i]));
      for (const item of after) expect(item).toEqual(original.get(item.externalId));
      expect(resumed.at(-1)).toEqual(whole.at(-1));
    }
  });

  it("puts parents first whatever order Graph gives items in", async () => {
    const reversed = connector({
      fetch: rewriting((page) => {
        page.value.reverse();
      }),
    });
    const items = itemsOf(await collect(reversed));
    const seen = new Set<string>();
    for (const item of items) {
      if (item.parentId !== null) expect(seen.has(item.parentId), item.externalId).toBe(true);
      seen.add(item.externalId);
    }
    const straight = new Map(itemsOf(await collect(connector())).map((i) => [i.externalId, i]));
    expect(seen.size).toBe(straight.size);
    for (const item of items) expect(item).toEqual(straight.get(item.externalId));
  });

  it("says what it can't serve is there, not gone, and passes over it", async () => {
    const below = (id: string): string[] =>
      inSite()
        .filter((i) => i.parentId === id)
        .flatMap((i) => [i.id, ...below(i.id)]);
    const folder = inSite().find(
      (i) => i.kind === "folder" && inSite().some((c) => c.parentId === i.id),
    ) as { id: string };
    const inside = below(folder.id);
    const apart = inSite().filter((i) => i.kind === "file" && !inside.includes(i.id));
    const file = apart[0] as { id: string };
    const sized = apart[1] as { id: string };
    const strange = await collect(
      connector({
        pageSize: 999,
        fetch: rewriting((page) => {
          for (const raw of page.value) {
            if (raw.id === folder.id) raw.name = "..";
            if (raw.id === file.id) {
              delete raw.file;
              raw.remoteItem = {};
            }
            if (raw.id === sized.id) raw.size = -1;
          }
          page.value.push(
            { id: "i-gone", deleted: { state: "deleted" } },
            { name: "no id" },
            7 as never,
          );
        }),
      }),
    );
    const warnings = strange.flatMap((e) => (e.type === "warning" ? [e] : []));
    const coded = (code: string) =>
      warnings.filter((w) => w.code === code).map((w) => w.externalId);
    // A name that isn't one: the folder is warned of, and so is everything under it, each by
    // its id (which the runner takes as mentioned: none of them is taken for gone).
    expect(coded("invalid-item")).toContain(`${site.driveId}:${folder.id}`);
    expect(coded("unplaced-item").sort()).toEqual(
      inside.map((id) => `${site.driveId}:${id}`).sort(),
    );
    // A file Graph says nonsense of.
    expect(coded("invalid-item")).toContain(`${site.driveId}:${sized.id}`);
    // Two entries that can't even be named: unknown, not gone, so nothing is reconciled.
    expect(coded("unreadable")).toEqual([undefined, undefined]);
    // What is neither a file nor a folder was never one of ours.
    expect(coded("unsupported-item")).toEqual([`${site.driveId}:${file.id}`]);
    expect(warnings).toHaveLength(inside.length + 5);
    // A deletion in the feed is not said as one: the crawl's reconcile removes what it missed.
    expect(strange.some((e) => e.type === "deleted")).toBe(false);
    const served = new Set(itemsOf(strange).map((i) => i.externalId));
    for (const id of [folder.id, file.id, sized.id, ...inside]) {
      expect(served.has(`${site.driveId}:${id}`)).toBe(false);
    }
    expect(served.size).toBe(inSite().length + 1 - 3 - inside.length);
    for (const e of strange) expect(checkEvent(e, connector().describe())).toBeNull();
  });

  it("can't place what is under a folder that is gone, refused or misnamed when asked for", async () => {
    // Children first, so each folder is asked for by id, and one of them answers oddly.
    const folder = inSite().find(
      (i) => i.kind === "folder" && inSite().some((c) => c.parentId === i.id),
    ) as { id: string };
    const below = (id: string): string[] =>
      inSite()
        .filter((i) => i.parentId === id)
        .flatMap((i) => [i.id, ...below(i.id)]);
    const under = below(folder.id);
    const answering = (answer: (response: Response) => Response | Promise<Response>) =>
      connector({
        pageSize: 999,
        fetch: async (input, init) => {
          const response = await rewriting((page) => {
            // The folder itself isn't in the feed this time: only by id.
            page.value = page.value.filter((raw) => raw.id !== folder.id).reverse();
          })(input, init);
          return String(input).includes(`/items/${folder.id}?`) ? answer(response) : response;
        },
      });
    for (const answer of [
      () => new Response("{}", { status: 404 }),
      () => new Response("{}", { status: 403 }),
      async (r: Response) =>
        new Response(JSON.stringify({ ...((await r.json()) as object), name: ".." })),
      async (r: Response) => {
        const { folder: _folder, ...rest } = (await r.json()) as Record<string, unknown>;
        return new Response(JSON.stringify({ ...rest, file: {} }));
      },
      async (r: Response) => {
        const { parentReference: _parent, ...rest } = (await r.json()) as Record<string, unknown>;
        return new Response(JSON.stringify(rest));
      },
    ]) {
      const events = await collect(answering(answer));
      const unplaced = new Set(
        events.flatMap((e) =>
          e.type === "warning" && e.code === "unplaced-item" ? [e.externalId] : [],
        ),
      );
      for (const id of under) expect(unplaced.has(`${site.driveId}:${id}`), id).toBe(true);
      expect(unplaced.size).toBe(under.length);
      // Nothing here stops the crawl's reconcile: each is named, so each is kept.
      expect(events.some((e) => e.type === "warning" && e.code === "unreadable")).toBe(false);
      // (The library's top comes twice here: asked for by a child, then given by the feed.)
      const served = new Set(itemsOf(events).map((i) => i.externalId));
      expect(served.size).toBe(inSite().length + 1 - 1 - under.length);
    }
    // Asked for and answered as it is: placed, with the folder yielded first.
    const whole = itemsOf(await collect(answering((r) => r)));
    expect(new Set(whole.map((i) => i.externalId)).size).toBe(inSite().length + 1);
    const at = (id: string) => whole.findIndex((i) => i.externalId === `${site.driveId}:${id}`);
    for (const id of under) expect(at(folder.id)).toBeLessThan(at(id));
  });

  it("crawls every library of the site, each a folder at the top, and resumes between them", async () => {
    // The fake gives a site one library: a second is borrowed from another site.
    const other = f.tenant.sites[1] as typeof site;
    f.entra.grantSite(CLIENT_ID, other.id);
    const two: typeof fetch = async (input, init) => {
      const response = await f.fetch(input, init);
      if (!String(input).includes(`/sites/${site.id}/drives`) || !response.ok) return response;
      const page = (await response.json()) as { value: unknown[] };
      page.value.push({ id: other.driveId, name: "Documents", webUrl: other.webUrl });
      return new Response(JSON.stringify(page));
    };
    const whole = await collect(connector({ fetch: two }));
    const items = itemsOf(whole);
    const tops = items.filter((i) => i.parentId === null).map((i) => i.path[0]);
    // Two libraries of one name are told apart.
    expect(tops.sort()).toEqual(
      [`Documents (${site.driveId})`, `Documents (${other.driveId})`].sort(),
    );
    expect(items).toHaveLength(inSite().length + f.graph.store.inDrive(other.driveId).length + 2);
    const cursor = JSON.parse((whole.at(-1) as { cursor: string }).cursor) as {
      done: Record<string, string>;
    };
    expect(Object.keys(cursor.done).sort()).toEqual([site.driveId, other.driveId].sort());

    // Resumed after the first library ended: the second only, and the same end.
    const between = whole.find(
      (e) => e.type === "checkpoint" && (JSON.parse(e.token) as { drive: unknown }).drive === null,
    ) as { token: string };
    const resumed = await collect(connector({ fetch: two }), between.token);
    const firstDone = Object.keys((JSON.parse(between.token) as typeof cursor).done)[0] as string;
    expect(itemsOf(resumed).every((i) => !i.externalId.startsWith(`${firstDone}:`))).toBe(true);
    expect(resumed.at(-1)).toEqual(whole.at(-1));
  });

  it("stops when its caller leaves", async () => {
    const leaving = new AbortController();
    let n = 0;
    const work = (async () => {
      for await (const e of connector().crawl(null, leaving.signal)) {
        if (e.type === "item" && ++n === 30) leaving.abort(new Error("killed"));
      }
    })();
    await expect(work).rejects.toThrow("killed");
    expect(n).toBe(30);
    await expect(collect(connector(), null, AbortSignal.abort(new Error("early")))).rejects.toThrow(
      "early",
    );
  });
});

describe("a crawl that can't go on", () => {
  it("says the site isn't granted, as something an admin fixes", async () => {
    f.entra.revokeSite(CLIENT_ID, site.id);
    const e = await failure(collect(connector()));
    expect(errorCode(e)).toBe("auth");
    expect(e?.message).toContain("isn't granted this site");
  });

  it("says a site that isn't there, or a library it can't name, without taking files for gone", async () => {
    const e = await failure(collect(connector({ site: "s-nowhere" })));
    expect([errorCode(e), e?.message]).toEqual(["permanent", "Graph has no such site"]);
    const unnamed = connector({
      fetch: async (input, init) => {
        const response = await f.fetch(input, init);
        if (!String(input).includes("/drives?") || !response.ok) return response;
        const page = (await response.json()) as { value: unknown[] };
        page.value.push({ id: "a library/with a slash", name: "Odd" });
        return new Response(JSON.stringify(page));
      },
    });
    expect(errorCode(await failure(collect(unnamed)))).toBe("retryable");
    const listless = connector({
      fetch: (input, init) =>
        String(input).includes("/drives?")
          ? Promise.resolve(new Response('{"value":7}'))
          : f.fetch(input, init),
    });
    expect(errorCode(await failure(collect(listless)))).toBe("retryable");
  });

  it("reports a busy Graph as the runner expects, and resumes after it", async () => {
    const c = connector();
    const events: SyncEvent[] = [];
    let token: string | null = null;
    const run = async () => {
      for await (const e of c.crawl(token, never)) {
        events.push(e);
        if (e.type === "checkpoint") {
          token = e.token;
          if (events.filter((x) => x.type === "checkpoint").length === 2) {
            f.graph.failNext(429, 1, 5);
          }
        }
      }
    };
    const throttled = await failure(run());
    expect([errorCode(throttled), throttled?.retryAfterMs]).toEqual(["throttled", 5000]);
    f.graph.failNext(503);
    expect(errorCode(await failure(run()))).toBe("retryable");
    f.graph.failNext(503, 1, 2);
    expect((await failure(run()))?.retryAfterMs).toBe(2000);
    await run();
    expect(new Set(itemsOf(events).map((i) => i.externalId)).size).toBe(inSite().length + 1);
  });

  it("starts again when Graph can't continue from a link, or the token isn't this site's", async () => {
    const whole = await collect(connector());
    const token = (whole.find((e) => e.type === "checkpoint") as { token: string }).token;
    f.graph.requireResync();
    expect(errorCode(await failure(collect(connector(), token)))).toBe("resync");
    // A link out of a token that Graph no longer takes, however it says so.
    for (const status of [400, 404]) {
      const lapsed = connector({
        fetch: (input, init) =>
          String(input).includes("/root/delta?token=")
            ? Promise.resolve(new Response("{}", { status }))
            : f.fetch(input, init),
      });
      expect(errorCode(await failure(collect(lapsed, token))), String(status)).toBe("resync");
      // The same answer to a link it made itself is not "start again": that would never end.
      expect(errorCode(await failure(collect(lapsed))), String(status)).not.toBe("resync");
    }

    const position = JSON.parse(token) as Record<string, unknown>;
    const tokens = [
      "not json",
      "7",
      JSON.stringify({ ...position, v: 2 }),
      JSON.stringify({ ...position, site: "s-another" }),
      JSON.stringify({ ...position, link: null }),
      JSON.stringify({ ...position, drive: "d-gone" }),
      JSON.stringify({ ...position, drive: "a b" }),
      // A link is followed with the app's token on: never one that isn't Graph's.
      JSON.stringify({ ...position, link: "https://evil.test/v1.0/drives/x/root/delta" }),
      JSON.stringify({ ...position, done: { "d-x": "https://evil.test/delta" } }),
      JSON.stringify({ ...position, done: { "d x": `${GRAPH}/v1.0/x` } }),
      JSON.stringify({ ...position, done: 3 }),
    ];
    for (const bad of tokens) {
      const before = f.sent.filter((s) => s.url.includes("evil.test")).length;
      expect(errorCode(await failure(collect(connector(), bad))), bad.slice(0, 60)).toBe("resync");
      expect(f.sent.filter((s) => s.url.includes("evil.test"))).toHaveLength(before);
    }
  });

  it("follows no link out of Graph, and takes no page that isn't one", async () => {
    const elsewhere = connector({
      fetch: rewriting((page) => {
        if (page["@odata.nextLink"]) page["@odata.nextLink"] = "https://evil.test/next";
      }),
    });
    const e = await failure(collect(elsewhere));
    expect(errorCode(e)).toBe("permanent");
    expect(e?.message).not.toContain("evil.test");
    expect(f.sent.some((s) => s.url.includes("evil.test"))).toBe(false);

    const endless = connector({
      fetch: rewriting((page) => {
        delete page["@odata.nextLink"];
        delete page["@odata.deltaLink"];
      }),
    });
    expect(errorCode(await failure(collect(endless)))).toBe("retryable");
    const stuck = connector({
      fetch: async (input, init) => {
        const response = await f.fetch(input, init);
        if (!String(input).includes("/root/delta") || !response.ok) return response;
        const page = (await response.json()) as Record<string, unknown>;
        return new Response(JSON.stringify({ ...page, "@odata.nextLink": String(input) }));
      },
    });
    expect(errorCode(await failure(collect(stuck)))).toBe("retryable");
    const shapeless = connector({
      fetch: rewriting((page) => {
        (page as { value: unknown }).value = "none";
      }),
    });
    expect(errorCode(await failure(collect(shapeless)))).toBe("retryable");
  });

  it("asks for a new token once when Graph refuses the one it has", async () => {
    let refused = 0;
    const once = connector({
      fetch: (input, init) =>
        String(input).includes("/root/delta") && refused++ === 0
          ? Promise.resolve(new Response("{}", { status: 401 }))
          : f.fetch(input, init),
    });
    f.clock.now += 1000;
    expect(itemsOf(await collect(once))).toHaveLength(inSite().length + 1);
    expect(f.entra.requests).toHaveLength(2);
    const always = connector({
      fetch: (input, init) =>
        String(input).includes("/root/delta")
          ? Promise.resolve(new Response("{}", { status: 401 }))
          : f.fetch(input, init),
    });
    expect(errorCode(await failure(collect(always)))).toBe("auth");
  });
});

describe("reading a file", () => {
  const firstFile = async (c: Connector) =>
    itemsOf(await collect(c)).find(
      (i) => i.kind === "file" && (i.size as number) > 100,
    ) as SourceItem;
  const bytesOf = async (body: AsyncIterable<Uint8Array>) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) chunks.push(chunk);
    return Buffer.concat(chunks);
  };
  const stored = (item: SourceItem) =>
    f.graph.store.get(item.externalId.split(":")[1] as string) as ReturnType<typeof inSite>[0];

  it("returns exactly the bytes crawled, and never sends its token to the download", async () => {
    const c = connector();
    const item = await firstFile(c);
    f.sent.length = 0;
    const result = await c.read(refOf(item), never);
    expect(result.contentVersion).toBe(item.contentVersion);
    expect(result.size).toBe(item.size);
    expect(result.contentId).toMatch(/^quickxor:/);
    const bytes = await bytesOf(result.body);
    expect(bytes.equals(Buffer.from(await contentBytes(f.tenant, stored(item))))).toBe(true);
    const download = f.sent.find((s) => s.url.includes("/_download/"));
    expect(download).toBeDefined();
    expect(new Headers(download?.init?.headers).has("authorization")).toBe(false);
    expect(download?.init?.redirect).toBe("manual");
    // Every file of the site reads back whole.
    for (const other of itemsOf(await collect(c))
      .filter((i) => i.kind === "file")
      .slice(0, 40)) {
      const read = await c.read(refOf(other), never);
      expect((await bytesOf(read.body)).length).toBe(other.size);
    }
  });

  it("refuses a file that has changed, before or while it is read", async () => {
    const c = connector();
    const item = await firstFile(c);
    const result = await c.read(refOf(item), never);
    // Replaced while the bytes are on their way: said at the end, not passed off as crawled.
    f.graph.store.update(stored(item).id, { size: (item.size as number) + 10 });
    expect(errorCode(await failure(bytesOf(result.body)))).toBe("changed");
    expect(errorCode(await failure(c.read(refOf(item), never)))).toBe("changed");
    // Renamed only: the same bytes, still readable as the version crawled.
    const other = itemsOf(await collect(c)).find(
      (i) => i.kind === "file" && i.externalId !== item.externalId,
    ) as SourceItem;
    f.graph.store.update(stored(other).id, { name: "renamed.bin" });
    expect((await bytesOf((await c.read(refOf(other), never)).body)).length).toBe(other.size);
    // Another size than the caller expects: refused before any bytes are asked for.
    f.sent.length = 0;
    expect(
      errorCode(
        await failure(c.read({ ...refOf(other), size: (other.size as number) + 1 }, never)),
      ),
    ).toBe("changed");
    expect(f.sent.some((s) => s.url.endsWith("/content"))).toBe(false);
    // Without a version asked for, the one Graph has is returned.
    const { contentVersion: _any, ...loose } = refOf(other);
    expect((await c.read(loose, never)).contentVersion).toBe(other.contentVersion);
  });

  it("tells versions by eTag where Graph gives no hash, at the crawl and at the read alike", async () => {
    f = fakes({ items: 600, maxFileBytes: 4096, contentHashes: false });
    f.entra.registerApp({ clientId: CLIENT_ID, secret: SECRET, appRoles: ["Sites.Selected"] });
    site = f.tenant.sites[0] as typeof site;
    f.entra.grantSite(CLIENT_ID, site.id);
    const c = connector();
    const files = itemsOf(await collect(c)).filter((i) => i.kind === "file");
    // The feed has no cTag and the item asked for by id has one: it is never what is compared.
    expect(files.every((i) => /^e:/.test(i.contentVersion as string))).toBe(true);
    for (const item of files.slice(0, 20)) {
      const result = await c.read(refOf(item), never);
      expect(result.contentVersion).toBe(item.contentVersion);
      expect(result.contentId).toBeUndefined();
      expect((await bytesOf(result.body)).length).toBe(item.size);
    }
    // An eTag changes on a rename too: read again, never missed.
    const item = files[0] as SourceItem;
    f.graph.store.update(stored(item).id, { name: "renamed.bin" });
    expect(errorCode(await failure(c.read(refOf(item), never)))).toBe("changed");
    // A version of a kind Graph no longer gives for the file can't be confirmed.
    expect(
      errorCode(
        await failure(c.read({ ...refOf(files[1] as SourceItem), contentVersion: "q:abc" }, never)),
      ),
    ).toBe("changed");
    expect(
      errorCode(
        await failure(c.read({ ...refOf(files[1] as SourceItem), contentVersion: "c:abc" }, never)),
      ),
    ).toBe("changed");
  });

  it("says a deleted file is gone, and refuses what isn't a file of this source", async () => {
    const c = connector();
    const item = await firstFile(c);
    const folder = itemsOf(await collect(c)).find(
      (i) => i.kind === "folder" && i.parentId !== null,
    ) as SourceItem;
    expect(errorCode(await failure(c.read(refOf(folder), never)))).toBe("permanent");
    f.graph.store.delete(stored(item).id);
    expect(errorCode(await failure(c.read(refOf(item), never)))).toBe("not-found");
    for (const externalId of ["nothing", ":x", "d-x:", "d x:i-1", `${site.driveId}:../x`]) {
      expect(errorCode(await failure(c.read({ externalId }, never))), externalId).toBe("not-found");
    }
    await expect(c.read(refOf(folder), AbortSignal.abort(new Error("early")))).rejects.toThrow(
      "early",
    );
  });

  it("reports a download that fails as the runner expects", async () => {
    const item = await firstFile(connector());
    const downloadSays = (status: number, headers: Record<string, string> = {}) =>
      connector({
        fetch: (input, init) =>
          String(input).includes("/_download/")
            ? Promise.resolve(new Response("x", { status, headers }))
            : f.fetch(input, init),
      }).read(refOf(item), never);
    expect(errorCode(await failure(downloadSays(404)))).toBe("changed");
    const slow = await failure(downloadSays(429, { "retry-after": "3" }));
    expect([errorCode(slow), slow?.retryAfterMs]).toEqual(["throttled", 3000]);
    expect(errorCode(await failure(downloadSays(500)))).toBe("retryable");
    expect(errorCode(await failure(downloadSays(408)))).toBe("retryable");
    // Refused, or sent elsewhere: this file is passed over, the sync goes on.
    expect(errorCode(await failure(downloadSays(403)))).toBe("permanent");
    expect(errorCode(await failure(downloadSays(302, { location: "https://evil.test/" })))).toBe(
      "permanent",
    );
    expect(f.sent.some((s) => s.url.includes("evil.test"))).toBe(false);
    // Graph refusing this one file's content is not the app being refused.
    const blocked = connector({
      fetch: (input, init) =>
        String(input).endsWith("/content")
          ? Promise.resolve(new Response("{}", { status: 403 }))
          : f.fetch(input, init),
    });
    expect(errorCode(await failure(blocked.read(refOf(item), never)))).toBe("permanent");
    const down = connector({
      fetch: (input, init) =>
        String(input).includes("/_download/")
          ? Promise.reject(new TypeError("fetch failed"))
          : f.fetch(input, init),
    });
    expect(errorCode(await failure(down.read(refOf(item), never)))).toBe("retryable");
    // A link that isn't one to follow.
    const nowhere = connector({
      fetch: (input, init) =>
        String(input).endsWith("/content")
          ? Promise.resolve(new Response(null, { status: 302, headers: { location: "ftp://x/y" } }))
          : f.fetch(input, init),
    });
    expect(errorCode(await failure(nowhere.read(refOf(item), never)))).toBe("permanent");
    // Bytes come from Graph or from a host that is allowed, and from nowhere else.
    const bytes = Buffer.from(await contentBytes(f.tenant, stored(item)));
    const linking = (location: string, downloadHosts?: string[]) => {
      const asked: string[] = [];
      const c = connector({
        ...(downloadHosts === undefined ? {} : { downloadHosts }),
        fetch: (input, init) => {
          const url = String(input);
          if (url.endsWith("/content")) {
            return Promise.resolve(new Response(null, { status: 302, headers: { location } }));
          }
          if (URL.canParse(location) && url === new URL(location).href) {
            asked.push(url);
            return Promise.resolve(new Response(bytes, { status: 200 }));
          }
          return f.fetch(input, init);
        },
      });
      return { asked, read: () => c.read(refOf(item), never) };
    };
    for (const [location, hosts] of [
      ["https://files.evil.test/x", undefined],
      ["https://sharepoint.com.evil.test/x", undefined],
      ["https://evilsharepoint.com/x", undefined],
      ["https://sharepoint.com/x", undefined],
      ["https://contoso.sharepoint.com./x", undefined],
      ["https://user:pw@contoso.sharepoint.com/x", undefined],
      ["https://evil.test/contoso.sharepoint.com", undefined],
      ["http://contoso.sharepoint.com/x", undefined],
      ["https://contoso.sharepoint.com/x", ["files.example.com"]],
    ] as const) {
      const elsewhere = linking(location, hosts === undefined ? undefined : [...hosts]);
      const e = await failure(elsewhere.read());
      expect([errorCode(e), elsewhere.asked], location).toEqual(["permanent", []]);
    }
    for (const [location, hosts] of [
      ["https://contoso.sharepoint.com/_layouts/15/download.aspx?x=1", undefined],
      ["https://CONTOSO-my.SharePoint.com/x", undefined],
      ["https://contoso.sharepoint.com:8443/x", undefined],
      ["https://files.example.com/x", ["files.example.com"]],
      ["https://a.b.sharepoint.us/x", [".sharepoint.us"]],
    ] as const) {
      const allowed = linking(location, hosts === undefined ? undefined : [...hosts]);
      expect((await bytesOf((await allowed.read()).body)).length, location).toBe(item.size);
      expect(allowed.asked).toHaveLength(1);
    }
    expect(() => connector({ downloadHosts: ["https://x"] })).toThrow(/downloadHosts/);
    expect(() => connector({ downloadHosts: ["*"] })).toThrow(/downloadHosts/);
    expect(() => connector({ downloadHosts: [".com"] })).toThrow(/downloadHosts/);
    expect(() => connector({ downloadHosts: ["."] })).toThrow(/downloadHosts/);
    // Fewer bytes than the file has: not the file.
    const short = connector({
      fetch: (input, init) =>
        String(input).includes("/_download/")
          ? Promise.resolve(new Response("x", { status: 200 }))
          : f.fetch(input, init),
    });
    const result = await short.read(refOf(item), never);
    expect(errorCode(await failure(bytesOf(result.body)))).toBe("changed");
    // More bytes than the file has: stopped as soon as it shows.
    const long = connector({
      fetch: (input, init) =>
        String(input).includes("/_download/")
          ? Promise.resolve(new Response("x".repeat((item.size as number) + 1), { status: 200 }))
          : f.fetch(input, init),
    });
    expect(errorCode(await failure(bytesOf((await long.read(refOf(item), never)).body)))).toBe(
      "changed",
    );
    // Graph answering with the bytes itself is taken too.
    const direct = connector({
      fetch: async (input, init) => {
        if (!String(input).endsWith("/content")) return f.fetch(input, init);
        return new Response(Buffer.from(await contentBytes(f.tenant, stored(item))), {
          status: 200,
        });
      },
    });
    expect((await bytesOf((await direct.read(refOf(item), never)).body)).length).toBe(item.size);
  });
});

describe("opening an item", () => {
  it("gives the address SharePoint has for it", async () => {
    const c = connector();
    const item = itemsOf(await collect(c)).find((i) => i.kind === "file") as SourceItem;
    expect(await c.redirect?.(refOf(item), never)).toBe(item.url);
    f.graph.store.delete(item.externalId.split(":")[1] as string);
    expect(errorCode(await failure(c.redirect?.(refOf(item), never) as Promise<string>))).toBe(
      "not-found",
    );
  });
});
