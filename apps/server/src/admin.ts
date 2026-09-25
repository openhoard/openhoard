import { parseArgs } from "node:util";
import { appendAudit } from "@openhoard/core-audit";
import {
  createTenant,
  getTenant,
  isId,
  newId,
  openDatabase,
  type Database,
} from "@openhoard/core-db";
import {
  issueScimToken,
  listScimTokens,
  revokeScimToken,
  SCIM_TOKEN_MAX_DAYS,
} from "@openhoard/core-identity";
import { ensureDataDir, loadConfig, type Config } from "./config.js";

/*
 * `openhoard admin …` (T-103): what an operator needs before there is an admin UI, to create a
 * tenant and connect its identity provider over SCIM.
 *
 *   admin tenant create --name "Acme"
 *   admin tenant list
 *   admin scim-token issue  --tenant ten_… --name "Entra" [--days 365]
 *   admin scim-token list   --tenant ten_…
 *   admin scim-token revoke --tenant ten_… --id sct_…
 *
 * It reads the server's configuration (and `--data-dir`, as the server does) and opens the same
 * database. The embedded database (PGlite) belongs to one process at a time, so while the
 * server runs on it these commands refuse, and say so; with PostgreSQL they run beside it.
 * Creating a tenant and issuing or revoking a token are audited as `system:admin-cli`. A token
 * is printed once, and only its hash is kept.
 */

export const ADMIN_ACTOR = "system:admin-cli";

/**
 * Where `admin` is in the server's arguments, when it is the first one that isn't an option
 * (`--data-dir x admin …` too); undefined when they start the server.
 */
