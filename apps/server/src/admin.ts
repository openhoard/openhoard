import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  appendAudit,
  exportAudit,
  verifyAudit,
  type AuditFilter,
  type ExportFormat,
} from "@openhoard/core-audit";
import {
  APPLY_TRANSACTION,
  applyPack,
  decideReview,
  HEALTH_SECTIONS,
  healthCsv,
  healthCsvCut,
  HealthError,
  healthReport,
  healthText,
  PackError,
  planPack,
  REVIEW_INBOX_MAX,
  ReviewAccessError,
  reviewInbox,
  reviewItemFor,
  TagError,
  tenantPolicies,
  VIEW_TRANSACTION,
  type HealthOptions,
  type HealthReport,
  type PackChange,
  type PackPlan,
  type ReviewDecision,
  type ReviewItem,
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
  syncStanding,
  type SourceSyncState,
} from "@openhoard/core-jobs";
import { Authorizer, createCedarEngine } from "@openhoard/core-policy";
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
 *   admin review list    --tenant ten_… --user <usr_… | email | userName> [--limit 100]
 *   admin review approve --tenant ten_… --user <…> --id rev_… [--replace]
 *   admin review reject  --tenant ten_… --user <…> --id rev_…
 *   admin review merge   --tenant ten_… --user <…> --id rev_… --into <value> [--replace]
 *   admin audit verify --tenant ten_…
 *   admin audit export --tenant ten_… [--format ndjson|csv] [--out <new file>] [--actor <principal>]
 *                      [--action <name>] [--decision allow|deny] [--client <id>] [--object <id>]
 *                      [--from <time>] [--to <time>]
 *   admin health report --tenant ten_… --user <admin: usr_… | email | userName>
 *                       [--format text|csv] [--out <new file>] [--limit <n>]
 *                       [--stale-days <n>] [--large-mb <n>]
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
 *
 * `review …` is the tag review inbox (T-406, T-1403) until the app has one: what models and AI
 * assistants proposed and a person must decide. A decision is a person's, so each command
 * names one (`--user`), and they see and decide only what they could in the app: items on
 * files they may tag (core/catalog review-inbox.ts). Being the operator, or a tenant admin,
 * gives no more. A decision that reaches further than the file takes a tenant admin who may
 * tag the file: approving or rejecting a value the vocabulary doesn't have, and taking a
 * restriction off the file (rejecting a value that sets a level, or replacing a tighter one).
 * `list` prints an item a line: id, tag, reason, who proposed it, confidence, when, `admin`
 * when some decision on it takes one, the file's id and title. `approve` applies the tag
 * (grants on it then count for the file), `reject` drops it, `merge` applies an approved value of the same facet
 * instead; `--replace` confirms taking another value of a single-value facet off the file.
 * Audited as `tag.review`, acted by `system:admin-cli` for the person; a refused decision too
 * (`refusal`: why), unless the tenant doesn't exist.
 *
 * `audit verify` (T-702, T-1404) checks a tenant's whole audit chain (core/audit verifyAudit()):
 * every hash and link, and that the columns queries read agree with the hashed events. It
 * prints `ok`, the number of events and the head hash, or the first event that doesn't check
 * out, and exits 1. It writes nothing, so the head it prints is the chain's until the next
 * event: keep it somewhere the database's owner can't write, since a chain cut short or
 * rewritten whole verifies. `audit export` (T-703) writes the tenant's events, filtered, as
 * NDJSON (each line the event as hashed, with its hash) or CSV, to standard output or to a new
 * file (`--out`, never over an existing one; its owner's alone where the system has file
 * modes). Times are ISO 8601 with a zone (`2026-10-01T00:00:00Z`) or a date, taken as UTC;
 * `--from` is included, `--to` is not. An export is audited (`audit.export`: the filter, the
 * format and how many events) once it ends, so the chain's head moves by that one event; one
 * that fails or whose reader goes away part way is audited as `incomplete`, and its file is
 * removed.
 *
 * `health report` (T-1001, T-1002) is the File Health Report: what a tenant's admin should
 * look at among its files (core/catalog health.ts). As text, a page for the tenant's owner:
 * each finding, why it matters, what to do and its first few files (`--limit`, 10). As CSV,
 * a line for every file listed, for a spreadsheet (`--limit` per section, 10,000, the most;
 * it says which sections have more). It names files by their real titles, so it is a tenant
 * admin's to read: `--user` names one, and it is audited (`health.report`: who it was for,
 * the format and each finding's count), a refusal too. `--stale-days` and `--large-mb` move
 * two of its thresholds. `--out` writes a new file, never over an existing one.
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
  /**
   * Standard output for a stream (an export): resolves once the reader has taken the text, so
   * a slow reader slows the writer instead of filling memory, and rejects when the reader has
   * gone. Default: `out`.
   */
  write?: (text: string) => Promise<void>;
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
  review list --tenant <ten_…> --user <usr_…|email|userName> [--limit <1-${REVIEW_INBOX_MAX}>]
                                                   the proposed tags that person may decide
  review approve --tenant <ten_…> --user <…> --id <rev_…> [--replace]
                                                   apply the proposed tag, as that person
  review reject --tenant <ten_…> --user <…> --id <rev_…>
                                                   turn the proposed tag down
  review merge --tenant <ten_…> --user <…> --id <rev_…> --into <value> [--replace]
                                                   apply an approved value of the facet instead
  audit verify --tenant <ten_…>                    check the tenant's audit chain, and print
                                                   its length and head hash
  audit export --tenant <ten_…> [--format ndjson|csv] [--out <new file>]
               [--actor <principal>] [--action <name>] [--decision allow|deny]
               [--client <id>] [--object <id>] [--from <time>] [--to <time>]
                                                   write the tenant's audit events, filtered
  health report --tenant <ten_…> --user <a tenant admin> [--format text|csv] [--out <new file>]
                [--limit <files listed per finding>] [--stale-days <n>] [--large-mb <n>]
                                                   the File Health Report: what to look at
                                                   among the tenant's files, and why
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
        into: { type: "string" },
        limit: { type: "string" },
        replace: { type: "boolean" },
        format: { type: "string" },
        out: { type: "string" },
        actor: { type: "string" },
        action: { type: "string" },
        decision: { type: "string" },
        client: { type: "string" },
        object: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        "stale-days": { type: "string" },
        "large-mb": { type: "string" },
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
    "review list",
    "review approve",
    "review reject",
    "review merge",
    "audit verify",
    "audit export",
    "health report",
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
      case "review list":
        return await reviewList(
          db,
          config,
          tenantArg(values.tenant),
          need(values.user, "--user"),
          values.limit,
          io,
        );
      case "review approve":
      case "review reject":
      case "review merge": {
        const id = need(values.id, "--id");
        if (!isId("review", id)) throw new UsageError(`not a review item id: ${id}`);
        const replace = values.replace === true;
        if (command !== "review merge" && values.into !== undefined) {
          throw new UsageError("--into goes with review merge");
        }
        if (command === "review reject" && replace) {
          throw new UsageError("--replace goes with review approve or merge");
        }
        return await reviewDecide(
          db,
          config,
          tenantArg(values.tenant),
          need(values.user, "--user"),
          id,
          command === "review approve"
            ? { decision: "approve", replace }
            : command === "review reject"
              ? { decision: "reject" }
              : { decision: "merge", into: need(values.into, "--into"), replace },
          io,
        );
      }
      case "audit verify":
        return await auditVerify(db, tenantArg(values.tenant), io);
      case "audit export":
        return await auditExport(db, tenantArg(values.tenant), exportArgs(values), io);
      case "health report":
        return await healthCommand(
          db,
          config,
          tenantArg(values.tenant),
          need(values.user, "--user"),
          healthArgs(values),
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

/** What lifts a stop: the command for what the source waits on (core/jobs syncStanding()). */
function stopAdvice(s: SourceSyncState): string {
  const standing = syncStanding(s);
  return standing.is === "held"
    ? "source confirm-reconcile removes what is held, source discard-reconcile reads the source again instead"
    : standing.is === "identity-changed"
      ? "source accept-identity, if the source is meant to be another one now"
      : "fix the cause, then source resume";
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
          ? `STOPPED since ${s.stoppedAt.toISOString()} (${s.stoppedError ?? "failed"}): ${stopAdvice(s)}`
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
        // Where it signs in: a passkey belongs to the address it was made at.
        p.rpId ?? "-",
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

/** Text from the catalog on one line of a terminal: no control characters. */
const oneLine = (text: string) => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ");

/** The text's characters, without the halves of a pair left alone (audit text must be whole). */
const wellFormed = (text: string) => [...text].filter((c) => !/^[\ud800-\udfff]$/.test(c));

/** The person a `review` command names; "none" or "ambiguous" with the reason said. */
async function reviewerNamed(
  db: Database,
  tenantId: string,
  named: string,
  io: AdminIo,
): Promise<User | "no-tenant" | "none" | "ambiguous"> {
  if (!(await db.withTenant(tenantId, (tx) => getTenant(tx, tenantId)))) {
    io.err(`no tenant ${tenantId}\n`);
    return "no-tenant";
  }
  const user = await namedUser(db, tenantId, named);
  if (user === "none" || user === "ambiguous") {
    io.err(
      user === "none"
        ? `tenant ${tenantId} has no user ${oneLine(named)}\n`
        : `${oneLine(named)} names more than one user: use the usr_… id\n`,
    );
  }
  return user;
}

/** The tenant's policies, compiled: what the server decides with (tools/context.ts). */
const authorizerOf = async (tx: Tx, tenantId: string) =>
  new Authorizer(createCedarEngine(await tenantPolicies(tx, tenantId)));

/** `review list`: the open items the person may decide, oldest first, one a line. */
async function reviewList(
  db: Database,
  config: Config,
  tenantId: string,
  named: string,
  limitArg: string | undefined,
  io: AdminIo,
): Promise<number> {
  const limit = limitArg === undefined ? 100 : Number(limitArg);
  if (!Number.isInteger(limit) || limit < 1 || limit > REVIEW_INBOX_MAX) {
    throw new UsageError(`--limit is 1 to ${REVIEW_INBOX_MAX}`);
  }
  const user = await reviewerNamed(db, tenantId, named, io);
  if (typeof user === "string") return 1;
  const reviewer = { userId: user.id, adminGroupId: adminGroupOf(config.auth)(tenantId) };
  let inbox;
  try {
    inbox = await db.withTenant(
      tenantId,
      async (tx) => reviewInbox(tx, tenantId, await authorizerOf(tx, tenantId), reviewer, limit),
      VIEW_TRANSACTION,
    );
  } catch (e) {
    if (!(e instanceof ReviewAccessError)) throw e;
    io.err(`${user.id} can't review: not a current user\n`);
    return 1;
  }
  for (const i of inbox.items) {
    io.out(
      [
        i.id,
        i.tag,
        i.reason,
        oneLine(i.appliedBy ?? i.source),
        i.confidence.toFixed(2),
        i.createdAt.toISOString(),
        i.admin ? "admin" : "-",
        i.objectId,
        oneLine(i.title),
      ].join("\t") + "\n",
    );
  }
  const who = oneLine(user.email ?? user.id);
  if (inbox.items.length === 0 && !inbox.capped) {
    io.err(`Nothing waits for ${who} to decide: no open item is on a file they may tag.\n`);
  } else if (inbox.more) {
    io.err(`More wait: decide some of these and list again.\n`);
  }
  if (inbox.capped) {
    io.err(
      `So many files have open items that not all were looked at for ${who}: there may be more that deciding these won't bring up.\n`,
    );
  }
  return 0;
}

/** `review approve | reject | merge`: the person's decision, checked as theirs, audited. */
async function reviewDecide(
  db: Database,
  config: Config,
  tenantId: string,
  named: string,
  reviewId: string,
  how: ReviewDecision,
  io: AdminIo,
): Promise<number> {
  const asked = {
    review: reviewId,
    asked: how.decision,
    ...(how.decision === "merge"
      ? { into: wellFormed(oneLine(how.into)).slice(0, 200).join("") }
      : {}),
  };
  const refused = async (detail: Record<string, string>, message?: string, object?: string) => {
    await db.withTenant(tenantId, (tx) =>
      appendAudit(tx, tenantId, {
        actor: ADMIN_ACTOR,
        action: "tag.review",
        decision: "deny",
        ...(object === undefined ? {} : { object }),
        detail: { ...asked, ...detail },
      }),
    );
    if (message !== undefined) io.err(`${message}\n`);
    return 1;
  };
  const user = await reviewerNamed(db, tenantId, named, io);
  if (user === "no-tenant") return 1;
  if (typeof user === "string") {
    return refused({ refusal: user === "none" ? "unknown-user" : "ambiguous-user" });
  }
  const who = oneLine(user.email ?? user.id);
  const reviewer = `user:${user.id}`;
  const adminGroupId = adminGroupOf(config.auth)(tenantId);
  const denied = (e: ReviewAccessError) =>
    refused(
      { reviewer, refusal: e.code },
      e.code === "refused"
        ? `${who} may not tag that file, so can't decide ${reviewId}`
        : e.code === "not-admin"
          ? `${who} isn't a tenant admin: ${e.message}`
          : e.code === "unknown-reviewer"
            ? `${user.id} can't review: not a current user`
            : `no open review item ${reviewId} that ${who} may decide`,
      e.objectId,
    );
  let item: ReviewItem;
  try {
    item = await db.withTenant(
      tenantId,
      async (tx) =>
        reviewItemFor(
          tx,
          tenantId,
          await authorizerOf(tx, tenantId),
          { userId: user.id, adminGroupId },
          reviewId,
          how,
        ),
      VIEW_TRANSACTION,
    );
  } catch (e) {
    if (!(e instanceof ReviewAccessError)) throw e;
    return denied(e);
  }
  let done;
  try {
    done = await retrying(() =>
      db.withTenant(tenantId, (tx) =>
        decideReview(
          tx,
          tenantId,
          { reviewId, userId: user.id, adminGroupId, actor: ADMIN_ACTOR },
          how,
        ),
      ),
    );
  } catch (e) {
    if (e instanceof ReviewAccessError) return denied(e);
    if (!(e instanceof TagError)) throw e;
    return refused({ reviewer, refusal: e.code }, oneLine(e.message), item.objectId);
  }
  const file = `"${oneLine(item.title)}" (${done.objectId})`;
  const off = done.replaced.length > 0 ? `, replacing ${done.replaced.join(", ")}` : "";
  io.err(
    how.decision === "reject"
      ? `Rejected ${done.tag} on ${file}, for ${who}${done.alsoClosed > 0 ? `; ${done.alsoClosed} other open items proposing the value closed with it` : ""}.\n`
      : item.reason === "primary"
        ? `Confirmed ${done.tag} as the home of ${file}, for ${who}.\n`
        : `${how.decision === "merge" ? `Merged ${done.tag} into` : "Approved"} ${done.applied ?? done.tag} on ${file}${off}, for ${who}: grants on the tag now count for the file.\n`,
  );
  io.out(`${reviewId}\n`);
  return 0;
}

/** `audit verify`: the tenant's whole chain, checked; `ok`, its length and head on stdout. */
async function auditVerify(db: Database, tenantId: string, io: AdminIo): Promise<number> {
  if (!(await db.withTenant(tenantId, (tx) => getTenant(tx, tenantId)))) {
    io.err(`no tenant ${tenantId}\n`);
    return 1;
  }
  const result = await verifyAudit(db, tenantId);
  if (!result.ok) {
    io.out(`failed\t${result.count}\t${result.seq}\n`);
    io.err(
      `The audit chain of ${tenantId} does not verify at event ${result.seq}: ${oneLine(result.problem)}. ` +
        `The ${result.count} events before it check out; nothing from it on can be trusted as written.\n`,
    );
    return 1;
  }
  io.out(`ok\t${result.count}\t${result.head}\n`);
  io.err(
    result.count === 0
      ? `The audit chain of ${tenantId} is empty.\n`
      : `The audit chain of ${tenantId} verifies: ${result.count} events, every hash and link. ` +
          `Keep the head hash where the database's owner can't write: a chain cut short or rewritten whole verifies too.\n`,
  );
  return 0;
}

/** An export goes out in pieces of about this many characters. */
const EXPORT_CHUNK = 64 * 1024;

interface ExportArgs {
  format: ExportFormat;
  out: string | undefined;
  filter: AuditFilter;
  /** The filter as given, for the audit record. */
  asked: Record<string, string>;
}

/** A time for `--from` / `--to`: a date (UTC) or a full ISO 8601 time with its zone. */
function timeArg(value: string, flag: string): Date {
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
  const m = iso.exec(value);
  const at = m ? new Date(value) : new Date(Number.NaN);
  // A day the month doesn't have, or hour 24, is read as a later one: refused, not shifted.
  const [, y, mo, d, h = "00"] = m ?? [];
  const day = m ? new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))) : at;
  const real =
    Number.isFinite(at.getTime()) &&
    day.getUTCMonth() === Number(mo) - 1 &&
    day.getUTCDate() === Number(d) &&
    Number(h) < 24 &&
    at.getUTCFullYear() >= 1970 &&
    at.getUTCFullYear() <= 9999;
  if (!real) {
    throw new UsageError(
      `${flag} is a date (2026-10-01, UTC) or a time with its zone (2026-10-01T09:30:00Z)`,
    );
  }
  return at;
}

