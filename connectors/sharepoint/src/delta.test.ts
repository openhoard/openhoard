import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkEvent,
  errorCode,
  type Connector,
  type SourceItem,
  type SyncEvent,
} from "@openhoard/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { graphAuth } from "./auth.js";
import { sharepointConnector, type SharePointConnectorOptions } from "./connector.js";
import { AUTHORITY, CLIENT_ID, fakes, GRAPH, SECRET, type Fakes } from "./testing/fakes.js";

/*
 * T-304: following a site's changes. The measure throughout: what a catalog holds after a crawl
 * and the deltas that followed is what a fresh crawl of the site as it is now would give it.
 */

let f: Fakes;
let site: Fakes["tenant"]["sites"][0];
let stateDir: string;
const never = new AbortController().signal;

beforeEach(() => {
  f = fakes({ items: 900, maxFileBytes: 2048 });
  f.entra.registerApp({ clientId: CLIENT_ID, secret: SECRET, appRoles: ["Sites.Selected"] });
  site = f.tenant.sites[0] as typeof site;
  f.entra.grantSite(CLIENT_ID, site.id);
  stateDir = mkdtempSync(join(tmpdir(), "oh-sp-state-"));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true, maxRetries: 5 });
});

/** A connector that remembers nothing itself: what it knows between runs is in `stateDir`. */
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
    stateDir,
    ...over,
  });
}
async function collect(events: AsyncIterable<SyncEvent>): Promise<SyncEvent[]> {
  const out: SyncEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}
const crawl = (c = connector(), token: string | null = null) => collect(c.crawl(token, never));
const delta = (cursor: string, c = connector()) =>
  collect((c.delta as NonNullable<Connector["delta"]>)(cursor, never));
const cursorOf = (events: SyncEvent[]) => (events.at(-1) as { cursor: string }).cursor;
const failure = (work: Promise<unknown>) =>
  work.then(
    () => undefined,
    (e: unknown) => e as Error,
  );

/** What a catalog would hold: the items by id, as the events applied in order leave them. */
type Model = Map<string, SourceItem>;
function apply(model: Model, events: SyncEvent[]): Model {
  const description = connector().describe();
  for (const e of events) {
    expect(checkEvent(e, description), JSON.stringify(e)).toBeNull();
    if (e.type === "item") {
      // Parents before their children, always.
      if (e.item.parentId !== null)
        expect(model.has(e.item.parentId), e.item.externalId).toBe(true);
      model.set(e.item.externalId, e.item);
    } else if (e.type === "deleted") model.delete(e.externalId);
  }
  return model;
}
/** The site as a crawl that knows nothing of what came before sees it now. */
const fresh = async (over: Partial<SharePointConnectorOptions> = {}): Promise<Model> =>
  apply(new Map(), await crawl(connector({ ...over, stateDir: undefined as never })));
const sorted = (model: Model) =>
  [...model.values()].sort((a, b) => (a.externalId < b.externalId ? -1 : 1));

const store = () => f.graph.store;
const items = () => store().inDrive(site.driveId);
const folderWith = (pick: (children: ReturnType<typeof items>) => boolean) =>
  items().find(
    (i) => i.kind === "folder" && pick(items().filter((c) => c.parentId === i.id)),
  ) as ReturnType<typeof items>[0];
const files = () => readdirSync(stateDir).filter((name) => !name.startsWith("."));
const generations = () => files().filter((name) => name.startsWith("folders."));

/** The site with a second library: another site's drive, listed among this one's. */
function twoLibraries(): { fetch: typeof fetch; other: typeof site } {
  const other = f.tenant.sites[1] as typeof site;
  f.entra.grantSite(CLIENT_ID, other.id);
  const send: typeof fetch = async (input, init) => {
    const response = await f.fetch(input, init);
    if (!String(input).includes(`/sites/${site.id}/drives`) || !response.ok) return response;
    const page = (await response.json()) as { value: unknown[] };
    page.value.push({ id: other.driveId, name: "Archive" });
    return new Response(JSON.stringify(page));
  };
  return { fetch: send, other };
}
/** A `fetch` whose pages of a library's feed are changed on the way back. */
const feed =
  (change: (page: { value: Record<string, unknown>[] }, url: string) => void): typeof fetch =>
  async (input, init) => {
    const response = await f.fetch(input, init);
    if (!String(input).includes("/root/delta") || !response.ok) return response;
    const page = (await response.json()) as { value: Record<string, unknown>[] };
    change(page, String(input));
    return new Response(JSON.stringify(page));
  };

