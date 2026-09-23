import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp, loadConfig } from "./index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "oh-server-"));

describe("loadConfig", () => {
  it("uses defaults with no file or env", () => {
    const cwd = tmp();
    const c = loadConfig({}, cwd);
    expect(c).toMatchObject({ host: "127.0.0.1", port: 7420, logLevel: "info" });
    expect(c.dataDir).toBe(join(cwd, ".openhoard"));
    expect(c.database.url).toBe("pglite");
  });

  it("layers env over file", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".openhoard"));
    writeFileSync(
      join(cwd, ".openhoard", "config.json"),
      JSON.stringify({ port: 9000, host: "0.0.0.0" }),
    );
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
});

type Json = Record<string, unknown>;
const json = async (res: Response | Promise<Response>) => (await (await res).json()) as Json;

describe("HTTP app", () => {
  const app = createApp(loadConfig({}, tmp()));

  it("serves health, version and root", async () => {
    expect(await json(app.request("/healthz"))).toEqual({ status: "ok" });
    expect((await json(app.request("/version"))).name).toBe("openhoard");
    expect((await json(app.request("/"))).database).toBe("embedded (PGlite)");
  });

  it("reports postgres when configured", async () => {
    const pg = createApp(loadConfig({ OPENHOARD_DATABASE_URL: "postgres://x/y" }, tmp()));
    expect((await json(pg.request("/"))).database).toBe("postgres");
  });

  it("returns JSON 404s", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "not found" });
  });
});