/** `audit export`'s options, checked. */
function exportArgs(values: {
  format?: string | undefined;
  out?: string | undefined;
  actor?: string | undefined;
  action?: string | undefined;
  decision?: string | undefined;
  client?: string | undefined;
  object?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}): ExportArgs {
  const format = values.format ?? "ndjson";
  if (format !== "ndjson" && format !== "csv") throw new UsageError("--format is ndjson or csv");
  const { decision } = values;
  if (decision !== undefined && decision !== "allow" && decision !== "deny") {
    throw new UsageError("--decision is allow or deny");
  }
  if (values.out === "") throw new UsageError("--out is a file's path");
  const filter: AuditFilter = {};
  const asked: Record<string, string> = {};
  for (const key of ["actor", "action", "client", "object"] as const) {
    const value = values[key];
    if (value === undefined) continue;
    // What the log can hold (core/audit store.ts): anything else matches nothing.
    const whole = wellFormed(value).join("") === value;
    if (value === "" || value.length > 1024 || !whole || value.includes("\0")) {
      throw new UsageError(`--${key} is not a value the audit log holds`);
    }
    filter[key] = value;
    asked[key] = value;
  }
  if (decision !== undefined) {
    filter.decision = decision;
    asked.decision = decision;
  }
  for (const key of ["from", "to"] as const) {
    const value = values[key];
    if (value === undefined) continue;
    filter[key] = timeArg(value, `--${key}`);
    asked[key] = (filter[key] as Date).toISOString();
  }
  if (filter.from && filter.to && filter.from >= filter.to) {
    throw new UsageError("--from must be before --to");
  }
  return { format, out: values.out, filter, asked };
}

