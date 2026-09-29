import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { appendAudit } from "@openhoard/core-audit";
import { getTenant, isId, type Database } from "@openhoard/core-db";
import { ADMIN_ACTOR, openAdminDatabase, signInLink } from "./admin.js";
import { stripBom, type Config } from "./config.js";
import {
  commandLine,
  pathFor,
  SOLO_PUBLIC_URL,
  soloConfig,
  soloDataDir,
  writeFileAtomic,
  type SoloIo,
} from "./solo.js";

/*
 * `connect claude-desktop` (T-1202): Claude Desktop reaches this server with no config edited
 * by hand.
 *
 *   connect claude-desktop [--tenant ten_…] [--user <usr_…|email>] [--claude-config <file>]
 *                          [--data-dir <dir>]
 *
 * It approves Claude Desktop's bridge (mcp-remote) for the tenant in the server's config.json
 * (`auth.clients`, trust `commercial`), adds the `openhoard` server to Claude Desktop's config
 * (keeping everything else in it, and the first previous file as `.bak`), and issues a one-time
 * sign-in link (60 minutes) for the folders' owner, audited as the admin command is. The
 * approval is audited `oauth-client.approve` as `system:admin-cli`. If any step fails, the
 * files written before it are put back. Running it again changes nothing that is already right,
 * and issues a new link.
 */

/** Records the config approval (or its refusal) in the tenant's audit log. */
async function audit(
  db: Database,
  tenantId: string,
  decision: "allow" | "deny",
  detail: Record<string, string>,
): Promise<void> {
  await db.withTenant(tenantId, (tx) =>
    appendAudit(tx, tenantId, {
      actor: ADMIN_ACTOR,
      action: "oauth-client.approve",
      decision,
      detail,
    }),
  );
}

/** The approved client entry for Claude Desktop through mcp-remote (docs/dogfood.md). */
export const MCP_REMOTE_REDIRECT = "http://127.0.0.1/oauth/callback";
export const MCP_REMOTE_NOTE = "Claude Desktop through mcp-remote";

/** The `openhoard` server in Claude Desktop's config: mcp-remote, bridged on this machine. */
export function claudeDesktopServer(publicUrl: string) {
  return {
    command: "npx",
    args: [
      "-y",
      "mcp-remote",
      new URL("/mcp", publicUrl).href,
      "33418",
      "--host",
      "127.0.0.1",
      "--allow-http",
    ],
  };
}

