import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { appendAudit } from "@openhoard/core-audit";
import {
  APPLY_TRANSACTION,
  applyPack,
  PackError,
  planPack,
  type PackChange,
  type PackPlan,
} from "@openhoard/core-catalog";
import {
  createTenant,
  getTenant,
  isId,
  newId,
  openDatabase,
  type Database,
  type Tx,
} from "@openhoard/core-db";
import {
  createUser,
  findUserByEmail,
  findUserByUserName,
  getGroup,
  getUser,
  grantAdmin,
  IdentityError,
  INVITE_MAX_HOURS,
  issueInvite,
  issueScimToken,
  issueSignInLink,
  listAdmins,
  listGroups,
  listPasskeys,
  MAX_LIST,
  memberCount,
  listScimTokens,
  lockUser,
  removePasskey,
  revokeAdmin,
  revokeScimToken,
  SCIM_TOKEN_MAX_DAYS,
  SIGN_IN_LINK_MAX_MINUTES,
  unlockUser,
  type EndedAccess,
  type User,
} from "@openhoard/core-identity";
import {
  acceptSourceIdentity,
  confirmReconcile,
  discardReconcile,
  listSourceSyncs,
  resumeSource,
  startJobs,
  type SourceSyncState,
} from "@openhoard/core-jobs";
import { adminGroupOf, ensureDataDir, loadConfig, type Config } from "./config.js";
import { retrying } from "./retry.js";

/*
 * `openhoard admin …` (T-103, T-106): what an operator needs before there is an admin UI, to
 * create a tenant, connect its identity provider over SCIM, and make its first admin.
 *
 *   admin tenant create --name "Acme"
 *   admin tenant list
 *   admin scim-token issue  --tenant ten_… --name "Entra" [--days 365]
 *   admin scim-token list   --tenant ten_…
 *   admin scim-token revoke --tenant ten_… --id sct_…
 *   admin user grant-admin  --tenant ten_… --user <usr_… | email | userName>
 *   admin user revoke-admin --tenant ten_… --user <usr_… | email | userName>
 *   admin user list-admins  --tenant ten_…
 *   admin user lock         --tenant ten_… --user <usr_… | email | userName>
 *   admin user unlock       --tenant ten_… --user <usr_… | email | userName>
 *   admin user create       --tenant ten_… --email <email> --name <display name>
 *   admin user sign-in-link --tenant ten_… --user <usr_… | email | userName> [--minutes 15]
 *   admin user invite          --tenant ten_… --user <usr_… | email> [--hours 168]
 *   admin user list-passkeys   --tenant ten_… --user <usr_… | email>
 *   admin user remove-passkey  --tenant ten_… --user <usr_… | email> --id pky_…
 *   admin group list        --tenant ten_…
 *   admin pack plan               --tenant ten_… --file <pack.json>
 *   admin pack apply              --tenant ten_… --file <pack.json> --plan-hash <hash>
 *   admin source list             --tenant ten_…
 *   admin source status           --tenant ten_… [--source <name>]
 *   admin source run-now          --tenant ten_… --source <name>
 *   admin source resume           --tenant ten_… --source <name>
 *   admin source confirm-reconcile --tenant ten_… --source <name>
 *   admin source discard-reconcile --tenant ten_… --source <name>
 *   admin source accept-identity   --tenant ten_… --source <name>
 *
 * It reads the server's configuration (and `--data-dir`, as the server does) and opens the same
 * database. The embedded database (PGlite) belongs to one process at a time, so while the
 * server runs on it these commands refuse, and say so; with PostgreSQL they run beside it.
 * Every change (a tenant, a token issued or revoked, an admin granted or removed) is audited as
 * `system:admin-cli`, refusals too for admins. A token is printed once, and only its hash is
 * kept. The CLI is the way in when a tenant has no admin (the first one, or after the last was
 * locked or left); admins then make others in the app (the admin API). Removing the last admin
 * is refused here too.
 *
 * `user lock` is the operator's emergency stop (T-104), for anyone: a person of either source,
 * or a service account. It ends their sessions and revokes their AI clients' grants at once, and
 * they are refused from their next request on every server sharing the database; a service
 * account's API keys stop until `user unlock`. Unlocking brings back none of what the lock ended,
 * and never lifts a provider disable. Both are audited (`user.lock`, `user.unlock`), with what
 * the lock ended.
 *
 * `user create` makes a local person (a member) for a tenant without an identity provider, and
 * `user sign-in-link` issues them a one-time link to sign in with (core/identity
 * sign-in-links.ts), on a server with `auth.signInLinks` (loopback only). Both are audited
 * (`user.create`, `sign-in-link.issue`); the link is printed once. A link can be issued for any
 * current person, SCIM-provisioned ones too, and bypasses the identity provider and its MFA: the
 * operator running admin commands is trusted with every account.
 *
 * `user invite` issues a local person an invite (core/identity passkeys.ts, T-108), on a server
 * with `auth.passkeys`: a link, good once and for at most 7 days, whose holder makes a passkey
 * for that person and is signed in. Send it to them yourself, over a channel you trust; it
 * replaces any earlier invite of theirs. It works from anywhere publicUrl is reachable, so it is
 * how a person signs in through a tunnel, where sign-in links are refused. `user list-passkeys`
 * shows what they hold and `user remove-passkey` removes one (a lost phone), ending the sessions
 * it signed in. All audited (`invite.issue`, `passkey.remove`); the link is printed once.
 *
 * `pack plan` shows what applying a pack (packs/README.md) would change in a tenant, every
 * loosening flagged, its tests, and the plan's hash; `pack apply` applies exactly that plan
 * (refused if anything changed since, or a test fails), audited as `pack.apply` with the hash.
 * The starter pack (packs/general-business) is how a tenant gets defaults other than
 * hidden / metadata-only, and so how AI clients get content at all.
 *
 * `source status` shows how each source's last scheduled sync ended (T-303); `source run-now`
 * queues a run now (audited `source.run-now`; on the embedded database the server runs it when
 * it starts again); `source resume` lets the schedule run a source a failure stopped
 * (`source.resume`).
 *
 * `source …` is about connector syncs (T-301). A crawl from the beginning that would remove a
 * large part of a source (a folder not mounted, a lost state) is held until an operator looks
 * and confirms it (`source.confirm-reconcile`, with the count) or discards it and has the
 * source crawled afresh (`source.discard-reconcile`); a source whose connector says it
 * is now another one (another disk at the path) syncs again only once accepted
 * (`source.accept-identity`), which starts a crawl from the beginning. Both are audited, refusals
 * too.
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
  /** Starts the job queue to send on (tests); the default is core/jobs startJobs(). */
  startJobs?: typeof startJobs;
}

