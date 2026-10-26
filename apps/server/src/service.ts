import { execFile, spawn } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fchownSync,
  fstatSync,
  lchownSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { soloConfig, soloDataDir, type SoloIo } from "./solo.js";

/*
 * `service install | uninstall | start | stop | status` (T-1102): the server as the operating
 * system's own service, so it starts at boot, with nobody signed in, and starts again after a
 * crash.
 *
 * - Linux: a systemd unit, /etc/systemd/system/<name>.service, run as `--user` (default: whoever
 *   ran sudo; never an account with uid 0). Logs: `journalctl -u <name>`.
 * - macOS: a launchd daemon, /Library/LaunchDaemons/org.openhoard.<name>.plist, run as `--user`
 *   likewise. Logs: <dataDir>/logs/server.log.
 * - Windows: a Task Scheduler task at startup, run as the person installing it whether they are
 *   signed in or not, with no password stored (S4U: it reaches the internet, never their
 *   network shares). The task runs `service run`, which starts the server, sends what it prints
 *   to <dataDir>\logs\server.log and starts it again when it fails: Task Scheduler restarts a
 *   task only when it can't launch. `service stop` asks it to stop the server cleanly before it
 *   would end the task, which kills the whole tree.
 *
 * Each runs this Node and this CLI with `--env-file=<dataDir>/service.env`, so the service has
 * the secrets the server reads from the environment, under the same names: install writes the
 * OPENHOARD_ variables set where it runs (never OPENHOARD_DATA_DIR) into service.env, readable
 * by the service's account only, and checks the server would load its config with them. An
 * existing service.env is kept as it is: change a secret there, then stop and start.
 *
 * Installing, starting, stopping and removing need an administrator (sudo; an elevated
 * PowerShell), as a service does. As root, nothing the service's account controls is followed:
 * service.env is owned before it is put in place, and a link where a file or folder is expected
 * is refused.
 */

const USAGE = `usage: openhoard [--data-dir <dir>] service <install|uninstall|start|stop|status> [options]

  Runs the server as this machine's service: at boot, and again after a crash.
  Linux: systemd. macOS: launchd. Windows: Task Scheduler. Needs sudo or an elevated shell.

  --name <name>    the service's name (default: openhoard)
  --user <name>    Linux and macOS: the account it runs as (default: whoever ran sudo)
  --data-dir <dir> where OpenHoard keeps its data (default: the OS's app-data folder;
                   OPENHOARD_DATA_DIR also sets it). Under sudo the default is root's: name it.
`;

/** Runs a program: its exit code and what it printed (tests replace it). */
export type RunCaptured = (
  file: string,
  args: readonly string[],
) => Promise<{ code: number; output: string }>;

export interface ServiceIo extends SoloIo {
  /** Runs the OS's service tools: systemctl, launchctl, schtasks, icacls, id (tests replace it). */
  exec?: RunCaptured;
  /** The Node and the CLI script the service runs; default this process's. */
  node?: string;
  script?: string;
  /** Where systemd units or launchd daemons go (tests); default the system's folder. */
  unitDir?: string;
  /** This process's user id (tests); default process.getuid(). */
  uid?: number;
  /** How often `service stop` asks whether the Windows task ended (tests); default 1 s. */
  pollMs?: number;
}

const runCaptured: RunCaptured = (file, args) =>
  new Promise((done) => {
    execFile(file, [...args], { timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
      const code = err === null ? 0 : (err as { code?: unknown }).code;
      done({ code: typeof code === "number" ? code : 1, output: `${stdout}${stderr}` });
    });
  });

const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
/**
 * Characters a path in a unit, plist or task may not hold here: each format would need quoting
 * rules of its own for them (systemd expands `$` and `%`, and escapes with `\`).
 */