describe("following changes", () => {
  it("says it can, with a state directory, and only then", () => {
    expect(connector().describe().capabilities.delta).toBe(true);
    expect(connector().delta).toBeTypeOf("function");
    const without = connector({ stateDir: undefined as never });
    expect(without.describe().capabilities.delta).toBe(false);
    expect(without.delta).toBeUndefined();
    expect(() => connector({ recrawlAfterDays: -1 })).toThrow(RangeError);
    expect(() => connector({ roundRequests: 0 })).toThrow(RangeError);
  });

  it("yields nothing but `done` when nothing changed", async () => {
    const cursor = cursorOf(await crawl());
    const events = await delta(cursor);
    expect(events.map((e) => e.type)).toEqual(["done"]);
    // And again from where that left off.
    expect((await delta(cursorOf(events))).map((e) => e.type)).toEqual(["done"]);
  });

  it("brings a catalog to what a fresh crawl would give: files added, changed, renamed, deleted", async () => {
    const model = apply(new Map(), await crawl());
    let cursor = cursorOf(await crawl());
    const some = items().filter((i) => i.kind === "file");
    const folder = folderWith((c) => c.length > 0);
    store().addFile(site.driveId, folder.id, "new report.txt", 300);
    store().addFile(site.driveId, undefined, "at the top.txt", 10);
    store().update((some[0] as { id: string }).id, { size: 777 });
    store().update((some[1] as { id: string }).id, { name: "renamed file.bin" });
    store().delete((some[2] as { id: string }).id);

    const events = await delta(cursor);
    expect(events.filter((e) => e.type === "item")).toHaveLength(4);
    expect(events.filter((e) => e.type === "deleted")).toEqual([
      { type: "deleted", externalId: `${site.driveId}:${(some[2] as { id: string }).id}` },
    ]);
    apply(model, events);
    expect(sorted(model)).toEqual(sorted(await fresh()));
    cursor = cursorOf(events);
    expect((await delta(cursor)).map((e) => e.type)).toEqual(["done"]);
  });

  it("says where everything in a renamed or moved folder is now, though Graph says only the folder", async () => {
    const model = apply(new Map(), await crawl());
    let cursor = cursorOf(await crawl());
    // A folder with folders in it, so there are grandchildren to find.
    const deep = folderWith((c) =>
      c.some((x) => x.kind === "folder" && items().some((y) => y.parentId === x.id)),
    );
    const below = (id: string): string[] =>
      items()
        .filter((i) => i.parentId === id)
        .flatMap((i) => [i.id, ...below(i.id)]);
    const leaving = store().addFile(site.driveId, deep.id, "leaving.txt", 3);
    apply(model, await delta(cursor));
    cursor = cursorOf(await delta(cursor));
    const under = below(deep.id);
    expect(under.length).toBeGreaterThan(3);
    const was = new Map(under.map((id) => [id, model.get(`${site.driveId}:${id}`) as SourceItem]));

    // The store's item is live: its name is read before it changes.
    const renamed = `${deep.name} (2026)`;
    store().update(deep.id, { name: renamed });
    let events = await delta(cursor);
    // Graph gave one entry; the connector says the folder and everything under it.
    const said = events.flatMap((e) => (e.type === "item" ? [e.item.externalId] : []));
    expect(new Set(said)).toEqual(
      new Set([deep.id, ...under].map((id) => `${site.driveId}:${id}`)),
    );
    apply(model, events);
    for (const id of under) {
      const now = model.get(`${site.driveId}:${id}`) as SourceItem;
      expect(now.path).toContain(renamed);
      expect(now.etag).not.toBe(was.get(id)?.etag);
      expect(now.contentVersion).toBe(was.get(id)?.contentVersion);
    }
    expect(sorted(model)).toEqual(sorted(await fresh()));
    cursor = cursorOf(events);

    // Moved into another folder, and a file moved out of it, in one round.
    const target = items().find(
      (i) =>
        i.kind === "folder" && i.id !== deep.id && !under.includes(i.id) && i.parentId !== deep.id,
    ) as ReturnType<typeof items>[0];
    store().move(deep.id, target.id);
    store().move(leaving.id, undefined);
    events = await delta(cursor);
    apply(model, events);
    expect(sorted(model)).toEqual(sorted(await fresh()));
    cursor = cursorOf(events);

    // A new folder, files put in it, then the folder renamed: all in one round.
    const made = store().addFolder(site.driveId, undefined, "Inbox");
    store().addFile(site.driveId, made.id, "a.txt", 5);
    const inner = store().addFolder(site.driveId, made.id, "Inner");
    store().addFile(site.driveId, inner.id, "b.txt", 6);
    store().update(made.id, { name: "Inbox 2" });
    events = await delta(cursor);
    apply(model, events);
    expect(sorted(model)).toEqual(sorted(await fresh()));
    // And renamed again later: the kept folders knew it under its new name.
    store().update(made.id, { name: "Inbox 3" });
    events = await delta(cursorOf(events));
    expect(events.filter((e) => e.type === "item")).toHaveLength(4);
    apply(model, events);
    expect(sorted(model)).toEqual(sorted(await fresh()));
  });

  it("says a deleted folder and everything in it are gone", async () => {
    const model = apply(new Map(), await crawl());
    const cursor = cursorOf(await crawl());
    const doomed = folderWith((c) => c.length > 1);
    const count = items().length;
    store().delete(doomed.id);
    const events = await delta(cursor);
    expect(events.filter((e) => e.type === "deleted")).toHaveLength(count - items().length);
    expect(events.some((e) => e.type === "item")).toBe(false);
    apply(model, events);
    expect(sorted(model)).toEqual(sorted(await fresh()));
  });

  it("crawls again when Graph says a folder went and nothing of the folders in it", async () => {
    const cursor = cursorOf(await crawl());
    const doomed = folderWith((c) => c.some((x) => x.kind === "folder"));
    store().delete(doomed.id);
    // The feed with only the folder itself deleted, as a source that says no more would give.
    const terse = feed((page) => {
      page.value = page.value.filter((v) => v.id === doomed.id);
    });
    expect(errorCode(await failure(delta(cursor, connector({ fetch: terse }))))).toBe("resync");
  });

  it("takes the last word on an item that comes twice, and places one whose folder it never kept", async () => {
    const model = apply(new Map(), await crawl());
    const cursor = cursorOf(await crawl());
    const file = items().find((i) => i.kind === "file") as ReturnType<typeof items>[0];
    store().update(file.id, { name: "final name.txt" });
    // The feed gives the item twice, an older state first.
    const twice = feed((page) => {
      const again = page.value.find((v) => v.id === file.id);
      if (again) page.value.unshift({ ...again, name: "older name.txt" }, { name: "no id" });
    });
    const events = await delta(cursor, connector({ fetch: twice }));
    expect(events.filter((e) => e.type === "item")).toHaveLength(1);
    expect(events).toContainEqual({ type: "warning", code: "unreadable" });
    apply(model, events);
    expect(model.get(`${site.driveId}:${file.id}`)?.path.at(-1)).toBe("final name.txt");

    // A folder the kept state doesn't have (taken out by hand): asked for, yielded, kept.
    const [genFile] = files().filter((n) => n.startsWith("folders."));
    const path = join(stateDir, genFile as string);
    const kept = JSON.parse(readFileSync(path, "utf8")) as {
      drives: Record<string, [string, string | null, string][]>;
    };
    const parent = folderWith((c) => c.some((x) => x.kind === "file"));
    kept.drives[site.driveId] = (kept.drives[site.driveId] ?? []).filter(
      ([id]) => id !== parent.id,
    );
    writeFileSync(path, JSON.stringify(kept));
    store().addFile(site.driveId, parent.id, "into the unknown.txt", 9);
    const after = await delta(cursorOf(events));
    apply(model, after);
    expect(sorted(model)).toEqual(sorted(await fresh()));
    const gen = (JSON.parse(cursorOf(after)) as { gen: string }).gen;
    const keptNow = JSON.parse(
      readFileSync(join(stateDir, `folders.${gen}.json`), "utf8"),
    ) as typeof kept;
    expect(keptNow.drives[site.driveId]?.some(([id]) => id === parent.id)).toBe(true);
  });
});

