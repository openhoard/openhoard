import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp, createLogger, ensureDataDir, loadConfig } from "./index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "oh-server-"));

function withConfigFile(content: string): string {
  const cwd = tmp();
  mkdirSync(join(cwd, ".openhoard"));
  writeFileSync(join(cwd, ".openhoard", "config.json"), content);
  return cwd;
}

describe("loadConfig", () => {
  it("uses defaults with no file or env", () => {
    const cwd = tmp();
    const c = loadConfig({}, cwd);
    expect(c).toMatchObject({ host: "127.0.0.1", port: 7420, logLevel: "info" });
    expect(c.dataDir).toBe(join(cwd, ".openhoard"));
    expect(c.database.url).toBe("pglite");
  });

  it("layers env over file", () => {
    const cwd = withConfigFile(JSON.stringify({ port: 9000, host: "0.0.0.0" }));
    const c = loadConfig({ OPENHOARD_PORT: "9100", OPENHOARD_DATABASE_URL: "postgres://x/y" }, cwd);
    expect(c.port).toBe(9100);
    expect(c.host).toBe("0.0.0.0");
    expect(c.database.url).toBe("postgres://x/y");
  });

  it("honours a custom data dir and ignores non-object files", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, "data"));
    writeFileSync(join(cwd, "data", "config.json"), "42");
    expect(loadConfig({ OPENHOARD_DATA_DIR: "data" }, cwd).dataDir).toBe(join(cwd, "data"));
  });

  it("rejects invalid values with a readable message", () => {
    expect(() => loadConfig({ OPENHOARD_PORT: "99999" }, tmp())).toThrow(
      /invalid OpenHoard config:\n {2}port:/,
    );
  });

  it("rejects unknown keys (typos) at the top level and in nested objects", () => {
    expect(() => loadConfig({}, withConfigFile(JSON.stringify({ prot: 9000 })))).toThrow(
      /Unrecognized key.*prot/,
    );
    expect(() =>
      loadConfig({}, withConfigFile(JSON.stringify({ database: { ulr: "postgres://x" } }))),
    ).toThrow(/database: Unrecognized key.*ulr/);
  });

  it("reports malformed JSON with the file path", () => {
    expect(() => loadConfig({}, withConfigFile("{ not json"))).toThrow(/config\.json:/);
  });
});

describe("ensureDataDir", () => {
  it("creates the directory owner-only (0700) and tightens an existing one", () => {
    const dir = join(tmp(), "data");
    mkdirSync(dir, { mode: 0o755 });
    ensureDataDir(dir);
    if (process.platform !== "win32") expect(statSync(dir).mode & 0o777).toBe(0o700);
    const fresh = join(tmp(), "a", "b");
    ensureDataDir(fresh);
    expect(statSync(fresh).isDirectory()).toBe(true);
  });
});

type Json = Record<string, unknown>;
const json = async (res: Response | Promise<Response>) => (await (await res).json()) as Json;

describe("HTTP app", () => {
  const app = createApp(loadConfig({}, tmp()));

  it("serves health, version and root without fingerprinting details", async () => {
    expect(await json(app.request("/healthz"))).toEqual({ status: "ok" });
    const version = await json(app.request("/version"));
    expect(Object.keys(version).sort()).toEqual(["name", "version"]);
    const root = await json(app.request("/"));
    expect(root).not.toHaveProperty("database");
    expect(root.name).toBe("OpenHoard");
  });

  it("sends baseline security headers", async () => {
    const res = await app.request("/healthz");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("returns JSON 404s", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "not found" });
  });

  it("hides internal error details and logs requests", async () => {
    const lines: string[] = [];
    const log = createLogger({ logLevel: "info" }, { write: (s: string) => void lines.push(s) });
    const logged = createApp(loadConfig({}, tmp()), log);
    logged.get("/boom", () => {
      throw new Error("secret stack detail");
    });
    const res = await logged.request("/boom");
    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ error: "internal error" });
    await logged.request("/healthz");
    expect(lines.some((l) => l.includes('"msg":"unhandled error"'))).toBe(true);
    expect(lines.some((l) => l.includes('"path":"/healthz"') && l.includes('"status":200'))).toBe(
      true,
    );
  });
});

describe("createLogger", () => {
  it("redacts secrets", () => {
    const lines: string[] = [];
    const log = createLogger({ logLevel: "info" }, { write: (s: string) => void lines.push(s) });
    log.info({ database: { url: "postgres://user:pw@host/db" }, auth: { token: "abc" } }, "cfg");
    expect(lines.join("")).not.toContain("pw@host");
    expect(lines.join("")).not.toContain("abc");
    expect(lines.join("")).toContain("[redacted]");
  });
});
