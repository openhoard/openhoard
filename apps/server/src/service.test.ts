import {
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseEnv } from "node:util";
import { envFileText, runService, type ServiceIo } from "./service.js";

/*
 * T-1102: `service install` writes the OS's service definition and service.env (the OPENHOARD_
 * variables, checked against the config), then hands over to systemctl, launchctl or schtasks.
 * The OS tools are replaced here; .github/workflows/ci.yml installs it for real on each OS.
 */

let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oh-service-"));
  dir = join(root, "data");
  mkdirSync(dir);
  writeFileSync(join(dir, "config.json"), "{}");
  // The service's account is never root: run as root (a container), the data is given to 1000.
  if (process.getuid?.() === 0) chownSync(dir, 1000, 1000);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function service(argv: string[], more: Partial<ServiceIo> = {}) {
  const seen = { err: "", ran: [] as string[] };
  const io: ServiceIo = {
    env: { SUDO_USER: "oh", OPENHOARD_AUTH_ENTRA_CLIENT_SECRET: "s3cr#t", PATH: "/bin" },
    platform: "linux",
    uid: 0,
    node: "/usr/bin/node",
    script: "/opt/openhoard/apps/cli/dist/bin.js",
    unitDir: join(root, "units"),
    out: () => undefined,
    err: (s) => void (seen.err += s),
    exec: (file, args) => {
      seen.ran.push([file, ...args].join(" "));
      const uid = args[1] === "root" ? "0" : String(statSync(dir).uid);
      return Promise.resolve({ code: 0, output: file === "id" ? uid : "" });
    },
    ...more,
  };
  const code = await runService([...argv, "--data-dir", dir], io);
  return { code, ...seen };
}

// Paths here are POSIX ones; a Windows host has its own (the task test below runs everywhere).
describe.skipIf(process.platform === "win32")("service install", () => {
  it("writes a systemd unit and service.env, and enables it", async () => {
    const run = await service(["install"]);
    expect(run.code).toBe(0);
    const unit = readFileSync(join(root, "units", "openhoard.service"), "utf8");
    expect(unit).toContain("User=oh\n");
    expect(unit).toContain(
      `ExecStart="/usr/bin/node" "--env-file=${join(dir, "service.env")}" "/opt/openhoard/apps/cli/dist/bin.js" "--data-dir" "${dir}" "serve"`,
    );
    expect(readFileSync(join(dir, "service.env"), "utf8")).toContain(
      "\nOPENHOARD_AUTH_ENTRA_CLIENT_SECRET='s3cr#t'\n",
    );
    expect(readFileSync(join(dir, "service.env"), "utf8")).not.toContain("PATH");
    if (process.platform !== "win32")
      expect(statSync(join(dir, "service.env")).mode & 0o777).toBe(0o600);
    expect(run.ran.slice(-2)).toEqual([
      "systemctl daemon-reload",
      "systemctl enable --now openhoard",
    ]);
    expect(run.err).toContain("OPENHOARD_AUTH_ENTRA_CLIENT_SECRET");
    expect(run.err).not.toContain("s3cr#t");
  });

  it("keeps an existing service.env, and refuses to install twice", async () => {
    writeFileSync(join(dir, "service.env"), "OPENHOARD_LOG_LEVEL='debug'\n");
    expect((await service(["install"])).code).toBe(0);
    expect(readFileSync(join(dir, "service.env"), "utf8")).toBe("OPENHOARD_LOG_LEVEL='debug'\n");
    const again = await service(["install"]);
    expect([again.code, again.err]).toEqual([1, expect.stringContaining("is installed")]);
  });

  it("refuses without root, as root, or with a config the server wouldn't load", async () => {
    expect((await service(["install"], { uid: 1000 })).err).toContain("needs root");
    expect((await service(["install", "--user", "root"])).err).toContain("is root");
    writeFileSync(join(dir, "config.json"), '{"port": "many"}');
    const bad = await service(["install"]);
    expect([bad.code, bad.err]).toEqual([1, expect.stringContaining("wouldn't start")]);
    expect(existsSync(join(root, "units", "openhoard.service"))).toBe(false);
  });

  it("on macOS, a launchd daemon logging to the data directory", async () => {
    const run = await service(["install"], { platform: "darwin" });
    expect(run.code).toBe(0);
    const plist = readFileSync(join(root, "units", "org.openhoard.openhoard.plist"), "utf8");
    expect(plist).toContain("<key>UserName</key>\n  <string>oh</string>");
    expect(plist).toContain(`<string>${join(dir, "logs", "server.log")}</string>`);
    expect(run.ran.at(-1)).toMatch(/^launchctl bootstrap system /);
  });
});