describe("a round of changes", () => {
  it("is a crawl's work when it would ask too much of Graph", async () => {
    const cursor = cursorOf(await crawl());
    const deep = folderWith((c) =>
      c.some((x) => x.kind === "folder" && items().some((y) => y.parentId === x.id)),
    );
    store().update(deep.id, { name: "Renamed with much in it" });
    // The feed's page, the folder's children, and no more: the folders in it aren't reached.
    expect(errorCode(await failure(delta(cursor, connector({ roundRequests: 2 }))))).toBe("resync");
    // Nothing was kept of the attempt: the same cursor, with room, gives the whole answer.
    const events = await delta(cursor);
    expect(events.at(-1)?.type).toBe("done");
    expect(events.filter((e) => e.type === "item").length).toBeGreaterThan(3);
    // A feed that never ends runs out of it too.
    const endless = feed((page, url) => {
      (page as Record<string, unknown>)["@odata.nextLink"] = `${url}&again=${Math.random()}`;
      delete (page as Record<string, unknown>)["@odata.deltaLink"];
    });
    expect(errorCode(await failure(delta(cursor, connector({ fetch: endless }))))).toBe("resync");
  });

  it("goes on past a folder it may not list, saying so", async () => {
    const model = apply(new Map(), await crawl());
    const cursor = cursorOf(await crawl());
    const folder = folderWith((c) => c.length > 1);
    const inside = items().filter((i) => i.parentId === folder.id);
    store().update(folder.id, { name: "Renamed and closed" });
    const closed: typeof fetch = (input, init) =>
      String(input).includes(`/items/${folder.id}/children`)
        ? Promise.resolve(new Response("{}", { status: 403 }))
        : f.fetch(input, init);
    const events = await delta(cursor, connector({ fetch: closed }));
    expect(events).toContainEqual({
      type: "warning",
      code: "unlisted-folder",
      externalId: `${site.driveId}:${folder.id}`,
    });
    expect(events.at(-1)?.type).toBe("done");
    apply(model, events);
    // The folder is where it is now; what is in it is still where it was.
    expect(model.get(`${site.driveId}:${folder.id}`)?.path.at(-1)).toBe("Renamed and closed");
    const child = model.get(`${site.driveId}:${(inside[0] as { id: string }).id}`) as SourceItem;
    expect(child.path).not.toContain("Renamed and closed");
    // It is tried again at the next round, though Graph has nothing new to say of the folder.
    apply(model, await delta(cursorOf(events)));
    expect(sorted(model)).toEqual(sorted(await fresh()));
  });

  it("sees a folder given a name it can hold after one it couldn't", async () => {
    const model = apply(new Map(), await crawl());
    const cursor = cursorOf(await crawl());
    const folder = folderWith((c) => c.length > 1);
    store().update(folder.id, { name: "Any name" });
    // Graph gives it a name no path can hold: it is warned of, with what is in it left be.
    const unholdable = feed((page) => {
      for (const v of page.value) if (v.id === folder.id) v.name = "a/b";
    });
    const first = await delta(cursor, connector({ fetch: unholdable }));
    expect(first).toContainEqual({
      type: "warning",
      code: "invalid-item",
      externalId: `${site.driveId}:${folder.id}`,
    });
    apply(model, first);
    // Then one it can: the folder isn't where it was kept, so what is in it is said again.
    store().update(folder.id, { name: "A good name" });
    apply(model, await delta(cursorOf(first)));
    expect(sorted(model)).toEqual(sorted(await fresh()));
  });

  it("is checkpointed library by library, and goes on from any of them", async () => {
    const two = twoLibraries();
    const c = () => connector({ fetch: two.fetch });
    const model = apply(new Map(), await crawl(c()));
    const cursor = cursorOf(await crawl(c()));
    expect(new Set(sorted(model).map((i) => i.path[0])).size).toBe(2);

    const folder = folderWith((x) => x.length > 1);
    store().update(folder.id, { name: "Renamed in the first" });
    const made = store().addFolder(two.other.driveId, undefined, "Made in the second");
    store().addFile(two.other.driveId, made.id, "in it.txt", 12);
    const events = await delta(cursor, c());
    const tokens = events.flatMap((e) => (e.type === "checkpoint" ? [e.token] : []));
    expect(tokens).toHaveLength(2);
    // Each library that changed its folders wrote a generation; the cursor's own went once
    // the first checkpoint was behind.
    expect(generations()).toHaveLength(2);
    expect(generations()).not.toContain(
      `folders.${(JSON.parse(cursor) as { gen: string }).gen}.json`,
    );
    apply(model, events);
    expect(sorted(model)).toEqual(sorted(await fresh({ fetch: two.fetch })));

    // From the first checkpoint (the runner saved it and was killed): the first library has
    // nothing more to say, the second says its part again.
    const again = await delta(tokens[0] as string, c());
    const said = (list: SyncEvent[]) =>
      list.flatMap((e) => (e.type === "item" ? [e.item.externalId] : []));
    expect(said(again).length).toBeGreaterThan(0);
    expect(said(again).every((id) => id.startsWith(`${two.other.driveId}:`))).toBe(true);
    apply(model, again);
    expect(sorted(model)).toEqual(sorted(await fresh({ fetch: two.fetch })));
    // And on from its end.
    store().addFile(two.other.driveId, made.id, "later.txt", 7);
    apply(model, await delta(cursorOf(again), c()));
    expect(sorted(model)).toEqual(sorted(await fresh({ fetch: two.fetch })));
  });
});

