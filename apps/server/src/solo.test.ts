import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAudit } from "@openhoard/core-audit";
import { openDatabase, type Database } from "@openhoard/core-db";
import { openTestDatabase, TEST_POSTGRES_ENV } from "@openhoard/core-db/testing";
import { findUserByEmail } from "@openhoard/core-identity";
import { startJobs } from "@openhoard/core-jobs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_ACTOR, runAdmin } from "./admin.js";
import { loadConfig } from "./config.js";
import {
  defaultDataDir,
  findStarterPack,
  PLACEHOLDER_EMAIL,
  runInit,
  soloArgument,
  soloConfigFile,
  sourceId,
  type SoloIo,
} from "./solo.js";

/*
 * T-1201: `init --solo` sets one person up on one machine in one command. On PGlite it runs
 * against a real data directory (and refuses while another process holds it); on PostgreSQL
 * against the test database.
 */

const postgres = process.env[TEST_POSTGRES_ENV] !== undefined;

let root: string;
let dir: string;
let home: string;
let shared: Database | undefined;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "oh-solo-"));
  dir = join(root, "data");
  home = join(root, "home");
  mkdirSync(home);
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
    ...(shared
      ? {
          open: async () => ({ ...(shared as Database), close: async () => {} }),
          startJobs: (_db, options) => startJobs(shared as Database, options),
        }
      : {}),
    ...extra,
  };
  return { io: value, seen };
}

async function init(...argv: string[]) {
  const { io: value, seen } = io();
  const code = await runInit(["--solo", "--data-dir", dir, ...argv], value);
  return { code, ...seen };
}

async function inspect<T>(work: (db: Database) => Promise<T>): Promise<T> {
  if (shared) return work(shared);
  const db = await openDatabase({ url: "pglite", dataDir: dir });
  try {
    return await work(db);
  } finally {
    await db.close();
  }
}

async function auditOf(tenantId: string) {
  return inspect(async (db) => {
    const lines: string[] = [];
    await exportAudit(db, tenantId, {}, "ndjson", (s: string) => void lines.push(s));
    return lines
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { actor: string; action: string; decision: string });
  });
}

describe("solo helpers", () => {
  it("finds init as the first positional argument", () => {
    expect(soloArgument(["init", "--solo"])).toEqual({ command: "init", at: 0 });
    expect(soloArgument(["--data-dir", "/x", "init", "--solo"])).toEqual({
      command: "init",
      at: 2,
    });
    expect(soloArgument(["--data-dir", "init"])).toBeUndefined();
    expect(soloArgument(["admin", "init"])).toBeUndefined();
    expect(soloArgument([])).toBeUndefined();
  });

  it("puts the data in the OS's app-data folder, not in the indexed folder", () => {
    expect(
      defaultDataDir("win32", { LOCALAPPDATA: "C:\\Users\\s\\AppData\\Local" }, "C:\\Users\\s"),
    ).toBe("C:\\Users\\s\\AppData\\Local\\OpenHoard");
    expect(defaultDataDir("win32", {}, "C:\\Users\\s")).toBe(
      "C:\\Users\\s\\AppData\\Local\\OpenHoard",
    );
    expect(defaultDataDir("darwin", {}, "/Users/s")).toBe(
      "/Users/s/Library/Application Support/OpenHoard",
    );
    expect(defaultDataDir("linux", { XDG_DATA_HOME: "/x/share" }, "/home/s")).toBe(
      "/x/share/openhoard",
    );
    expect(defaultDataDir("linux", {}, "/home/s")).toBe("/home/s/.local/share/openhoard");
    // A relative XDG_DATA_HOME is invalid (the XDG spec): ignored.
    expect(defaultDataDir("linux", { XDG_DATA_HOME: "rel" }, "/home/s")).toBe(
      "/home/s/.local/share/openhoard",
    );
  });

  it("names sources after their folders, uniquely, as lower-case slugs", () => {
    const taken = new Set<string>();
    const ids = ["/a/My Notes", "/b/my notes", "/c/Café Plans!", "/d/---", "/e/NOTES"].map((f) => {
      const id = sourceId(f, taken);
      taken.add(id);
      return id;
    });
    expect(ids).toEqual(["fs-my-notes", "fs-my-notes-2", "fs-cafe-plans", "fs-folder", "fs-notes"]);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/);
    const file = soloConfigFile("ten_" + "0".repeat(26), ["/a/Notes", "/b/Notes"], "a@b.c", true);
    expect(file.sources.map((s) => [s.id, s.zone])).toEqual([
      ["fs-notes", "Notes"],
      ["fs-notes-2", "Notes (2)"],
    ]);
  });

  it("finds the starter pack from the source and the build", () => {
    expect(findStarterPack()).toMatch(/packs[\\/]general-business[\\/]pack\.json$/);
    expect(findStarterPack(tmpdir())).toBeNull();
  });
});

