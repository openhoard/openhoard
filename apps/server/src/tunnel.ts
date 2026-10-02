import { spawn, type ChildProcess } from "node:child_process";
import { parseArgs } from "node:util";
import { appendAudit } from "@openhoard/core-audit";
import { getTenant, isId, type Database } from "@openhoard/core-db";
import {
  findUserByEmail,
  getUser,
  IdentityError,
  INVITE_MAX_HOURS,
  issueInvite,
  listPasskeys,
  removeStrandedPasskeys,
  revokeInvites,
  type User,
} from "@openhoard/core-identity";
import { ADMIN_ACTOR, openAdminDatabase } from "./admin.js";
import { isLoopbackHost, TUNNEL_HOST, TUNNEL_NAME, type Config } from "./config.js";
import { commandLine, soloConfig, soloDataDir, type SoloIo } from "./solo.js";

/*
 * `tunnel` (T-1205): this server, reachable from outside, with nothing opened on the network it
 * sits in. It runs Cloudflare's `cloudflared` (which the operator installs: OpenHoard downloads
 * nothing and depends on no service of its own) beside the server, and tells the server the
 * address people reach it at.
 *
 *   tunnel [--data-dir <dir>]                              a quick tunnel, to try
 *   tunnel --name <tunnel> --hostname <files.example.com>  a named tunnel, to keep
 *          [--cloudflared <path>] [--tenant ten_…] [--user <usr_…|email>]
 *
 * - A quick tunnel needs no Cloudflare account: cloudflared prints a random
 *   `https://….trycloudflare.com` address, new on every run. A named tunnel is the operator's
 *   own, on their Cloudflare account and their domain (`cloudflared tunnel login`, `tunnel
 *   create`, `tunnel route dns`, once), and keeps its address. `tunnel` in config.json names it,
 *   so the flags needn't be repeated.
 * - The server is started by this command, with OPENHOARD_TUNNEL_URL: for that run its
 *   publicUrl is the tunnel's address, one-time sign-in links are off (they are for this machine
 *   only), and built-in accounts sign in with passkeys. config.json is not changed: run the
 *   server without `tunnel` and it is local again.
 * - A passkey belongs to the address it was made at. Before the server starts, this command
 *   looks at the person who signs in: with no passkey for this address it issues an invite and
 *   prints its link (on standard output: the one thing a script would want); a named tunnel's
 *   passkey from last time needs nothing. Passkeys left at quick-tunnel addresses, which never
 *   come back, are removed, and so is any invite of theirs not yet used: a link an earlier run
 *   printed doesn't outlive it. A quick tunnel's invite lasts an hour.
 * - Audited as `system:admin-cli`: `tunnel.start` with the address, and `invite.issue`.
 * - When either program stops, the other is stopped, and the command ends with the server's
 *   exit code (1 if the tunnel went first).
 */

const USAGE = `usage: openhoard tunnel [--data-dir <dir>] [--name <tunnel> --hostname <host>]
                        [--cloudflared <path>] [--tenant <ten_…>] [--user <usr_…|email>]

  With no --name: a Cloudflare quick tunnel (no account; a new address every run), to try.
  With --name and --hostname: your own named tunnel, at your own host name. Once, beforehand:
    cloudflared tunnel login
    cloudflared tunnel create <tunnel>
    cloudflared tunnel route dns <tunnel> <host>
`;

/** Quick tunnels' addresses: handed out once, never again. */
export const QUICK_TUNNEL_SUFFIX = ".trycloudflare.com";
/**
 * A quick tunnel's address as cloudflared prints it: alone between spaces (in a box), never the
 * service's own `api.` host, which its error messages name with a path after it.
 */
const QUICK_URL = /(?<=\s)https:\/\/(?!api\.)[a-z0-9]+(-[a-z0-9]+)*\.trycloudflare\.com(?=\s)/;
/** What cloudflared logs once an edge connection is up. */
const REGISTERED = /Registered tunnel connection/;
/** How long a quick tunnel's invite lasts (the shortest there is): this run's address won't. */
const QUICK_INVITE_HOURS = 1;
/** How long cloudflared gets to stop by itself before it is ended. */
const TUNNEL_STOP_MS = 10_000;

