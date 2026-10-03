import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { objects, sourceRefs, type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { createUser } from "@openhoard/core-identity";
import { listSourceSyncs, runSync } from "@openhoard/core-jobs";
import {
  FakeEntra,
  FakeGraph,
  generateTenant,
  selfSignedCertificate,
  type FakeTenant,
} from "@openhoard/testkit";
import { and, count, eq, isNull } from "drizzle-orm";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, sourceSecretEnv, SourceSchema } from "./config.js";
import { prepareSources } from "./sources.js";
import { tenantKeyStore } from "./tenant-keys.js";

/*
 * T-303 in the server: a SharePoint site named in the configuration is synced by the SharePoint
 * connector, signed in with a secret from the environment or a certificate from files, against
 * the testkit's fake Entra and fake Graph.
 */

const CLIENT_ID = "11111111-2222-4333-8444-555555555555";
const AUTHORITY = "https://login.test";
const GRAPH = "https://graph.test";
const SECRET = "the-client-secret-value";

let db: Database;
let t: SeededTenant;
let base: string;
let dataDir: string;
let tenant: FakeTenant;
let entra: FakeEntra;
let send: typeof fetch;

beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  await db.withTenant(t.tenantId, (tx) =>
    createUser(tx, t.tenantId, {
      email: "steve@example.com",
      displayName: "Steve",
      source: "local",
    }),
  );
  base = mkdtempSync(join(tmpdir(), "oh-sp-"));
  dataDir = join(base, "data");
  mkdirSync(dataDir);
  tenant = generateTenant({ items: 300 });
  for (const item of tenant.items) item.size = Math.min(item.size, 256);
  entra = new FakeEntra(tenant, { graph: GRAPH });
  const graph = new FakeGraph(tenant, { entra });
  entra.registerApp({ clientId: CLIENT_ID, secret: SECRET, appRoles: ["Sites.Selected"] });
  entra.grantSite(CLIENT_ID, site().id);
  send = (input, init) => {
    const url = String(input);
    if (url.startsWith(`${AUTHORITY}/`)) return entra.fetch(url, init);
    if (url.startsWith(`${GRAPH}/`)) return graph.fetch(url, init);
    return Promise.reject(new TypeError(`fetch failed: nothing at ${url}`));
  };
});
afterEach(async () => {
  await db?.close();
  rmSync(base, { recursive: true, force: true, maxRetries: 5 });
});

const site = () => tenant.sites[0] as FakeTenant["sites"][0];
const source = (more: Record<string, unknown> = {}) => ({
  id: "sp-finance",
  connector: "sharepoint",
  tenantId: t.tenantId,
  site: `${new URL(site().webUrl).host}:${new URL(site().webUrl).pathname}`,
  directory: tenant.domain,
  clientId: CLIENT_ID,
  authority: AUTHORITY,
  graph: GRAPH,
  downloadHosts: ["graph.test"],
  zone: "Finance",
  owner: "steve@example.com",
  ...more,
});
const keys = () => tenantKeyStore(dataDir, { hasContent: async () => false });
/** What the server would log, through its real logger: as JSON lines, parsed. */
function prepare(sources: Record<string, unknown>[], env: NodeJS.ProcessEnv = {}) {
  const lines: string[] = [];
  const log = pino({ level: "debug" }, { write: (line: string) => void lines.push(line) });
  return prepareSources(db, ConfigSchema.parse({ dataDir, sources }), {
    tenantKey: keys(),
    env,
    fetch: send,
    log,
  }).then((prepared) => ({
    prepared,
    text: lines.join(""),
    logged: lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  }));
}

