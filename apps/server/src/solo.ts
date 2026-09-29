import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { appendAudit } from "@openhoard/core-audit";
import { APPLY_TRANSACTION, PackError, planPack } from "@openhoard/core-catalog";
import { createTenant, getTenant, newId, type Database, type Tx } from "@openhoard/core-db";
import {
  createUser,
  findUserByEmail,
  grantAdmin,
  IdentityError,
  listUsers,
} from "@openhoard/core-identity";
import {
  ADMIN_ACTOR,
  applyPackAudited,
  openAdminDatabase,
  packPlanText,
  type AdminIo,
} from "./admin.js";
import { ConfigSchema, loadConfig } from "./config.js";
import { pinFolder, type Run } from "./pin.js";
import { retrying } from "./retry.js";

/*
 * `init --solo` (T-1201): one person on one machine, from nothing to a configured server with
 * one folder or more, in one command, without an identity provider, SCIM or hand-written JSON.
 *
 *   init --solo [--folder <path>]… [--name <display name>] [--email <email>] [--no-extract]
 *               [--data-dir <dir>]
 *
 * In one run it creates a tenant (named after the person), the person (a local member), makes
 * them its admin, applies the starter pack (packs/general-business), and writes
 * <dataDir>/config.json: sign-in links on, one fs source per folder owned by the person, and
 * Claude (Haiku) for summaries. The command itself is the consent to the pack: it is applied
 * without a second prompt, and every change it made is printed, each loosening marked `!`.
 *
 * Only on the embedded database (PGlite), whose lock keeps the server and a second run out.
 * All the database work is one transaction, so it happens entirely or not at all; config.json is
 * created last, never over one made meanwhile. If writing it fails, the tenant stays: running `init --solo` again picks it up,
 * but only when that is unambiguous (the data directory holds exactly that one tenant, of the
 * same name, with nobody in it but that person). Anything else is refused with what to do.
 * Changes are audited as `system:admin-cli`, as the admin commands audit them.
 */

/** Where the solo commands keep their data unless told otherwise: the OS's app-data folder. */
export function defaultDataDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  const p = pathFor(platform);
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    return p.join(
      local && p.isAbsolute(local) ? local : p.join(home, "AppData", "Local"),
      "OpenHoard",
    );
  }
  if (platform === "darwin") return p.join(home, "Library", "Application Support", "OpenHoard");
  const xdg = env.XDG_DATA_HOME;
  // The XDG spec: a relative value is invalid and must be ignored.
  return p.join(xdg && p.isAbsolute(xdg) ? xdg : p.join(home, ".local", "share"), "openhoard");
}

/** The path functions for an OS: Windows' on win32, POSIX elsewhere. */
export function pathFor(platform: NodeJS.Platform): typeof win32 {
  return platform === "win32" ? win32 : posix;
}

export interface SoloIo extends AdminIo {
  /** The operating system the paths are for (tests); default process.platform. */
  platform?: NodeJS.Platform;
  /** The person's home folder (tests); default os.homedir(). */
  home?: string;
  /** The OS user name, the default display name (tests); default os.userInfo().username. */
  username?: string;
  /** How the person runs this entry point, for the next commands printed (`node …/main.js`). */
  command?: string;
  /** Runs the program that pins a folder (pin.ts; tests). */
  run?: Run;
}

/**
 * The data directory a solo command uses: `--data-dir`, else OPENHOARD_DATA_DIR, else the OS's
 * app-data folder (defaultDataDir()). The server's own default (`.openhoard` in the working
 * directory) stays as it was, so existing setups keep working; the commands printed carry
 * `--data-dir`.
 */
export function soloDataDir(flag: string | undefined, io: SoloIo): string {
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();
  if (flag !== undefined && flag !== "") return resolve(cwd, flag);
  if (env.OPENHOARD_DATA_DIR) return resolve(cwd, env.OPENHOARD_DATA_DIR);
  return defaultDataDir(io.platform ?? process.platform, env, io.home ?? homedir());
}

/** The config the server would load from `dataDir`, with the environment's overrides. */
export function soloConfig(dataDir: string, io: SoloIo) {
  return loadConfig({ ...(io.env ?? process.env), OPENHOARD_DATA_DIR: dataDir }, io.cwd);
}