export interface TunnelIo extends SoloIo {
  /** This entry point (`…/main.js`), started again as the server. */
  self: string;
  /** Starts a program (tests); default node's spawn. */
  spawn?: typeof spawn;
  /** How long to wait for the tunnel to come up, in milliseconds (default 45,000). */
  startMs?: number;
  /** How long a program gets to stop before it is ended (tests; default 10 s, the server 12). */
  stopMs?: number;
  /**
   * How long after set-up the tunnel must still be running before it is announced and the server
   * started, in milliseconds (default 250): a tunnel that came up and went at once isn't one.
   */
  settleMs?: number;
  /** Stops the command when aborted (tests; the default listens for SIGINT and SIGTERM). */
  signal?: AbortSignal;
}

/** The last lines a program wrote, for when it fails: never more than a screenful. */
function tail(lines: string[], text: string): void {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() !== "") lines.push(line.slice(0, 300));
  }
  while (lines.length > 12) lines.shift();
}

/** Resolves when the child has exited, with its exit code (null: killed, or it never started). */
function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((done) => {
    child.once("exit", (code) => done(code));
    // An error with no process is one that never started. With a process it is something else
    // (a signal that couldn't be sent): the process is still there, and `exit` will say when
    // it isn't. Listened to for good, so a later one isn't thrown.
    child.on("error", () => {
      if (child.pid === undefined) done(null);
    });
  });
}

/** Started, and not yet gone (a program that never started has no pid). */
const running = (child: ChildProcess | undefined): child is ChildProcess =>
  child?.pid !== undefined && child.exitCode === null && child.signalCode === null;

/** Stops cloudflared: asked first, ended if it hasn't gone in time. */
function stop(child: ChildProcess | undefined, ms = TUNNEL_STOP_MS): void {
  if (!running(child)) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (running(child)) child.kill("SIGKILL");
  }, ms).unref();
}

/** How long the server gets to stop by itself (its own limit is 10 s) before it is ended. */
const SERVER_STOP_MS = 12_000;

/**
 * Stops the server cleanly: by closing the channel it was started with, which it answers on
 * every OS (main.ts), and with a signal where there are signals. On Windows a kill ends the
 * process at once, mid-write, so that is only what happens if it hasn't stopped in time.
 */
function stopServer(child: ChildProcess | undefined, ms = SERVER_STOP_MS): void {
  if (!running(child)) return;
  if (child.connected) child.disconnect();
  if (process.platform !== "win32") child.kill("SIGTERM");
  setTimeout(() => {
    if (running(child)) child.kill("SIGKILL");
  }, ms).unref();
}

/**
 * Waits for the tunnel: its address (a quick tunnel says it; a named one's is known, once an
 * edge connection is registered), or why there is none.
 */
function tunnelUp(
  tunnel: ChildProcess,
  gone: Promise<number | null>,
  options: {
    named: { name: string; hostname: string } | null;
    said: string[];
    ms: number;
    stopped: Promise<void>;
  },
): Promise<string | { failed: string; quiet?: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: string | { failed: string; quiet?: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(
      () => done({ failed: `cloudflared didn't connect within ${options.ms / 1000} s` }),
      options.ms,
    );
    // What it wrote lately, whole: an address can arrive split across two chunks.
    let recent = "";
    let address: string | undefined;
    let registered = false;
    const read = (chunk: Buffer | string) => {
      const text = chunk.toString();
      tail(options.said, text);
      // Looked at before it is cut down: a large chunk may carry what is waited for early on.
      recent += text;
      // Up once an edge connection is registered; a quick tunnel says its address before that.
      if (!options.named) address ??= QUICK_URL.exec(recent)?.[0];
      registered ||= REGISTERED.test(recent);
      recent = recent.slice(-4096);
      if (!registered) return;
      if (options.named) done(`https://${options.named.hostname}`);
      else if (address !== undefined) done(address);
    };
    tunnel.stdout?.on("data", read);
    tunnel.stderr?.on("data", read);
    tunnel.once("error", (e: NodeJS.ErrnoException) => {
      done(
        e.code === "ENOENT"
          ? {
              quiet: true,
              failed:
                `cloudflared isn't installed (or isn't on the PATH). Install it from ` +
                `https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ ` +
                `(Windows: winget install Cloudflare.cloudflared; macOS: brew install cloudflared), ` +
                `or name it with --cloudflared <path>`,
            }
          : { failed: `cloudflared couldn't start: ${e.message}` },
      );
    });
    // After its last output was read.
    void gone.then((code) =>
      setImmediate(() => done({ failed: `cloudflared stopped (exit ${code ?? "none"})` })),
    );
    void options.stopped.then(() => done({ failed: "stopped", quiet: true }));
  });
}

