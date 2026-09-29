import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAudit } from "@openhoard/core-audit";
import { openDatabase, type Database } from "@openhoard/core-db";
import { openTestDatabase, TEST_POSTGRES_ENV } from "@openhoard/core-db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  claudeDesktopConfigPath,
  claudeDesktopServer,
  MCP_REMOTE_NOTE,
  MCP_REMOTE_REDIRECT,
  runConnect,
} from "./connect.js";
import { runInit, soloArgument, type SoloIo } from "./solo.js";

/*
 * T-1202: `connect claude-desktop` approves Claude Desktop's bridge, merges OpenHoard into
 * Claude Desktop's config and issues a sign-in link, with nothing edited by hand.
 */

const postgres = process.env[TEST_POSTGRES_ENV] !== undefined;

let root: string;
let dir: string;
let home: string;
let claudeFile: string;
let shared: Database | undefined;
beforeEach(async () => {
  // The long form: a Windows runner's temp folder is an 8.3 short path (C:\Users\RUNNER~1\…).
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "oh-connect-")));
  dir = join(root, "data");
  home = join(root, "home");
  mkdirSync(home);
  claudeFile = join(root, "claude", "claude_desktop_config.json");
  shared = postgres ? await openTestDatabase() : undefined;
});
afterEach(async () => {
  await shared?.close();
  rmSync(root, { recursive: true, force: true });
});

function io(extra: Partial<SoloIo> = {}) {
  const seen = { out: "", err: "" };
  const value: SoloIo = {
    env: {},
    home,
    username: "steve",
    platform: "linux",
    cwd: root,
    out: (s) => void (seen.out += s),
    err: (s) => void (seen.err += s),
    ...(shared ? { open: async () => ({ ...(shared as Database), close: async () => {} }) } : {}),
    ...extra,
  };
  return { io: value, seen };
}

async function connect(...argv: string[]) {
  const { io: value, seen } = io();
  const code = await runConnect(["claude-desktop", "--data-dir", dir, ...argv], value);
  return { code, ...seen };
}

async function initSolo(): Promise<string> {
  const { io: value, seen } = io();
  expect(await runInit(["--solo", "--data-dir", dir, "--name", "Steve"], value), seen.err).toBe(0);
  return seen.out.trim();
}

interface Server {
  command: string;
  args: string[];
}
interface Written {
  auth: { signInLinks: boolean; clients: object[] };
  sources: object[];
  mcpServers: Record<string, Server>;
  globalShortcut?: string;
}
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Written;

describe("connect helpers", () => {
  it("finds connect as the first positional argument", () => {
    expect(soloArgument(["--data-dir", "/x", "connect", "claude-desktop"])).toEqual({
      command: "connect",
      at: 2,
    });
  });

  it("knows where Claude Desktop keeps its config, and that Linux has none", () => {
    expect(
      claudeDesktopConfigPath("win32", { APPDATA: "C:\\Users\\s\\AppData\\Roaming" }, "C:\\x"),
    ).toBe("C:\\Users\\s\\AppData\\Roaming\\Claude\\claude_desktop_config.json");
    expect(claudeDesktopConfigPath("darwin", {}, "/Users/s")).toBe(
      "/Users/s/Library/Application Support/Claude/claude_desktop_config.json",
    );
    expect(claudeDesktopConfigPath("linux", {}, "/home/s")).toBeNull();
  });

  it("bridges with mcp-remote on this machine, as docs/dogfood.md says", () => {
    expect(claudeDesktopServer("http://127.0.0.1:7420")).toEqual({
      command: "npx",
      args: [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:7420/mcp",
        "33418",
        "--host",
        "127.0.0.1",
        "--allow-http",
      ],
    });
  });
});

