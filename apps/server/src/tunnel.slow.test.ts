import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAudit } from "@openhoard/core-audit";
import { invites, openDatabase, type Database } from "@openhoard/core-db";
import { openTestDatabase, TEST_POSTGRES_ENV } from "@openhoard/core-db/testing";
import {
  issueInvite,
  listPasskeys,
  listUsers,
  lockUser,
  newChallenge,
  registerPasskey,
  registrationOptions,
} from "@openhoard/core-identity";
import { SoftAuthenticator } from "@openhoard/core-identity/testing";
import { and, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { runInit, soloArgument } from "./solo.js";
import { runTunnel, type TunnelIo } from "./tunnel.js";

/*
 * T-1205: `tunnel` runs cloudflared beside the server, tells the server its public address for
 * that run, and prepares the person's way in. Both programs are stand-ins here: small node
 * scripts that behave as cloudflared and the server do towards the command.
 */

const postgres = process.env[TEST_POSTGRES_ENV] !== undefined;
// Each test sets a server up and starts programs, several times over: slow on a Windows runner.
vi.setConfig({ testTimeout: process.platform === "win32" ? 240_000 : 60_000 });
const QUICK = "https://quiet-river-1234.trycloudflare.com";

let root: string;
let dir: string;
let shared: Database | undefined;
let fakeTunnel: string;
let fakeServer: string;
let record: string;
beforeEach(async () => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "oh-tunnel-")));
  dir = join(root, "data");
  mkdirSync(join(root, "home"));
  shared = postgres ? await openTestDatabase() : undefined;
  record = join(root, "server.json");
  // cloudflared: logs to stderr, then stays until it is stopped. FAKE says how it behaves.
  fakeTunnel = join(root, "cloudflared.mjs");
  writeFileSync(
    fakeTunnel,
    `import { existsSync, writeFileSync } from "node:fs";
const mode = process.env.FAKE ?? "quick";
writeFileSync(process.env.FAKE_ARGS, JSON.stringify(process.argv.slice(2)));
const log = (s) => process.stderr.write(s);
log("2026-10-02T12:00:00Z INF Thank you for trying Cloudflare Tunnel.\\n");
const up = "INF Registered tunnel connection connIndex=0 location=den01\\n";
if (mode === "broken") { log("ERR Cannot determine default origin certificate path.\\n"); process.exit(1); }
if (mode === "no-service") { log('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: i/o timeout\\n'); setTimeout(() => process.exit(1), 300); }
if (mode === "quick" || mode === "stubborn") log("INF +-----+\\nINF |  ${QUICK}  |\\nINF +-----+\\n" + up);
if (mode === "crlf") log("INF |  ${QUICK}  |\\r\\n" + up.replace("\\n", "\\r\\n"));
if (mode === "unconnected") log("INF |  ${QUICK}  |\\n");
if (mode === "split") { log("INF |  https://quiet-riv"); setTimeout(() => log("er-1234.trycloudflare.com  |\\n" + up), 80); }
if (mode === "named") log(up);
// Dies once the server is up (its record is there), however long that takes on this machine.
if (mode === "dies") { log("INF |  ${QUICK}  |\\n" + up); setInterval(() => { if (existsSync(process.env.FAKE_RECORD)) { log("ERR lost the edge\\n"); process.exit(7); } }, 50); }
if (mode === "flash") process.stderr.write("INF |  ${QUICK}  |\\n" + up, () => process.exit(9));
if (mode === "stubborn") process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
  );
  // The server: records how it was started, then stays (or ends as FAKE_SERVER_EXIT says).
  fakeServer = join(root, "main.mjs");
  writeFileSync(
    fakeServer,
    `import { renameSync, writeFileSync } from "node:fs";
// Told to stop the way the real server is: the channel closes. (Listening before it says it
// is up, so a stop right then is still a clean one.)
process.on("disconnect", () => { writeFileSync(process.env.FAKE_RECORD + ".stopped", "clean"); process.exit(0); });
process.on("SIGTERM", () => {});
if (process.env.FAKE_SERVER_EXIT) setTimeout(() => process.exit(Number(process.env.FAKE_SERVER_EXIT)), 100);
else setInterval(() => {}, 1000);
// Whole or not there: written beside, then renamed.
writeFileSync(process.env.FAKE_RECORD + ".tmp", JSON.stringify({ args: process.argv.slice(2), url: process.env.OPENHOARD_TUNNEL_URL }));
renameSync(process.env.FAKE_RECORD + ".tmp", process.env.FAKE_RECORD);
`,
  );
});
afterEach(async () => {
  await shared?.close();
  // (Retried: on Windows a program that has just ended may still hold its folder for a moment.)
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

interface Run {
  code: Promise<number>;
  seen: { out: string; err: string };
  stop: () => void;
  /** Resolves once the server stand-in has started. */
  serving: () => Promise<{ args: string[]; url: string }>;
  pids: number[];
}

function tunnel(
  argv: string[] = [],
  env: Record<string, string> = {},
  extra: Partial<TunnelIo> = {},
): Run {
  const seen = { out: "", err: "" };
  const abort = new AbortController();
  const pids: number[] = [];
  const io: TunnelIo = {
    env: { FAKE_ARGS: join(root, "tunnel-args.json"), FAKE_RECORD: record, ...env },
    home: join(root, "home"),
    username: "steve",
    platform: "linux",
    cwd: root,
    self: fakeServer,
    startMs: 8000,
    stopMs: 1500,
    signal: abort.signal,
    out: (s) => void (seen.out += s),
    err: (s) => void (seen.err += s),
    // "cloudflared" is the stand-in script; the server is started as the command starts it.
    spawn: ((command: string, args: readonly string[], options: object) => {
      const child =
        command === "cloudflared"
          ? spawn(process.execPath, [fakeTunnel, ...args], {
              ...options,
              env: { ...process.env, ...io.env },
            })
          : spawn(command, args, {
              ...options,
              stdio: ["ignore", "ignore", "ignore", "ipc"],
              env: { ...process.env, ...(options as { env: NodeJS.ProcessEnv }).env },
            });
      if (child.pid !== undefined) pids.push(child.pid);
      return child;
    }) as unknown as typeof spawn,
    ...(shared ? { open: async () => ({ ...(shared as Database), close: async () => {} }) } : {}),
    ...extra,
  };
  const code = runTunnel(["--data-dir", dir, ...argv], io);
  const serving = async () => {
    // (Generous: a Windows runner starts programs slowly.)
    for (let i = 0; i < 2400 && !existsSync(record); i++)
      await new Promise((r) => setTimeout(r, 25));
    return JSON.parse(readFileSync(record, "utf8")) as { args: string[]; url: string };
  };
  return { code, seen, stop: () => abort.abort(), serving, pids };
}

/** Whether a process is still there. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function allGone(pids: number[]) {
  for (let i = 0; i < 200 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 25));
  return pids.every((p) => !alive(p));
}

async function initSolo(): Promise<void> {
  const seen = { err: "" };
  const code = await runInit(["--solo", "--data-dir", dir, "--name", "Steve"], {
    env: {},
    home: join(root, "home"),
    username: "steve",
    platform: "linux",
    cwd: root,
    out: () => {},
    err: (s) => void (seen.err += s),
    ...(shared ? { open: async () => ({ ...(shared as Database), close: async () => {} }) } : {}),
  });
  expect(code, seen.err).toBe(0);
}

/** The database the command wrote, for checking: reopened on PGlite. */
async function inspect<T>(work: (db: Database) => Promise<T>): Promise<T> {
  if (shared) return work(shared);
  const db = await openDatabase({ url: "pglite", dataDir: dir });
  try {
    return await work(db);
  } finally {
    await db.close();
  }
}

const solo = () =>
  inspect(async (db) => {
    const { tenantId } = loadConfig({ OPENHOARD_DATA_DIR: dir }).sources[0] as { tenantId: string };
    const people = await db.withTenant(tenantId, (tx) => listUsers(tx, tenantId, {}));
    return { tenantId, user: people.users[0] as { id: string; displayName: string } };
  });

async function audit(tenantId: string) {
  return inspect(async (db) => {
    const lines: string[] = [];
    await exportAudit(db, tenantId, {}, "ndjson", (s: string) => void lines.push(s));
    return lines
      .join("")
      .split("\n")
      .filter(Boolean)
      .map(
        (l) =>
          JSON.parse(l) as { action: string; decision: string; detail?: Record<string, unknown> },
      );
  });
}

describe("tunnel", () => {
  it("is a command of the entry point", () => {
    expect(soloArgument(["--data-dir", "/x", "tunnel", "--name", "t"])).toEqual({
      command: "tunnel",
      at: 2,
    });
  });

  it("opens a quick tunnel, tells the server its address, and prints an invite", async () => {
    await initSolo();
    const before = readFileSync(join(dir, "config.json"), "utf8");
    const run = tunnel();
    const server = await run.serving();
    expect(server).toEqual({ args: ["--data-dir", dir], url: QUICK });
    // cloudflared points at the server on this machine, and doesn't update itself under us.
    expect(JSON.parse(readFileSync(join(root, "tunnel-args.json"), "utf8"))).toEqual([
      "tunnel",
      "--no-autoupdate",
      "--url",
      "http://127.0.0.1:7420",
    ]);
    // The link alone on standard output; everything for the person on standard error.
    expect(run.seen.out).toMatch(
      /^https:\/\/quiet-river-1234\.trycloudflare\.com\/auth\/invite#ohi\.ten_\S+\n$/,
    );
    expect(run.seen.err).toContain(`OpenHoard is reachable at ${QUICK}`);
    expect(run.seen.err).toContain(`connector: ${QUICK}/mcp`);
    expect(run.seen.err).toContain("Steve has no passkey for this address yet");
    expect(run.seen.err).not.toContain("ohi.");

    run.stop();
    expect(await run.code).toBe(0);
    expect(await allGone(run.pids)).toBe(true);
    // The server was asked to stop, not killed: it had time to close its database.
    expect(readFileSync(`${record}.stopped`, "utf8")).toBe("clean");
    // Nothing is written to the config: without `tunnel` the server is local again.
    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(before);
    const { tenantId, user } = await solo();
    const events = (await audit(tenantId)).filter((e) => /^(tunnel|invite)\./.test(e.action));
    expect(events.map((e) => [e.action, e.detail?.address ?? e.detail?.user])).toEqual([
      ["tunnel.start", QUICK],
      ["invite.issue", user.id],
    ]);
    // A quick tunnel's invite lasts an hour: its address won't outlive the run.
    const until = Date.parse(events[1]?.detail?.expiresAt as string);
    expect(until - Date.now()).toBeGreaterThan(50 * 60_000);
    expect(until - Date.now()).toBeLessThanOrEqual(60 * 60_000 + 5000);
    expect(JSON.stringify(events)).not.toContain(run.seen.out.trim().split(".").at(-1));
  });

  it("reads an address that arrives in two pieces, or with Windows line ends", async () => {
    await initSolo();
    for (const FAKE of ["split", "crlf"]) {
      rmSync(record, { force: true });
      const run = tunnel([], { FAKE });
      expect([FAKE, (await run.serving()).url]).toEqual([FAKE, QUICK]);
      run.stop();
      expect(await run.code).toBe(0);
    }
  });

  it("takes no address from cloudflared's errors, and none before it is connected", async () => {
    await initSolo();
    // The quick-tunnel service unreachable: its own address is in the error, with a path.
    const refused = tunnel([], { FAKE: "no-service" });
    expect(await refused.code).toBe(1);
    expect(refused.seen.err).toContain("cloudflared stopped (exit 1)");
    expect(refused.seen.err).toContain("failed to request quick Tunnel");
    expect(refused.seen.err).not.toContain("OpenHoard is reachable");
    // An address printed, but no connection to the edge behind it.
    const waiting = tunnel([], { FAKE: "unconnected" }, { startMs: 500 });
    expect(await waiting.code).toBe(1);
    expect(waiting.seen.err).toContain("cloudflared didn't connect within");
    // Gone again at once: not announced. (However slowly this machine reports a program's end.)
    const flash = tunnel([], { FAKE: "flash" }, { settleMs: 5000 });
    expect(await flash.code).toBe(1);
    expect(flash.seen.err).not.toContain("OpenHoard is reachable");
    for (const run of [refused, waiting, flash]) {
      expect(run.seen.out).toBe("");
      expect(await allGone(run.pids)).toBe(true);
    }
    expect(existsSync(record)).toBe(false);
  });

  // (Windows has no signal to ignore: a stop there ends the program at once.)
  it.skipIf(process.platform === "win32")("ends a cloudflared that won't stop", async () => {
    await initSolo();
    const run = tunnel([], { FAKE: "stubborn", FAKE_SERVER_EXIT: "3" });
    expect(await run.code).toBe(3);
    expect(await allGone(run.pids)).toBe(true);
  });

  it("needs the server on this machine only", async () => {
    await initSolo();
    // With sign-in links on, the config itself refuses any other address.
    const links = tunnel([], { OPENHOARD_HOST: "0.0.0.0" });
    expect(await links.code).toBe(1);
    expect(links.seen.err).toContain("a server on this machine only");
    // Without them the config allows it (a server behind a proxy), but a tunnel doesn't.
    const file = join(dir, "config.json");
    const config = JSON.parse(readFileSync(file, "utf8")) as { auth: object };
    writeFileSync(
      file,
      JSON.stringify({
        ...config,
        host: "0.0.0.0",
        auth: { ...config.auth, publicUrl: "https://files.example.com", signInLinks: false },
      }),
    );
    const run = tunnel();
    expect(await run.code).toBe(1);
    expect(run.seen.err).toContain("listens on 0.0.0.0, not on this machine only");
    expect([...links.pids, ...run.pids]).toEqual([]);
  });

  it("runs a named tunnel at its host, and invites only until a passkey is made there", async () => {
    await initSolo();
    const { tenantId, user } = await solo();
    const flags = ["--name", "home", "--hostname", "Files.Example.com"];
    const first = tunnel(flags, { FAKE: "named" });
    expect((await first.serving()).url).toBe("https://files.example.com");
    expect(JSON.parse(readFileSync(join(root, "tunnel-args.json"), "utf8"))).toEqual([
      "tunnel",
      "--no-autoupdate",
      "run",
      "--url",
      "http://127.0.0.1:7420",
      "home",
    ]);
    expect(first.seen.err).toContain("through your tunnel home");
    first.stop();
    expect(await first.code).toBe(0);
    const link = first.seen.out.trim();
    expect(link).toMatch(/^https:\/\/files\.example\.com\/auth\/invite#ohi\./);

    // The server as that run configured it: the invite makes a passkey there, and one-time links
    // are off however the file has them.
    const device = new SoftAuthenticator();
    await inspect(async (db) => {
      const config = loadConfig({
        OPENHOARD_DATA_DIR: dir,
        OPENHOARD_TUNNEL_URL: "https://files.example.com",
      });
      expect(config.auth).toMatchObject({
        publicUrl: "https://files.example.com",
        signInLinks: false,
        passkeys: true,
      });
      const app = createApp({ ...config, uploads: undefined }, undefined, { db });
      expect((await app.request("/auth/link?token=x")).status).toBe(404);
      const token = link.split("#")[1];
      const headers = { "content-type": "application/json", origin: "https://files.example.com" };
      const options = await app.request("/auth/passkey/register/options", {
        method: "POST",
        headers,
        body: JSON.stringify({ invite: token }),
      });
      expect(options.status).toBe(200);
      const made = await app.request("/auth/passkey/register", {
        method: "POST",
        headers: {
          ...headers,
          cookie: (options.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "",
        },
        body: JSON.stringify({
          invite: token,
          response: device.create(
            (await options.json()) as Record<string, unknown>,
            "https://files.example.com",
          ),
        }),
      });
      expect(made.status).toBe(200);
      // And passkeys left at quick-tunnel addresses from earlier tries.
      for (const host of ["old-one.trycloudflare.com", "old-two.trycloudflare.com"]) {
        const challenge = newChallenge();
        await db.withTenant(tenantId, (tx) =>
          registerPasskey(tx, tenantId, {
            userId: user.id,
            response: new SoftAuthenticator().create(
              registrationOptions({
                rp: { id: host, name: "OpenHoard" },
                tenantId,
                user: { id: user.id, email: null, displayName: "Steve" },
                challenge,
                exclude: [],
              }),
              `https://${host}`,
            ),
            expected: { challenge, origin: `https://${host}`, rpId: host },
          }),
        );
      }
    });

    // The config can name the tunnel, so the flags needn't be repeated.
    const file = join(dir, "config.json");
    writeFileSync(
      file,
      JSON.stringify({
        ...(JSON.parse(readFileSync(file, "utf8")) as object),
        tunnel: { name: "home", hostname: "files.example.com" },
      }),
    );
    // An invite still out from before (one an operator issued, or an earlier run printed).
    await inspect((db) =>
      db.withTenant(tenantId, (tx) =>
        issueInvite(tx, tenantId, { userId: user.id, by: "system:admin-cli" }),
      ),
    );
    rmSync(record);
    const second = tunnel([], { FAKE: "named" });
    expect((await second.serving()).url).toBe("https://files.example.com");
    second.stop();
    expect(await second.code).toBe(0);
    expect(second.seen.out).toBe("");
    expect(second.seen.err).toContain("with the passkey Steve made here before");
    const held = await inspect((db) =>
      db.withTenant(tenantId, (tx) => listPasskeys(tx, tenantId, user.id)),
    );
    expect(held.map((p) => p.rpId)).toEqual(["files.example.com"]);
    const starts = (await audit(tenantId)).filter((e) => e.action === "tunnel.start");
    expect(starts.map((e) => e.detail)).toEqual([
      { address: "https://files.example.com", kind: "named" },
      {
        address: "https://files.example.com",
        kind: "named",
        passkeysRemoved: 2,
        invitesRevoked: 1,
      },
    ]);
    // Nothing printed earlier is still a way in.
    const open = await inspect((db) =>
      db.withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(invites)
          .where(and(isNull(invites.usedAt), isNull(invites.revokedAt))),
      ),
    );
    expect(open).toEqual([]);
  });

  it("says how to get cloudflared when there is none, and starts no server", async () => {
    await initSolo();
    const run = tunnel(["--cloudflared", join(root, "no-such-program")], {}, { spawn });
    expect(await run.code).toBe(1);
    expect(run.seen.err).toContain("cloudflared isn't installed");
    expect(run.seen.err).toContain("--cloudflared <path>");
    expect(existsSync(record)).toBe(false);
    expect(run.seen.out).toBe("");
  });

  it("stops with what cloudflared said when it fails, or never connects", async () => {
    await initSolo();
    const broken = tunnel([], { FAKE: "broken" });
    expect(await broken.code).toBe(1);
    expect(broken.seen.err).toContain("cloudflared stopped (exit 1)");
    expect(broken.seen.err).toContain("Cannot determine default origin certificate path");
    // A named tunnel that never registers a connection: given up on, and stopped.
    const silent = tunnel(
      ["--name", "home", "--hostname", "files.example.com"],
      { FAKE: "quiet" },
      { startMs: 400 },
    );
    expect(await silent.code).toBe(1);
    expect(silent.seen.err).toContain("cloudflared didn't connect within");
    expect(await allGone(silent.pids)).toBe(true);
    expect(existsSync(record)).toBe(false);
    // Neither issued an invite for an address nobody can reach.
    const { tenantId } = await solo();
    expect((await audit(tenantId)).filter((e) => /^(tunnel|invite)\./.test(e.action))).toEqual([]);
  });

  it("stops the server when the tunnel goes, and the tunnel when the server goes", async () => {
    await initSolo();
    const dies = tunnel([], { FAKE: "dies" });
    await dies.serving();
    expect(await dies.code).toBe(1);
    expect(dies.seen.err).toContain("cloudflared stopped (exit 7), so the server was stopped too");
    expect(dies.seen.err).toContain("lost the edge");
    expect(await allGone(dies.pids)).toBe(true);

    rmSync(record);
    const ends = tunnel([], { FAKE_SERVER_EXIT: "3" });
    expect(await ends.code).toBe(3);
    expect(await allGone(ends.pids)).toBe(true);
  });

  it("still runs for a person who can't be invited, and says so", async () => {
    await initSolo();
    const { tenantId, user } = await solo();
    await inspect((db) =>
      db.withTenant(tenantId, (tx) => lockUser(tx, tenantId, user.id, "system:admin-cli")),
    );
    const run = tunnel();
    await run.serving();
    run.stop();
    expect(await run.code).toBe(0);
    expect(run.seen.out).toBe("");
    expect(run.seen.err).toContain(`No invite for Steve (${user.id}): they are locked.`);
    // The start is on record all the same, and so is the invite that wasn't given.
    const events = (await audit(tenantId)).filter((e) => /^(tunnel|invite)\./.test(e.action));
    expect(events.map((e) => [e.action, e.decision, e.detail?.reason])).toEqual([
      ["tunnel.start", "allow", undefined],
      ["invite.issue", "deny", "inactive"],
    ]);
  });

  it("refuses what it can't run", async () => {
    // Nothing set up.
    const none = tunnel();
    expect(await none.code).toBe(1);
    expect(none.seen.err).toContain("init --solo");
    await initSolo();
    for (const [argv, said] of [
      [["--name", "home"], "--name and --hostname go together"],
      [["--name", "home", "--hostname", "https://files.example.com"], "a host name"],
      [["--name", "home", "--hostname", "192.0.2.7"], "a host name"],
      [["--name", "a b", "--hostname", "files.example.com"], "the tunnel's name or id"],
      [["--name", "home", "--hostname", "x.trycloudflare.com"], "can't be asked for"],
      [["--tenant", "nope"], "not a tenant id"],
      [["--user", "nobody@example.com"], "no current person nobody@example.com"],
      [["--bogus"], "usage: openhoard tunnel"],
    ] as const) {
      const run = tunnel([...argv]);
      expect([argv, await run.code]).toEqual([argv, argv[0] === "--user" ? 1 : 2]);
      expect(run.seen.err).toContain(said);
      expect(run.pids).toEqual([]);
    }
    const help = tunnel(["--help"]);
    expect(await help.code).toBe(0);
    expect(help.seen.err).toContain("cloudflared tunnel route dns");
  });
});