/** A command line to run this entry point with the data directory, for the person to copy. */
export function commandLine(io: SoloIo, dataDir: string, rest: string): string {
  const self = io.command ?? "openhoard";
  return `${self} --data-dir "${dataDir}"${rest === "" ? "" : ` ${rest}`}`;
}

/**
 * The file a write to `file` should land in: `file` itself, or, when it is a symbolic link, the
 * file it points to, so that replacing it keeps the link (a dotfiles repository, say). A link to
 * nothing is refused rather than replaced.
 */
function writeTarget(file: string): { path: string; mode: number | null } {
  let link: boolean;
  try {
    link = lstatSync(file).isSymbolicLink();
  } catch {
    return { path: file, mode: null }; // No file yet.
  }
  let path = file;
  if (link) {
    try {
      path = realpathSync.native(file);
    } catch (e) {
      throw new Error(`${file} is a link to a file that doesn't exist`, { cause: e });
    }
  }
  return { path, mode: statSync(path).mode & 0o777 };
}

/** A temporary file's name beside `file`, unique to this process and moment. */
const tempBeside = (file: string) =>
  `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;

/** A file written in full, owner-only where the OS has mode bits. */
function writeTemp(temp: string, text: string, mode: number): void {
  writeFileSync(temp, text, { mode, flag: "wx" });
  if (process.platform !== "win32") chmodSync(temp, mode);
}

/**
 * renameSync, tried again a few times on EPERM, EBUSY or EACCES: on Windows another program
 * (an antivirus scan, a sync client, an editor) briefly holding the target makes a rename fail.
 */
function renameRetrying(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 5 || !(code === "EPERM" || code === "EBUSY" || code === "EACCES")) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt);
    }
  }
}

/**
 * Writes a file in one step: a temporary file beside it, then renamed over it, so a reader sees
 * the old content or the new, never half. A file that exists keeps its mode, and a symbolic link
 * keeps pointing where it did (the file it points to is the one replaced); a new file is
 * owner-only (`mode`, 0600) where the OS has mode bits. On Windows the file inherits the
 * folder's ACL (the user profile's).
 */
export function writeFileAtomic(file: string, text: string, mode = 0o600): void {
  const target = writeTarget(file);
  const temp = tempBeside(target.path);
  try {
    writeTemp(temp, text, target.mode ?? mode);
    renameRetrying(temp, target.path);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
}

/**
 * Creates a file that doesn't exist yet, whole, owner-only: written to a temporary file, then
 * hard-linked to its name, which fails (EEXIST, thrown) if something made it meanwhile. Nothing
 * is overwritten. Where the file system has no hard links, an exclusive create instead.
 */
export function createFileExclusive(file: string, text: string, mode = 0o600): void {
  const temp = tempBeside(file);
  try {
    writeTemp(temp, text, mode);
    try {
      linkSync(temp, file);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "ENOSYS") throw e;
      writeFileSync(file, text, { mode, flag: "wx" });
    }
  } finally {
    rmSync(temp, { force: true });
  }
}

/** The reserved address a solo owner gets without `--email` (RFC 2606's `.invalid`). */
export const PLACEHOLDER_EMAIL = "owner@solo.openhoard.invalid";

/** Summaries by Claude: the key comes from OPENHOARD_MODEL_CLAUDE_API_KEY, never the file. */
export const CLAUDE_KEY_ENV = "OPENHOARD_MODEL_CLAUDE_API_KEY";

/** Where the server listens in a solo setup by default: this machine only, as links require. */
export const SOLO_PUBLIC_URL = "http://127.0.0.1:7420";

/**
 * The starter pack, where a clone keeps it: this module is apps/server/src or apps/server/dist,
 * and packs/ is at the repository's root, three folders up. Only there: never a pack.json some
 * folder further up happens to hold. (A packaged `openhoard` will bring its own copy.)
 */
export function findStarterPack(from = dirname(fileURLToPath(import.meta.url))): string | null {
  const file = resolve(from, "..", "..", "..", "packs", "general-business", "pack.json");
  return existsSync(file) ? file : null;
}

/**
 * The public URL for a server listening on `host`:`port` on this machine: an IPv6 loopback
 * address in brackets. Null for port 0 (a port chosen at start, which no link can name).
 */
export function soloPublicUrl(host: string, port: number): string | null {
  if (port === 0) return null;
  const name = host === "::1" ? "[::1]" : host;
  return `http://${name}:${port}`;
}

