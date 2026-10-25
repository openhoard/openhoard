import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorCode, type Connector, type SyncEvent } from "@openhoard/sdk";
import { selfSignedCertificate } from "@openhoard/testkit";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { graphAuth, type ClientCredential } from "./auth.js";
import { sharepointConnector } from "./connector.js";
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
 * T-305: a file shared through a site's SharePoint group ("Finance Members") is shared with
 * the group's members, as SharePoint's own API names them.
 */

let f: Fakes;
let cert: ReturnType<typeof selfSignedCertificate>;
const never = new AbortController().signal;

beforeAll(() => {
  cert = selfSignedCertificate();
});
beforeEach(() => {
  f = fakes({ items: 30 });
  f.entra.registerApp({
    clientId: CLIENT_ID,
    secret: SECRET,
    certificate: cert.certificate,
    appRoles: ["Sites.Selected"],
  });
  f.entra.grantSite(CLIENT_ID, site().id);
});

const site = () => f.tenant.sites[0] as Fakes["tenant"]["sites"][0];
const files = () => f.graph.store.inDrive(site().driveId).filter((i) => i.kind === "file");
const ana = () => f.tenant.users[0] as Fakes["tenant"]["users"][0];

let stateDir: string | undefined;
afterEach(() => {
  if (stateDir !== undefined) rmSync(stateDir, { recursive: true, force: true, maxRetries: 5 });
  stateDir = undefined;
});

function connector(credential: ClientCredential, pageSize?: number): Connector {
  return sharepointConnector({
    auth: graphAuth({
      tenant: f.tenant.domain,
      clientId: CLIENT_ID,
      credential,
      authority: AUTHORITY,
      graph: GRAPH,
      fetch: f.fetch,
      now: () => f.clock.now,
    }),
    site: site().id,
    fetch: f.fetch,
    now: () => f.clock.now,
    sleep: f.sleep,
    unitsPerMinute: UNPACED,
    downloadHosts: [".sharepoint.test"],
    ...(stateDir === undefined ? {} : { stateDir }),
    ...(pageSize === undefined ? {} : { pageSize }),
  });
}
const certificate = (): ClientCredential => ({
  kind: "certificate",
  certificate: cert.certificate,
  privateKey: cert.privateKey,
});
const aclOf = (c: Connector, id: string) =>
  (c.aclImport as NonNullable<Connector["aclImport"]>)(
    { externalId: `${site().driveId}:${id}` },
    never,
  ).then((acl) => acl.entries.map((e) => [e.principal, e.role]));

it("grants what a SharePoint group is given to the people and groups in it", async () => {
  const [one, two] = files();
  f.sharepoint.defineGroup(site().id, 5, [
    { user: ana().id },
    { group: "g-finance" },
    // A Microsoft 365 group's owners are not the group: nobody here, as in permissions.
    { group: "g-finance", owners: true },
    { everyone: true },
  ]);
  for (const file of [one, two]) {
    f.graph.store.setAcl(file?.id as string, [{ principal: "sitegroup:5", role: "write" }]);
  }
  const c = connector(certificate());
  expect(await aclOf(c, one?.id as string)).toEqual([
    [{ kind: "group", id: "g-finance" }, "write"],
    [{ kind: "organization" }, "write"],
    [{ kind: "user", id: ana().id, email: ana().upn.toLowerCase() }, "write"],
  ]);
  // Asked once for both files.
  expect(await aclOf(c, two?.id as string)).toHaveLength(3);
  expect(f.sharepoint.requests).toHaveLength(1);

  // An answer without the account's id names the person by claim, matched by email alone.
  f.sharepoint.objectIds = false;
  f.sharepoint.defineGroup(site().id, 5, [{ user: ana().id }]);
  expect(await aclOf(connector(certificate()), one?.id as string)).toEqual([
    [
      {
        kind: "user",
        id: `siteuser:i:0#.f|membership|${ana().upn}`,
        email: ana().upn.toLowerCase(),
      },
      "write",
    ],
  ]);
});

it("leaves a SharePoint group granting nobody when the app signs in with a secret", async () => {
  const [one] = files();
  f.graph.store.setAcl(one?.id as string, [{ principal: "sitegroup:5", role: "read" }]);
  // SharePoint takes no app-only token made with a secret: it isn't asked.
  expect(await aclOf(connector({ kind: "secret", secret: SECRET }), one?.id as string)).toEqual([
    [{ kind: "group", id: `sitegroup:${site().id}:5` }, "read"],
  ]);
  expect(f.sharepoint.requests).toHaveLength(0);
});