describe("service install on Windows", () => {
  it("is a task at startup as the person installing it, running `service run`", async () => {
    const ran: string[] = [];
    const run = await service(["install"], {
      platform: "win32",
      env: { USERDOMAIN: "CONTOSO", USERNAME: "steve", OPENHOARD_PORT: "7420" },
      // The task isn't there yet; then everything succeeds.
      exec: (file, args) => {
        ran.push([file, ...args].join(" "));
        return Promise.resolve({ code: args[0] === "/Query" ? 1 : 0, output: "" });
      },
    });
    expect(run.code).toBe(0);
    expect(ran).toContain(
      `icacls ${dir} /inheritance:r /grant:r CONTOSO\\steve:(OI)(CI)F *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F`,
    );
    expect(ran.at(-1)).toBe("schtasks /Run /TN openhoard");
    expect(parseEnv(readFileSync(join(dir, "service.env"), "utf8"))).toEqual({
      OPENHOARD_PORT: "7420",
    });
    expect(run.err).toContain("as CONTOSO\\steve");
  });
});

describe("service run", () => {
  it("starts the server again after it fails, and ends when it exits cleanly", async () => {
    const script = join(root, "server.mjs");
    const count = join(root, "count");
    writeFileSync(
      script,
      `import { appendFileSync, readFileSync } from "node:fs";
       appendFileSync(${JSON.stringify(count)}, "x");
       console.log("started", process.env.OPENHOARD_SUPERVISED);
       process.exit(readFileSync(${JSON.stringify(count)}, "utf8").length === 1 ? 1 : 0);`,
    );
    writeFileSync(join(dir, "service.env"), "");
    const code = await runService(["run", "--data-dir", dir], {
      platform: "win32",
      script,
      env: process.env,
      out: () => undefined,
      err: () => undefined,
    });
    expect(code).toBe(0);
    const log = readFileSync(join(dir, "logs", "server.log"), "utf8");
    expect(log).toMatch(/started 1\n.*exit 1.*again in 5 s\nstarted 1\n/s);
  }, 20_000);
});

describe("service.env", () => {
  it("quotes values so Node reads them back as they were, and refuses what it can't hold", () => {
    const env = {
      OPENHOARD_A: "it's",
      OPENHOARD_B: "C:\\x y\\z # $HOME",
      OPENHOARD_DATA_DIR: "/d",
    };
    expect(parseEnv(envFileText(env))).toEqual({
      OPENHOARD_A: "it's",
      OPENHOARD_B: "C:\\x y\\z # $HOME",
    });
    expect(() => envFileText({ OPENHOARD_C: "a\nb" })).toThrow(/line break/);
  });
});

describe.skipIf(process.platform === "win32")("service start, stop, uninstall", () => {
  it("runs the OS's commands; uninstall goes ahead when it isn't running", async () => {
    expect((await service(["stop"])).ran).toEqual(["systemctl stop openhoard"]);
    const gone = await service(["uninstall"], {
      exec: (file, args) => Promise.resolve({ code: args[0] === "stop" ? 5 : 0, output: "" }),
    });
    expect([gone.code, gone.err]).toEqual([0, expect.stringContaining("removed openhoard")]);
    expect((await service(["restart"])).code).toBe(2);
  });
});