describe("what a crawl leaves for the first delta", () => {
  it("is a folder renamed while the crawl was stopped: what was yielded under it is said again", async () => {
    // Killed after its second checkpoint, with a folder and some of what is in it yielded.
    const first: SyncEvent[] = [];
    const tokens: string[] = [];
    for await (const e of connector().crawl(null, never)) {
      if (e.type === "checkpoint" && tokens.push(e.token) === 2) break;
      first.push(e);
    }
    const yielded = new Set(first.flatMap((e) => (e.type === "item" ? [e.item.externalId] : [])));
    const has = (id: string) => yielded.has(`${site.driveId}:${id}`);
    const folder = items().find(
      (i) =>
        i.kind === "folder" &&
        has(i.id) &&
        items().some((c) => c.parentId === i.id && has(c.id)) &&
        items().some((c) => c.parentId === i.id && !has(c.id)),
    ) as ReturnType<typeof items>[0];
    expect(folder, "a folder with children on both sides of the kill").toBeDefined();
    store().update(folder.id, { name: "Renamed while stopped" });

    const model = apply(new Map(), first);
    const rest = await crawl(connector(), tokens[1] as string);
    apply(model, rest);
    // The crawl alone leaves what it yielded before the kill at the old path...
    expect(sorted(model)).not.toEqual(sorted(await fresh()));
    // ...and the first delta puts it right.
    apply(model, await delta(cursorOf(rest)));
    expect(sorted(model)).toEqual(sorted(await fresh()));
  });

  it("is a folder the feed gave twice, under two names", async () => {
    const folder = folderWith((c) => c.length > 1);
    // The crawl's feed gives the folder once more at its end, renamed since.
    let pages = 0;
    const renamedLater = feed((page, url) => {
      if (url.includes("token=") && ++pages === 3) store().update(folder.id, { name: "Twice" });
      const last = (page as Record<string, unknown>)["@odata.deltaLink"] !== undefined;
      const mine = url.includes(`/drives/${site.driveId}/`);
      if (last && mine && pages >= 3 && !page.value.some((v) => v.id === folder.id)) {
        page.value.push({
          id: folder.id,
          name: "Twice",
          folder: {},
          parentReference: { id: folder.parentId ?? `${site.driveId}-root` },
        });
      }
    });
    const events = await crawl(connector({ fetch: renamedLater }));
    expect(pages).toBeGreaterThanOrEqual(3);
    const model = apply(new Map(), events);
    const gen = (JSON.parse(cursorOf(events)) as { gen: string }).gen;
    const kept = JSON.parse(readFileSync(join(stateDir, `folders.${gen}.json`), "utf8")) as {
      relist: Record<string, string[]>;
    };
    expect(kept.relist[site.driveId]).toEqual([folder.id]);
    const after = await delta(cursorOf(events));
    apply(model, after);
    expect(sorted(model)).toEqual(sorted(await fresh()));
    // Done once: the generation that follows has nothing left to do.
    const next = (JSON.parse(cursorOf(after)) as { gen: string }).gen;
    expect(next).not.toBe(gen);
    expect(readFileSync(join(stateDir, `folders.${next}.json`), "utf8")).toContain('"relist":{}');
  });

  it("is nothing it asks Graph for again: a resumed crawl places items as it did before", async () => {
    const tokens: string[] = [];
    for await (const e of connector().crawl(null, never)) {
      if (e.type === "checkpoint" && tokens.push(e.token) === 2) break;
    }
    const before = f.sent.length;
    const rest = await crawl(connector(), tokens[1] as string);
    const byId = f.sent.slice(before).filter((r) => /\/items\/[^/?]+\?/.test(r.url));
    expect(byId).toEqual([]);
    // Every parent it needed was one it had logged: none is yielded twice.
    const again = rest.flatMap((e) => (e.type === "item" && e.item.kind === "folder" ? [e] : []));
    expect(again.length).toBeLessThan(items().filter((i) => i.kind === "folder").length);
  });

  it("is said a part at a time when it is much, each id once", async () => {
    const gone = Array.from({ length: 230 }, (_, i) => `i-gone-${i}`);
    const told = feed((page, url) => {
      if (!url.includes("token=")) page.value.push(...gone.map((id) => ({ id, deleted: {} })));
    });
    const events = await crawl(connector({ fetch: told }));
    const deletedIn = (list: SyncEvent[]) =>
      list.flatMap((e) => (e.type === "deleted" ? [e.externalId] : []));
    const first = await delta(cursorOf(events));
    expect(deletedIn(first)).toHaveLength(200);
    const second = await delta(cursorOf(first));
    expect(deletedIn(second)).toHaveLength(30);
    expect(new Set([...deletedIn(first), ...deletedIn(second)]).size).toBe(230);
    expect((await delta(cursorOf(second))).map((e) => e.type)).toEqual(["done"]);
  });

  it("waits when Graph won't say whether an item is there", async () => {
    const told = feed((page, url) => {
      if (!url.includes("token=")) page.value.push({ id: "i-gone", deleted: {} });
    });
    const events = await crawl(connector({ fetch: told }));
    const refusing: typeof fetch = (input, init) =>
      String(input).includes("/items/i-gone?")
        ? Promise.resolve(new Response("{}", { status: 403 }))
        : f.fetch(input, init);
    const first = await delta(cursorOf(events), connector({ fetch: refusing }));
    expect(first.some((e) => e.type === "deleted")).toBe(false);
    expect((await delta(cursorOf(first))).filter((e) => e.type === "deleted")).toHaveLength(1);
  });

  it("is what it was told is deleted: never said by the crawl, said by the delta if still gone", async () => {
    const live = items().find((i) => i.kind === "file") as ReturnType<typeof items>[0];
    const told = feed((page, url) => {
      if (url.includes("token=")) return;
      page.value.push({ id: "i-gone", deleted: {} }, { id: live.id, deleted: {} });
      // The live one comes after its deletion elsewhere in the feed: it is there.
    });
    const events = await crawl(connector({ fetch: told }));
    expect(events.some((e) => e.type === "deleted")).toBe(false);
    const after = await delta(cursorOf(events));
    expect(after.filter((e) => e.type === "deleted")).toEqual([
      { type: "deleted", externalId: `${site.driveId}:i-gone` },
    ]);
    // Once.
    expect((await delta(cursorOf(after))).map((e) => e.type)).toEqual(["done"]);
  });
});

