import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUser, type User } from "@openhoard/core-identity";
import { coreEnrichSteps, enrichVersion, runSync, type EnrichPayload } from "@openhoard/core-jobs";
import {
  FakeEntra,
  FakeGraph,
  FakeSharePoint,
  generateTenant,
  selfSignedCertificate,
  type FakeTenant,
} from "@openhoard/testkit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConfigSchema } from "../config.js";
import { prepareSources } from "../sources.js";
import { tenantKeyStore } from "../tenant-keys.js";
import { openHarness, type Harness } from "./tools.fixtures.js";

/*
 * M1's exit, end to end on the fake Microsoft 365 (T-1105): a SharePoint site named in the
 * configuration is crawled with its permissions, a file shared through the site's Members
 * group reaches the people in it, and they find it, open it in SharePoint and see why they may
 * (PRD scenarios 1 and 4) through the real /mcp endpoint; someone else finds its title at most.
 */

vi.setConfig({ testTimeout: process.platform === "win32" ? 300_000 : 120_000 });

const CLIENT_ID = "11111111-2222-4333-8444-555555555555";
const AUTHORITY = "https://login.test";
const GRAPH = "https://graph.test";

let h: Harness;
let dir: string;
let tenant: FakeTenant;
let entra: FakeEntra;
let graph: FakeGraph;
let sharepoint: FakeSharePoint;
let send: typeof fetch;

beforeEach(async () => {
  h = await openHarness({ embed: false });
  dir = mkdtempSync(join(tmpdir(), "oh-m1-"));
  tenant = generateTenant({ items: 40 });
  entra = new FakeEntra(tenant, { graph: GRAPH });
  graph = new FakeGraph(tenant, { entra });
  sharepoint = new FakeSharePoint(tenant, { entra });
  const sites = new Set(tenant.sites.map((s) => new URL(s.webUrl).origin));
  send = (input, init) => {
    const url = String(input);
    if (url.startsWith(`${AUTHORITY}/`)) return entra.fetch(url, init);
    if (url.startsWith(`${GRAPH}/`)) return graph.fetch(url, init);
    if (sites.has(new URL(url).origin)) return sharepoint.fetch(url, init);
    return Promise.reject(new TypeError(`fetch failed: nothing at ${url}`));
  };
});
afterEach(async () => {
  await h?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

it("a file shared through a site's Members group is found, opened and explained by its members only", async () => {
  const site = tenant.sites[0] as FakeTenant["sites"][0];
  const cert = selfSignedCertificate();
  writeFileSync(join(dir, "app.pem"), cert.certificate);
  writeFileSync(join(dir, "app.key"), cert.privateKey);
  entra.registerApp({
    clientId: CLIENT_ID,
    certificate: cert.certificate,
    appRoles: ["Sites.Selected"],
  });
  entra.grantSite(CLIENT_ID, site.id);

  // Two people of the directory, here as people of the tenant (matched by email: local users).
  const [inside, outside] = tenant.users.filter((u) => !u.guest) as [
    FakeTenant["users"][0],
    FakeTenant["users"][0],
  ];
  const person = (u: FakeTenant["users"][0]): Promise<User> =>
    h.inTenant((tx) =>
      createUser(tx, h.tenantId, { email: u.upn, displayName: u.displayName, source: "local" }),
    );
  const member = await person(inside);
  const other = await person(outside);
  // The site's Members group holds the first; one file is shared with the group alone.
  sharepoint.defineGroup(site.id, 5, [{ user: inside.id }]);
  const file = graph.store.inDrive(site.driveId).find((i) => i.kind === "file") as {
    id: string;
    name: string;
  };
  graph.store.setAcl(file.id, [{ principal: "sitegroup:5", role: "read" }]);

  const config = ConfigSchema.parse({
    dataDir: dir,
    sources: [
      {
        id: "sp-site",
        connector: "sharepoint",
        tenantId: h.tenantId,
        site: site.id,
        directory: tenant.domain,
        clientId: CLIENT_ID,
        authority: AUTHORITY,
        graph: GRAPH,
        certificate: {
          certificateFile: join(dir, "app.pem"),
          privateKeyFile: join(dir, "app.key"),
        },
        downloadHosts: [".sharepoint.test"],
        zone: "Site",
        owner: "ana@example.com",
        graphUnitsPerMinute: 1_000_000,
      },
    ],
  });
  const tenantKey = tenantKeyStore(dir, { hasContent: async () => false });
  const prepared = await prepareSources(h.db, config, { tenantKey, fetch: send });
  const scheduled = prepared.scheduled[0] as (typeof prepared.scheduled)[0];

  // The crawl, and enrichment of what it recorded (a version stays hidden until processed).
  const recorded: EnrichPayload[] = [];
  const report = await runSync(h.db, {
    tenantId: h.tenantId,
    source: scheduled.source,
    zoneId: scheduled.zoneId,
    connector: scheduled.connector,
    ownerId: (await scheduled.owner()) as string,
    tenantKey,
    enqueue: async (tenantId, result) =>
      void recorded.push({ tenantId, versionId: result.versionId }),
    sleep: async () => {},
  });
  expect(report).toMatchObject({ status: "done", skipped: [] });
  expect(report.counts.grantsAdded).toBeGreaterThan(0);
  for (const payload of recorded) {
    const outcome = await enrichVersion(h.db, coreEnrichSteps(), payload, {
      signal: new AbortController().signal,
      requeue: async () => undefined,
    });
    expect(outcome).toBe("processed");
  }

  // Scenario 1: the member finds it by its name and opens it where it lives.
  const words = file.name
    .replace(/\.[^.]+$/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  const asMember = await h.token({ user: member });
  const found = await h.call(asMember, "find", { query: words });
  const card = [found.data.top, ...found.data.alternatives].find(
    (c: { title: string } | null) => c?.title === file.name,
  );
  expect(card).toMatchObject({ access: "read", metadataOnly: false });
  const opened = await h.call(asMember, "open", { id: card.id, mode: "link" });
  expect(opened.data.link).toMatch(new RegExp(`^${site.webUrl.replace(/[.]/g, "\\.")}/`));

  // Scenario 4: the source's owner, whose files these are here, asks why the member may.
  const why = await h.call(await h.token(), "explain", { id: card.id, person: inside.upn });
  expect(why.isError).toBe(false);
  expect(why.data.person).toMatchObject({ canRead: true });
  expect(why.data.access).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: inside.displayName, role: "read" })]),
  );

  // Someone outside the group gets no more than the tenant lets anyone discover: no content.
  const asOther = await h.call(await h.token({ user: other }), "find", { query: words });
  const seen = [asOther.data.top, ...asOther.data.alternatives].find(
    (c: { title: string } | null) => c?.title === file.name,
  );
  if (seen) expect(seen).toMatchObject({ access: "title-only" });
  const refused = await h.call(await h.token({ user: other }), "open", {
    id: card.id,
    mode: "link",
  });
  // A real refusal, not a failed call: the file as they may know it, and no link.
  expect(refused).toMatchObject({
    isError: false,
    data: { file: { id: card.id, access: "title-only" }, link: null },
  });
});
