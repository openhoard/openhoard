import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { appendAudit } from "@openhoard/core-audit";
import { createTenant, newId } from "@openhoard/core-db";
import { issueScimToken, SCIM_TOKEN_MAX_DAYS } from "@openhoard/core-identity";
import { ADMIN_ACTOR, openAdminDatabase } from "./admin.js";
import { ConfigSchema, ensureDataDir, sourceSecretEnv } from "./config.js";
import { sharepointSource } from "./sources.js";
import {
  commandLine,
  createFileExclusive,
  findStarterPack,
  soloConfig,
  soloDataDir,
  type SoloIo,
} from "./solo.js";

/*
 * `init --team` (T-1101): a team's server, from nothing to a configured tenant that Entra can
 * provision into, people can sign in to, and one SharePoint site syncs into.
 *
 *   init --team --name <organization> --public-url https://<host>
 *        [--directory <Entra tenant id> --client-id <sign-in app id>]
 *        [--site <host>:/sites/<name> --owner <email> [--graph-client-id <app id>]
 *         [--certificate <pem> --private-key <pem>]]
 *        [--data-dir <dir>]
 *
 * It checks what can be checked on this machine before anything is made: the config it would
 * write (the server's own schema), the certificate and its key (as the server reads them), and
 * the database (opened as the server opens it, which checks PostgreSQL, pgvector and the role,
 * and migrates). The database is the embedded one unless OPENHOARD_DATABASE_URL names a
 * PostgreSQL, so its password never lands in config.json. It must hold no tenant yet.
 *
 * Then config.json is created (never over one), and the tenant and a SCIM token are made in
 * one transaction; if that fails, config.json is removed again, so a run either sets everything
 * up or nothing. The token is printed once, on standard output after the tenant id. What is
 * left is in Entra and in the environment, and is printed as next steps (docs/pilot.md walks
 * through them). No admin, pack or model is set up: the first admin is a person Entra
 * provisions, and the starter pack is an admin's decision (`admin pack plan`).
 */

const USAGE = `usage: openhoard init --team [options]

  A team's server: creates the tenant and a SCIM token for Entra, and writes config.json
  with sign-in through Entra and one SharePoint site. Checks the database and the
  certificate first. The database is OPENHOARD_DATABASE_URL's PostgreSQL, else the embedded one.

  --name <organization>     the tenant's name (required)
  --public-url <https://…>  where people and Entra reach this server (required)
  --directory <tenant id>   the Entra directory (tenant) id, a GUID
  --client-id <app id>      the app registration people sign in through (with --directory)
  --site <host>:/sites/<x>  a SharePoint site to index in place (with --directory)
  --owner <email>           who owns the site's files here (with --site)
  --graph-client-id <id>    the app that reads the site (default: --client-id)
  --certificate <file>      that app's certificate (PEM); with --private-key. Without them its
  --private-key <file>      secret is read from the environment
  --data-dir <dir>          where OpenHoard keeps its data (default: the OS's app-data folder;
                            OPENHOARD_DATA_DIR also sets it)
`;

/** The sign-in provider's id: its redirect URI is <publicUrl>/auth/callback/entra. */
const PROVIDER = "entra";