/** `audit export`: the tenant's events, filtered, to stdout or a new file; then audited. */
async function auditExport(
  db: Database,
  tenantId: string,
  args: ExportArgs,
  io: AdminIo,
): Promise<number> {
  if (!(await db.withTenant(tenantId, (tx) => getTenant(tx, tenantId)))) {
    io.err(`no tenant ${tenantId}\n`);
    return 1;
  }
  let fd: number | undefined;
  const path = args.out === undefined ? undefined : resolve(io.cwd ?? process.cwd(), args.out);
  if (path !== undefined) {
    try {
      // A new file, its owner's alone: never over one that exists.
      fd = openSync(path, "wx", 0o600);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      io.err(
        code === "EEXIST"
          ? `${path} exists: an export is written to a new file\n`
          : `cannot write ${path}: ${code ?? (e as Error).message}\n`,
      );
      return 1;
    }
  }
  // Written in pieces of some size, each awaited: a slow reader slows the export.
  const file = fd;
  const deliver =
    file !== undefined
      ? // (Until every byte is written: one write may take only part.)
        (text: string) => writeFileSync(file, text)
      : (io.write ?? ((text: string) => Promise.resolve(io.out(text))));
  let sunk = 0;
  let header = args.format === "csv";
  let pending = "";
  const record = (incomplete: boolean) =>
    db.withTenant(tenantId, (tx) =>
      appendAudit(tx, tenantId, {
        actor: ADMIN_ACTOR,
        action: "audit.export",
        decision: "allow",
        detail: {
          format: args.format,
          events: sunk,
          ...(incomplete ? { incomplete: true } : {}),
          ...args.asked,
        },
      }),
    );
  let failure: unknown;
  try {
    await exportAudit(db, tenantId, args.filter, args.format, async (chunk) => {
      pending += chunk;
      // (A CSV's first line is its header, not an event.)
      if (header) header = false;
      else sunk++;
      if (pending.length < EXPORT_CHUNK) return;
      const text = pending;
      pending = "";
      await deliver(text);
    });
    if (pending !== "") await deliver(pending);
  } catch (e) {
    failure = e ?? new Error("the export failed");
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch (e) {
        failure ??= e;
      }
    }
  }
  const remove = () => {
    if (path === undefined) return;
    try {
      unlinkSync(path);
    } catch {
      // Gone already, or not ours to remove: the message says what happened.
    }
  };
  const said = (e: unknown) => oneLine(e instanceof Error ? e.message : String(e));
  if (failure !== undefined) {
    // No file left that looks like an export; what got out is recorded as taken.
    remove();
    const code = (failure as NodeJS.ErrnoException).code;
    io.err(
      code === "EPIPE" || code === "ERR_STREAM_DESTROYED"
        ? `The reader stopped: the export of ${tenantId} is incomplete (up to ${sunk} events).\n`
        : `The export of ${tenantId} failed, incomplete (up to ${sunk} events): ${said(failure)}\n`,
    );
    try {
      await record(true);
    } catch (e) {
      io.err(`And it could not be recorded in the audit log: ${said(e)}\n`);
    }
    return 1;
  }
  // After the export, so the record isn't in it: the next one shows this one was taken.
  try {
    await record(false);
  } catch (e) {
    // An export nobody can see was taken is not left lying about.
    remove();
    io.err(
      `The export of ${tenantId} could not be recorded in the audit log: ${said(e)}\n` +
        (path === undefined
          ? `What was written to standard output is an export the log doesn't show.\n`
          : `${path} was removed.\n`),
    );
    return 1;
  }
  const written = sunk;
  io.err(
    `Exported ${written} audit event${written === 1 ? "" : "s"} of ${tenantId} as ${args.format}` +
      `${path === undefined ? "" : ` to ${path}`}.\n`,
  );
  return 0;
}

