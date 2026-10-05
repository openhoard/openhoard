import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDatabase } from "@openhoard/core-db/testing";
import { Hono } from "hono";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_UI_CSP, builtAdminUi, mountAdminUi } from "./admin-ui.js";
import { createApp } from "./app.js";
import type { AuthEnv } from "./auth.js";
import { ConfigSchema } from "./config.js";

/*
 * T-901, the server's half: the admin web app's build served at /admin/. (The app itself is
 * tested in apps/web; "works in current Chrome, Edge, Safari, Firefox" is a run in each.)
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oh-admin-ui-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>the page</title>");
  writeFileSync(join(dir, "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(join(dir, "assets", "index-abc123.js"), "console.log('app')");
  writeFileSync(join(dir, "assets", "index-abc123.css"), "body{}");
  writeFileSync(join(dir, "notes.txt"), "not part of a build");
  writeFileSync(join(dir, "secret.env"), "KEY=1");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function served(from: string | null = dir) {
  const app = new Hono<AuthEnv>();
  const logged: string[] = [];
  const log = pino({ level: "warn" }, { write: (line: string) => void logged.push(line) });
  const mounted = mountAdminUi(app, { dir: from, log });
  return { app, mounted, logged };
}

describe("the admin web app's files (T-901)", () => {
  it("serves the page at /admin/ and at every path that is one of the app's pages", async () => {
    const { app, mounted } = served();
    expect(mounted).toBe(true);

    const bare = await app.request("/admin");
    expect(bare.status).toBe(302);
    expect(bare.headers.get("location")).toBe("/admin/");

    const pages = ["/admin/", "/admin/review", "/admin/audit/evt_123", "/admin/a/b/"];
    // A page's path may have a dot in it (a source's name).
    pages.push("/admin/sources/finance.docs", "/admin/notes.txt");
    for (const path of pages) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("content-security-policy")).toBe(ADMIN_UI_CSP);
      // A new build is seen on the next load.
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(await res.text()).toContain("the page");
    }
  });

  it("serves the build's files by name: assets for good, the rest checked each time", async () => {
    const { app } = served();
    const js = await app.request("/admin/assets/index-abc123.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(js.headers.get("content-security-policy")).toBe(ADMIN_UI_CSP);
    expect(await js.text()).toBe("console.log('app')");

    const css = await app.request("/admin/assets/index-abc123.css");
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");

    const logo = await app.request("/admin/logo.svg");
    expect(logo.headers.get("content-type")).toBe("image/svg+xml");
    expect(logo.headers.get("cache-control")).toBe("no-cache");
    // An SVG opened as a page of its own runs nothing either.
    expect(logo.headers.get("content-security-policy")).toBe(ADMIN_UI_CSP);
  });

  it("answers a missing file with 404, not with the page", async () => {
    const { app } = served();
    for (const path of [
      "/admin/assets/index-old.js",
      "/admin/assets/",
      "/admin/missing.png",
      "/admin/index.html",
    ]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
    }
  });

  it("serves nothing that isn't a web file of the build, wherever the path points", async () => {
    symlinkSync(join(dir, "secret.env"), join(dir, "linked.js"));
    const { app } = served();
    // (`/admin/../x` never gets here as written: whatever parses the URL resolves the dots
    // first. An encoded slash does, and the router decodes it.)
    for (const path of [
      "/admin/notes.txt",
      "/admin/secret.env",
      "/admin/linked.js",
      "/admin/..%2f..%2fpackage.json",
      "/admin/assets/..%2fsecret.env",
      "/admin/assets%2f..%2fsecret.env",
    ]) {
      const res = await app.request(path);
      const body = await res.text();
      expect(body, path).not.toContain("KEY=1");
      expect(body, path).not.toContain("not part of a build");
      expect(body, path).not.toContain('"name"');
      expect([200, 404], path).toContain(res.status);
      if (res.status === 200) expect(body).toContain("the page");
    }
  });

  it("serves nothing, and says so once, where there is no build", async () => {
    for (const from of [null, join(dir, "nowhere"), join(dir, "assets")]) {
      const { app, mounted, logged } = served(from);
      expect(mounted).toBe(false);
      expect((await app.request("/admin/")).status).toBe(404);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain("no build found");
    }
  });

  it("refuses a directory too large to be a build, and says that", async () => {
    for (let i = 0; i < 520; i++) writeFileSync(join(dir, "assets", `chunk-${i}.js`), "");
    const { mounted, logged } = served();
    expect(mounted).toBe(false);
    expect(logged[0]).toContain("more than a build would");
  });
});

describe("the admin web app as built (T-901)", () => {
  it("is served by the server, and loads nothing its policy would refuse", async () => {
    const built = builtAdminUi();
    expect(built, "apps/web is built before the server's tests (turbo: ^build)").not.toBeNull();

    const db = await openTestDatabase();
    try {
      const config = ConfigSchema.parse({
        dataDir: "/tmp/unused",
        auth: {
          publicUrl: "https://hoard.example",
          cookieKey: "k".repeat(43),
          providers: [
            {
              id: "dev",
              kind: "generic",
              tenantId: "ten_00000000000000000000000000",
              issuer: "https://idp.example",
              clientId: "openhoard-test",
            },
          ],
        },
      });
      const app = createApp(config, undefined, { db });

      // Nobody is signed in: the page is still the page (it asks who is there itself).
      const page = await app.request("/admin/");
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toBe(ADMIN_UI_CSP);
      expect(page.headers.get("x-content-type-options")).toBe("nosniff");
      expect(page.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      const html = await page.text();

      // Nothing inline: the policy has no 'unsafe-inline'.
      expect(html).not.toMatch(/<style[\s>]/i);
      expect(html).not.toMatch(/\sstyle\s*=/i);
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)];
      expect(scripts.length).toBeGreaterThan(0);
      for (const [, attrs, body] of scripts) {
        expect(attrs).toMatch(/\ssrc="\/admin\/assets\/[^"]+"/);
        expect((body ?? "").trim()).toBe("");
      }

      // Everything the page names is this server's, under /admin/, and is there.
      const named = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1] as string);
      expect(named.length).toBeGreaterThanOrEqual(3);
      for (const url of named) {
        expect(url, url).toMatch(/^\/admin\/[^/]/);
        const res = await app.request(url);
        expect(res.status, url).toBe(200);
        await res.arrayBuffer();
      }

      // The styles reach for nothing outside either (no data: or remote url()).
      const sheet = named.find((u) => u.endsWith(".css")) as string;
      const css = await (await app.request(sheet)).text();
      expect(css).not.toMatch(/url\(/i);
      expect(css).not.toMatch(/@import/i);
    } finally {
      await db.close();
    }
  });
});
