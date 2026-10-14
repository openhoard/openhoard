import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "@openhoard/core-db";
import { HEALTH_TIMEOUT_MS } from "./app.js";
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

  it("works the job queues unless told not to", () => {
    expect(loadConfig({}, tmp()).jobs).toEqual({ worker: true });
    const cwd = withConfigFile(JSON.stringify({ jobs: { worker: false } }));
    expect(loadConfig({}, cwd).jobs).toEqual({ worker: false });
    expect(loadConfig({ OPENHOARD_JOBS_WORKER: "true" }, cwd).jobs).toEqual({ worker: true });
    expect(loadConfig({ OPENHOARD_JOBS_WORKER: "false" }, tmp()).jobs).toEqual({ worker: false });
    expect(() => loadConfig({ OPENHOARD_JOBS_WORKER: "no" }, tmp())).toThrow(/jobs\.worker:/);
    expect(() => loadConfig({}, withConfigFile(JSON.stringify({ jobs: { workers: 2 } })))).toThrow(
      /jobs: Unrecognized key.*workers/,
    );
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

  it("says unavailable on /healthz when the database doesn't answer, or while shutting down", async () => {
    const withDb = (tenantIds: () => Promise<string[]>, stopping = () => false) =>
      createApp(loadConfig({}, tmp()), undefined, {
        db: { tenantIds } as unknown as Database,
        stopping,
      });
    const up = await withDb(async () => []).request("/healthz");
    expect(up.status).toBe(200);
    expect(await up.json()).toEqual({ status: "ok" });
    expect(up.headers.get("cache-control")).toBe("no-store");
    // The database refuses: 503, and nothing of why.
    const down = await withDb(async () => {
      throw new Error("connection refused to db.internal:5432");
    }).request("/healthz");
    expect(down.status).toBe(503);
    expect(await down.text()).toBe('{"status":"unavailable"}');
    // The database hangs: 503 after the limit, not a hung probe.
    vi.useFakeTimers();
    try {
      const hung = withDb(() => new Promise<string[]>(() => {})).request("/healthz");
      await vi.advanceTimersByTimeAsync(HEALTH_TIMEOUT_MS + 1);
      expect((await hung).status).toBe(503);
    } finally {
      vi.useRealTimers();
    }
    // One check at a time: requests while one runs share it.
    let calls = 0;
    let answer: (ids: string[]) => void = () => {};
    const shared = withDb(() => {
      calls++;
      return new Promise<string[]>((resolve) => {
        answer = resolve;
      });
    });
    const both = [shared.request("/healthz"), shared.request("/healthz")];
    await new Promise((r) => setTimeout(r, 10));
    answer([]);
    expect((await Promise.all(both)).map((r) => r.status)).toEqual([200, 200]);
    expect(calls).toBe(1);
    // PGlite runs in this process, one transaction at a time: a check stuck behind a long one is
    // busy, not down. Only an error fails it there.
    vi.useFakeTimers();
    try {
      const busy = createApp(loadConfig({}, tmp()), undefined, {
        db: {
          kind: "pglite",
          tenantIds: () => new Promise<string[]>(() => {}),
        } as unknown as Database,
      }).request("/healthz");
      await vi.advanceTimersByTimeAsync(HEALTH_TIMEOUT_MS + 1);
      expect((await busy).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
    // Shutting down: 503 without asking the database.
    let asked = 0;
    const stopping = await withDb(
      async () => {
        asked++;
        return [];
      },
      () => true,
    ).request("/healthz");
    expect(stopping.status).toBe(503);
    expect(asked).toBe(0);
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