describe("a SharePoint site in the configuration", { timeout: 120_000 }, () => {
  it("is described without its credential, which is never the configuration's to hold", () => {
    const ok = (more: Record<string, unknown> = {}) => SourceSchema.safeParse(source(more)).success;
    expect(ok()).toBe(true);
    expect(SourceSchema.parse(source())).toMatchObject({
      connector: "sharepoint",
      // Every six hours: until changes are followed, a sync crawls the whole site.
      schedule: "0 */6 * * *",
      extract: false,
    });
    expect(ok({ directory: "0f0e0d0c-0b0a-4908-8706-050403020100" })).toBe(true);
    expect(ok({ authority: undefined, graph: undefined, downloadHosts: undefined })).toBe(true);
    expect(
      ok({
        certificate: { certificateFile: join(base, "a.pem"), privateKeyFile: join(base, "a.key") },
      }),
    ).toBe(true);
    // No secret, in any spelling, and nothing of a folder's.
    expect(ok({ clientSecret: SECRET })).toBe(false);
    expect(ok({ secret: SECRET })).toBe(false);
    expect(ok({ root: base })).toBe(false);
    expect(ok({ watch: true })).toBe(false);
    expect(ok({ clientId: "my-app" })).toBe(false);
    expect(ok({ directory: "common" })).toBe(false);
    expect(ok({ directory: "a b" })).toBe(false);
    expect(ok({ directory: "-".repeat(36) })).toBe(false);
    expect(ok({ authority: "https://login.test:99999" })).toBe(false);
    expect(ok({ authority: "https://.." })).toBe(false);
    expect(ok({ authority: "https://login.test/?x=1" })).toBe(false);
    expect(ok({ authority: "https://login.microsoftonline.us/" })).toBe(true);
    expect(ok({ graph: "https://microsoftgraph.chinacloudapi.cn:443" })).toBe(true);
    expect(ok({ downloadHosts: ["*.sharepoint.com"] })).toBe(false);
    expect(ok({ downloadHosts: ["com"] })).toBe(false);
    expect(ok({ downloadHosts: [".sharepoint.us", "files.example.com"] })).toBe(true);
    expect(
      ok({
        certificate: { certificateFile: join(base, "a.pem"), privateKeyFile: join(base, "a.pem") },
      }),
    ).toBe(false);
    expect(ok({ authority: "http://login.test" })).toBe(false);
    expect(ok({ graph: "https://graph.test/v1.0" })).toBe(false);
    expect(ok({ graph: "https://user:pw@graph.test" })).toBe(false);
    expect(
      ok({ certificate: { certificateFile: "a.pem", privateKeyFile: join(base, "a.key") } }),
    ).toBe(false);
    expect(ok({ certificate: { certificateFile: join(base, "a.pem") } })).toBe(false);
    expect(ok({ site: "" })).toBe(false);
    // A folder is still a folder.
    expect(
      SourceSchema.safeParse({
        id: "fs-docs",
        connector: "fs",
        tenantId: t.tenantId,
        root: base,
        zone: "Docs",
        owner: "steve@example.com",
      }).success,
    ).toBe(true);
    expect(SourceSchema.safeParse({ ...source(), connector: "dropbox" }).success).toBe(false);

    // Two sources whose secrets would be one variable are told to differ.
    expect(sourceSecretEnv("sp-finance")).toBe("OPENHOARD_SOURCE_SP_FINANCE_CLIENT_SECRET");
    const twins = ConfigSchema.safeParse({
      dataDir,
      sources: [source({ id: "sp.finance" }), source({ id: "sp-finance", zone: "Other" })],
    });
    expect(twins.success).toBe(false);
    expect(JSON.stringify(twins.error?.issues)).toContain(
      "OPENHOARD_SOURCE_SP_FINANCE_CLIENT_SECRET",
    );
    // The variable is one per id, whatever the tenant: the same id in two tenants is refused.
    const other = `ten_${"0".repeat(26)}`;
    expect(
      ConfigSchema.safeParse({ dataDir, sources: [source(), source({ tenantId: other })] }).success,
    ).toBe(false);
  });

  it("is left out, loudly, while its secret isn't set, and the others start", async () => {
    mkdirSync(join(base, "Docs"));
    const fs = {
      id: "fs-docs",
      connector: "fs",
      tenantId: t.tenantId,
      root: join(base, "Docs"),
      zone: "Docs",
      owner: "steve@example.com",
    };
    for (const env of [{}, { OPENHOARD_SOURCE_SP_FINANCE_CLIENT_SECRET: "" }]) {
      const { prepared, logged } = await prepare([source(), fs], env);
      expect(prepared.scheduled.map((s) => s.source)).toEqual(["fs-docs"]);
      const said = logged.find((l) => l.source === "sp-finance");
      expect(said).toMatchObject({
        level: 50,
        variable: "OPENHOARD_SOURCE_SP_FINANCE_CLIENT_SECRET",
      });
      expect(said?.msg).toContain("isn't synced until");
    }
    // Nothing was bound for it: given its secret later, it starts clean.
    const syncs = await db.withTenant(t.tenantId, (tx) => listSourceSyncs(tx, t.tenantId));
    expect(syncs.map((s) => s.source)).toEqual(["fs-docs"]);
    // A mistake that needs no secret to see is still said at once.
    await expect(prepare([source({ site: "not/a/site" })])).rejects.toThrow(
      /sources sp-finance: not a site/,
    );
  });

  it("is synced with its secret from the environment, into the owner's files", async () => {
    const { prepared, logged, text } = await prepare([source({ extract: true })], {
      OPENHOARD_SOURCE_SP_FINANCE_CLIENT_SECRET: SECRET,
    });
    // The secret is the connector's alone: not in what the server logs, which says only how
    // the source signs in.
    expect(text).not.toContain(SECRET);
    expect(logged.find((l) => l.msg === "source ready")).toMatchObject({
      source: "sp-finance",
      credential: "secret",
    });
    expect(prepared.scheduled).toHaveLength(1);
    const scheduled = prepared.scheduled[0] as (typeof prepared.scheduled)[0];
    expect(scheduled.connector.describe().id).toBe("connector-sharepoint");
    expect(prepared.content).not.toBeNull();
    const syncs = await db.withTenant(t.tenantId, (tx) => listSourceSyncs(tx, t.tenantId));
    expect(syncs).toMatchObject([{ source: "sp-finance", connector: "connector-sharepoint" }]);

    const report = await runSync(db, {
      tenantId: t.tenantId,
      source: scheduled.source,
      zoneId: scheduled.zoneId,
      connector: scheduled.connector,
      ownerId: (await scheduled.owner()) as string,
      tenantKey: keys(),
      enqueue: async () => {},
      sleep: async () => {},
    });
    expect(report).toMatchObject({ status: "done", skipped: [] });
    const files = tenant.items.filter((i) => i.siteId === site().id && i.kind === "file").length;
    const [row] = await db.withTenant(t.tenantId, (tx) =>
      tx
        .select({ n: count() })
        .from(sourceRefs)
        .innerJoin(
          objects,
          and(eq(objects.tenantId, sourceRefs.tenantId), eq(objects.id, sourceRefs.objectId)),
        )
        .where(and(eq(sourceRefs.source, "sp-finance"), isNull(objects.deletedAt))),
    );
    expect(Number(row?.n)).toBe(files);
    expect(entra.requests.length).toBeGreaterThan(0);
    expect(entra.requests.every((r) => r.auth === "secret" && r.status === 200)).toBe(true);
  });

  it("signs in with a certificate from the files named, and says which file it can't read", async () => {
    const cert = selfSignedCertificate();
    const certificateFile = join(base, "app.pem");
    const privateKeyFile = join(base, "app.key");
    writeFileSync(certificateFile, cert.certificate);
    writeFileSync(privateKeyFile, cert.privateKey);
    entra.registerApp({
      clientId: CLIENT_ID,
      certificate: cert.certificate,
      appRoles: ["Sites.Selected"],
    });
    // The certificate is what signs in, even with a secret set: said, since one is unused.
    const { prepared, logged, text } = await prepare(
      [source({ certificate: { certificateFile, privateKeyFile } })],
      { OPENHOARD_SOURCE_SP_FINANCE_CLIENT_SECRET: SECRET },
    );
    expect(logged.find((l) => l.level === 40)?.msg).toContain("is set and not used");
    expect(logged.find((l) => l.msg === "source ready")).toMatchObject({
      credential: "certificate",
    });
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(cert.privateKey.split("\n")[1]);
    const scheduled = prepared.scheduled[0] as (typeof prepared.scheduled)[0];
    expect(await scheduled.connector.identity?.(new AbortController().signal)).toBe(
      `sharepoint:${site().id}`,
    );
    expect(entra.requests.map((r) => [r.auth, r.status])).toEqual([["certificate", 200]]);

    // A file that isn't there, a key that isn't the certificate's, a site that isn't one: each
    // stops the start, naming the source, and never quoting a key.
    const failing = async (more: Record<string, unknown>) =>
      prepare([source({ id: "sp-other", zone: "Other", ...more })]).then(
        () => "started",
        (e: Error) => e.message,
      );
    const missing = await failing({
      certificate: { certificateFile, privateKeyFile: join(base, "none.key") },
    });
    expect(missing).toMatch(/sources sp-other: its private key file can't be read \(ENOENT\)/);
    expect(await failing({ certificate: { certificateFile, privateKeyFile: base } })).toMatch(
      // (Windows refuses to open a directory at all.)
      /its private key file can't be read \((not a file|EPERM|EACCES)\)/,
    );
    writeFileSync(join(base, "huge.key"), "x".repeat(300_000));
    expect(
      await failing({ certificate: { certificateFile, privateKeyFile: join(base, "huge.key") } }),
    ).toMatch(/its private key file can't be read \(too large to be one\)/);
    const other = selfSignedCertificate();
    writeFileSync(join(base, "other.key"), other.privateKey);
    const mismatched = await failing({
      certificate: { certificateFile, privateKeyFile: join(base, "other.key") },
    });
    expect(mismatched).toMatch(/sources sp-other: the private key isn't the certificate's/);
    expect(mismatched).not.toContain(other.privateKey.split("\n")[1]);
    expect(
      await failing({ site: "not/a/site", certificate: { certificateFile, privateKeyFile } }),
    ).toMatch(/sources sp-other: not a site/);
  });
});