/** A source id from a folder's name: `fs-` and a lower-case slug, unique among `taken`. */
export function sourceId(folder: string, taken: ReadonlySet<string>): string {
  const slug =
    basename(folder)
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-._]+|[-._]+$/g, "")
      .slice(0, 50)
      .replace(/[-._]+$/, "") || "folder";
  let id = `fs-${slug}`;
  for (let n = 2; taken.has(id); n++) id = `fs-${slug}-${n}`;
  return id;
}

/** Whether `inner` is `outer` or inside it (case-insensitively where the file system is). */
function within(outer: string, inner: string, platform: NodeJS.Platform): boolean {
  const fold = platform === "linux" ? (x: string) => x : (x: string) => x.toLowerCase();
  const rel = relative(fold(outer), fold(inner));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const USAGE = `usage: openhoard init --solo [options]

  One person on this machine: creates a tenant and you (its admin), applies the starter pack,
  and writes config.json with your folders, sign-in links and Claude for summaries.

  --folder <path>        a folder to index (repeatable; default: <home>/OpenHoard, made if missing)
  --name <display name>  your name (default: your OS user name)
  --email <email>        your email (default: ${PLACEHOLDER_EMAIL}, which receives nothing)
  --no-extract           index names and metadata only: no text, no summaries
  --no-pin               don't pin the folders where Save dialogs show them (Quick Access on
                         Windows, a GTK bookmark on Linux)
  --data-dir <dir>       where OpenHoard keeps its data (default: the OS's app-data folder;
                         OPENHOARD_DATA_DIR also sets it)
`;

/** Runs `init --solo`; returns the exit code (0 done, 1 failed, 2 misused). */
export async function runInit(argv: readonly string[], io: SoloIo): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      allowPositionals: false,
      allowNegative: true,
      strict: true,
      options: {
        solo: { type: "boolean" },
        folder: { type: "string", multiple: true },
        name: { type: "string" },
        email: { type: "string" },
        extract: { type: "boolean", default: true },
        pin: { type: "boolean", default: true },
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
  if (values.solo !== true) {
    io.err(`init needs --solo: it is the only setup it makes so far\n\n${USAGE}`);
    return 2;
  }
  const platform = io.platform ?? process.platform;
  const home = io.home ?? homedir();
  const cwd = io.cwd ?? process.cwd();
  const env = io.env ?? process.env;

  const dataDir = soloDataDir(values["data-dir"], io);
  const configFile = join(dataDir, "config.json");
  if (existsSync(configFile)) {
    io.err(
      `${configFile} exists already: this data directory is set up. To add a folder, add an ` +
        `entry to its "sources" and restart the server (docs/dogfood.md); to start afresh, use ` +
        `another --data-dir (or move this one away).\n`,
    );
    return 1;
  }

  const name = (values.name ?? safeUsername(io) ?? "").trim() || "Owner";
  const email = (values.email ?? PLACEHOLDER_EMAIL).trim();
  const extract = values.extract;

  // The folders: absolute, existing directories, none inside another.
  const given = values.folder ?? [];
  const folders: string[] = [];
  if (given.length === 0) {
    const folder = join(home, "OpenHoard");
    try {
      mkdirSync(folder, { recursive: true });
    } catch (e) {
      io.err(`cannot make the folder ${folder}: ${(e as Error).message}\n`);
      return 1;
    }
    folders.push(folder);
  } else {
    // Each as written, and as the file system resolves it (links, junctions, mapped drives), so
    // one folder named two ways is still one.
    const real: string[] = [];
    for (const f of given) {
      const folder = resolve(cwd, f);
      let dir = false;
      try {
        dir = statSync(folder).isDirectory();
      } catch {
        // Said below.
      }
      if (!dir) {
        io.err(
          `${folder} isn't a folder on this machine` +
            (f.startsWith("~")
              ? ` (a "~" in quotes isn't your home folder: write the path out)`
              : "") +
            `\n`,
        );
        return 1;
      }
      const resolved = realpathSync.native(folder);
      const clash = folders.findIndex(
        (other, i) =>
          within(other, folder, platform) ||
          within(folder, other, platform) ||
          within(real[i] as string, resolved, platform) ||
          within(resolved, real[i] as string, platform),
      );
      if (clash !== -1) {
        io.err(
          `${folder} and ${folders[clash] as string} are one folder, or one is inside the ` +
            `other (links included): name one\n`,
        );
        return 1;
      }
      folders.push(folder);
      real.push(resolved);
    }
  }

  const pack = findStarterPack();
  let packJson: unknown;
  try {
    if (pack === null) throw new Error("packs/general-business/pack.json isn't beside this server");
    packJson = JSON.parse(readFileSync(pack, "utf8"));
  } catch (e) {
    io.err(`cannot read the starter pack: ${(e as Error).message}\n`);
    return 1;
  }

  // The database, as the server would open it (refused while the server holds it). Only the
  // embedded one: its lock keeps a running server and a second init out, and config.json has no
  // database URL. A shared PostgreSQL is for a team, set up by hand.
  let config;
  try {
    config = soloConfig(dataDir, io);
  } catch (e) {
    io.err(`${(e as Error).message}\n`);
    return 1;
  }
  if (config.database.url !== "pglite") {
    io.err(
      `init --solo sets up the embedded database only, and OPENHOARD_DATABASE_URL names ` +
        `another one: unset it to use the embedded database, or set PostgreSQL up by hand ` +
        `(docs/dogfood.md, "Manual setup").\n`,
    );
    return 1;
  }
  const publicUrl = soloPublicUrl(config.host, config.port);
  if (publicUrl === null) {
    io.err(`OPENHOARD_PORT is 0: a sign-in link needs a fixed port. Set another, or unset it.\n`);
    return 1;
  }
  const db = await openAdminDatabase(config, io);
  if (db === null) return 1;

  try {
    // A fresh data directory, or the one tenant an earlier run left before its config.
    const existing = await soloTenant(db, name, email);
    if (typeof existing === "object" && "refused" in existing) {
      io.err(existing.refused);
      return 1;
    }
    const tenantId = existing ?? newId("tenant");

    // The config, checked before anything is written: a folder around the data directory, or an
    // environment that can't have sign-in links, fails now, with nothing made.
    const file = soloConfigFile(tenantId, folders, email, extract, publicUrl);
    const checked = ConfigSchema.safeParse({
      ...file,
      dataDir,
      host: config.host,
      port: config.port,
    });
    if (!checked.success) {
      const issues = checked.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      );
      io.err(`this setup wouldn't be a valid config:\n  ${issues.join("\n  ")}\n`);
      return 1;
    }

    if (existing !== undefined) {
      io.err(
        `Picking up tenant ${tenantId} (${name}), which an earlier init --solo made before it ` +
          `could write config.json.\n`,
      );
    }
    let applied;
    try {
      // What it did is said once it is committed, not in each try.
      applied = await retrying(() =>
        db.withTenant(
          tenantId,
          (tx) => setUp(tx, tenantId, existing === undefined, name, email, packJson),
          APPLY_TRANSACTION,
        ),
      );
    } catch (e) {
      if (e instanceof IdentityError) {
        io.err(
          e.code === "invalid" && /email/.test(e.message)
            ? `${email} isn't a usable email address\n`
            : `cannot set you up: ${e.message}\n`,
        );
        return 1;
      }
      if (e instanceof PackError) {
        io.err(`the starter pack can't be applied: ${e.message}\n`);
        return 1;
      }
      if (e instanceof TypeError && /tenant's name/.test(e.message)) {
        io.err(`--name: ${e.message}\n`);
        return 1;
      }
      throw e;
    }
    io.err(applied);

    // config.json, last: created whole, never over one made meanwhile, then loaded as the
    // server will load it.
    let created = false;
    try {
      createFileExclusive(configFile, JSON.stringify(file, null, 2) + "\n");
      created = true;
      soloConfig(dataDir, io);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        io.err(
          `${configFile} appeared while this ran (another init --solo?), so it was left as it ` +
            `is. Tenant ${tenantId} is set up in the database; if that config isn't for it, ` +
            `start afresh with another --data-dir.\n`,
        );
        return 1;
      }
      if (created) rmSync(configFile, { force: true });
      io.err(
        `Tenant ${tenantId} is set up in the database, but config.json couldn't be written: ` +
          `${(e as Error).message}\nFix that, then run the same init --solo again: it picks up ` +
          `this tenant.\n`,
      );
      return 1;
    }

    // Where Save dialogs show them (T-1204): a convenience, never a reason to fail.
    const pinned: string[] = [];
    if (values.pin) {
      for (const folder of folders) {
        const result = await pinFolder(folder, {
          platform,
          home,
          env,
          ...(io.run === undefined ? {} : { run: io.run }),
        });
        pinned.push(result.note);
      }
    }
    io.out(`${tenantId}\n`);
    io.err(
      summary(io, { dataDir, tenantId, name, email, folders: file.sources, platform, env, pinned }),
    );
    return 0;
  } catch (e) {
    io.err(`${(e as Error).message}\n`);
    return 1;
  } finally {
    await db.close();
  }
}