const USAGE = `usage: openhoard admin <command> [--data-dir <dir>]

  tenant create --name <name>                      create a tenant
  tenant list                                      list tenants
  scim-token issue --tenant <ten_…> --name <name> [--days <1-${SCIM_TOKEN_MAX_DAYS}>]
                                                   issue a SCIM token (printed once)
  scim-token list --tenant <ten_…>                 list a tenant's SCIM tokens
  scim-token revoke --tenant <ten_…> --id <sct_…>  revoke a SCIM token
  user grant-admin --tenant <ten_…> --user <usr_…|email|userName>
                                                   make a person the tenant's admin
  user revoke-admin --tenant <ten_…> --user <usr_…|email|userName>
                                                   take the admin role away
  user list-admins --tenant <ten_…>                list the tenant's admins
  user lock --tenant <ten_…> --user <usr_…|email|userName>
                                                   lock someone out now: their sessions and AI
                                                   clients' grants end, API keys stop
  user unlock --tenant <ten_…> --user <usr_…|email|userName>
                                                   lift the lock (what it ended stays ended)
  group list --tenant <ten_…>                      list the tenant's groups (the grp_… id
                                                   names the admin group in auth.adminGroups)
  user create --tenant <ten_…> --email <email> --name <name>
                                                   make a local person (no identity provider)
  user sign-in-link --tenant <ten_…> --user <usr_…|email|userName> [--minutes <1-${SIGN_IN_LINK_MAX_MINUTES}>]
                                                   a one-time sign-in link (auth.signInLinks)
  user invite --tenant <ten_…> --user <usr_…|email> [--hours <1-${INVITE_MAX_HOURS}>]
                                                   an invite link: its holder makes a passkey
                                                   for that person (auth.passkeys)
  user list-passkeys --tenant <ten_…> --user <usr_…|email>
                                                   the passkeys a person holds
  user remove-passkey --tenant <ten_…> --user <usr_…|email> --id <pky_…>
                                                   remove a passkey (a lost device)
  pack plan --tenant <ten_…> --file <pack.json>   what applying a pack would change, and its hash
  pack apply --tenant <ten_…> --file <pack.json> --plan-hash <hash>
                                                   apply exactly the plan shown
  source list --tenant <ten_…>                     list the tenant's connector syncs
  source status --tenant <ten_…> [--source <name>] how each source's last scheduled sync ended
  source run-now --tenant <ten_…> --source <name>  queue a sync of the source now
  source resume --tenant <ten_…> --source <name>   schedule a source a failure stopped again
  source confirm-reconcile --tenant <ten_…> --source <name>
                                                   let a held reconcile remove what it counted
  source discard-reconcile --tenant <ten_…> --source <name>
                                                   drop a held or deferred reconcile, removing
                                                   nothing, and crawl the source afresh
  source accept-identity --tenant <ten_…> --source <name>
                                                   accept that the source is now another one
                                                   (it is crawled again from the beginning)
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
        user: { type: "string" },
        source: { type: "string" },
        email: { type: "string" },
        minutes: { type: "string" },
        hours: { type: "string" },
        file: { type: "string" },
        "plan-hash": { type: "string" },
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
    "user grant-admin",
    "user revoke-admin",
    "user list-admins",
    "user lock",
    "user unlock",
    "user create",
    "user sign-in-link",
    "user invite",
    "user list-passkeys",
    "user remove-passkey",
    "group list",
    "pack plan",
    "pack apply",
    "source list",
    "source status",
    "source run-now",
    "source resume",
    "source confirm-reconcile",
    "source discard-reconcile",
    "source accept-identity",
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

  const db = await openAdminDatabase(config, io);
  if (db === null) return 1;

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
      case "user grant-admin":
      case "user revoke-admin":
        return await adminChange(
          db,
          config,
          command === "user grant-admin" ? "grant" : "revoke",
          tenantArg(values.tenant),
          need(values.user, "--user"),
          io,
        );
      case "user list-admins":
        return await adminList(db, config, tenantArg(values.tenant), io);
      case "user lock":
      case "user unlock":
        return await lockChange(
          db,
          command === "user lock" ? "lock" : "unlock",
          tenantArg(values.tenant),
          need(values.user, "--user"),
          io,
        );
      case "group list":
        return await groupList(db, config, tenantArg(values.tenant), io);
      case "user create":
        return await userCreate(
          db,
          tenantArg(values.tenant),
          need(values.email, "--email"),
          need(values.name, "--name"),
          io,
        );
      case "user sign-in-link":
        return await signInLink(db, config, values, io);
      case "user invite":
        return await invite(db, config, values, io);
      case "user list-passkeys":
        return await passkeyList(db, tenantArg(values.tenant), need(values.user, "--user"), io);
      case "user remove-passkey":
        return await passkeyRemove(
          db,
          tenantArg(values.tenant),
          need(values.user, "--user"),
          need(values.id, "--id"),
          io,
        );
      case "pack plan":
      case "pack apply":
        return await packCommand(
          db,
          command === "pack plan" ? "plan" : "apply",
          tenantArg(values.tenant),
          need(values.file, "--file"),
          values["plan-hash"],
          io,
          io.cwd,
        );
      case "source list":
        return await sourceList(db, tenantArg(values.tenant), io);
      case "source status":
        return await sourceStatus(
          db,
          tenantArg(values.tenant),
          values.source === undefined ? undefined : sourceArg(values.source),
          io,
        );
      case "source run-now":
        return await sourceRunNow(db, tenantArg(values.tenant), sourceArg(values.source), io);
      case "source resume":
        return await sourceResume(db, tenantArg(values.tenant), sourceArg(values.source), io);
      case "source confirm-reconcile":
      case "source discard-reconcile":
      case "source accept-identity":
        return await sourceChange(
          db,
          command.slice("source ".length) as SourceChange,
          tenantArg(values.tenant),
          sourceArg(values.source),
          io,
        );
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

/**
 * Opens the configured database for a command run beside (or instead of) the server; null, with
 * the reason said, when it can't: on the embedded database, most likely because the server holds
 * it. Also used by `init --solo` and `connect` (solo.ts, connect.ts).
 */
export async function openAdminDatabase(config: Config, io: AdminIo): Promise<Database | null> {
  try {
    if (io.open) return await io.open(config);
    ensureDataDir(config.dataDir);
    return await openDatabase({ url: config.database.url, dataDir: config.dataDir });
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
    return null;
  }
}

function need(value: string | undefined, flag: string): string {
  if (value === undefined || value === "") throw new UsageError(`${flag} is required`);
  return value;
}

function sourceArg(value: string | undefined): string {
  const source = need(value, "--source");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(source)) {
    throw new UsageError(`not a source name: ${source}`);
  }
  return source;
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

/**
 * The current person `--user` names: an id, or an email or userName that exactly one current
 * person has (a UPN often looks like an email: both are tried, and two people are ambiguous).
 */
async function namedUser(
  db: Database,
  tenantId: string,
  named: string,
): Promise<User | "none" | "ambiguous"> {
  return db.withTenant(tenantId, async (tx) => {
    if (isId("user", named)) {
      const u = await getUser(tx, tenantId, named);
      return u && u.retired === null ? u : "none";
    }
    const found = [
      await findUserByEmail(tx, tenantId, named),
      await findUserByUserName(tx, tenantId, named),
    ].filter((u): u is User => u !== null);
    const ids = new Set(found.map((u) => u.id));
    if (ids.size === 0) return "none";
    return ids.size === 1 ? (found[0] as User) : "ambiguous";
  });
}

/** Why the directory refused an admin change, for the operator. */
function adminRefusal(e: IdentityError): { reason: string; message: string } {
  switch (e.code) {
    case "invalid":
      return {
        reason: "not-a-member",
        message: "only a member is an admin, never a guest or a service account",
      };
    case "inactive":
      return { reason: "inactive", message: "they are locked or disabled: unlock them first" };
    case "wrong-source":
      return {
        reason: "admin-group",
        message: "they are an admin through the identity provider's admin group: remove them there",
      };
    case "conflict":
      return {
        reason: "last-admin",
        message: "the tenant's last admin: make someone else admin first",
      };
    default:
      return { reason: "unknown-user", message: "no such person" };
  }
}

async function adminChange(
  db: Database,
  config: Config,
  change: "grant" | "revoke",
  tenantId: string,
  named: string,
  io: AdminIo,
): Promise<number> {
  if (!(await db.withTenant(tenantId, (tx) => getTenant(tx, tenantId)))) {
    io.err(`no tenant ${tenantId}\n`);
    return 1;
  }
  const action = change === "grant" ? "admin.grant" : "admin.revoke";
  const user = await namedUser(db, tenantId, named);
  const refused = async (reason: string, message: string, userId?: string) => {
    await db.withTenant(tenantId, (tx) =>
      appendAudit(tx, tenantId, {
        actor: ADMIN_ACTOR,
        action,
        decision: "deny",
        detail: { ...(userId ? { user: userId } : {}), reason },
      }),
    );
    io.err(`${message}\n`);
    return 1;
  };
  if (user === "none")
    return refused("unknown-user", `tenant ${tenantId} has no current person ${named}`);
  if (user === "ambiguous") {
    return refused(
      "ambiguous",
      `${named} is one person's email and another's userName: use the id`,
    );
  }
  const adminGroup = adminGroupOf(config.auth)(tenantId);
  try {
    // Run again after a deadlock or serialization failure (beside a running server on Postgres).
    const outcome = await retrying(() =>
      db.withTenant(tenantId, async (tx) => {
        const done =
          change === "grant"
            ? { changed: await grantAdmin(tx, tenantId, user.id, ADMIN_ACTOR), byGroup: false }
            : await revokeAdmin(
                tx,
                tenantId,
                user.id,
                ADMIN_ACTOR,
                adminGroup === undefined ? {} : { adminGroupId: adminGroup },
              ).then((r) => ({ changed: r.revoked, byGroup: r.stillAdminByGroup }));
        await appendAudit(tx, tenantId, {
          actor: ADMIN_ACTOR,
          action,
          decision: "allow",
          detail: {
            user: user.id,
            ...(done.changed ? {} : { unchanged: true }),
            ...(done.byGroup ? { stillAdminByGroup: true } : {}),
          },
        });
        return done;
      }),
    );
    const who = `${user.displayName} (${user.id})`;
    if (change === "grant") {
      io.err(outcome.changed ? `${who} is an admin now.\n` : `${who} was an admin already.\n`);
    } else if (!outcome.changed) {
      io.err(`${who} wasn't an admin.\n`);
    } else {
      io.err(
        outcome.byGroup
          ? `Removed ${who}'s admin role; they stay an admin through the admin group.\n`
          : `${who} is no longer an admin.\n`,
      );
    }
    io.out(`${user.id}\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof IdentityError)) throw e;
    const { reason, message } = adminRefusal(e);
    return refused(reason, message, user.id);
  }
}

/**
 * `user lock` and `user unlock`: an admin's lock (core/identity lockUser()), set or lifted as
 * `system:admin-cli`, and audited with what the lock ended.
 */
async function lockChange(
  db: Database,
  change: "lock" | "unlock",
  tenantId: string,
  named: string,
  io: AdminIo,
): Promise<number> {
  if (!(await db.withTenant(tenantId, (tx) => getTenant(tx, tenantId)))) {
    io.err(`no tenant ${tenantId}\n`);
    return 1;
  }
  const action = change === "lock" ? "user.lock" : "user.unlock";
  const refused = async (reason: string, message: string) => {
    await db.withTenant(tenantId, (tx) =>
      appendAudit(tx, tenantId, {
        actor: ADMIN_ACTOR,
        action,
        decision: "deny",
        detail: { reason },
      }),
    );
    io.err(`${message}\n`);
    return 1;
  };
  const user = await namedUser(db, tenantId, named);
  if (user === "none") {
    return refused("unknown-user", `tenant ${tenantId} has no current person ${named}`);
  }
  if (user === "ambiguous") {
    return refused(
      "ambiguous",
      `${named} is one person's email and another's userName: use the id`,
    );
  }
  let outcome: { changed: boolean; ended?: EndedAccess };
  try {
    // Run again after a deadlock or serialization failure: a lock ends sessions and grants, and
    // may meet an OAuth request or a SCIM sync locking the same rows (beside a running server).
    outcome = await retrying(() =>
      db.withTenant(tenantId, async (tx) => {
        const seen: { ended?: EndedAccess } = {};
        const changed =
          change === "lock"
            ? await lockUser(tx, tenantId, user.id, ADMIN_ACTOR, {
                onEnded: (e) => (seen.ended = e),
              })
            : await unlockUser(tx, tenantId, user.id, ADMIN_ACTOR);
        const ended = seen.ended;
        await appendAudit(tx, tenantId, {
          actor: ADMIN_ACTOR,
          action,
          decision: "allow",
          detail: {
            user: user.id,
            ...(changed ? {} : { unchanged: true }),
            ...(ended
              ? {
                  sessionsEnded: ended.sessions,
                  oauthGrantsRevoked: ended.oauthGrants,
                  oauthCodesUsedUp: ended.oauthCodes,
                  ...(ended.invites > 0 ? { invitesRevoked: ended.invites } : {}),
                }
              : {}),
          },
        });
        return { changed, ...(ended ? { ended } : {}) };
      }),
    );
  } catch (e) {
    // Retired since it was found.
    if (!(e instanceof IdentityError)) throw e;
    return refused("unknown-user", `tenant ${tenantId} has no current person ${named}`);
  }
  const who = `${user.displayName} (${user.id})`;
  if (change === "unlock") {
    io.err(
      outcome.changed
        ? `${who} is unlocked. What the lock ended stays ended: they sign in again, and AI ` +
            `clients ask for their consent again.\n`
        : `${who} wasn't locked.\n`,
    );
  } else if (!outcome.changed) {
    io.err(`${who} was locked already.\n`);
  } else {
    const ended = outcome.ended as EndedAccess;
    io.err(
      `${who} is locked: refused from their next request. Ended ${ended.sessions} ` +
        `session(s) and revoked ${ended.oauthGrants} AI-client grant(s).` +
        (user.kind === "service" ? " Their API keys stop until they are unlocked." : "") +
        (user.source === "scim"
          ? " The identity provider's syncs don't lift the lock; if they left, remove them there."
          : "") +
        "\n",
    );
  }
  io.out(`${user.id}\n`);
  return 0;
}