export function adminArgument(args: readonly string[]): number | undefined {
  const { tokens } = parseArgs({
    args: [...args],
    options: { "data-dir": { type: "string" } },
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  const first = tokens.find((t) => t.kind === "positional");
  return first?.kind === "positional" && first.value === "admin" ? first.index : undefined;
}

export interface AdminIo {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Standard output: what a script would read (the token, ids). */
  out: (text: string) => void;
  /** Standard error: messages for the person. */
  err: (text: string) => void;
  /** Opens the database (tests); the default opens the configured one. */
  open?: (config: Config) => Promise<Database>;
}

const USAGE = `usage: openhoard admin <command> [--data-dir <dir>]

  tenant create --name <name>                      create a tenant
  tenant list                                      list tenants
  scim-token issue --tenant <ten_…> --name <name> [--days <1-${SCIM_TOKEN_MAX_DAYS}>]
                                                   issue a SCIM token (printed once)
  scim-token list --tenant <ten_…>                 list a tenant's SCIM tokens
  scim-token revoke --tenant <ten_…> --id <sct_…>  revoke a SCIM token
`;

class UsageError extends Error {}

/** Runs an admin command; returns the process exit code (0 done, 1 failed, 2 misused). */
export async function runAdmin(argv: readonly string[], io: AdminIo): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        "data-dir": { type: "string" },
        name: { type: "string" },
        tenant: { type: "string" },
        id: { type: "string" },
        days: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = args;
  const command = positionals.join(" ");
  if (values.help === true || positionals.length === 0) {
    io.err(USAGE);
    return values.help === true ? 0 : 2;
  }
  const known = [
    "tenant create",
    "tenant list",
    "scim-token issue",
    "scim-token list",
    "scim-token revoke",
  ];
  if (!known.includes(command)) {
    io.err(`unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }

  let config: Config;
  try {
    const env = io.env ?? process.env;
    const dataDir = values["data-dir"];
    config = loadConfig(dataDir ? { ...env, OPENHOARD_DATA_DIR: dataDir } : env, io.cwd);
  } catch (e) {
    io.err(`${(e as Error).message}\n`);
    return 1;
  }

  let db: Database;
  try {
    if (io.open) db = await io.open(config);
    else {
      ensureDataDir(config.dataDir);
      db = await openDatabase({ url: config.database.url, dataDir: config.dataDir });
    }
  } catch (e) {
    const message = (e as Error).message;
    if (/already open|locked by another process/.test(message)) {
      io.err(
        `The embedded database in ${config.dataDir} is in use, most likely by the running ` +
          `OpenHoard server: only one process may open it at a time. Stop the server, run this ` +
          `command, then start the server again. (With PostgreSQL, admin commands run beside ` +
          `the server.)\n`,
      );
    } else {
      // Never the URL: it may hold a password.
      io.err(`cannot open the database: ${message}\n`);
    }
    return 1;
  }

  try {
    switch (command) {
      case "tenant create":
        return await tenantCreate(db, need(values.name, "--name"), io);
      case "tenant list":
        return await tenantList(db, io);
      case "scim-token issue":
        return await tokenIssue(db, config, values, io);
      case "scim-token list":
        return await tokenList(db, tenantArg(values.tenant), io);
      default:
        return await tokenRevoke(db, tenantArg(values.tenant), need(values.id, "--id"), io);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    io.err(`${(e as Error).message}\n`);
    return 1;
  } finally {
    await db.close();
  }
}

function need(value: string | undefined, flag: string): string {
  if (value === undefined || value === "") throw new UsageError(`${flag} is required`);
  return value;
}

function tenantArg(value: string | undefined): string {
  const id = need(value, "--tenant");
  if (!isId("tenant", id)) throw new UsageError(`not a tenant id: ${id}`);
  return id;
}

async function tenantCreate(db: Database, name: string, io: AdminIo): Promise<number> {
  const id = newId("tenant");
  const tenant = await db.withTenant(id, async (tx) => {
    const made = await createTenant(tx, id, { name });
    await appendAudit(tx, id, {
      actor: ADMIN_ACTOR,
      action: "tenant.create",
      decision: "allow",
      detail: { name: made.name },
    });
    return made;
  });
  io.out(`${tenant.id}\n`);
  io.err(
    `Created tenant ${tenant.id} (${tenant.name}).\n` +
      `Next: openhoard admin scim-token issue --tenant ${tenant.id} --name "Entra provisioning"\n`,
  );
  return 0;
}

async function tenantList(db: Database, io: AdminIo): Promise<number> {
  let after: string | undefined;
  for (;;) {
    const ids = await db.tenantIds(after === undefined ? {} : { after });
    for (const id of ids) {
      const tenant = await db.withTenant(id, (tx) => getTenant(tx, id));
      if (tenant) io.out(`${tenant.id}\t${tenant.createdAt.toISOString()}\t${tenant.name}\n`);
    }
    if (ids.length < 1000) return 0;
    after = ids[ids.length - 1];
  }
}

async function tokenIssue(
  db: Database,
  config: Config,
  values: { tenant?: string; name?: string; days?: string },
  io: AdminIo,
): Promise<number> {
  const tenantId = tenantArg(values.tenant);
  const name = need(values.name, "--name");
  const daysText = values.days ?? String(SCIM_TOKEN_MAX_DAYS);
  const days = /^\d{1,4}$/.test(daysText) ? Number(daysText) : Number.NaN;
  if (!(days >= 1 && days <= SCIM_TOKEN_MAX_DAYS)) {
    throw new UsageError(`--days is a whole number from 1 to ${SCIM_TOKEN_MAX_DAYS}`);
  }
  const issued = await db.withTenant(tenantId, async (tx) => {
    if (!(await getTenant(tx, tenantId))) return null;
    const token = await issueScimToken(tx, tenantId, {
      name,
      days,
      by: ADMIN_ACTOR,
    });
    await appendAudit(tx, tenantId, {
      actor: ADMIN_ACTOR,
      action: "scim-token.issue",
      decision: "allow",
      detail: { token: token.id, name: token.name, expiresAt: token.expiresAt.toISOString() },
    });
    return token;
  });
  if (!issued) {
    io.err(`no tenant ${tenantId}\n`);
    return 1;
  }
  const tenantUrl = config.auth
    ? new URL("/scim/v2", config.auth.publicUrl).href
    : "<publicUrl>/scim/v2 (the address Entra reaches this server at, over https)";
  io.out(`${issued.token}\n`);
  io.err(
    `SCIM token ${issued.id} (${issued.name}) for tenant ${tenantId}, expires ` +
      `${issued.expiresAt.toISOString()}.\n` +
      `The token (on standard output) is shown once: paste it into the identity provider as ` +
      `the Secret Token now.\n` +
      `Tenant URL: ${tenantUrl}\n`,
  );
  return 0;
}

async function tokenList(db: Database, tenantId: string, io: AdminIo): Promise<number> {
  const tokens = await db.withTenant(tenantId, async (tx) =>
    (await getTenant(tx, tenantId)) ? listScimTokens(tx, tenantId) : null,
  );
  if (!tokens) {
    io.err(`no tenant ${tenantId}\n`);
    return 1;
  }
  const now = Date.now();
  for (const t of tokens) {
    const state =
      t.revokedAt !== null
        ? `revoked ${t.revokedAt.toISOString()} by ${t.revokedBy ?? "?"}`
        : t.expiresAt.getTime() <= now
          ? "expired"
          : "active";
    io.out(
      [
        t.id,
        state,
        `expires ${t.expiresAt.toISOString()}`,
        `last used ${t.lastUsedAt?.toISOString() ?? "never"}`,
        t.name,
      ].join("\t") + "\n",
    );
  }
  if (tokens.length === 0) io.err(`tenant ${tenantId} has no SCIM tokens\n`);
  return 0;
}

async function tokenRevoke(
  db: Database,
  tenantId: string,
  tokenId: string,
  io: AdminIo,
): Promise<number> {
  const result = await db.withTenant(tenantId, async (tx) => {
    if (!(await getTenant(tx, tenantId))) return "no-tenant" as const;
    const revoked = await revokeScimToken(tx, tenantId, tokenId, ADMIN_ACTOR);
    await appendAudit(tx, tenantId, {
      actor: ADMIN_ACTOR,
      action: "scim-token.revoke",
      decision: revoked ? "allow" : "deny",
      detail: {
        token: isId("scimToken", tokenId) ? tokenId : "not-a-token-id",
        ...(revoked ? {} : { reason: "unknown-or-revoked" }),
      },
    });
    return revoked ? ("revoked" as const) : ("none" as const);
  });
  if (result === "no-tenant") {
    io.err(`no tenant ${tenantId}\n`);
    return 1;
  }
  if (result === "none") {
    io.err(`tenant ${tenantId} has no live SCIM token ${tokenId}\n`);
    return 1;
  }
  io.err(`Revoked ${tokenId}: it fails from the next request.\n`);
  return 0;
}
