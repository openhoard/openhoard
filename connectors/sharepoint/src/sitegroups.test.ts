import type { Connector } from "@openhoard/sdk";
import { selfSignedCertificate } from "@openhoard/testkit";
import { beforeAll, beforeEach, expect, it } from "vitest";
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

function connector(credential: ClientCredential): Connector {
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