async function adminList(
  db: Database,
  config: Config,
  tenantId: string,
  io: AdminIo,
): Promise<number> {
  const adminGroup = adminGroupOf(config.auth)(tenantId);
  const admins = await db.withTenant(tenantId, async (tx) =>
    (await getTenant(tx, tenantId))
      ? listAdmins(tx, tenantId, adminGroup === undefined ? {} : { adminGroupId: adminGroup })
      : null,
  );
  if (!admins) {
    io.err(`no tenant ${tenantId}\n`);
    return 1;
  }
  for (const a of admins) {
    const state = a.effective
      ? "active"
      : a.user.kind !== "member"
        ? a.user.kind
        : a.user.lock
          ? "locked"
          : "disabled";
    io.out(
      [a.user.id, a.via.join("+"), state, a.user.email ?? "", a.user.displayName].join("\t") + "\n",
    );
  }
  if (admins.length === 0) {
    io.err(
      `tenant ${tenantId} has no admin: openhoard admin user grant-admin --tenant ${tenantId} --user <email>\n`,
    );
  }
  if (adminGroup !== undefined) {
    const group = await db.withTenant(tenantId, (tx) => getGroup(tx, tenantId, adminGroup));
    if (group?.source !== "scim") {
      io.err(
        `the configured admin group ${adminGroup} ${group ? "isn't a SCIM group" : "doesn't exist"}: it makes nobody an admin\n`,
      );
    }
  }
  return 0;
}