function safeUsername(io: SoloIo): string | undefined {
  if (io.username !== undefined) return io.username;
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

/**
 * The tenant an earlier, unfinished `init --solo` left (its id), undefined for an empty data
 * directory, or a refusal saying what to do instead.
 */
async function soloTenant(
  db: Database,
  name: string,
  email: string,
): Promise<string | undefined | { refused: string }> {
  const ids = await db.tenantIds({ limit: 2 });
  if (ids.length === 0) return undefined;
  const manual =
    `Set this data directory up by hand instead (docs/dogfood.md, "Manual setup"), or use ` +
    `another --data-dir for a fresh start.\n`;
  if (ids.length > 1) {
    return {
      refused:
        `This data directory's database holds several tenants already, and no config.json: ` +
        `init --solo sets up an empty one. ${manual}`,
    };
  }
  const tenantId = ids[0] as string;
  const found = await db.withTenant(tenantId, async (tx) => {
    const tenant = await getTenant(tx, tenantId);
    const people = await listUsers(tx, tenantId, {}, { limit: 2 });
    const owner = await findUserByEmail(tx, tenantId, email);
    return { tenant, people, owner };
  });
  const listed = `  node …/main.js --data-dir <dir> admin tenant list\n`;
  if (
    found.tenant?.name !== name.trim() ||
    found.people.total > 1 ||
    (found.people.total === 1 && found.owner === null)
  ) {
    return {
      refused:
        `This data directory's database holds tenant ${tenantId} (${found.tenant?.name ?? "?"}) ` +
        `already, and no config.json, and it isn't one init --solo left for ${name} <${email}>: ` +
        `it won't guess. If it is yours, run init --solo again with the same --name and ` +
        `--email as the first time; to see it:\n${listed}${manual}`,
    };
  }
  return tenantId;
}

/**
 * Everything in the database, in the caller's (serializable) transaction: the tenant (when
 * new), the person, their admin role, the starter pack. Returns what to print after.
 */
async function setUp(
  tx: Tx,
  tenantId: string,
  fresh: boolean,
  name: string,
  email: string,
  pack: unknown,
): Promise<string> {
  const lines: string[] = [];
  if (fresh) {
    const made = await createTenant(tx, tenantId, { name });
    await appendAudit(tx, tenantId, {
      actor: ADMIN_ACTOR,
      action: "tenant.create",
      decision: "allow",
      detail: { name: made.name },
    });
    lines.push(`Created tenant ${tenantId} (${made.name}).`);
  }
  let user = await findUserByEmail(tx, tenantId, email);
  if (user === null) {
    user = await createUser(tx, tenantId, { email, displayName: name, source: "local" });
    await appendAudit(tx, tenantId, {
      actor: ADMIN_ACTOR,
      action: "user.create",
      decision: "allow",
      detail: { user: user.id, source: "local" },
    });
    lines.push(`Created you: ${user.displayName} <${email}> (${user.id}).`);
  }
  const granted = await grantAdmin(tx, tenantId, user.id, ADMIN_ACTOR);
  await appendAudit(tx, tenantId, {
    actor: ADMIN_ACTOR,
    action: "admin.grant",
    decision: "allow",
    detail: { user: user.id, ...(granted ? {} : { unchanged: true }) },
  });
  lines.push(granted ? `You are its admin.` : `You were its admin already.`);

  const plan = await planPack(tx, tenantId, pack);
  if (plan.changes.length === 0 && plan.previous === plan.version) {
    lines.push(`The starter pack ${plan.name} ${plan.version} is applied already.`);
    return lines.join("\n") + "\n";
  }
  // Running init --solo is the consent to the pack; every change it made is shown.
  const applied = await applyPackAudited(tx, tenantId, pack, plan.planHash);
  return (
    lines.join("\n") +
    "\n" +
    `The starter pack makes files discoverable and lets their content reach commercial AI ` +
    `(Claude); "!" marks a loosening:\n` +
    packPlanText("Applied", applied) +
    `(plan ${applied.planHash})\n`
  );
}

/** config.json for a solo setup (what is written: the server fills in the defaults). */
export function soloConfigFile(
  tenantId: string,
  folders: readonly string[],
  owner: string,
  extract: boolean,
  publicUrl = SOLO_PUBLIC_URL,
) {
  const ids = new Set<string>();
  const zones = new Set<string>();
  const sources = folders.map((root) => {
    const id = sourceId(root, ids);
    ids.add(id);
    const base = basename(root) || root;
    let zone = base;
    for (let n = 2; zones.has(zone); n++) zone = `${base} (${n})`;
    zones.add(zone);
    return { id, connector: "fs" as const, tenantId, root, zone, owner, extract };
  });
  return {
    auth: { publicUrl, signInLinks: true },
    sources,
    models: {
      providers: [{ id: "claude", kind: "commercial" as const, adapter: "anthropic" as const }],
      dailyTokenBudget: 2_000_000,
    },
  };
}

function summary(
  io: SoloIo,
  s: {
    dataDir: string;
    tenantId: string;
    name: string;
    email: string;
    folders: readonly { id: string; root: string; zone: string; extract: boolean }[];
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    pinned: readonly string[];
  },
): string {
  const keySet = Boolean(s.env[CLAUDE_KEY_ENV]);
  const keyHow =
    s.platform === "win32"
      ? `    [Environment]::SetEnvironmentVariable("${CLAUDE_KEY_ENV}", "<your key>", "User")\n` +
        `  in PowerShell, then open a new window to start the server from.`
      : `    export ${CLAUDE_KEY_ENV}=<your key>\n` +
        `  in the shell that starts the server; to keep it, add that line to ` +
        `${s.platform === "darwin" ? "~/.zshrc" : "~/.profile"} (readable by you only).`;
  return [
    ``,
    `OpenHoard is set up for ${s.name} <${s.email}>${s.email === PLACEHOLDER_EMAIL ? " (a placeholder address: it receives nothing)" : ""}.`,
    `  tenant:   ${s.tenantId}`,
    `  data:     ${s.dataDir} (config.json, the database and keys: back it up whole)`,
    ...s.folders.map(
      (f) =>
        `  folder:   ${f.root} (source ${f.id}, zone "${f.zone}"${f.extract ? "" : ", names and metadata only"})`,
    ),
    ...s.pinned.map((note) => `  saving:   ${note}`),
    keySet
      ? `  Claude:   ${CLAUDE_KEY_ENV} is set: summaries will run.`
      : `  Claude:   ${CLAUDE_KEY_ENV} isn't set: the server starts without it, with no ` +
        `summaries (search still works by keywords). For summaries, set it to your Anthropic ` +
        `API key, in the environment only, never in config.json, and restart the server:\n` +
        keyHow,
    ``,
    `Next, connect Claude Desktop, then start the server:`,
    `  ${commandLine(io, s.dataDir, "connect claude-desktop")}`,
    `  ${commandLine(io, s.dataDir, "")}`,
    ``,
  ].join("\n");
}

/**
 * Which solo command the server's arguments name, and where, when it is the first one that
 * isn't an option (`--data-dir x init --solo` too): `init` or `connect`.
 */
export function soloArgument(
  args: readonly string[],
): { command: "init" | "connect"; at: number } | undefined {
  const { tokens } = parseArgs({
    args: [...args],
    options: { "data-dir": { type: "string" } },
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  const first = tokens.find((t) => t.kind === "positional");
  if (first?.kind !== "positional") return undefined;
  return first.value === "init" || first.value === "connect"
    ? { command: first.value, at: first.index }
    : undefined;
}
