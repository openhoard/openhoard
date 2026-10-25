import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTenant, openDatabase } from "@openhoard/core-db";
import { TEST_POSTGRES_ENV } from "@openhoard/core-db/testing";
import { listScimTokens } from "@openhoard/core-identity";
import { selfSignedCertificate } from "@openhoard/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { runInit, type SoloIo } from "./solo.js";

/*
 * T-1101: `init --team` makes a team's tenant, its SCIM token and config.json in one run, after
 * checking what it can on this machine; a run that fails leaves nothing. On the embedded
 * database (the test PostgreSQL holds other tests' tenants, which init refuses).
 */

const DIRECTORY = "8d2f0a6e-3b1c-4c55-9a7e-2f4b6c8d0e1f";
const APP = "11111111-2222-4333-8444-555555555555";

let root: string;
let dir: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "oh-team-")));
  dir = join(root, "data");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function init(...argv: string[]) {
  const seen = { out: "", err: "" };
  const io: SoloIo = {
    env: {},
    cwd: root,
    platform: "linux",
    home: root,
    out: (s) => void (seen.out += s),
    err: (s) => void (seen.err += s),
  };
  const code = await runInit(["--team", "--data-dir", dir, ...argv], io);
  return { code, ...seen };
}

const site = ["--site", "contoso.sharepoint.com:/sites/finance", "--owner", "it@contoso.com"];

describe.skipIf(process.env[TEST_POSTGRES_ENV] !== undefined)("init --team", () => {
  it("sets up the tenant, its SCIM token, sign-in and the site, and the server loads it", async () => {
    const cert = selfSignedCertificate();
    writeFileSync(join(root, "app.pem"), cert.certificate);
    writeFileSync(join(root, "app.key"), cert.privateKey);
    const run = await init(
      "--name",
      "Contoso",
      "--public-url",
      "https://files.contoso.com/",
      "--directory",
      DIRECTORY,
      "--client-id",
      APP,
      ...site,
      "--certificate",
      "app.pem",
      "--private-key",
      "app.key",
    );
    expect(run.err).not.toContain(cert.privateKey.split("\n")[1]);
    expect(run.code).toBe(0);
    const [tenantId, token] = run.out.trim().split("\n") as [string, string];
    expect(token).toMatch(/^ohscim\./);
    expect(run.err).toContain("https://files.contoso.com/scim/v2");
    expect(run.err).toContain("https://files.contoso.com/auth/callback/entra");

    const config = loadConfig({ OPENHOARD_DATA_DIR: dir }, root);
    expect(config.auth?.providers[0]).toMatchObject({
      kind: "entra",
      tenantId,
      issuer: `https://login.microsoftonline.com/${DIRECTORY}/v2.0`,
      clientId: APP,
    });
    expect(config.sources[0]).toMatchObject({
      id: "sp-finance",
      connector: "sharepoint",
      tenantId,
      clientId: APP,
      certificate: {
        certificateFile: join(root, "app.pem"),
        privateKeyFile: join(root, "app.key"),
      },
    });
    const db = await openDatabase({ url: "pglite", dataDir: dir });
    try {
      const made = await db.withTenant(tenantId, async (tx) => ({
        tenant: await getTenant(tx, tenantId),
        tokens: await listScimTokens(tx, tenantId),
      }));
      expect(made.tenant?.name).toBe("Contoso");
      expect(made.tokens).toHaveLength(1);
    } finally {
      await db.close();
    }

    // Set up once: a second run changes nothing.
    expect((await init("--name", "Other", "--public-url", "https://x.contoso.com")).code).toBe(1);
  });

  it("checks the certificate before anything is made", async () => {
    writeFileSync(join(root, "app.pem"), selfSignedCertificate().certificate);
    writeFileSync(join(root, "app.key"), selfSignedCertificate().privateKey);
    const run = await init(
      "--name",
      "Contoso",
      "--public-url",
      "https://files.contoso.com",
      "--directory",
      DIRECTORY,
      "--client-id",
      APP,
      ...site,
      "--certificate",
      "app.pem",
      "--private-key",
      "app.key",
    );
    expect(run.code).toBe(1);
    expect(run.err).toMatch(/the private key isn't the certificate's/);
    expect(existsSync(dir)).toBe(false);
    expect(run.out).toBe("");
  });
});