/**
 * The tenant's groups, a page of 1,000 at a time: id, name, external id, source and how many
 * members, and which one the config names as the admin group. `auth.adminGroups` names a group
 * by the id this prints, never by its external id (which the SCIM token chooses).
 */
async function groupList(
  db: Database,
  config: Config,
  tenantId: string,
  io: AdminIo,
): Promise<number> {
  const adminGroup = adminGroupOf(config.auth)(tenantId);
  if (!(await db.withTenant(tenantId, (tx) => getTenant(tx, tenantId)))) {
    io.err(`no tenant ${tenantId}\n`);
    return 1;
  }
  let shown = 0;
  for (let offset = 0; ; offset += MAX_LIST) {
    const rows = await db.withTenant(tenantId, async (tx) => {
      const page = await listGroups(tx, tenantId, {}, { offset, limit: MAX_LIST });
      const out = [];
      for (const g of page.groups) out.push({ g, members: await memberCount(tx, tenantId, g.id) });
      return out;
    });
    for (const { g, members } of rows) {
      const mark = g.id === adminGroup ? "\tadmin group" : "";
      io.out(`${g.id}\t${g.source}\t${members}\t${g.externalId ?? ""}\t${g.name}${mark}\n`);
    }
    shown += rows.length;
    if (rows.length < MAX_LIST) break;
  }
  if (shown === 0) io.err(`tenant ${tenantId} has no groups\n`);
  return 0;
}