/** Who signs in: `--user`, or the one owner of the tenant's folders, as a current local person. */
async function signer(
  db: Database,
  config: Config,
  tenantId: string,
  named: string | undefined,
): Promise<User | string> {
  const owners = [
    ...new Set(config.sources.filter((s) => s.tenantId === tenantId).map((s) => s.owner)),
  ];
  const who = named ?? (owners.length === 1 ? owners[0] : undefined);
  if (who === undefined) {
    return owners.length === 0
      ? `no folder of tenant ${tenantId} names an owner: say who signs in with --user`
      : `tenant ${tenantId}'s folders have several owners (${owners.join(", ")}): say who signs in with --user`;
  }
  const user = await db.withTenant(tenantId, (tx) =>
    isId("user", who) ? getUser(tx, tenantId, who) : findUserByEmail(tx, tenantId, who),
  );
  if (!user || user.retired !== null) return `tenant ${tenantId} has no current person ${who}`;
  if (user.source !== "local" || user.kind === "service") {
    return `${user.displayName} (${user.id}) signs in through the identity provider, not with a passkey: nothing to prepare`;
  }
  return user;
}

/** Runs `tunnel`; returns the process exit code (0 done, 1 failed, 2 misused). */
export async function runTunnel(argv: readonly string[], io: TunnelIo): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      options: {
        "data-dir": { type: "string" },
        name: { type: "string" },
        hostname: { type: "string" },
        cloudflared: { type: "string" },
        tenant: { type: "string" },
        user: { type: "string" },
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
  const dataDir = soloDataDir(values["data-dir"], io);
  let config: Config;
  try {
    config = soloConfig(dataDir, io);
  } catch (e) {
    io.err(`${(e as Error).message}\n`);
    return 1;
  }
  if (!config.auth) {
    io.err(
      `no sign-in is configured in ${dataDir}: set OpenHoard up first with\n` +
        `  ${commandLine(io, dataDir, "init --solo")}\n`,
    );
    return 1;
  }
  // The tunnel is the way in: the server listens on this machine only, where cloudflared is.
  if (!isLoopbackHost(config.host)) {
    io.err(
      `the server listens on ${config.host}, not on this machine only: with a tunnel, set host ` +
        `to 127.0.0.1 (cloudflared reaches it there, and nothing else should)\n`,
    );
    return 1;
  }
  if (config.port === 0) {
    io.err(`the server's port is 0 (chosen at start), which a tunnel can't point at: set port\n`);
    return 1;
  }

  // Which tunnel: flags, else the config's, else a quick one.
  if ((values.name === undefined) !== (values.hostname === undefined)) {
    io.err(`--name and --hostname go together\n\n${USAGE}`);
    return 2;
  }
  const named =
    values.name !== undefined && values.hostname !== undefined
      ? { name: values.name, hostname: values.hostname.toLowerCase() }
      : (config.tunnel ?? null);
  if (named && (!TUNNEL_NAME.test(named.name) || !TUNNEL_HOST.test(named.hostname))) {
    io.err(
      `--name is the tunnel's name or id, and --hostname a host name (files.example.com), ` +
        `with no https:// and no path\n`,
    );
    return 2;
  }
  if (named?.hostname.endsWith(QUICK_TUNNEL_SUFFIX)) {
    io.err(
      `${named.hostname} is a quick tunnel's address, which can't be asked for: leave --name and --hostname out\n`,
    );
    return 2;
  }

  // The tenant: --tenant, or the one the folders name (as connect claude-desktop does).
  const tenants = [...new Set(config.sources.map((s) => s.tenantId))];
  if (values.tenant !== undefined && !isId("tenant", values.tenant)) {
    io.err(`not a tenant id: ${values.tenant}\n\n${USAGE}`);
    return 2;
  }
  const tenantId = values.tenant ?? (tenants.length === 1 ? tenants[0] : undefined);
  if (tenantId === undefined) {
    io.err(
      tenants.length === 0
        ? `the config has no folders (sources), so no tenant: name one with --tenant\n`
        : `the config's folders are in several tenants (${tenants.join(", ")}): name one with --tenant\n`,
    );
    return 2;
  }

  // The database first: refused while a server holds it, before anything is started.
  const db = await openAdminDatabase(config, io);
  if (db === null) return 1;
  let who: User;
  try {
    if (!(await db.withTenant(tenantId, (tx) => getTenant(tx, tenantId)))) {
      io.err(`no tenant ${tenantId}\n`);
      await db.close();
      return 1;
    }
    const found = await signer(db, config, tenantId, values.user);
    if (typeof found === "string") {
      io.err(`${found}\n`);
      await db.close();
      return values.user === undefined ? 2 : 1;
    }
    who = found;
  } catch (e) {
    await db.close().catch(() => {});
    throw e;
  }

  let open = true;
  const close = async () => {
    if (!open) return;
    open = false;
    await db.close().catch(() => {});
  };
  const start = io.spawn ?? spawn;
  const env = io.env ?? process.env;
  const local = `http://${config.host.includes(":") ? `[${config.host.replace(/^\[|\]$/g, "")}]` : config.host}:${config.port}`;
  const program = values.cloudflared ?? "cloudflared";
  const args = named
    ? ["tunnel", "--no-autoupdate", "run", "--url", local, named.name]
    : ["tunnel", "--no-autoupdate", "--url", local];
  const said: string[] = [];
  let tunnel: ChildProcess | undefined;
  let server: ChildProcess | undefined;
  let stopping = false;
  let wake = () => {};
  const end = () => {
    stopping = true;
    wake();
    stopServer(server, io.stopMs);
    stop(tunnel, io.stopMs);
  };
  const onSignal = () => end();
  if (io.signal) io.signal.addEventListener("abort", onSignal, { once: true });
  else for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, onSignal);
  const cleanUp = () => {
    if (io.signal) io.signal.removeEventListener("abort", onSignal);
    else for (const s of ["SIGINT", "SIGTERM"] as const) process.off(s, onSignal);
  };

  try {
    // 1. The tunnel, until it says where it is (a quick one) or that it is connected.
    tunnel = start(program, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const tunnelGone = exited(tunnel);
    const up = await tunnelUp(tunnel, tunnelGone, {
      named,
      said,
      ms: io.startMs ?? 45_000,
      stopped: new Promise<void>((done) => (wake = done)),
    });
    if (typeof up !== "string") {
      io.err(`${up.failed}${up.quiet || said.length === 0 ? "" : `\n  ${said.join("\n  ")}`}\n`);
      return 1;
    }
    const publicUrl = up;
    const host = new URL(publicUrl).hostname;

    // 2. The person's way in at this address, while this process still holds the database.
    // First what holds whoever is invited: the start is recorded, passkeys left at addresses
    // that are gone go, and so does any invite not yet used (a link printed by an earlier run,
    // in a terminal's history, must not outlive that run).
    let withdrawn = 0;
    const has = await db.withTenant(tenantId, async (tx) => {
      const stranded = await removeStrandedPasskeys(
        tx,
        tenantId,
        who.id,
        { suffix: QUICK_TUNNEL_SUFFIX, keep: host },
        ADMIN_ACTOR,
      );
      const revoked = await revokeInvites(tx, tenantId, who.id, ADMIN_ACTOR);
      withdrawn = revoked;
      const here = (await listPasskeys(tx, tenantId, who.id)).some((p) => p.rpId === host);
      // Audit last (core/audit).
      await appendAudit(tx, tenantId, {
        actor: ADMIN_ACTOR,
        action: "tunnel.start",
        decision: "allow",
        detail: {
          address: publicUrl,
          kind: named ? "named" : "quick",
          ...(stranded > 0 ? { passkeysRemoved: stranded } : {}),
          ...(revoked > 0 ? { invitesRevoked: revoked } : {}),
        },
      });
      return here;
    });
    // Then the invite, when they have no passkey here: refused (they are locked, say), the
    // tunnel still runs, and the refusal is recorded as the admin command records it.
    let link: { url: string; expiresAt: Date } | null = null;
    if (!has) {
      try {
        link = await db.withTenant(tenantId, async (tx) => {
          const invite = await issueInvite(tx, tenantId, {
            userId: who.id,
            by: ADMIN_ACTOR,
            hours: named ? INVITE_MAX_HOURS : QUICK_INVITE_HOURS,
          });
          await appendAudit(tx, tenantId, {
            actor: ADMIN_ACTOR,
            action: "invite.issue",
            decision: "allow",
            detail: {
              user: who.id,
              invite: invite.id,
              expiresAt: invite.expiresAt.toISOString(),
            },
          });
          const url = new URL("/auth/invite", publicUrl);
          url.hash = invite.token;
          return { url: url.href, expiresAt: invite.expiresAt };
        });
      } catch (e) {
        if (!(e instanceof IdentityError)) throw e;
        await db.withTenant(tenantId, (tx) =>
          appendAudit(tx, tenantId, {
            actor: ADMIN_ACTOR,
            action: "invite.issue",
            decision: "deny",
            detail: { user: who.id, reason: e.code },
          }),
        );
        io.err(`No invite for ${who.displayName} (${who.id}): ${e.message}.\n`);
      }
    }
    await close();
    // One whole turn of the event loop first: the embedded database works without yielding to
    // it, so a signal, or the tunnel's exit, during that work hasn't been heard yet.
    // And a moment more: an operating system may take that long to say a program has ended.
    await new Promise<void>((turn) => setTimeout(() => setImmediate(turn), io.settleMs ?? 250));
    if (stopping) return 1;
    // Gone meanwhile: nothing is announced, and no server started, for an address that is dead.
    if (tunnel.exitCode !== null || tunnel.signalCode !== null) {
      io.err(`cloudflared stopped (exit ${tunnel.exitCode ?? "none"}).\n  ${said.join("\n  ")}\n`);
      return 1;
    }

    // 3. The server, told where it is reached.
    io.err(
      `\nOpenHoard is reachable at ${publicUrl}\n` +
        (named
          ? `  through your tunnel ${named.name}.\n`
          : `  through a Cloudflare quick tunnel: for trying it out. The address is new on every ` +
            `run, and anyone who has it reaches the sign-in page.\n`) +
        `  connector: ${new URL("/mcp", publicUrl).href}  (add it to Claude, or another MCP ` +
        `client, as a custom connector)\n` +
        (config.uploads
          ? `  add files: ${new URL("/app/", publicUrl).href}  (install that page on a phone or ` +
            `a desktop, and OpenHoard is in its share menu)\n`
          : ``) +
        (withdrawn > 0 && !link
          ? `  An invite of ${who.displayName}'s that was still unused was withdrawn (every start ` +
            `does that): issue another with "admin user invite" if a second device needs one.\n`
          : ``) +
        (link
          ? `  sign in:   ${who.displayName} has no passkey for this address yet. Open this link ` +
            `once, on the device you'll use, and create one (good until ` +
            `${link.expiresAt.toISOString()}; whoever opens it signs in as them):\n`
          : `  sign in:   with the passkey ${who.displayName} made here before.\n`),
    );
    if (link) io.out(`${link.url}\n`);
    io.err(
      `  The first time an AI client connects, the page that opens asks you, as the admin, to ` +
        `approve it.\n` +
        `  While the tunnel runs, one-time sign-in links are off, and Claude Desktop set up with ` +
        `"connect claude-desktop" (which uses this machine's address) doesn't connect: use the ` +
        `connector address above. Stop with Ctrl+C.\n\n`,
    );
    server = start(process.execPath, [io.self, "--data-dir", dataDir], {
      env: { ...env, OPENHOARD_TUNNEL_URL: publicUrl },
      // Its log goes to standard error with this command's messages: standard output carries
      // the invite link and nothing else.
      // The channel is how it is told to stop (stopServer()).
      stdio: ["inherit", 2, "inherit", "ipc"],
    });
    const serverGone = exited(server);
    // 4. Until one of them stops; then the other is stopped too.
    const first = await Promise.race([
      serverGone.then((code) => ({ which: "server" as const, code })),
      tunnelGone.then((code) => ({ which: "tunnel" as const, code })),
    ]);
    const wasStopping = stopping;
    end();
    const [serverCode] = await Promise.all([serverGone, tunnelGone]);
    if (first.which === "tunnel" && !wasStopping) {
      io.err(
        `cloudflared stopped (exit ${first.code ?? "none"}), so the server was stopped too.\n  ${said.join("\n  ")}\n`,
      );
      return 1;
    }
    // Stopped on purpose: done, however the server's own exit is numbered on this OS.
    return wasStopping ? 0 : (serverCode ?? 1);
  } finally {
    end();
    cleanUp();
    await close();
    // Not left behind: cloudflared is gone (ended, if it wouldn't stop) before this returns and
    // the process exits.
    if (running(tunnel)) await exited(tunnel);
  }
}
