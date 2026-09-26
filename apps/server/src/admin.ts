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
  findUserByEmail,
  findUserByUserName,
  getGroup,
  getUser,
  grantAdmin,
  IdentityError,
  issueScimToken,
  listAdmins,
  listGroups,
  MAX_LIST,
  memberCount,
  listScimTokens,
  lockUser,
  revokeAdmin,
  revokeScimToken,
  SCIM_TOKEN_MAX_DAYS,
  unlockUser,
  type EndedAccess,
  type User,
} from "@openhoard/core-identity";
import { acceptSourceIdentity, confirmReconcile, listSourceSyncs } from "@openhoard/core-jobs";
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
 *   admin group list        --tenant ten_…
 *   admin source list             --tenant ten_…
 *   admin source confirm-reconcile --tenant ten_… --source <name>
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
 * `source …` is about connector syncs (T-301). A crawl from the beginning that would remove a
 * large part of a source (a folder not mounted, a lost state) is held until an operator looks
 * and confirms it (`source.confirm-reconcile`, with the count); a source whose connector says it
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
  source list --tenant <ten_…>                     list the tenant's connector syncs
  source confirm-reconcile --tenant <ten_…> --source <name>
                                                   let a held reconcile remove what it counted
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
    "group list",
    "source list",
    "source confirm-reconcile",
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
      case "source list":
        return await sourceList(db, tenantArg(values.tenant), io);
      case "source confirm-reconcile":
      case "source accept-identity":
        return await sourceChange(
          db,
          command === "source confirm-reconcile" ? "confirm-reconcile" : "accept-identity",
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
    const reconcile =
      s.reconcileHeld !== null
        ? `reconcile held: ${s.reconcileHeld} to remove` +
          (s.reconcileConfirmed !== null ? ` (confirmed ${s.reconcileConfirmed})` : "")
        : s.reconciling
          ? "reconciling"
          : "";
    io.out(
      [s.source, s.connector, s.zoneId, s.phase, s.updatedAt.toISOString(), reconcile].join("\t") +
        "\n",
    );
  }
  if (syncs.length === 0) io.err(`tenant ${tenantId} has no connector syncs\n`);
  return 0;
}

async function sourceChange(
  db: Database,
  change: "confirm-reconcile" | "accept-identity",
  tenantId: string,
  source: string,
  io: AdminIo,
): Promise<number> {
  const result = await db.withTenant(tenantId, async (tx) => {
    if (!(await getTenant(tx, tenantId))) return "no-tenant" as const;
    const done =
      change === "confirm-reconcile"
        ? await confirmReconcile(tx, tenantId, source)
        : (await acceptSourceIdentity(tx, tenantId, source))
          ? 0
          : null;
    await appendAudit(tx, tenantId, {
      actor: ADMIN_ACTOR,
      action: `source.${change}`,
      decision: done === null ? "deny" : "allow",
      detail: {
        source,
        ...(done === null
          ? { reason: change === "confirm-reconcile" ? "nothing-held" : "unknown-source" }
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
      change === "confirm-reconcile"
        ? `source ${source} has no reconcile held for confirmation\n`
        : `tenant ${tenantId} has no source ${source}\n`,
    );
    return 1;
  }
  io.err(
    change === "confirm-reconcile"
      ? `Confirmed: the next sync of ${source} may remove up to ${result} items.\n`
      : `Accepted: the next sync of ${source} records what it is now, and crawls it again.\n`,
  );
  return 0;
}