async function sourceList(db: Database, tenantId: string, io: AdminIo): Promise<number> {
  const syncs = await db.withTenant(tenantId, async (tx) =>
    (await getTenant(tx, tenantId)) ? listSourceSyncs(tx, tenantId) : null,
  );
  if (!syncs) {
    io.err(`no tenant ${tenantId}\n`);
    return 1;
  }
  for (const s of syncs) {
    const reconcile = reconcileText(s);
    io.out(
      [
        s.source,
        s.connector,
        s.zoneId,
        s.phase,
        s.updatedAt.toISOString(),
        s.stoppedAt !== null
          ? `stopped: ${s.stoppedError ?? "failed"}`
          : (s.lastStatus ?? "never run"),
        reconcile,
      ].join("\t") + "\n",
    );
  }
  if (syncs.length === 0) io.err(`tenant ${tenantId} has no connector syncs\n`);
  return 0;
}

function reconcileText(s: SourceSyncState): string {
  return s.reconcileHeld !== null
    ? `reconcile held: ${s.reconcileHeld} to remove` +
        (s.reconcileConfirmed !== null ? ` (confirmed ${s.reconcileConfirmed})` : "")
    : s.reconcileDeferred
      ? "reconcile deferred: a place couldn't be read"
      : s.reconciling
        ? "reconciling"
        : "";
}

/** One line per change a pack plan makes, `!` before a loosening. */
export function changeText(c: PackChange): string {
  const mark = "loosens" in c && c.loosens ? "! " : "  ";
  const what =
    c.kind === "set-defaults"
      ? `defaults ${c.from.visibility}/${c.from.exposure} -> ${c.to.visibility}/${c.to.exposure}`
      : "tag" in c
        ? c.tag
        : "facet" in c
          ? c.facet
          : c.kind === "set-rules"
            ? `${c.added.length} added, ${c.removed.length} removed`
            : "";
  return `${mark}${c.kind} ${what}`.trimEnd();
}

/**
 * A pack plan for the person: its changes (`!` before a loosening), warnings and tests, under
 * `heading` ("Plan", "Applied").
 */
export function packPlanText(heading: string, plan: PackPlan): string {
  const lines = [
    `${heading}: pack ${plan.name} ${plan.version}` +
      (plan.previous === null ? "" : ` (now ${plan.previous})`),
    ...plan.changes.map(changeText),
    ...plan.warnings.map((w) => `warning: ${w}`),
    ...plan.tests.map((t) => `test ${t.passed ? "passed" : "FAILED"}: ${t.name}`),
  ];
  return lines.join("\n") + "\n";
}

/**
 * Applies exactly the plan `planHash` names, audited `pack.apply` as `system:admin-cli`, in the
 * caller's transaction (APPLY_TRANSACTION). Also used by `init --solo` (solo.ts).
 */
export async function applyPackAudited(
  tx: Tx,
  tenantId: string,
  pack: unknown,
  planHash: string,
): Promise<PackPlan> {
  const applied = await applyPack(tx, tenantId, pack, { planHash, by: ADMIN_ACTOR });
  await appendAudit(tx, tenantId, {
    actor: ADMIN_ACTOR,
    action: "pack.apply",
    decision: "allow",
    detail: {
      pack: applied.name,
      version: applied.version,
      ...(applied.previous === null ? {} : { previous: applied.previous }),
      planHash: applied.planHash,
      loosening: applied.changes.filter((c) => "loosens" in c && c.loosens).length,
    },
  });
  return applied;
}

/** `pack plan` and `pack apply`: see the header. */
async function packCommand(
  db: Database,
  step: "plan" | "apply",
  tenantId: string,
  file: string,
  planHash: string | undefined,
  io: AdminIo,
  cwd = process.cwd(),
): Promise<number> {
  if (step === "apply" && (planHash === undefined || !/^[0-9a-f]{64}$/.test(planHash))) {
    throw new UsageError("--plan-hash is the hash `pack plan` printed");
  }
  let pack: unknown;
  try {
    pack = JSON.parse(readFileSync(resolve(cwd, file), "utf8"));
  } catch (e) {
    io.err(`cannot read the pack: ${(e as Error).message}\n`);
    return 1;
  }
  if (!(await db.withTenant(tenantId, (tx) => getTenant(tx, tenantId)))) {
    io.err(`no tenant ${tenantId}\n`);
    return 1;
  }
  let plan: PackPlan;
  try {
    plan =
      step === "plan"
        ? await db.withTenant(tenantId, (tx) => planPack(tx, tenantId, pack), {
            accessMode: "read only",
          })
        : await retrying(() =>
            db.withTenant(
              tenantId,
              (tx) => applyPackAudited(tx, tenantId, pack, planHash as string),
              APPLY_TRANSACTION,
            ),
          );
  } catch (e) {
    if (!(e instanceof PackError)) throw e;
    if (step === "apply") {
      await db.withTenant(tenantId, (tx) =>
        appendAudit(tx, tenantId, {
          actor: ADMIN_ACTOR,
          action: "pack.apply",
          decision: "deny",
          detail: { reason: e.code },
        }),
      );
    }
    io.err(`${e.message}\n`);
    return 1;
  }
  io.err(packPlanText(step === "plan" ? "Plan" : "Applied", plan));
  io.out(`${plan.planHash}\n`);
  if (step === "plan") {
    io.err(
      `To apply exactly this: openhoard admin pack apply --tenant ${tenantId} --file ${file} --plan-hash ${plan.planHash}\n`,
    );
  }
  return 0;
}