/** Runs `init --team`; returns the exit code (0 done, 1 failed, 2 misused). */
export async function runTeamInit(argv: readonly string[], io: SoloIo): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      options: {
        team: { type: "boolean" },
        name: { type: "string" },
        "public-url": { type: "string" },
        directory: { type: "string" },
        "client-id": { type: "string" },
        site: { type: "string" },
        owner: { type: "string" },
        "graph-client-id": { type: "string" },
        certificate: { type: "string" },
        "private-key": { type: "string" },
        "data-dir": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help === true) {
    io.err(USAGE);
    return 0;
  }
  const misused = (message: string) => {
    io.err(`${message}\n\n${USAGE}`);
    return 2;
  };
  const name = values.name?.trim() ?? "";
  if (name === "") return misused("--name is required");
  if (values["public-url"] === undefined) return misused("--public-url is required");
  const publicUrl = values["public-url"].replace(/\/+$/, "");
  if (!publicUrl.startsWith("https://")) {
    return misused("--public-url is https: Entra reaches this server there");
  }
  if ((values["client-id"] !== undefined || values.site !== undefined) && !values.directory) {
    return misused("--client-id and --site need --directory");
  }
  if (values.site !== undefined && values.owner === undefined) {
    return misused("--site needs --owner");
  }
  if ((values.certificate === undefined) !== (values["private-key"] === undefined)) {
    return misused("--certificate and --private-key go together");
  }
  const graphClientId = values["graph-client-id"] ?? values["client-id"];
  if (values.site !== undefined && graphClientId === undefined) {
    return misused("--site needs --graph-client-id (or --client-id)");
  }

  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();
  const dataDir = soloDataDir(values["data-dir"], io);
  const configFile = join(dataDir, "config.json");
  if (existsSync(configFile)) {
    io.err(`${configFile} exists already: this data directory is set up\n`);
    return 1;
  }

  const tenantId = newId("tenant");
  const file = teamConfigFile({
    tenantId,
    publicUrl,
    directory: values.directory,
    clientId: values["client-id"],
    site: values.site,
    owner: values.owner,
    graphClientId,
    certificate: values.certificate,
    privateKey: values["private-key"],
    cwd,
  });

  // What the server would load: the schema, then the site's credential as the server reads it.
  let config;
  try {
    config = soloConfig(dataDir, io);
  } catch (e) {
    io.err(`${(e as Error).message}\n`);
    return 1;
  }
  const checked = ConfigSchema.safeParse({
    ...file,
    dataDir,
    host: config.host,
    port: config.port,
    database: config.database,
  });
  if (!checked.success) {
    const issues = checked.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    io.err(`this setup wouldn't be a valid config:\n  ${issues.join("\n  ")}\n`);
    return 1;
  }
  for (const s of checked.data.sources) {
    if (s.connector !== "sharepoint") continue;
    try {
      sharepointSource(s, env);
    } catch (e) {
      io.err(`the site ${s.site}: ${(e as Error).message}\n`);
      return 1;
    }
  }

  try {
    ensureDataDir(dataDir);
  } catch (e) {
    io.err(`cannot make the data directory ${dataDir}: ${(e as Error).message}\n`);
    return 1;
  }
  const db = await openAdminDatabase(config, io);
  if (db === null) return 1;
  try {
    if ((await db.tenantIds({ limit: 1 })).length > 0) {
      io.err(
        `the database holds a tenant already: init --team sets up an empty one. To add one ` +
          `to it, use admin tenant create and edit config.json by hand.\n`,
      );
      return 1;
    }
    try {
      createFileExclusive(configFile, JSON.stringify(file, null, 2) + "\n");
    } catch (e) {
      io.err(`cannot write ${configFile}: ${(e as Error).message}\n`);
      return 1;
    }
    let token;
    try {
      token = await db.withTenant(tenantId, async (tx) => {
        const made = await createTenant(tx, tenantId, { name });
        await appendAudit(tx, tenantId, {
          actor: ADMIN_ACTOR,
          action: "tenant.create",
          decision: "allow",
          detail: { name: made.name },
        });
        const issued = await issueScimToken(tx, tenantId, {
          name: "Entra provisioning",
          days: SCIM_TOKEN_MAX_DAYS,
          by: ADMIN_ACTOR,
        });
        await appendAudit(tx, tenantId, {
          actor: ADMIN_ACTOR,
          action: "scim-token.issue",
          decision: "allow",
          detail: {
            token: issued.id,
            name: issued.name,
            expiresAt: issued.expiresAt.toISOString(),
          },
        });
        return issued;
      });
    } catch (e) {
      rmSync(configFile, { force: true });
      io.err(`cannot set the tenant up (nothing was kept): ${(e as Error).message}\n`);
      return 1;
    }
    io.out(`${tenantId}\n${token.token}\n`);
    io.err(
      nextSteps(io, {
        dataDir,
        tenantId,
        name,
        publicUrl,
        postgres: config.database.url !== "pglite",
        expires: token.expiresAt,
        file,
      }),
    );
    return 0;
  } finally {
    await db.close();
  }
}