/** Claude Desktop's config file on this OS, or null where it has none (Linux). */
export function claudeDesktopConfigPath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string | null {
  const p = pathFor(platform);
  if (platform === "win32") {
    const roaming = env.APPDATA;
    return p.join(
      roaming && p.isAbsolute(roaming) ? roaming : p.join(home, "AppData", "Roaming"),
      "Claude",
      "claude_desktop_config.json",
    );
  }
  if (platform === "darwin") {
    return p.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return null;
}

const USAGE = `usage: openhoard connect claude-desktop [options]

  Approves Claude Desktop for your tenant, adds OpenHoard to Claude Desktop's config, and
  prints a one-time sign-in link. Run init --solo first.

  --tenant <ten_…>        the tenant (needed only when config.json's folders name several)
  --user <usr_…|email>    who signs in (default: the folders' owner)
  --claude-config <file>  Claude Desktop's config file (default: where Claude Desktop keeps it;
                          required on Linux, which has no official Claude Desktop)
  --data-dir <dir>        OpenHoard's data directory (as for init --solo)
`;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Runs `connect <client>`; returns the exit code (0 done, 1 failed, 2 misused). */
export async function runConnect(argv: readonly string[], io: SoloIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        tenant: { type: "string" },
        user: { type: "string" },
        "claude-config": { type: "string" },
        "data-dir": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    io.err(USAGE);
    return 0;
  }
  if (positionals.join(" ") !== "claude-desktop") {
    io.err(
      `${positionals.length === 0 ? "connect what?" : `can't connect ${positionals.join(" ")}`}: ` +
        `claude-desktop is the only client so far\n\n${USAGE}`,
    );
    return 2;
  }
  const platform = io.platform ?? process.platform;
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();

  // OpenHoard's config: made by init --solo, valid now.
  const dataDir = soloDataDir(values["data-dir"], io);
  const configFile = join(dataDir, "config.json");
  if (!existsSync(configFile)) {
    io.err(
      `${configFile} doesn't exist: set up OpenHoard first with\n` +
        `  ${commandLine(io, dataDir, "init --solo")}\n`,
    );
    return 1;
  }
  let config: Config;
  let raw: Json;
  try {
    config = soloConfig(dataDir, io);
    const text: unknown = JSON.parse(stripBom(readFileSync(configFile, "utf8")));
    if (!isObject(text)) throw new Error(`${configFile} isn't a JSON object`);
    raw = text;
  } catch (e) {
    io.err(`${(e as Error).message}\n`);
    return 1;
  }
  if (config.auth?.signInLinks !== true) {
    io.err(
      `${configFile} has no auth.signInLinks: connect claude-desktop is for a server set up ` +
        `with init --solo. Set up the client by hand instead (docs/dogfood.md, "Manual setup").\n`,
    );
    return 1;
  }

  // The tenant: --tenant, or the one the folders name.
  const tenants = [...new Set(config.sources.map((s) => s.tenantId))];
  let tenantId: string;
  if (values.tenant !== undefined) {
    if (!isId("tenant", values.tenant)) {
      io.err(`not a tenant id: ${values.tenant}\n\n${USAGE}`);
      return 2;
    }
    tenantId = values.tenant;
  } else if (tenants.length === 1) {
    tenantId = tenants[0] as string;
  } else {
    io.err(
      tenants.length === 0
        ? `${configFile} has no folders (sources), so no tenant: name one with --tenant\n`
        : `${configFile}'s folders are in several tenants (${tenants.join(", ")}): name one with --tenant\n`,
    );
    return 2;
  }
  // Who signs in: --user, or the one owner of the tenant's folders.
  const owners = [
    ...new Set(config.sources.filter((s) => s.tenantId === tenantId).map((s) => s.owner)),
  ];
  const user = values.user ?? (owners.length === 1 ? owners[0] : undefined);
  if (user === undefined) {
    io.err(
      owners.length === 0
        ? `no folder of tenant ${tenantId} names an owner: say who signs in with --user\n`
        : `tenant ${tenantId}'s folders have several owners (${owners.join(", ")}): say who signs in with --user\n`,
    );
    return 2;
  }

  // Claude Desktop's config: found, and JSON we can merge into (never clobbered).
  const claudeFile =
    values["claude-config"] !== undefined
      ? resolve(cwd, values["claude-config"])
      : claudeDesktopConfigPath(platform, env, io.home ?? homedir());
  if (claudeFile === null) {
    io.err(
      `Claude Desktop has no official Linux version, so there is no config file to find: name ` +
        `the file to write with --claude-config <file>\n`,
    );
    return 2;
  }
  let claude: Json = {};
  // The file as it was (null: none), to put back if a later step fails.
  let claudeText: string | null = null;
  if (existsSync(claudeFile)) {
    try {
      claudeText = readFileSync(claudeFile, "utf8");
      const text = stripBom(claudeText);
      const read: unknown = text.trim() === "" ? {} : JSON.parse(text);
      if (!isObject(read)) throw new Error("it isn't a JSON object");
      if (read.mcpServers !== undefined && !isObject(read.mcpServers)) {
        throw new Error("its mcpServers isn't a JSON object");
      }
      claude = read;
    } catch (e) {
      io.err(
        `${claudeFile} isn't valid JSON (${(e as Error).message}), so it was left as it is: fix ` +
          `it (or move it away), then run this again.\n`,
      );
      return 1;
    }
  }

  // The database, now: refused while the server holds it, before anything is written.
  const db = await openAdminDatabase(config, io);
  if (db === null) return 1;
  try {
    // Nothing is written for a tenant that doesn't exist (a mistyped --tenant).
    if (!(await db.withTenant(tenantId, (tx) => getTenant(tx, tenantId)))) {
      io.err(`no tenant ${tenantId}\n`);
      return 1;
    }

    // The approval there is already, if any: only as commercial, never relabelled here.
    const auth = isObject(raw.auth) ? raw.auth : {};
    const clients = Array.isArray(auth.clients) ? (auth.clients as unknown[]) : [];
    const listed = clients.find(
      (c): c is Json =>
        isObject(c) &&
        c.tenantId === tenantId &&
        Array.isArray(c.redirectUris) &&
        c.redirectUris.length === 1 &&
        c.redirectUris[0] === MCP_REMOTE_REDIRECT,
    );
    if (listed !== undefined && listed.trust !== "commercial") {
      await audit(db, tenantId, "deny", { reason: "trust-differs", trust: String(listed.trust) });
      io.err(
        `${configFile} approves ${MCP_REMOTE_REDIRECT} for tenant ${tenantId} already, with ` +
          `trust "${String(listed.trust)}", not "commercial": Claude sends what it reads to ` +
          `Anthropic, so it is commercial. Change or remove that entry yourself, then run this ` +
          `again; nothing was changed.\n`,
      );
      return 1;
    }

    // What is written, to put back if a later step fails: nothing is left half done (above
    // all, not the approval, which trusts every program on this computer).
    const undo: (() => void)[] = [];
    const rollBack = () => {
      for (const step of undo.reverse()) {
        try {
          step();
        } catch (e) {
          io.err(`could not put a file back as it was: ${(e as Error).message}\n`);
        }
      }
    };
    try {
      // 1. OpenHoard in Claude Desktop's config.
      const publicUrl = config.auth?.publicUrl ?? SOLO_PUBLIC_URL;
      const server = claudeDesktopServer(publicUrl);
      const servers = isObject(claude.mcpServers) ? claude.mcpServers : {};
      const before = servers.openhoard;
      let claudeSaid: string;
      if (JSON.stringify(before) === JSON.stringify(server)) {
        claudeSaid = `Claude Desktop's config has OpenHoard already (${claudeFile}).\n`;
      } else {
        mkdirSync(dirname(claudeFile), { recursive: true });
        // The first backup is kept: a later run never overwrites it with an already-merged file.
        const bak = `${claudeFile}.bak`;
        const madeBak = claudeText !== null && !existsSync(bak);
        if (madeBak) {
          copyFileSync(claudeFile, bak, constants.COPYFILE_EXCL);
          undo.push(() => rmSync(bak, { force: true }));
        }
        const next = { ...claude, mcpServers: { ...servers, openhoard: server } };
        // Through a link to the real file, keeping its mode; owner-only when new (other MCP
        // servers' entries in it often carry tokens).
        writeFileAtomic(claudeFile, JSON.stringify(next, null, 2) + "\n");
        undo.push(() =>
          claudeText === null
            ? rmSync(claudeFile, { force: true })
            : writeFileAtomic(claudeFile, claudeText),
        );
        claudeSaid =
          (before === undefined
            ? `Added OpenHoard to Claude Desktop's config (${claudeFile})`
            : `Replaced the "openhoard" server in Claude Desktop's config (${claudeFile}), ` +
              `which ran something else`) +
          (madeBak
            ? `; the previous file is ${bak}.\n`
            : claudeText !== null
              ? `; ${bak} (the first backup) is kept as it was.\n`
              : `.\n`);
      }

      // 2. The client approved in OpenHoard's config (audited once all steps are done).
      let approvalSaid: string;
      let approvedNow = false;
      if (listed !== undefined) {
        approvalSaid = `Claude Desktop is approved for tenant ${tenantId} already.\n`;
      } else {
        const previous = readFileSync(configFile, "utf8");
        const next = {
          ...raw,
          auth: {
            ...auth,
            clients: [
              ...clients,
              {
                tenantId,
                redirectUris: [MCP_REMOTE_REDIRECT],
                trust: "commercial",
                note: MCP_REMOTE_NOTE,
              },
            ],
          },
        };
        writeFileAtomic(configFile, JSON.stringify(next, null, 2) + "\n");
        undo.push(() => writeFileAtomic(configFile, previous));
        config = soloConfig(dataDir, io);
        approvedNow = true;
        approvalSaid =
          `Approved Claude Desktop (mcp-remote) for tenant ${tenantId} in ${configFile}, as ` +
          `commercial: what Claude reads goes to Anthropic.\n`;
      }

      // 3. A sign-in link (audited as `admin user sign-in-link`), on standard output.
      // Held back, so what was done is said first, and a refusal after the undo.
      let linkOut = "";
      let linkErr = "";
      const code = await signInLink(
        db,
        config,
        { tenant: tenantId, user, minutes: "60" },
        { ...io, out: (s) => void (linkOut += s), err: (s) => void (linkErr += s) },
      );
      if (code !== 0) {
        rollBack();
        io.err(`${linkErr}Nothing was changed.\n`);
        return code;
      }
      if (approvedNow) {
        await audit(db, tenantId, "allow", {
          redirectUri: MCP_REMOTE_REDIRECT,
          trust: "commercial",
          via: "config",
        });
      }
      io.err(claudeSaid + approvalSaid + linkErr);
      io.out(linkOut);
    } catch (e) {
      rollBack();
      io.err(`${(e as Error).message}\nNothing was changed.\n`);
      return 1;
    }
  } catch (e) {
    io.err(`${(e as Error).message}\n`);
    return 1;
  } finally {
    await db.close();
  }

  io.err(
    [
      ``,
      `What's left, in this order:`,
      `  1. Start the server:  ${commandLine(io, dataDir, "")}`,
      `  2. Open the sign-in link above in your browser (within the hour) and press Sign in.`,
      `  3. Restart Claude Desktop (quit it fully, then open it again).`,
      `  4. A browser tab opens OpenHoard's consent page for mcp-remote: press Allow.`,
      ``,
      `This approval trusts every program on this computer: any local program can ask the same`,
      `way, and read your files as you once you press Allow. Allow only right after starting Claude Desktop.`,
      ``,
    ].join("\n"),
  );
  return 0;
}