/** `source status`: each source (or one), a block of `key: value` lines. */
async function sourceStatus(
  db: Database,
  tenantId: string,
  source: string | undefined,
  io: AdminIo,
): Promise<number> {
  const syncs = await db.withTenant(tenantId, async (tx) =>
    (await getTenant(tx, tenantId)) ? listSourceSyncs(tx, tenantId) : null,
  );
  if (!syncs) {
    io.err(`no tenant ${tenantId}\n`);
    return 1;
  }
  const shown = syncs.filter((s) => source === undefined || s.source === source);
  if (shown.length === 0) {
    io.err(
      source === undefined
        ? `tenant ${tenantId} has no connector syncs\n`
        : `tenant ${tenantId} has no source ${source}\n`,
    );
    return 1;
  }
  for (const s of shown) {
    const counts = s.lastCounts
      ? Object.entries(s.lastCounts)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ")
      : "";
    const lines: [string, string][] = [
      ["source", s.source],
      ["connector", s.connector],
      ["zone", s.zoneId],
      [
        "state",
        s.stoppedAt !== null
          ? `STOPPED since ${s.stoppedAt.toISOString()} (${s.stoppedError ?? "failed"}): fix the cause, then source resume`
          : "scheduled",
      ],
      ["phase", s.phase],
      ["last run", s.lastRunAt?.toISOString() ?? "never"],
      [
        "last status",
        s.lastStatus === null ? "" : s.lastStatus + (s.lastError ? ` (${s.lastError})` : ""),
      ],
      ["last counts", counts],
      ["reconcile", reconcileText(s)],
    ];
    io.out(
      lines
        .filter(([, v]) => v !== "")
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n") + "\n\n",
    );
  }
  return 0;
}

/** `source run-now`: queues a run of a bound, running source (audited). */
async function sourceRunNow(
  db: Database,
  tenantId: string,
  source: string,
  io: AdminIo,
): Promise<number> {
  const found = await db.withTenant(tenantId, async (tx) => {
    if (!(await getTenant(tx, tenantId))) return "no-tenant" as const;
    const state = (await listSourceSyncs(tx, tenantId)).find((s) => s.source === source);
    const reason = !state ? "unknown-source" : state.stoppedAt !== null ? "stopped" : null;
    if (reason !== null) {
      await appendAudit(tx, tenantId, {
        actor: ADMIN_ACTOR,
        action: "source.run-now",
        decision: "deny",
        detail: { source, reason },
      });
    }
    return reason ?? ("ok" as const);
  });
  if (found === "no-tenant") {
    io.err(`no tenant ${tenantId}\n`);
    return 1;
  }
  if (found !== "ok") {
    io.err(
      found === "stopped"
        ? `source ${source} is stopped: fix what failed (source status), then source resume\n`
        : `tenant ${tenantId} has no source ${source} (the server binds configured sources when it starts)\n`,
    );
    return 1;
  }
  // This process only sends: it works no queue and keeps no schedule.
  const jobs = await (io.startJobs ?? startJobs)(db, { worker: false, maintenance: false });
  let id: string | null;
  try {
    id = await jobs.requestSync(tenantId, source);
  } finally {
    await jobs.stop({ timeoutMs: 1_000 });
  }
  await db.withTenant(tenantId, (tx) =>
    appendAudit(tx, tenantId, {
      actor: ADMIN_ACTOR,
      action: "source.run-now",
      decision: "allow",
      detail: { source, ...(id === null ? { joined: true } : {}) },
    }),
  );
  io.err(
    `Queued a sync of ${source}${id === null ? " (one was waiting already: brought forward)" : ""}. ` +
      `A running server's worker picks it up within seconds; on the embedded database, when the server starts.\n`,
  );
  return 0;
}

/** `source resume`: the schedule runs a stopped source again (audited). */
async function sourceResume(
  db: Database,
  tenantId: string,
  source: string,
  io: AdminIo,
): Promise<number> {
  const was = await db.withTenant(tenantId, async (tx) => {
    if (!(await getTenant(tx, tenantId))) return "no-tenant" as const;
    const resumed = await resumeSource(tx, tenantId, source);
    await appendAudit(tx, tenantId, {
      actor: ADMIN_ACTOR,
      action: "source.resume",
      decision: resumed === null ? "deny" : "allow",
      detail: { source, ...(resumed === null ? { reason: "not-stopped" } : { was: resumed }) },
    });
    return resumed;
  });
  if (was === "no-tenant") {
    io.err(`no tenant ${tenantId}\n`);
    return 1;
  }
  if (was === null) {
    io.err(`source ${source} isn't stopped\n`);
    return 1;
  }
  io.err(
    `Resumed ${source} (it was stopped for ${was}): it runs at its next schedule, or now with source run-now.\n`,
  );
  return 0;
}