describe(
  "connect claude-desktop",
  { timeout: process.platform === "win32" ? 600_000 : 180_000 },
  () => {
    it("approves the client once, merges Claude's config keeping the rest, and issues a link", async () => {
      const tenantId = await initSolo();
      mkdirSync(join(root, "claude"));
      const before = {
        globalShortcut: "Ctrl+Space",
        mcpServers: { other: { command: "other-server", args: ["--x"] } },
      };
      writeFileSync(claudeFile, JSON.stringify(before));

      const res = await connect("--claude-config", claudeFile);
      expect(res.code, res.err).toBe(0);
      expect(res.out).toMatch(
        new RegExp(
          `^http://127\\.0\\.0\\.1:7420/auth/link\\?token=ohl\\.${tenantId}\\.sil_\\S+\\n$`,
        ),
      );
      expect(res.err).toContain("Approved Claude Desktop");
      expect(res.err).toContain("Added OpenHoard to Claude Desktop's config");
      expect(res.err).toContain("Start the server");
      expect(res.err).toContain("press Allow");
      expect(res.err).toContain("trusts every program on this computer");

      // OpenHoard's config: the client added, everything else kept, and it loads.
      const config = readJson(join(dir, "config.json"));
      expect(config.auth.clients).toEqual([
        {
          tenantId,
          redirectUris: [MCP_REMOTE_REDIRECT],
          trust: "commercial",
          note: MCP_REMOTE_NOTE,
        },
      ]);
      expect(config.auth.signInLinks).toBe(true);
      expect(config.sources).toHaveLength(1);
      expect(loadConfig({ OPENHOARD_DATA_DIR: dir }).auth?.clients).toHaveLength(1);

      // Claude's config: merged, the previous file kept as .bak.
      const claude = readJson(claudeFile);
      expect(claude.globalShortcut).toBe("Ctrl+Space");
      expect(claude.mcpServers.other).toEqual(before.mcpServers.other);
      expect(claude.mcpServers.openhoard).toEqual(claudeDesktopServer("http://127.0.0.1:7420"));
      expect(readJson(`${claudeFile}.bak`)).toEqual(before);

      // Again: nothing to change, a new link.
      const again = await connect("--claude-config", claudeFile);
      expect(again.code, again.err).toBe(0);
      expect(again.err).toContain("approved for tenant");
      expect(again.err).toContain("has OpenHoard already");
      expect(again.out).not.toBe(res.out);
      expect(readJson(join(dir, "config.json")).auth.clients).toHaveLength(1);
      expect(readJson(`${claudeFile}.bak`)).toEqual(before);

      // An openhoard entry that runs something else is replaced, and said.
      writeFileSync(
        claudeFile,
        JSON.stringify({ mcpServers: { openhoard: { command: "old", args: [] } } }),
      );
      const replaced = await connect("--claude-config", claudeFile);
      expect(replaced.code, replaced.err).toBe(0);
      expect(replaced.err).toContain(`Replaced the "openhoard" server`);
      expect(readJson(claudeFile).mcpServers.openhoard?.command).toBe("npx");
      // The first backup stays: the original, never a later, already-merged file.
      expect(replaced.err).toContain("(the first backup) is kept as it was");
      expect(readJson(`${claudeFile}.bak`)).toEqual(before);

      // The links were audited as the admin command's are, without the token.
      const events = await (async () => {
        const read = async (db: Database) => {
          const lines: string[] = [];
          await exportAudit(db, tenantId, {}, "ndjson", (s: string) => void lines.push(s));
          return lines.join("");
        };
        if (shared) return read(shared);
        const db = await openDatabase({ url: "pglite", dataDir: dir });
        try {
          return await read(db);
        } finally {
          await db.close();
        }
      })();
      expect(events.match(/"sign-in-link\.issue"/g)).toHaveLength(3);
      expect(events).toContain('"actor":"system:admin-cli"');
      expect(events).not.toContain(res.out.trim().split("token=")[1]);
      // The approval, once (the runs after found it there).
      expect(events.match(/"oauth-client\.approve"/g)).toHaveLength(1);
      expect(events).toContain('"trust":"commercial"');
    });

    it.skipIf(process.platform === "win32")(
      "writes through a linked Claude config, keeping its mode",
      async () => {
        await initSolo();
        mkdirSync(join(root, "claude"));
        const real = join(root, "dotfiles.json");
        const secret = { mcpServers: { gh: { command: "gh", env: { GITHUB_TOKEN: "ghp_x" } } } };
        writeFileSync(real, JSON.stringify(secret), { mode: 0o600 });
        chmodSync(real, 0o600);
        symlinkSync(real, claudeFile);
        const res = await connect("--claude-config", claudeFile);
        expect(res.code, res.err).toBe(0);
        expect(lstatSync(claudeFile).isSymbolicLink()).toBe(true);
        expect(statSync(real).mode & 0o777).toBe(0o600);
        expect(readJson(real).mcpServers.gh).toEqual(secret.mcpServers.gh);
        expect(readJson(real).mcpServers.openhoard?.command).toBe("npx");
        expect(statSync(`${claudeFile}.bak`).mode & 0o777).toBe(0o600);
      },
    );

    it("writes a new Claude config owner-only", async () => {
      await initSolo();
      expect((await connect("--claude-config", claudeFile)).code).toBe(0);
      if (process.platform !== "win32") expect(statSync(claudeFile).mode & 0o777).toBe(0o600);
    });

    it("reads both configs through a byte order mark", async () => {
      await initSolo();
      const bom = String.fromCharCode(0xfeff);
      const ours = join(dir, "config.json");
      writeFileSync(ours, bom + readFileSync(ours, "utf8"));
      mkdirSync(join(root, "claude"));
      writeFileSync(claudeFile, bom + JSON.stringify({ mcpServers: { other: { command: "o" } } }));
      expect(loadConfig({ OPENHOARD_DATA_DIR: dir }).sources).toHaveLength(1);
      const res = await connect("--claude-config", claudeFile);
      expect(res.code, res.err).toBe(0);
      expect(Object.keys(readJson(claudeFile).mcpServers)).toEqual(["other", "openhoard"]);
    });

    it("refuses an approval of the same redirect with another trust, changing nothing", async () => {
      const tenantId = await initSolo();
      const ours = join(dir, "config.json");
      const config = readJson(ours) as unknown as Record<string, Record<string, unknown>>;
      (config.auth as Record<string, unknown>).clients = [
        { tenantId, redirectUris: [MCP_REMOTE_REDIRECT], trust: "local" },
      ];
      writeFileSync(ours, JSON.stringify(config));
      const before = readFileSync(ours, "utf8");
      const res = await connect("--claude-config", claudeFile);
      expect(res.code).toBe(1);
      expect(res.err).toContain(`trust "local", not "commercial"`);
      expect(readFileSync(ours, "utf8")).toBe(before);
      expect(existsSync(claudeFile)).toBe(false);
      expect(res.out).toBe("");
    });

    it("puts both files back when a later step fails", async () => {
      const tenantId = await initSolo();
      mkdirSync(join(root, "claude"));
      const claudeBefore = JSON.stringify({ mcpServers: { other: { command: "o" } } });
      writeFileSync(claudeFile, claudeBefore);
      const oursBefore = readFileSync(join(dir, "config.json"), "utf8");
      // The link can't be issued: the owner the folders name doesn't exist.
      const res = await connect("--claude-config", claudeFile, "--user", "nobody@example.com");
      expect(res.code).toBe(1);
      expect(res.err).toContain("Nothing was changed");
      expect(res.out).toBe("");
      expect(readFileSync(claudeFile, "utf8")).toBe(claudeBefore);
      expect(existsSync(`${claudeFile}.bak`)).toBe(false);
      expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(oursBefore);
      // Not audited as approved.
      const db = shared ?? (await openDatabase({ url: "pglite", dataDir: dir }));
      try {
        const lines: string[] = [];
        await exportAudit(db, tenantId, {}, "ndjson", (s: string) => void lines.push(s));
        expect(lines.join("")).not.toContain("oauth-client.approve");
      } finally {
        if (!shared) await db.close();
      }
      // With no Claude config before, none is left after.
      rmSync(claudeFile);
      const fresh = await connect("--claude-config", claudeFile, "--user", "nobody@example.com");
      expect(fresh.code).toBe(1);
      expect(existsSync(claudeFile)).toBe(false);
    });

    it("writes a new Claude config where there is none", async () => {
      await initSolo();
      const res = await connect("--claude-config", claudeFile);
      expect(res.code, res.err).toBe(0);
      expect(Object.keys(readJson(claudeFile).mcpServers)).toEqual(["openhoard"]);
      expect(existsSync(`${claudeFile}.bak`)).toBe(false);
    });

    it("refuses a Claude config that isn't valid JSON, changing nothing", async () => {
      await initSolo();
      mkdirSync(join(root, "claude"));
      writeFileSync(claudeFile, "{ not json");
      const before = readFileSync(join(dir, "config.json"), "utf8");
      const res = await connect("--claude-config", claudeFile);
      expect(res.code).toBe(1);
      expect(res.err).toContain("isn't valid JSON");
      expect(readFileSync(claudeFile, "utf8")).toBe("{ not json");
      expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(before);
      expect(res.out).toBe("");
      writeFileSync(claudeFile, "[]");
      expect((await connect("--claude-config", claudeFile)).code).toBe(1);
    });

    it("needs --claude-config on Linux, init --solo first, and one tenant", async () => {
      const none = await connect("--claude-config", claudeFile);
      expect(none.code).toBe(1);
      expect(none.err).toContain("init --solo");

      await initSolo();
      const linux = await connect();
      expect(linux.code).toBe(2);
      expect(linux.err).toContain("--claude-config");
      expect(existsSync(claudeFile)).toBe(false);

      // Found where Claude Desktop keeps it, on macOS.
      const mac = io({ platform: "darwin" });
      expect(await runConnect(["claude-desktop", "--data-dir", dir], mac.io), mac.seen.err).toBe(0);
      expect(
        existsSync(
          join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
        ),
      ).toBe(true);

      // A tenant no folder names: whose link isn't known, and then it doesn't exist.
      const other = ["--claude-config", claudeFile, "--tenant", "ten_" + "0".repeat(26)];
      const nobody = await connect(...other);
      expect(nobody.code).toBe(2);
      expect(nobody.err).toContain("--user");
      const unknown = await connect(...other, "--user", "a@b.example");
      expect(unknown.code).toBe(1);
      expect(unknown.err).toContain("no tenant");
      expect(readJson(join(dir, "config.json")).auth.clients).toHaveLength(1);

      const { io: value, seen } = io();
      expect(await runConnect(["cursor", "--data-dir", dir], value)).toBe(2);
      expect(seen.err).toContain("claude-desktop is the only client");
      expect(
        await runConnect(["claude-desktop", "--tenant", "nope", "--data-dir", dir], value),
      ).toBe(2);
      expect(await runConnect(["--help"], value)).toBe(0);
    });

    it.skipIf(postgres)("refuses while the server holds the embedded database", async () => {
      await initSolo();
      const before = readFileSync(join(dir, "config.json"), "utf8");
      const server = await openDatabase({ url: "pglite", dataDir: dir });
      try {
        const res = await connect("--claude-config", claudeFile);
        expect(res.code).toBe(1);
        expect(res.err).toMatch(/in use, most likely by the running OpenHoard server/);
      } finally {
        await server.close();
      }
      expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(before);
      expect(existsSync(claudeFile)).toBe(false);
    });
  },
);
