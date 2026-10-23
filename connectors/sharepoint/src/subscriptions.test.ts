import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorCode } from "@openhoard/sdk";
import { afterEach, beforeEach, expect, it } from "vitest";
import { graphAuth } from "./auth.js";
import { sharepointConnector, type SharePointConnector } from "./connector.js";
import { LIFETIME_MS, type Subscriptions } from "./subscriptions.js";
import {
  AUTHORITY,
  CLIENT_ID,
  fakes,
  GRAPH,
  SECRET,
  UNPACED,
  type Fakes,
} from "./testing/fakes.js";

/*
 * T-304: Graph told of the site's libraries, and a change in one reaching OpenHoard as a
 * notification only this source's clientState makes believable.
 */

const URL = "https://hoard.example/graph/notifications/tnt_1/site";
const STATE = "a".repeat(64);
const never = new AbortController().signal;

let f: Fakes;
let stateDir: string;
/** Notifications delivered to `URL`, and whether it answers Graph's check. */
let delivered: unknown[];
let reachable: boolean;

beforeEach(() => {
  delivered = [];
  reachable = true;
  f = fakes({
    items: 20,
    notify: async (url, init) => {
      const token = new globalThis.URL(url).searchParams.get("validationToken");
      if (!reachable || !url.startsWith(URL)) throw new TypeError("fetch failed");
      if (token !== null) return new Response(token);
      delivered.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 202 });
    },
  });
  f.entra.registerApp({ clientId: CLIENT_ID, secret: SECRET, appRoles: ["Sites.Selected"] });
  f.entra.grantSite(CLIENT_ID, f.tenant.sites[0]?.id as string);
  stateDir = mkdtempSync(join(tmpdir(), "oh-sp-subs-"));
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true, maxRetries: 5 }));

/** A connector as the server builds one at start: nothing in memory, its state on disk. */
function subscriptions(clientState = STATE): Subscriptions {
  const connector: SharePointConnector = sharepointConnector({
    auth: graphAuth({
      tenant: f.tenant.domain,
      clientId: CLIENT_ID,
      credential: { kind: "secret", secret: SECRET },
      authority: AUTHORITY,
      graph: GRAPH,
      fetch: f.fetch,
      now: () => f.clock.now,
    }),
    site: f.tenant.sites[0]?.id as string,
    fetch: f.fetch,
    now: () => f.clock.now,
    sleep: f.sleep,
    unitsPerMinute: UNPACED,
    stateDir,
  });
  return (connector.subscriptions as NonNullable<SharePointConnector["subscriptions"]>)({
    url: URL,
    clientState,
  });
}
const subs = () => [...f.graph.subscriptions.values()];

it("subscribes to the library, and a change there notifies with this source's clientState", async () => {
  const s = subscriptions();
  const wait = await s.keep(never);
  expect(subs()).toHaveLength(1);
  expect(wait).toBeLessThanOrEqual(6 * 3600_000);

  const item = f.graph.store
    .inDrive(f.tenant.sites[0]?.driveId as string)
    .find((i) => i.kind === "file");
  f.graph.store.update(item?.id as string, { size: 5 });
  await f.graph.flushNotifications();
  expect(delivered).toHaveLength(1);
  expect(s.changed(delivered[0])).toBe(true);
  // Anyone can POST to the address: without the clientState it is not believed.
  expect(subscriptions("b".repeat(64)).changed(delivered[0])).toBe(false);
  expect(s.changed({ value: [{ subscriptionId: subs()[0]?.id }] })).toBe(false);
});

it("renews what it made after a restart, rather than making more", async () => {
  await subscriptions().keep(never);
  const [made] = subs();
  // Nothing to do yet: a second server start asks Graph nothing new.
  await subscriptions().keep(never);
  expect(subs()).toEqual([made]);

  f.clock.now += LIFETIME_MS - 3600_000;
  await subscriptions().keep(never);
  expect(subs()).toHaveLength(1);
  expect(subs()[0]?.id).toBe(made?.id);
  expect(Date.parse(subs()[0]?.expirationDateTime as string)).toBe(f.clock.now + LIFETIME_MS);

  // Graph forgot it (lapsed while the server was down): made again.
  f.graph.subscriptions.clear();
  f.clock.now += LIFETIME_MS - 3600_000;
  await subscriptions().keep(never);
  expect(subs()).toHaveLength(1);
  expect(subs()[0]?.id).not.toBe(made?.id);
});

it("is refused for good when Graph can't reach the address", async () => {
  reachable = false;
  const e = (await subscriptions()
    .keep(never)
    .then(
      () => undefined,
      (x: unknown) => x,
    )) as Error;
  expect(errorCode(e)).toBe("permanent");
  expect(e.message).toContain("publicUrl");
  expect(subs()).toHaveLength(0);
});