/** `user create`: a local person (a member), for a tenant without an identity provider. */
async function userCreate(
  db: Database,
  tenantId: string,
  email: string,
  name: string,
  io: AdminIo,
): Promise<number> {
  const made = await db
    .withTenant(tenantId, async (tx) => {
      if (!(await getTenant(tx, tenantId))) return "no-tenant" as const;
      const user = await createUser(tx, tenantId, {
        email,
        displayName: name,
        source: "local",
      });
      await appendAudit(tx, tenantId, {
        actor: ADMIN_ACTOR,
        action: "user.create",
        decision: "allow",
        detail: { user: user.id, source: "local" },
      });
      return user;
    })
    .catch((e: unknown) => {
      if (e instanceof IdentityError) return e;
      throw e;
    });
  if (made === "no-tenant") {
    io.err(`no tenant ${tenantId}\n`);
    return 1;
  }
  if (made instanceof IdentityError) {
    await db.withTenant(tenantId, (tx) =>
      appendAudit(tx, tenantId, {
        actor: ADMIN_ACTOR,
        action: "user.create",
        decision: "deny",
        detail: { reason: made.code },
      }),
    );
    io.err(
      made.code === "conflict"
        ? `someone in tenant ${tenantId} has that email already\n`
        : `${made.message}\n`,
    );
    return 1;
  }
  io.out(`${made.id}\n`);
  io.err(
    `Created ${made.displayName} (${made.id}).\n` +
      `Next: openhoard admin user sign-in-link --tenant ${tenantId} --user ${made.id}\n`,
  );
  return 0;
}

/**
 * `user sign-in-link`: a one-time link to sign in with, printed once (audited). Also how
 * `connect claude-desktop` (connect.ts) issues one.
 */
export async function signInLink(
  db: Database,
  config: Config,
  values: { tenant?: string; user?: string; minutes?: string },
  io: AdminIo,
): Promise<number> {
  const tenantId = tenantArg(values.tenant);
  const named = need(values.user, "--user");
  const minutesText = values.minutes ?? "15";
  const minutes = /^\d{1,2}$/.test(minutesText) ? Number(minutesText) : Number.NaN;
  if (!(minutes >= 1 && minutes <= SIGN_IN_LINK_MAX_MINUTES)) {
    throw new UsageError(`--minutes is a whole number from 1 to ${SIGN_IN_LINK_MAX_MINUTES}`);
  }
  if (!config.auth?.signInLinks) {
    io.err(
      `sign-in links are off: set auth.signInLinks to true in the server's config (on a server ` +
        `that listens on 127.0.0.1 only), and restart it\n`,
    );
    return 1;
  }
  if (!(await db.withTenant(tenantId, (tx) => getTenant(tx, tenantId)))) {
    io.err(`no tenant ${tenantId}\n`);
    return 1;
  }
  const refused = async (reason: string, message: string, userId?: string) => {
    await db.withTenant(tenantId, (tx) =>
      appendAudit(tx, tenantId, {
        actor: ADMIN_ACTOR,
        action: "sign-in-link.issue",
        decision: "deny",
        detail: { ...(userId ? { user: userId } : {}), reason },
      }),
    );
    io.err(`${message}\n`);
    return 1;
  };
  const user = await namedUser(db, tenantId, named);
  if (user === "none") {
    return refused("unknown-user", `tenant ${tenantId} has no current person ${named}`);
  }
  if (user === "ambiguous") {
    return refused(
      "ambiguous",
      `${named} is one person's email and another's userName: use the id`,
    );
  }
  let link;
  try {
    link = await db.withTenant(tenantId, async (tx) => {
      const issued = await issueSignInLink(tx, tenantId, {
        userId: user.id,
        by: ADMIN_ACTOR,
        minutes,
      });
      await appendAudit(tx, tenantId, {
        actor: ADMIN_ACTOR,
        action: "sign-in-link.issue",
        decision: "allow",
        detail: { user: user.id, link: issued.id, expiresAt: issued.expiresAt.toISOString() },
      });
      return issued;
    });
  } catch (e) {
    if (!(e instanceof IdentityError)) throw e;
    return refused(e.code, e.message, user.id);
  }
  const url = new URL("/auth/link", config.auth.publicUrl);
  url.searchParams.set("token", link.token);
  io.out(`${url.href}\n`);
  io.err(
    `A sign-in link for ${user.displayName} (${user.id}), shown once, good once, until ` +
      `${link.expiresAt.toISOString()}: open it in the browser you'll use with OpenHoard.\n`,
  );
  return 0;
}

/**
 * `user invite`: an invite link for a local person, printed once (audited). Whoever opens it
 * makes a passkey for that person and is signed in (T-108).
 */