// Several cold PGlite starts per test: the Windows runners need far more than the suite's 30 s.
describe("init --solo", { timeout: process.platform === "win32" ? 600_000 : 180_000 }, () => {
  it("creates the tenant, the person, their admin role, the pack and a config that loads", async () => {
    const res = await init("--name", "Steve Cook");
    expect(res.code, res.err).toBe(0);
    const tenantId = res.out.trim();
    expect(tenantId).toMatch(/^ten_[0-9a-hjkmnp-tv-z]{26}$/);

    // The default folder, made in the home folder.
    const folder = join(home, "OpenHoard");
    expect(statSync(folder).isDirectory()).toBe(true);

    // The plan was printed, loosenings marked, and it was applied.
    expect(res.err).toContain("! set-defaults defaults hidden/metadata-only -> discoverable");
    expect(res.err).toContain("Applied pack general-business");
    expect(res.err).toContain(`tenant:   ${tenantId}`);
    expect(res.err).toContain("OPENHOARD_MODEL_CLAUDE_API_KEY isn't set");
    expect(res.err).toContain("export OPENHOARD_MODEL_CLAUDE_API_KEY=<your key>");
    expect(res.err).toContain("connect claude-desktop");

    const file = join(dir, "config.json");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(written).toEqual({
      auth: { publicUrl: "http://127.0.0.1:7420", signInLinks: true },
      sources: [
        {
          id: "fs-openhoard",
          connector: "fs",
          tenantId,
          root: folder,
          zone: "OpenHoard",
          owner: PLACEHOLDER_EMAIL,
          extract: true,
        },
      ],
      models: {
        providers: [{ id: "claude", kind: "commercial", adapter: "anthropic" }],
        dailyTokenBudget: 2_000_000,
      },
    });
    const config = loadConfig({ OPENHOARD_DATA_DIR: dir });
    expect(config.auth?.signInLinks).toBe(true);
    expect(config.sources).toHaveLength(1);

    const state = await inspect((db) =>
      db.withTenant(tenantId, async (tx) => {
        const user = await findUserByEmail(tx, tenantId, PLACEHOLDER_EMAIL);
        return { user };
      }),
    );
    expect(state.user?.displayName).toBe("Steve Cook");
    expect(state.user?.source).toBe("local");
    expect(state.user?.adminRole?.by).toBe(ADMIN_ACTOR);

    const events = await auditOf(tenantId);
    expect(events.filter((e) => e.actor === ADMIN_ACTOR).map((e) => e.action)).toEqual([
      "tenant.create",
      "user.create",
      "admin.grant",
      "pack.apply",
    ]);

    // The admin commands see what it made (listed as the tenant's one admin).
    let out = "";
    const admins = await runAdmin(
      ["user", "list-admins", "--tenant", tenantId, "--data-dir", dir],
      {
        env: {},
        out: (s) => void (out += s),
        err: () => {},
        ...(shared
          ? { open: async () => ({ ...(shared as Database), close: async () => {} }) }
          : {}),
      },
    );
    expect(admins).toBe(0);
    expect(out).toContain("Steve Cook");

    // Once set up, it refuses, and says how to go on, changing nothing.
    const again = await init("--name", "Steve Cook");
    expect(again.code).toBe(1);
    expect(again.err).toContain("exists already");
    expect(again.err).toContain("--data-dir");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(written);
  });

  it("takes folders, an email and --no-extract; refuses a missing folder or one inside another", async () => {
    const a = join(root, "Notes");
    const b = join(root, "work", "Notes");
    mkdirSync(a);
    mkdirSync(b, { recursive: true });
    const missing = await init("--folder", join(root, "nope"));
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("isn't a folder");
    const nested = await init("--folder", root, "--folder", a);
    expect(nested.code).toBe(1);
    expect(nested.err).toContain("inside the other");
    // Around the data directory: refused by the config's own check, before anything is made.
    const around = await init("--folder", root);
    expect(around.code).toBe(1);
    expect(around.err).toContain("can't be inside one another");
    expect(existsSync(join(dir, "config.json"))).toBe(false);

    const res = await init(
      "--folder",
      a,
      "--folder",
      "work/Notes",
      "--email",
      "Steve@Example.com",
      "--no-extract",
      "--name",
      "Steve",
    );
    expect(res.code, res.err).toBe(0);
    const config = loadConfig({ OPENHOARD_DATA_DIR: dir });
    expect(config.sources.map((s) => [s.id, s.root, s.zone, s.owner, s.extract])).toEqual([
      ["fs-notes", a, "Notes", "Steve@Example.com", false],
      ["fs-notes-2", b, "Notes (2)", "Steve@Example.com", false],
    ]);
    expect(res.err).toContain("names and metadata only");
    expect(res.err).not.toContain("placeholder");
  });

  it("picks up the tenant a run left without its config, and only that", async () => {
    // A run that failed after the database work: the tenant and person exist, no config.
    const first = await init("--name", "Steve");
    expect(first.code, first.err).toBe(0);
    const tenantId = first.out.trim();
    rmSync(join(dir, "config.json"));

    const other = await init("--name", "Somebody Else");
    expect(other.code).toBe(1);
    expect(other.err).toContain("it won't guess");
    expect(other.err).toContain(tenantId);

    const again = await init("--name", "Steve");
    expect(again.code, again.err).toBe(0);
    expect(again.out.trim()).toBe(tenantId);
    expect(again.err).toContain("Picking up tenant");
    expect(again.err).toContain("You were its admin already.");
    expect(again.err).toContain("is applied already");
    expect(loadConfig({ OPENHOARD_DATA_DIR: dir }).sources[0]?.tenantId).toBe(tenantId);
  });

  it("refuses a bad email or misuse without making anything", async () => {
    const bad = await init("--email", "not an email");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("isn't a usable email address");
    expect(existsSync(join(dir, "config.json"))).toBe(false);
    const ids = await inspect((db) => db.tenantIds());
    expect(ids).toEqual([]);

    const { io: value, seen } = io();
    expect(await runInit(["--data-dir", dir], value)).toBe(2);
    expect(seen.err).toContain("init needs --solo");
    expect(await runInit(["--solo", "--bogus"], value)).toBe(2);
    expect(await runInit(["--help"], value)).toBe(0);
  });

  it("says when the key is set, and how to set it on Windows", async () => {
    const { io: value, seen } = io({
      platform: "win32",
      env: { OPENHOARD_MODEL_CLAUDE_API_KEY: "sk-test" },
    });
    expect(await runInit(["--solo", "--data-dir", dir], value), seen.err).toBe(0);
    expect(seen.err).toContain("is set: summaries will run");
    expect(seen.err).not.toContain("sk-test");
    rmSync(join(dir, "config.json"));
    const win = io({ platform: "win32" });
    expect(await runInit(["--solo", "--data-dir", dir], win.io), win.seen.err).toBe(0);
    expect(win.seen.err).toContain("[Environment]::SetEnvironmentVariable");
  });

  it("keeps its data in the OS's app-data folder without --data-dir", async () => {
    const appData = join(root, "appdata");
    const { io: value, seen } = io({
      platform: process.platform,
      env: { LOCALAPPDATA: appData, XDG_DATA_HOME: appData },
    });
    expect(await runInit(["--solo"], value), seen.err).toBe(0);
    const expected = defaultDataDir(process.platform, value.env ?? {}, home);
    expect(existsSync(join(expected, "config.json"))).toBe(true);
    expect(seen.err).toContain(`--data-dir "${expected}" connect claude-desktop`);
    dir = expected; // for inspect()
    expect(await inspect((db) => db.tenantIds())).toEqual([seen.out.trim()]);
  });

  it.skipIf(postgres)("refuses clearly while the server holds the embedded database", async () => {
    mkdirSync(dir, { recursive: true });
    const server = await openDatabase({ url: "pglite", dataDir: dir });
    try {
      const res = await init();
      expect(res.code).toBe(1);
      expect(res.err).toMatch(/in use, most likely by the running OpenHoard server/);
    } finally {
      await server.close();
    }
    expect(existsSync(join(dir, "config.json"))).toBe(false);
  });
});
