import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Connector, SyncEvent } from "@openhoard/sdk";
import { connectorContract, type ContractSource } from "@openhoard/sdk/testing";
import { graphAuth } from "./auth.js";
import { sharepointConnector } from "./connector.js";
import { AUTHORITY, CLIENT_ID, fakes, GRAPH, SECRET, UNPACED } from "./testing/fakes.js";

/*
 * T-308: the SharePoint connector passes the contract kit over the fake Graph, one site with
 * one library, changed through the fake's store as people would change it in SharePoint.
 *
 * The kit's source is one tree; a site is libraries, each a folder at the top. So the
 * connector is seen through one library: its folder is left out, and the paths start below it.
 */

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../openhoard.plugin.json", import.meta.url)), "utf8"),
) as unknown;

const CHECKPOINT_EVERY = 5;

async function open(): Promise<ContractSource> {
  const f = fakes({ items: 20 });
  f.entra.registerApp({ clientId: CLIENT_ID, secret: SECRET, appRoles: ["Sites.Selected"] });
  const site = f.tenant.sites[0] as (typeof f.tenant.sites)[0];
  f.entra.grantSite(CLIENT_ID, site.id);
  const store = f.graph.store;
  const drive = site.driveId;
  for (const item of store.children(drive, undefined)) store.delete(item.id);
  const stateDir = mkdtempSync(join(tmpdir(), "oh-sp-contract-"));

  const find = (path: readonly string[]) => {
    let parent: string | undefined;
    let found;
    for (const name of path) {
      found = store.children(drive, parent).find((i) => i.name === name);
      if (!found) return undefined;
      parent = found.id;
    }
    return found;
  };
  const folder = (path: readonly string[]) => {
    let parent: string | undefined;
    for (const name of path) {
      const next =
        store.children(drive, parent).find((i) => i.name === name) ??
        store.addFolder(drive, parent, name);
      parent = next.id;
    }
    return parent;
  };
  const existing = (path: readonly string[]) => {
    const item = find(path);
    if (!item) throw new Error(`nothing at ${path.join("/")}`);
    return item;
  };

  const inner = sharepointConnector({
    auth: graphAuth({
      tenant: f.tenant.domain,
      clientId: CLIENT_ID,
      credential: { kind: "secret", secret: SECRET },
      authority: AUTHORITY,
      graph: GRAPH,
      fetch: f.fetch,
      now: () => f.clock.now,
    }),
    site: site.id,
    fetch: f.fetch,
    now: () => f.clock.now,
    sleep: f.sleep,
    unitsPerMinute: UNPACED,
    pageSize: CHECKPOINT_EVERY,
    stateDir,
  });

  return {
    connector: inLibrary(inner),
    mkdir: async (path) => {
      folder(path);
    },
    write: async (path, bytes) => {
      const at = find(path);
      const file =
        at ??
        store.addFile(
          drive,
          folder(path.slice(0, -1)),
          path[path.length - 1] as string,
          0,
          "application/octet-stream",
        );
      store.write(file.id, bytes);
    },
    move: async (from, to) => {
      const item = existing(from);
      const parent = folder(to.slice(0, -1));
      if (parent !== item.parentId) store.move(item.id, parent);
      const name = to[to.length - 1] as string;
      if (name !== item.name) store.update(item.id, { name });
    },
    remove: async (path) => {
      store.delete(existing(path).id);
    },
    close: async () => {
      rmSync(stateDir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

/** The connector as the kit sees one library: the library's folder out, paths below it. */
function inLibrary(connector: Connector): Connector {
  async function* below(events: AsyncIterable<SyncEvent>): AsyncGenerator<SyncEvent> {
    for await (const e of events) {
      if (e.type !== "item") {
        yield e;
        continue;
      }
      if (e.item.path.length === 1) continue;
      yield {
        ...e,
        item: {
          ...e.item,
          path: e.item.path.slice(1),
          parentId: e.item.path.length === 2 ? null : e.item.parentId,
        },
      };
    }
  }
  const delta = connector.delta;
  return {
    ...connector,
    describe: () => connector.describe(),
    crawl: (checkpoint, signal) => below(connector.crawl(checkpoint, signal)),
    ...(delta ? { delta: (cursor, signal) => below(delta.call(connector, cursor, signal)) } : {}),
  };
}

connectorContract("sharepoint", { checkpointEvery: CHECKPOINT_EVERY, manifest, open });