describe("what is kept between runs", () => {
  it("is each library's folders, under the generation the cursor names, and nothing else", async () => {
    const events = await crawl();
    const cursor = JSON.parse(cursorOf(events)) as { gen: string; crawled: number };
    expect(cursor.crawled).toBe(f.clock.now);
    const kept = JSON.parse(readFileSync(join(stateDir, `folders.${cursor.gen}.json`), "utf8")) as {
      drives: Record<string, [string, string | null, string][]>;
    };
    const folders = items().filter((i) => i.kind === "folder");
    expect(new Set((kept.drives[site.driveId] ?? []).map(([id]) => id))).toEqual(
      new Set([`${site.driveId}-root`, ...folders.map((x) => x.id)]),
    );
    // Folder ids and names: no file's name, nothing of its content.
    const text = readFileSync(join(stateDir, `folders.${cursor.gen}.json`), "utf8");
    for (const file of items()
      .filter((i) => i.kind === "file")
      .slice(0, 20)) {
      expect(text).not.toContain(file.id);
    }

    // A delta that changes no folder writes nothing new; one that does writes a generation,
    // and the one before goes when the next delta starts from the new cursor.
    store().addFile(site.driveId, undefined, "x.txt", 1);
    const second = await delta(cursorOf(events));
    expect((JSON.parse(cursorOf(second)) as { gen: string }).gen).toBe(cursor.gen);
    store().addFolder(site.driveId, undefined, "New folder");
    const third = await delta(cursorOf(second));
    const gen3 = (JSON.parse(cursorOf(third)) as { gen: string }).gen;
    expect(gen3).not.toBe(cursor.gen);
    expect(files().sort()).toEqual([`folders.${cursor.gen}.json`, `folders.${gen3}.json`].sort());
    await delta(cursorOf(third));
    expect(files()).toEqual([`folders.${gen3}.json`]);
  });

  it("gives the same answer when a delta is run again from a cursor the runner kept", async () => {
    const cursor = cursorOf(await crawl());
    const folder = folderWith((c) => c.length > 2);
    store().update(folder.id, { name: "Renamed once" });
    store().addFolder(site.driveId, folder.id, "Sub");
    // The run's events were lost before the runner saved its cursor: it starts from the old one.
    const first = await delta(cursor);
    const again = await delta(cursor);
    const said = (events: SyncEvent[]) =>
      events.flatMap((e) =>
        e.type === "item" ? [[e.item.externalId, e.item.path.join("/")]] : [],
      );
    expect(said(again)).toEqual(said(first));
    expect(said(first).length).toBeGreaterThan(3);
  });

  it("survives a crawl killed and resumed, from its last checkpoint or an earlier one", async () => {
    const whole = await crawl();
    const wholeCursor = JSON.parse(cursorOf(whole)) as { gen: string };
    const complete = readFileSync(join(stateDir, `folders.${wholeCursor.gen}.json`), "utf8");
    const keptOf = (text: string) =>
      new Set(
        (JSON.parse(text) as { drives: Record<string, [string, string | null, string][]> }).drives[
          site.driveId
        ]?.map((e) => JSON.stringify(e)),
      );

    rmSync(stateDir, { recursive: true, force: true });
    // Killed after the fourth checkpoint was yielded (pages beyond the second are logged)...
    const tokens: string[] = [];
    for await (const e of connector().crawl(null, never)) {
      if (e.type === "checkpoint" && tokens.push(e.token) === 4) break;
    }
    // ...and resumed from the second, which the runner had saved: the log is cut back to it.
    const resumed = await crawl(connector(), tokens[1] as string);
    const cursor = JSON.parse(cursorOf(resumed)) as { gen: string };
    expect(keptOf(readFileSync(join(stateDir, `folders.${cursor.gen}.json`), "utf8"))).toEqual(
      keptOf(complete),
    );
    // Changes are followed from it as from an unbroken crawl.
    const model = apply(new Map(), [...(await crawl(connector({ stateDir: undefined as never })))]);
    const folder = folderWith((c) => c.length > 1);
    store().update(folder.id, { name: "After the kill" });
    apply(model, await delta(cursorOf(resumed)));
    expect(sorted(model)).toEqual(sorted(await fresh()));
  });
});

