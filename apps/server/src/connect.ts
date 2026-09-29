import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { getTenant, isId } from "@openhoard/core-db";
import { openAdminDatabase, signInLink } from "./admin.js";
import { type Config } from "./config.js";
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
 * (keeping everything else in it, and the previous file as `.bak`), and issues a one-time
 * sign-in link (60 minutes) for the folders' owner, audited as the admin command is. Running it
 * again changes nothing that is already right, and issues a new link.
 */

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
    const text: unknown = JSON.parse(readFileSync(configFile, "utf8"));
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
  const claudeExists = existsSync(claudeFile);
  if (claudeExists) {
    try {
      const text = readFileSync(claudeFile, "utf8");
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

    // 1. The client approved in OpenHoard's config.
    const auth = isObject(raw.auth) ? raw.auth : {};
    const clients = Array.isArray(auth.clients) ? (auth.clients as unknown[]) : [];
    const approved = clients.some(
      (c) =>
        isObject(c) &&
        c.tenantId === tenantId &&
        Array.isArray(c.redirectUris) &&
        c.redirectUris.length === 1 &&
        c.redirectUris[0] === MCP_REMOTE_REDIRECT,
    );
    if (approved) {
      io.err(`Claude Desktop is approved for tenant ${tenantId} already.\n`);
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
      try {
        config = soloConfig(dataDir, io);
      } catch (e) {
        writeFileAtomic(configFile, previous);
        io.err(`${(e as Error).message}\n(${configFile} is back as it was.)\n`);
        return 1;
      }
      io.err(
        `Approved Claude Desktop (mcp-remote) for tenant ${tenantId} in ${configFile}, as ` +
          `commercial: what Claude reads goes to Anthropic.\n`,
      );
    }

    // 2. OpenHoard in Claude Desktop's config.
    const publicUrl = config.auth?.publicUrl ?? SOLO_PUBLIC_URL;
    const server = claudeDesktopServer(publicUrl);
    const servers = isObject(claude.mcpServers) ? claude.mcpServers : {};
    const before = servers.openhoard;
    if (JSON.stringify(before) === JSON.stringify(server)) {
      io.err(`Claude Desktop's config has OpenHoard already (${claudeFile}).\n`);
    } else {
      mkdirSync(dirname(claudeFile), { recursive: true });
      if (claudeExists) copyFileSync(claudeFile, `${claudeFile}.bak`);
      const next = { ...claude, mcpServers: { ...servers, openhoard: server } };
      // Not owner-only: Claude Desktop's file holds no secret of ours, and is the user's own.
      writeFileAtomic(claudeFile, JSON.stringify(next, null, 2) + "\n", 0o644);
      io.err(
        (before === undefined
          ? `Added OpenHoard to Claude Desktop's config (${claudeFile})`
          : `Replaced the "openhoard" server in Claude Desktop's config (${claudeFile}), which ` +
            `ran something else`) +
          (claudeExists ? `; the previous file is ${claudeFile}.bak.\n` : `.\n`),
      );
    }

    // 3. A sign-in link (audited as `admin user sign-in-link`), on standard output.
    const code = await signInLink(db, config, { tenant: tenantId, user, minutes: "60" }, io);
    if (code !== 0) return code;
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