export async function invite(
  db: Database,
  config: Config,
  values: { tenant?: string; user?: string; hours?: string },
  io: AdminIo,
): Promise<number> {
  const tenantId = tenantArg(values.tenant);
  const named = need(values.user, "--user");
  const hoursText = values.hours ?? String(INVITE_MAX_HOURS);
  const hours = /^\d{1,3}$/.test(hoursText) ? Number(hoursText) : Number.NaN;
  if (!(hours >= 1 && hours <= INVITE_MAX_HOURS)) {
    throw new UsageError(`--hours is a whole number from 1 to ${INVITE_MAX_HOURS}`);
  }
  if (!config.auth?.passkeys) {
    io.err(
      `passkeys are off: set auth.passkeys to true in the server's config (publicUrl must be a ` +
        `host name, where people reach the server), and restart it\n`,
    );
    return 1;
  }
  if (!(await db.withTenant(tenantId, (tx) => getTenant(tx, tenantId)))) {
    io.err(`no tenant ${tenantId}\n`);
    return 1;
  }
  const refused = async (reason: string, message: string, userId?: string) => {
    await db.withTenant(tenantId, (tx) =>
      appendAudit(tx, tenantId, {
        actor: ADMIN_ACTOR,
        action: "invite.issue",
        decision: "deny",
        detail: { ...(userId ? { user: userId } : {}), reason },
      }),
    );
    io.err(`${message}\n`);
    return 1;
  };
  const user = await namedUser(db, tenantId, named);
  if (user === "none") {
    return refused("unknown-user", `tenant ${tenantId} has no current person ${named}`);
  }
  if (user === "ambiguous") {
    return refused(
      "ambiguous",
      `${named} is one person's email and another's userName: use the id`,
    );
  }
  let issued;
  try {
    issued = await db.withTenant(tenantId, async (tx) => {
      const made = await issueInvite(tx, tenantId, { userId: user.id, by: ADMIN_ACTOR, hours });
      await appendAudit(tx, tenantId, {
        actor: ADMIN_ACTOR,
        action: "invite.issue",
        decision: "allow",
        detail: {
          user: user.id,
          invite: made.id,
          expiresAt: made.expiresAt.toISOString(),
          ...(made.revoked > 0 ? { replaced: made.revoked } : {}),
        },
      });
      return made;
    });
  } catch (e) {
    if (!(e instanceof IdentityError)) throw e;
    return refused(e.code, e.message, user.id);
  }
  // In the fragment: browsers send it to no server, so it reaches no proxy's or tunnel's log.
  const url = new URL("/auth/invite", config.auth.publicUrl);
  url.hash = issued.token;
  io.out(`${url.href}\n`);
  io.err(
    `An invite for ${user.displayName} (${user.id}), shown once, good once, until ` +
      `${issued.expiresAt.toISOString()}: whoever opens it makes a passkey for them and is ` +
      `signed in, so send it only to them.` +
      (issued.revoked > 0 ? ` Their earlier invite no longer works.` : ``) +
      `\n`,
  );
  return 0;
}

/** `user list-passkeys`: what a person signs in with. */
async function passkeyList(
  db: Database,
  tenantId: string,
  named: string,
  io: AdminIo,
): Promise<number> {
  const user = await namedUser(db, tenantId, named);
  if (user === "none" || user === "ambiguous") {
    io.err(`tenant ${tenantId} has no one current person ${named}\n`);
    return 1;
  }
  const held = await db.withTenant(tenantId, (tx) => listPasskeys(tx, tenantId, user.id));
  for (const p of held) {
    io.out(
      [
        p.id,
        p.name,
        `created ${p.createdAt.toISOString()}`,
        p.lastUsedAt ? `last used ${p.lastUsedAt.toISOString()}` : "never used",
        p.backedUp ? "synced" : "this device only",
      ].join("\t") + "\n",
    );
  }
  if (held.length === 0) io.err(`${user.displayName} (${user.id}) has no passkey.\n`);
  return 0;
}

/** `user remove-passkey`: removes one, and ends the sessions it signed in (audited). */
async function passkeyRemove(
  db: Database,
  tenantId: string,
  named: string,
  passkeyId: string,
  io: AdminIo,
): Promise<number> {
  if (!isId("passkey", passkeyId)) throw new UsageError("--id is a passkey id (pky_…)");
  const user = await namedUser(db, tenantId, named);
  if (user === "none" || user === "ambiguous") {
    io.err(`tenant ${tenantId} has no one current person ${named}\n`);
    return 1;
  }
  const ended = await db.withTenant(tenantId, async (tx) => {
    const result = await removePasskey(tx, tenantId, user.id, passkeyId, ADMIN_ACTOR);
    if (result) {
      await appendAudit(tx, tenantId, {
        actor: ADMIN_ACTOR,
        action: "passkey.remove",
        decision: "allow",
        detail: {
          user: user.id,
          passkey: passkeyId,
          sessionsEnded: result.sessions,
          oauthGrantsRevoked: result.oauthGrants,
          oauthCodesUsedUp: result.oauthCodes,
        },
      });
    }
    return result;
  });
  if (!ended) {
    io.err(`${user.displayName} (${user.id}) has no passkey ${passkeyId}\n`);
    return 1;
  }
  io.err(
    `Removed ${passkeyId}: it no longer signs ${user.displayName} in, and ended ` +
      `${ended.sessions} session(s) and ${ended.oauthGrants} AI client grant(s).\n`,
  );
  return 0;
}

type SourceChange = "confirm-reconcile" | "discard-reconcile" | "accept-identity";

async function sourceChange(
  db: Database,
  change: SourceChange,
  tenantId: string,
  source: string,
  io: AdminIo,
): Promise<number> {
  const result = await db.withTenant(tenantId, async (tx) => {
    if (!(await getTenant(tx, tenantId))) return "no-tenant" as const;
    const done =
      change === "confirm-reconcile"
        ? await confirmReconcile(tx, tenantId, source)
        : (await (change === "discard-reconcile" ? discardReconcile : acceptSourceIdentity)(
              tx,
              tenantId,
              source,
            ))
          ? 0
          : null;
    await appendAudit(tx, tenantId, {
      actor: ADMIN_ACTOR,
      action: `source.${change}`,
      decision: done === null ? "deny" : "allow",
      detail: {
        source,
        ...(done === null
          ? { reason: change === "accept-identity" ? "unknown-source" : "nothing-held" }
          : change === "confirm-reconcile"
            ? { confirmed: done }
            : {}),
      },
    });
    return done;
  });
  if (result === "no-tenant") {
    io.err(`no tenant ${tenantId}\n`);
    return 1;
  }
  if (result === null) {
    io.err(
      change === "accept-identity"
        ? `tenant ${tenantId} has no source ${source}\n`
        : `source ${source} has no reconcile held${change === "discard-reconcile" ? " or deferred" : " for confirmation"}\n`,
    );
    return 1;
  }
  io.err(
    change === "confirm-reconcile"
      ? `Confirmed: the next sync of ${source} may remove up to ${result} items.\n`
      : change === "discard-reconcile"
        ? `Discarded: nothing was removed; the next sync crawls ${source} afresh, guarded again.\n`
        : `Accepted: the next sync of ${source} records what it is now, and crawls it again.\n`,
  );
  return 0;
}