/** A run as the runner drives it: one file's permissions asked as it is recorded. */
async function drive(
  connect: () => Connector,
  first: (c: Connector) => AsyncIterable<SyncEvent>,
  file: string,
  o: { onFile?: () => void; restartAfterFile?: boolean } = {},
): Promise<string> {
  let c = connect();
  let events = first(c);
  // "first": whichever file of the library the crawl meets first.
  let target = file === "first" ? undefined : `${site().driveId}:${file}`;
  for (;;) {
    let restartAt: string | undefined;
    let seen = false;
    for await (const e of events) {
      const ours =
        e.type === "item" &&
        e.item.kind === "file" &&
        e.item.externalId.startsWith(`${site().driveId}:`);
      if (ours && target === undefined) target = e.item.externalId;
      if (e.type === "item" && e.item.externalId === target) {
        await (c.aclImport as NonNullable<Connector["aclImport"]>)(e.item, never);
        o.onFile?.();
        seen = true;
      }
      if (
        e.type === "checkpoint" &&
        seen &&
        o.restartAfterFile === true &&
        restartAt === undefined
      ) {
        restartAt = e.token;
        break;
      }
      if (e.type === "done") return e.cursor;
    }
    if (restartAt === undefined) throw new Error("the run ended without a cursor");
    // Another process takes over from the checkpoint, knowing nothing of what was asked.
    o.restartAfterFile = false;
    c = connect();
    events = c.crawl(restartAt, never);
  }
}
const deltaOf = (c: Connector, cursor: string) =>
  (async () => {
    let next = "";
    for await (const e of (c.delta as NonNullable<Connector["delta"]>)(cursor, never)) {
      if (e.type === "done") next = e.cursor;
    }
    return next;
  })().then(
    (next) => next,
    (e: unknown) => (errorCode(e as Error) === "resync" ? "resync" : Promise.reject(e)),
  );

it("crawls again when someone left a group the site's files were recorded with", async () => {
  const [one] = files();
  const file = one?.id as string;
  f.sharepoint.defineGroup(site().id, 5, [{ user: ana().id }]);
  f.graph.store.setAcl(file, [{ principal: "sitegroup:5", role: "read" }]);
  stateDir = mkdtempSync(join(tmpdir(), "oh-sp-groups-"));
  const c = connector(certificate());
  const crawled = await drive(
    () => c,
    (x) => x.crawl(null, never),
    file,
  );
  expect(Object.keys((JSON.parse(crawled) as { groups: object }).groups)).toEqual(["5"]);

  // Nobody joined or left: the delta goes on, asking the group again.
  const asked = f.sharepoint.requests.length;
  const followed = await deltaOf(c, crawled);
  expect(followed).not.toBe("resync");
  expect(f.sharepoint.requests.length).toBe(asked + 1);

  // Ana leaves Members within the minutes her membership is kept: the next run crawls, and
  // that crawl records the file with who is in the group now.
  f.sharepoint.defineGroup(site().id, 5, []);
  expect(await deltaOf(c, followed)).toBe("resync");
  expect(await aclOf(c, file)).toEqual([]);
});

it("crawls again when someone left during the crawl, or the crawl moved to another process", async () => {
  const [one] = files();
  const file = one?.id as string;
  f.sharepoint.defineGroup(site().id, 5, [{ user: ana().id }]);
  f.graph.store.setAcl(file, [{ principal: "sitegroup:5", role: "read" }]);
  stateDir = mkdtempSync(join(tmpdir(), "oh-sp-groups-"));

  // The file is recorded granting Ana; she leaves; the crawl goes on past the kept minutes.
  const left = await drive(
    () => connector(certificate()),
    (x) => x.crawl(null, never),
    file,
    {
      onFile: () => {
        f.sharepoint.defineGroup(site().id, 5, []);
        f.clock.now += 16 * 60_000;
      },
    },
  );
  expect(await deltaOf(connector(certificate()), left)).toBe("resync");

  // The first page's files are recorded in one process, the crawl ends in another (which
  // records none: the group is on those files only), and then Ana leaves.
  f.sharepoint.defineGroup(site().id, 5, [{ user: ana().id }]);
  let restarted = 0;
  for (const other of files()) {
    f.graph.store.setAcl(other.id, [{ principal: "sitegroup:5", role: "read" }]);
  }
  const moved = await drive(
    () => (restarted++, connector(certificate(), 5)),
    (x) => x.crawl(null, never),
    "first",
    { restartAfterFile: true },
  );
  expect(restarted).toBe(2);
  expect(Object.keys((JSON.parse(moved) as { groups: object }).groups)).toEqual(["5"]);
  f.sharepoint.defineGroup(site().id, 5, []);
  expect(await deltaOf(connector(certificate()), moved)).toBe("resync");
});