describe("OPENHOARD_TUNNEL_URL", () => {
  it("makes a run's address public, with passkeys and without sign-in links", async () => {
    await initSolo();
    const load = (url: string) =>
      loadConfig({ OPENHOARD_DATA_DIR: dir, OPENHOARD_TUNNEL_URL: url });
    expect(loadConfig({ OPENHOARD_DATA_DIR: dir }).auth).toMatchObject({
      publicUrl: "http://127.0.0.1:7420",
      signInLinks: true,
      passkeys: false,
    });
    expect(
      loadConfig({ OPENHOARD_DATA_DIR: dir, OPENHOARD_TUNNEL_URL: "" }).auth?.signInLinks,
    ).toBe(true);
    expect(load(QUICK).auth).toMatchObject({
      publicUrl: QUICK,
      signInLinks: false,
      passkeys: true,
    });
    // An address a passkey can't belong to, or people can't safely reach.
    expect(() => load("https://192.0.2.7")).toThrow(/passkeys belong to a host name/);
    expect(() => load("http://files.example.com")).toThrow(/publicUrl must use https/);
    expect(() => load("https://files.example.com/x")).toThrow(/an origin, with no path/);
    // Without sign-in configured there is nothing to make public.
    const bare = join(root, "bare");
    mkdirSync(bare);
    expect(() => loadConfig({ OPENHOARD_DATA_DIR: bare, OPENHOARD_TUNNEL_URL: QUICK })).toThrow(
      /needs sign-in configured/,
    );
  });
});