/** config.json for a team (what is written: the server fills in the defaults). */
export function teamConfigFile(o: {
  tenantId: string;
  publicUrl: string;
  directory?: string | undefined;
  clientId?: string | undefined;
  site?: string | undefined;
  owner?: string | undefined;
  graphClientId?: string | undefined;
  certificate?: string | undefined;
  privateKey?: string | undefined;
  cwd: string;
}) {
  const providers =
    o.directory !== undefined && o.clientId !== undefined
      ? [
          {
            id: PROVIDER,
            label: "Microsoft",
            kind: "entra" as const,
            tenantId: o.tenantId,
            issuer: `https://login.microsoftonline.com/${o.directory}/v2.0`,
            clientId: o.clientId,
          },
        ]
      : [];
  const sources =
    o.site !== undefined && o.directory !== undefined
      ? [
          {
            id: siteSourceId(o.site),
            connector: "sharepoint" as const,
            tenantId: o.tenantId,
            site: o.site,
            zone: "SharePoint",
            owner: o.owner ?? "",
            extract: true,
            directory: o.directory,
            clientId: o.graphClientId ?? "",
            ...(o.certificate !== undefined && o.privateKey !== undefined
              ? {
                  certificate: {
                    certificateFile: resolve(o.cwd, o.certificate),
                    privateKeyFile: resolve(o.cwd, o.privateKey),
                  },
                }
              : {}),
          },
        ]
      : [];
  return { auth: { publicUrl: o.publicUrl, providers }, sources };
}

/** `sp-` and the site's last path segment as a slug: `sp-finance` for …:/sites/finance. */
export function siteSourceId(site: string): string {
  const last =
    site
      .split(/[:/]/)
      .filter((p) => p !== "")
      .pop() ?? "site";
  const slug = last
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 60);
  return `sp-${slug || "site"}`;
}

function nextSteps(
  io: SoloIo,
  s: {
    dataDir: string;
    tenantId: string;
    name: string;
    publicUrl: string;
    postgres: boolean;
    expires: Date;
    file: ReturnType<typeof teamConfigFile>;
  },
): string {
  const run = (rest: string) => `  ${commandLine(io, s.dataDir, rest)}`;
  const provider = s.file.auth.providers[0];
  const site = s.file.sources[0];
  const lines = [
    ``,
    `OpenHoard is set up for ${s.name}.`,
    `  tenant:   ${s.tenantId}`,
    `  data:     ${s.dataDir} (config.json and keys: back it up whole)`,
    `  database: ${s.postgres ? "PostgreSQL (OPENHOARD_DATABASE_URL)" : "embedded, in the data directory (admin commands run with the server stopped)"}`,
    `  SCIM:     the token on standard output, shown once; it expires ${s.expires.toISOString().slice(0, 10)}`,
    ``,
    `Next (docs/pilot.md has each step):`,
    `1. Entra, the enterprise app's Provisioning: Tenant URL ${s.publicUrl}/scim/v2, Secret Token`,
    `   the SCIM token; map externalId to objectId; assign the pilot's people and the owner.`,
  ];
  if (provider !== undefined) {
    lines.push(
      `2. Entra, app ${provider.clientId}: Web redirect URI ${s.publicUrl}/auth/callback/${PROVIDER},`,
      `   and a client secret, given to the server as OPENHOARD_AUTH_ENTRA_CLIENT_SECRET.`,
    );
  } else {
    lines.push(`2. Sign-in: add an Entra provider to auth.providers (--directory, --client-id).`);
  }
  if (site !== undefined) {
    lines.push(
      `3. Entra, app ${site.clientId}: Sites.Selected (Graph and SharePoint), admin consent, and`,
      `   the site granted to it. ${"certificate" in site ? "It signs in with the certificate." : `Its secret goes in ${sourceSecretEnv(site.id)}.`}`,
    );
  }
  lines.push(
    `Then start the server where ${s.publicUrl} reaches it:`,
    run("serve"),
    `Once Entra has provisioned the first admin:`,
    run(`admin user grant-admin --tenant ${s.tenantId} --user <their UPN>`),
    run(
      `admin pack plan --tenant ${s.tenantId} --file "${findStarterPack() ?? "<clone>/packs/general-business/pack.json"}"`,
    ),
    ``,
  );
  return lines.join("\n");
}