interface HealthArgs {
  format: "text" | "csv";
  out: string | undefined;
  options: HealthOptions & { limit: number };
}

/** The byte order mark: what tells a spreadsheet a file is UTF-8. */
const UTF8_MARK = String.fromCharCode(0xfeff);

/** `health report`'s options, checked. */
function healthArgs(values: {
  format?: string | undefined;
  out?: string | undefined;
  limit?: string | undefined;
  "stale-days"?: string | undefined;
  "large-mb"?: string | undefined;
}): HealthArgs {
  const format = values.format ?? "text";
  if (format !== "text" && format !== "csv") throw new UsageError("--format is text or csv");
  if (values.out === "") throw new UsageError("--out is a file's path");
  const whole = (flag: string, value: string | undefined, min: number, max: number) => {
    if (value === undefined) return undefined;
    const n = /^\d{1,9}$/.test(value) ? Number(value) : Number.NaN;
    if (!(n >= min && n <= max))
      throw new UsageError(`${flag} is a whole number, ${min} to ${max}`);
    return n;
  };
  const staleAfterDays = whole("--stale-days", values["stale-days"], 1, 36_500);
  const largeMb = whole("--large-mb", values["large-mb"], 1, 1_000_000);
  return {
    format,
    out: values.out,
    options: {
      // A page shows a few files a finding; a sheet has them all, as far as one read goes.
      limit: whole("--limit", values.limit, 1, 10_000) ?? (format === "text" ? 10 : 10_000),
      ...(staleAfterDays === undefined ? {} : { staleAfterDays }),
      ...(largeMb === undefined ? {} : { largeBytes: largeMb * 1024 * 1024 }),
    },
  };
}