const unsafePath = (path: string, platform: NodeJS.Platform) =>
  /["%$\r\n]/.test(path) || (platform !== "win32" && path.includes("\\"));

type Step = [string, ...string[]];

/** The service's files and commands on one platform. */
export interface ServicePlan {
  /** The file that defines the service, and its text. */
  file: string;
  text: string;
  install: Step[];
  /** After `stop` (which may fail: it isn't running), what takes the service out. */
  remove: Step[];
  start: Step[];
  /** Tried when `start` fails: launchd's job is still loaded, but isn't running. */
  startLoaded?: Step[];
  stop: Step[];
  status: Step[];
}

export interface ServiceSpec {
  name: string;
  user: string;
  node: string;
  script: string;
  dataDir: string;
  unitDir: string;
}

/** The command line the service runs: Node with the env file, the CLI, serve (`service run`). */
export function serviceArgs(
  spec: Pick<ServiceSpec, "script" | "dataDir">,
  run = "serve",
): string[] {
  const env = `--env-file=${join(spec.dataDir, "service.env")}`;
  return [env, spec.script, "--data-dir", spec.dataDir, ...run.split(" ")];
}

/** systemd: ExecStart's words quoted (systemd.syntax); other settings take a value as it is. */
export function systemdPlan(spec: ServiceSpec): ServicePlan {
  const exec = [spec.node, ...serviceArgs(spec)].map((s) => `"${s}"`).join(" ");
  const text = `[Unit]
Description=OpenHoard (${spec.name})
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=${spec.user}
WorkingDirectory=${spec.dataDir}
ExecStart=${exec}
Restart=on-failure
RestartSec=5
# The server finishes its requests and closes the database on SIGTERM.
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
`;
  return {
    file: join(spec.unitDir, `${spec.name}.service`),
    text,
    install: [
      ["systemctl", "daemon-reload"],
      ["systemctl", "enable", "--now", spec.name],
    ],
    remove: [["systemctl", "disable", spec.name]],
    start: [["systemctl", "start", spec.name]],
    stop: [["systemctl", "stop", spec.name]],
    status: [["systemctl", "status", "--no-pager", spec.name]],
  };
}

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** launchd: a daemon that runs at load, as the user, and again unless it exited cleanly. */
export function launchdPlan(spec: ServiceSpec): ServicePlan {
  const label = `org.openhoard.${spec.name}`;
  const log = join(spec.dataDir, "logs", "server.log");
  const args = [spec.node, ...serviceArgs(spec)].map((a) => `    <string>${xml(a)}</string>`);
  const text = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>UserName</key>
  <string>${xml(spec.user)}</string>
  <key>ProgramArguments</key>
  <array>
${args.join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(spec.dataDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
  const file = join(spec.unitDir, `${label}.plist`);
  return {
    file,
    text,
    install: [["launchctl", "bootstrap", "system", file]],
    remove: [],
    // A daemon kept alive comes back when killed: stopping takes it out of launchd, starting
    // puts it back, or, while it is still in (it exited cleanly), starts it.
    start: [["launchctl", "bootstrap", "system", file]],
    startLoaded: [["launchctl", "kickstart", `system/${label}`]],
    stop: [["launchctl", "bootout", `system/${label}`]],
    status: [["launchctl", "print", `system/${label}`]],
  };
}

/**
 * Task Scheduler: at startup, as `user` (DOMAIN\name), S4U, least privilege, normal priority, no
 * time limit, `service run` as its action. Ending the task stops the server.
 */
export function taskPlan(spec: ServiceSpec): ServicePlan {
  const args = serviceArgs(spec, "service run")
    .map((a) => (/\s/.test(a) ? `"${a}"` : a))
    .join(" ");
  const text = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>OpenHoard (${xml(spec.name)})</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(spec.user)}</UserId>
      <LogonType>S4U</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>255</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(spec.node)}</Command>
      <Arguments>${xml(args)}</Arguments>
      <WorkingDirectory>${xml(spec.dataDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
  return {
    file: join(spec.unitDir, `${spec.name}.task.xml`),
    text,
    install: [
      [
        "schtasks",
        "/Create",
        "/TN",
        spec.name,
        "/XML",
        join(spec.unitDir, `${spec.name}.task.xml`),
      ],
      ["schtasks", "/Run", "/TN", spec.name],
    ],
    remove: [["schtasks", "/Delete", "/TN", spec.name, "/F"]],
    start: [["schtasks", "/Run", "/TN", spec.name]],
    stop: [["schtasks", "/End", "/TN", spec.name]],
    status: [["schtasks", "/Query", "/TN", spec.name, "/V", "/FO", "LIST"]],
  };
}

/**
 * service.env's text: KEY='value' lines, or KEY=`value` for a value with a single quote (Node's
 * --env-file reads both literally). A value with both, or a line break, is refused.
 */
export function envFileText(env: NodeJS.ProcessEnv): string {
  const lines: string[] = [];
  for (const key of Object.keys(env).sort()) {
    const value = env[key];
    if (!key.startsWith("OPENHOARD_") || key === "OPENHOARD_DATA_DIR") continue;
    if (value === undefined) continue;
    if (/[\r\n]/.test(value)) throw new Error(`${key} holds a line break, which service.env can't`);
    if (!value.includes("'")) lines.push(`${key}='${value}'`);
    else if (!value.includes("`")) lines.push(`${key}=\`${value}\``);
    else throw new Error(`${key} holds both ' and \`, which service.env can't`);
  }
  return `# The server's environment when it runs as a service (openhoard service install).\n${lines.join("\n")}\n`;
}

/**
 * Creates `file` as root for `owner`: written, owned and only then linked into place, so the
 * owner of the folder never has a moment to swap something in that root would then change.
 */
function createOwnedFile(file: string, text: string, owner: { uid: number; gid: number } | null) {
  const temp = `${file}.${process.pid}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, text);
    if (owner) fchownSync(fd, owner.uid, owner.gid);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** A path root must not follow: a link (or anything but `kind`) is refused. */
function notLinked(path: string, kind: "file" | "dir"): string | null {
  const s = lstatSync(path, { throwIfNoEntry: false });
  if (s === undefined) return null;
  if (s.isSymbolicLink()) return `${path} is a link: replace it with a real ${kind}`;
  if (kind === "dir" ? !s.isDirectory() : !s.isFile()) return `${path} isn't a ${kind}`;
  return null;
}

/** Runs `service …`; returns the exit code (0 done, 1 failed, 2 misused). */
export async function runService(argv: readonly string[], io: ServiceIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        name: { type: "string", default: "openhoard" },
        user: { type: "string" },
        "data-dir": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const action = positionals[0] ?? "";
  if (values.help === true) {
    io.err(USAGE);
    return 0;
  }
  const misused = (message: string) => {
    io.err(`${message}\n\n${USAGE}`);
    return 2;
  };
  const actions = ["install", "uninstall", "start", "stop", "status", "run"];
  if (positionals.length !== 1 || !actions.includes(action)) {
    return misused("say which: install, uninstall, start, stop or status");
  }
  const name = values.name;
  if (!NAME.test(name)) return misused("--name is lower-case letters, digits and dashes");
  const platform = io.platform ?? process.platform;
  const env = io.env ?? process.env;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
    return misused(`no service manager for ${platform}: run \`serve\` under your own`);
  }
  const dataDir = soloDataDir(values["data-dir"], io);
  const node = io.node ?? process.execPath;
  const script = resolve(io.script ?? process.argv[1] ?? "");
  if (action === "run") {
    if (platform !== "win32") return misused("run is what the Windows task runs");
    return supervise(node, script, dataDir, io);
  }

  // Who it runs as matters to install only; the other commands name the service.
  let user: string;
  if (platform === "win32") {
    if (values.user !== undefined) {
      return misused("--user is for Linux and macOS: on Windows the task runs as you");
    }
    user = `${env.USERDOMAIN ?? "."}\\${env.USERNAME ?? ""}`;
    if (action === "install" && !env.USERNAME) return misused("USERNAME isn't set: who is this?");
  } else {
    user = values.user ?? env.SUDO_USER ?? "";
    if (action === "install") {
      if (user === "") return misused("--user is required unless you run this with sudo");
      if (!USER.test(user)) return misused("--user is an account name");
    }
    if (action !== "status" && (io.uid ?? process.getuid?.()) !== 0) {
      io.err(`${action} needs root: run it again with sudo\n`);
      return 1;
    }
  }
  for (const [what, path] of [
    ["the data directory", dataDir],
    ["Node", node],
    ["the CLI", script],
  ] as const) {
    if (unsafePath(path, platform)) return misused(`${what}'s path holds " % $ or \\: move it`);
  }
  const unitDir =
    io.unitDir ??
    (platform === "linux"
      ? "/etc/systemd/system"
      : platform === "darwin"
        ? "/Library/LaunchDaemons"
        : // The task's XML, for schtasks to read, next to service.env (whose folder is the
          // service account's alone by then), and removed after.
          dataDir);
  const spec: ServiceSpec = { name, user, node, script, dataDir, unitDir };
  const plan =
    platform === "linux"
      ? systemdPlan(spec)
      : platform === "darwin"
        ? launchdPlan(spec)
        : taskPlan(spec);
  const run = io.exec ?? runCaptured;
  const runAll = async (steps: Step[], quiet = false) => {
    for (const [file, ...args] of steps) {
      io.err(`$ ${file} ${args.join(" ")}\n`);
      const { code, output } = await run(file, args);
      if (code !== 0) {
        if (!quiet) io.err(`${output.trim()}\n${file} failed (exit ${code})\n`);
        return quiet ? code : 1;
      }
    }
    return 0;
  };

  if (action === "install") {
    try {
      return await install(io, platform, spec, plan, env, run, runAll);
    } finally {
      if (platform === "win32") rmSync(plan.file, { force: true });
    }
  }
  if (action === "status") {
    // What the tool says is the answer, whatever its exit code says (a stopped unit is 3).
    const [file, ...args] = plan.status[0] as Step;
    const { code, output } = await run(file, args);
    io.out(output.endsWith("\n") || output === "" ? output : `${output}\n`);
    return code === 0 ? 0 : 1;
  }
  if (action === "start") {
    if (plan.startLoaded === undefined) return runAll(plan.start);
    return (await runAll(plan.start, true)) === 0 ? 0 : runAll(plan.startLoaded);
  }
  if (action === "stop") {
    return platform === "win32" ? stopTask(name, dataDir, io, run) : runAll(plan.stop);
  }
  // Uninstall. Not running is fine: it is being removed.
  if (platform === "win32") await stopTask(name, dataDir, io, run);
  else for (const [file, ...args] of plan.stop) await run(file, args);
  const code = await runAll(plan.remove);
  if (code !== 0) return code;
  if (platform !== "win32") rmSync(plan.file, { force: true });
  if (platform === "linux" && (await runAll([["systemctl", "daemon-reload"]])) !== 0) return 1;
  io.err(`removed ${name}; ${join(dataDir, "service.env")} and the data are left as they are\n`);
  return 0;
}

async function install(
  io: ServiceIo,
  platform: "linux" | "darwin" | "win32",
  spec: ServiceSpec,
  plan: ServicePlan,
  env: NodeJS.ProcessEnv,
  run: RunCaptured,
  runAll: (steps: Step[]) => Promise<number>,
): Promise<number> {
  const failed = (message: string) => {
    io.err(`${message}\n`);
    return 1;
  };
  if (!existsSync(join(spec.dataDir, "config.json"))) {
    return failed(`no config.json in ${spec.dataDir}: set the server up first, or name --data-dir`);
  }
  const exists =
    platform === "win32"
      ? (await run("schtasks", ["/Query", "/TN", spec.name])).code === 0
      : existsSync(plan.file);
  if (exists)
    return failed(`${spec.name} is installed: uninstall it first, or choose another --name`);
  // The account the service runs as must own the data, and gets service.env and the logs.
  let owner: { uid: number; gid: number } | null = null;
  if (platform !== "win32") {
    const [uid, gid] = await Promise.all([
      run("id", ["-u", spec.user]),
      run("id", ["-g", spec.user]),
    ]);
    if (uid.code !== 0 || gid.code !== 0) return failed(`no account named ${spec.user}`);
    owner = { uid: Number(uid.output.trim()), gid: Number(gid.output.trim()) };
    if (owner.uid === 0) return failed(`${spec.user} is root: the server doesn't run as root`);
    if (statSync(spec.dataDir).uid !== owner.uid) {
      return failed(`${spec.dataDir} isn't ${spec.user}'s: the service runs as them (--user)`);
    }
  }
  const envFile = join(spec.dataDir, "service.env");
  const logs = join(spec.dataDir, "logs");
  if (platform === "darwin") {
    const linked = notLinked(logs, "dir");
    if (linked !== null) return failed(linked);
  }
  // Read if it is there, without following a link (no look first that it could change after);
  // made if not.
  let kept = true;
  let text: string;
  try {
    const fd = openSync(envFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!fstatSync(fd).isFile()) return failed(`${envFile} isn't a file`);
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      return failed(`can't read ${envFile} (a link isn't followed): ${(e as Error).message}`);
    }
    kept = false;
    try {
      text = envFileText(env);
      createOwnedFile(envFile, text, owner);
    } catch (e) {
      return failed(`can't write ${envFile}: ${(e as Error).message}`);
    }
  }
  // Written but not wanted: a refused install leaves the next one free to write it again.
  const undo = () => {
    if (!kept) rmSync(envFile, { force: true });
  };
  const serviceEnv = parseEnv(text);
  try {
    soloConfig(spec.dataDir, { ...io, env: { ...serviceEnv, OPENHOARD_DATA_DIR: spec.dataDir } });
  } catch (e) {
    undo();
    return failed(
      `${(e as Error).message}\n\nThe server wouldn't start with this config and ${envFile}`,
    );
  }
  if (platform === "win32") {
    // Files have their folder's permissions there: the data directory (keys, the database,
    // service.env) becomes the account's, the system's and administrators' alone.
    const acl = await run("icacls", [
      spec.dataDir,
      "/inheritance:r",
      "/grant:r",
      `${spec.user}:(OI)(CI)F`,
      "*S-1-5-18:(OI)(CI)F",
      "*S-1-5-32-544:(OI)(CI)F",
    ]);
    if (acl.code !== 0) {
      undo();
      return failed(`${acl.output.trim()}\ncan't make ${spec.dataDir} yours alone (icacls)`);
    }
  }
  io.err(
    kept
      ? `${envFile} exists: the service uses it as it is\n`
      : `wrote ${envFile} (${spec.user}'s only): ${Object.keys(serviceEnv).join(", ") || "no variables"}\n`,
  );
  if (platform === "darwin" && owner && !existsSync(logs)) {
    mkdirSync(logs, { mode: 0o700 });
    lchownSync(logs, owner.uid, owner.gid);
  }
  mkdirSync(dirname(plan.file), { recursive: true });
  // schtasks reads the task in UTF-16, as its XML says.
  if (platform === "win32") writeFileSync(plan.file, `\ufeff${plan.text}`, { encoding: "utf16le" });
  else writeFileSync(plan.file, plan.text, { mode: 0o644 });
  const code = await runAll(plan.install);
  if (code !== 0) {
    // What a failed enable left behind (systemd links the unit before starting it).
    if (platform === "linux") await run("systemctl", ["disable", spec.name]);
    if (platform !== "win32") rmSync(plan.file, { force: true });
    if (platform === "linux") await run("systemctl", ["daemon-reload"]);
    undo();
    return code;
  }
  io.err(`installed ${spec.name}: it starts at boot, as ${spec.user}\n`);
  return 0;
}

/** How long a run must last for the next failure to count as the first again. */
const STEADY_MS = 10 * 60_000;

/** What `service stop` leaves for `service run` on Windows: stop the server, cleanly. */
const stopFile = (dataDir: string) => join(dataDir, "service.stop");

/**
 * `service run`, the Windows task's action: the server as a child, its output appended to
 * <dataDir>/logs/server.log, started again after a failure (5 s, doubling to a minute while it
 * keeps failing). Ending the task kills both at once (Task Scheduler ends the whole tree), so
 * `service stop` asks first, with a file this watches: the child's channel is closed, the
 * server stops cleanly (main.ts), and this ends. A clean exit of its own ends it too.
 */
async function supervise(node: string, script: string, dataDir: string, io: ServiceIo) {
  mkdirSync(join(dataDir, "logs"), { recursive: true });
  const log = openSync(join(dataDir, "logs", "server.log"), "a");
  const say = (line: string) => writeSync(log, `openhoard service: ${line}\n`);
  rmSync(stopFile(dataDir), { force: true });
  let stopping = false;
  let wait = 5_000;
  for (;;) {
    const started = Date.now();
    const env = `--env-file=${join(dataDir, "service.env")}`;
    const child = spawn(node, [env, script, "--data-dir", dataDir, "serve"], {
      env: { ...(io.env ?? process.env), OPENHOARD_SUPERVISED: "1" },
      stdio: ["ignore", log, log, "ipc"],
      windowsHide: true,
    });
    // `exit` follows a failed start too; an error is only said.
    child.on("error", (e) => say(e.message));
    const asked = setInterval(() => {
      if (stopping || !existsSync(stopFile(dataDir))) return;
      stopping = true;
      say("asked to stop");
      if (child.connected) child.disconnect();
    }, 1_000);
    const code = await new Promise<number | null>((done) => child.once("exit", (c) => done(c)));
    clearInterval(asked);
    if (stopping || existsSync(stopFile(dataDir))) {
      rmSync(stopFile(dataDir), { force: true });
      say(`stopped (exit ${code ?? "none"})`);
      return 0;
    }
    if (code === 0) return 0;
    if (Date.now() - started > STEADY_MS) wait = 5_000;
    say(`the server stopped (exit ${code ?? "none"}); starting it again in ${wait / 1000} s`);
    await new Promise((done) => setTimeout(done, wait));
    wait = Math.min(wait * 2, 60_000);
  }
}

/**
 * `service stop` on Windows: asks `service run` to stop the server cleanly (above), waits up to
 * 30 s for the task to end, and only then ends it, which kills the server mid-write. Either
 * way the embedded database starts again (a killed one recovers as after a power cut).
 */
async function stopTask(name: string, dataDir: string, io: ServiceIo, run: RunCaptured) {
  const running = async () =>
    (await run("schtasks", ["/Query", "/TN", name, "/FO", "CSV", "/NH"])).output.includes(
      "Running",
    );
  if (!(await running())) {
    io.err(`${name} isn't running\n`);
    return 0;
  }
  writeFileSync(stopFile(dataDir), "");
  for (let i = 0; i < 30 && (await running()); i++) {
    await new Promise((done) => setTimeout(done, io.pollMs ?? 1_000));
  }
  if (!(await running())) {
    io.err(`stopped ${name}\n`);
    return 0;
  }
  io.err(`${name} didn't stop in 30 s: ending it\n`);
  rmSync(stopFile(dataDir), { force: true });
  const ended = await run("schtasks", ["/End", "/TN", name]);
  if (ended.code !== 0) io.err(`${ended.output.trim()}\nschtasks failed (exit ${ended.code})\n`);
  return ended.code === 0 ? 0 : 1;
}