describe("a delta that can't go on means a crawl", () => {
  it("when what it kept is gone, the cursor isn't one, or the crawl is too old", async () => {
    const events = await crawl();
    const cursor = cursorOf(events);
    const resync = async (work: Promise<unknown>, why: string) =>
      expect(errorCode(await failure(work)), why).toBe("resync");
    const position = JSON.parse(cursor) as Record<string, unknown>;

    await resync(delta(JSON.stringify({ ...position, gen: undefined })), "no generation");
    await resync(
      delta(JSON.stringify({ ...position, gen: "0123456789abcdef0123" })),
      "unknown generation",
    );
    await resync(delta(JSON.stringify({ ...position, gen: "../../etc" })), "not a generation");
    await resync(delta(JSON.stringify({ ...position, crawled: "then" })), "not a time");
    await resync(delta(JSON.stringify({ ...position, log: { id: "x", at: -1 } })), "not a log");
    const mid = (events.find((e) => e.type === "checkpoint") as { token: string }).token;
    await resync(delta(mid), "a crawl's checkpoint, not a cursor");
    await resync(delta("not json"), "not a token");

    // A week on, the crawl is too old to follow changes from; unless told never to mind.
    f.clock.now += 8 * 86_400_000;
    await resync(delta(cursor), "too old");
    expect((await delta(cursor, connector({ recrawlAfterDays: 0 }))).at(-1)?.type).toBe("done");
    f.clock.now -= 8 * 86_400_000;
    // A crawl stamped days ahead of the clock: its age is anyone's guess.
    f.clock.now -= 2 * 86_400_000;
    await resync(delta(cursor), "from the future");
    f.clock.now += 2 * 86_400_000;

    // A link Graph says isn't one (400), where a lapsed one is 410.
    const done = position.done as Record<string, string>;
    const broken = Object.fromEntries(
      Object.entries(done).map(([id, link]) => [id, link.replace(/token=.*/, "token=nonsense")]),
    );
    await resync(delta(JSON.stringify({ ...position, done: broken })), "400");

    // Graph no longer takes the link.
    f.graph.requireResync();
    await resync(delta(cursor), "410");

    // The state directory lost (a restore without it).
    rmSync(stateDir, { recursive: true, force: true });
    await resync(delta(cursor), "state gone");
  });

  it("when a library was added, removed or renamed", async () => {
    const cursor = cursorOf(await crawl());
    const renamed: typeof fetch = async (input, init) => {
      const response = await f.fetch(input, init);
      if (!String(input).includes(`/sites/${site.id}/drives`) || !response.ok) return response;
      const page = (await response.json()) as { value: { name: string }[] };
      for (const drive of page.value) drive.name = "Another name";
      return new Response(JSON.stringify(page));
    };
    expect(errorCode(await failure(delta(cursor, connector({ fetch: renamed }))))).toBe("resync");
    const more = twoLibraries().fetch;
    expect(errorCode(await failure(delta(cursor, connector({ fetch: more }))))).toBe("resync");
    const none: typeof fetch = (input, init) =>
      String(input).includes(`/sites/${site.id}/drives`)
        ? Promise.resolve(new Response('{"value":[]}'))
        : f.fetch(input, init);
    expect(errorCode(await failure(delta(cursor, connector({ fetch: none }))))).toBe("resync");
  });

  it("and a crawl resumed without its log ends with a cursor nothing can be followed from", async () => {
    const tokens: string[] = [];
    for await (const e of connector().crawl(null, never)) {
      if (e.type === "checkpoint" && tokens.push(e.token) === 2) break;
    }
    const token = tokens[1] as string;
    const log = (JSON.parse(token) as { log: { id: string; at: number } }).log;
    const genOf = (events: SyncEvent[]) => (JSON.parse(cursorOf(events)) as { gen?: string }).gen;
    // A longer log than the token knew is cut back, and the crawl ends as an unbroken one.
    expect(genOf(await crawl(connector(), token))).toEqual(expect.any(String));
    // A shorter or missing one (another node's, or lost) can't be trusted. The crawl goes on
    // all the same, to the same items, and the sync after it crawls again.
    const filesIn = (events: SyncEvent[]) =>
      events
        .flatMap((e) => (e.type === "item" && e.item.kind === "file" ? [e.item] : []))
        .map((i) => `${i.externalId} ${i.path.join("/")}`)
        .sort();
    const whole = filesIn(await crawl(connector(), token));
    expect(whole.length).toBeGreaterThan(20);
    for (const lose of [
      () => writeFileSync(join(stateDir, `crawl.${log.id}.jsonl`), ""),
      () => rmSync(stateDir, { recursive: true, force: true }),
    ]) {
      lose();
      const events = await crawl(connector(), token);
      // (Folders yielded before the token are asked for again, and yielded again: no log.)
      expect(filesIn(events)).toEqual(whole);
      apply(new Map(), events);
      expect(genOf(events)).toBeUndefined();
      // Its checkpoints name no log: resumed again, it still keeps none.
      const later = events.find((e) => e.type === "checkpoint") as { token: string };
      expect(JSON.parse(later.token)).not.toHaveProperty("log");
      expect(genOf(await crawl(connector(), later.token))).toBeUndefined();
      expect(errorCode(await failure(delta(cursorOf(events))))).toBe("resync");
    }
    // A token of a crawl that kept nothing, given to one that keeps: the same.
    const stateless = connector({ stateDir: undefined as never });
    let plain = "";
    for await (const e of stateless.crawl(null, never)) {
      if (e.type === "checkpoint") {
        plain = e.token;
        break;
      }
    }
    expect(genOf(await crawl(connector(), plain))).toBeUndefined();
    // The other way round is fine: the log is simply not kept.
    expect((await crawl(stateless, token)).at(-1)?.type).toBe("done");
  });
});