/** `health report`: the tenant's File Health Report, for one of its admins; audited. */
async function healthCommand(
  db: Database,
  config: Config,
  tenantId: string,
  named: string,
  args: HealthArgs,
  io: AdminIo,
): Promise<number> {
  const tenant = await db.withTenant(tenantId, (tx) => getTenant(tx, tenantId));
  if (!tenant) {
    io.err(`no tenant ${tenantId}\n`);
    return 1;
  }
  const audit = (decision: "allow" | "deny", detail: Record<string, string | number>) =>
    db.withTenant(tenantId, (tx) =>
      appendAudit(tx, tenantId, {
        actor: ADMIN_ACTOR,
        action: "health.report",
        decision,
        detail: { format: args.format, ...detail },
      }),
    );
  const user = await namedUser(db, tenantId, named);
  if (user === "none" || user === "ambiguous") {
    await audit("deny", { refusal: user === "none" ? "unknown-user" : "ambiguous-user" });
    io.err(
      user === "none"
        ? `tenant ${tenantId} has no user ${oneLine(named)}\n`
        : `${oneLine(named)} names more than one user: use the usr_… id\n`,
    );
    return 1;
  }
  const reader = `user:${user.id}`;
  // The file first: a report nobody can be handed isn't read, or recorded as read. A new
  // file, its owner's alone where the system has file modes, never over one that exists.
  const path = args.out === undefined ? undefined : resolve(io.cwd ?? process.cwd(), args.out);
  let fd: number | undefined;
  if (path !== undefined) {
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      io.err(
        code === "EEXIST"
          ? `${path} exists: a report is written to a new file\n`
          : `cannot write ${path}: ${code ?? oneLine((e as Error).message)}\n`,
      );
      return 1;
    }
  }
  /** Closes the file, and removes it unless the report is in it whole. */
  const finish = (whole: boolean) => {
    if (fd === undefined || path === undefined) return;
    const file = fd;
    fd = undefined;
    let closed = true;
    try {
      closeSync(file);
    } catch {
      closed = false;
    }
    if (whole && closed) return;
    try {
      unlinkSync(path);
    } catch {
      // Gone already, or not ours to remove.
    }
    if (whole) throw new Error(`cannot finish writing ${path}`);
  };
  try {
    let report: HealthReport;
    try {
      report = await db.withTenant(
        tenantId,
        (tx) =>
          healthReport(
            tx,
            tenantId,
            { userId: user.id, adminGroupId: adminGroupOf(config.auth)(tenantId) },
            args.options,
          ),
        VIEW_TRANSACTION,
      );
    } catch (e) {
      if (!(e instanceof HealthError)) throw e;
      finish(false);
      await audit("deny", { reader, refusal: e.code });
      io.err(
        e.code === "not-admin"
          ? `${oneLine(user.email ?? user.id)} isn't a tenant admin: the report names every file by its title, so it is an admin's to read (admin user grant-admin makes one)\n`
          : `${e.message}\n`,
      );
      return 1;
    }
    const text =
      args.format === "csv"
        ? healthCsv(report)
        : healthText(report, { tenant: tenant.name, show: args.options.limit });

    // Recorded before it is handed over: a report that was read is in the log, whatever
    // becomes of the writing of it.
    const counts = Object.fromEntries(HEALTH_SECTIONS.map((s) => [s, report.sections[s].count]));
    await audit("allow", { reader, files: report.files, ...counts });

    try {
      if (fd === undefined) {
        await (io.write ?? ((chunk: string) => Promise.resolve(io.out(chunk))))(text);
      } else {
        // (A sheet opened by a double click is read as UTF-8 only when it says so.)
        writeFileSync(fd, args.format === "csv" ? `${UTF8_MARK}${text}` : text);
        finish(true);
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      io.err(
        code === "EPIPE" || code === "ERR_STREAM_DESTROYED"
          ? `The reader stopped: the report is incomplete.\n`
          : `cannot write the report${path === undefined ? "" : ` to ${path}`}: ${code ?? oneLine((e as Error).message)}\n`,
      );
      return 1;
    }
    if (args.format === "csv") {
      const rows = HEALTH_SECTIONS.reduce((n, s) => n + report.sections[s].items.length, 0);
      io.err(
        `File health report of ${tenantId}: ${rows} ${rows === 1 ? "row" : "rows"}` +
          `${path === undefined ? "" : ` in ${path}`}.\n`,
      );
      for (const { section, missing } of healthCsvCut(report)) {
        io.err(
          `${section} lists its first ${report.sections[section].items.length}: ${missing} more aren't in the sheet.\n`,
        );
      }
    } else if (path !== undefined) {
      io.err(`File health report of ${tenantId} written to ${path}.\n`);
    }
    return 0;
  } finally {
    // Whatever went wrong on the way: no file left that isn't the report.
    finish(false);
  }
}
