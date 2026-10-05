import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import type { Hono } from "hono";
import type { Logger } from "pino";
import type { AuthEnv } from "./auth.js";

/*
 * The admin web app (T-901): the static files apps/web builds, served at /admin/.
 *
 *   GET /admin                redirects to /admin/
 *   GET /admin/               the page (index.html)
 *   GET /admin/assets/<file>  its script and styles, named by their content
 *   GET /admin/<anything>     the page again: the app has pages of its own under /admin/
 *
 * - The files hold nothing of anyone's, so they need no session. What the app shows it asks
 *   the API for as the signed-in person (/auth/me, /api/admin/*), and the API decides.
 * - Only what was in the build when the server started is served, from memory: a request's
 *   path picks a name out of that list and is never joined to a directory.
 * - The page's Content-Security-Policy allows this origin's own script, styles and images and
 *   requests to this origin: nothing inline, nothing from anywhere else, no framing.
 */

export const ADMIN_UI_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; " +
  "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

/** Most files and bytes a build may hold: a wrong directory isn't read into memory whole. */
const MAX_FILES = 500;
const MAX_BYTES = 32 * 1024 * 1024;

interface Served {
  body: Uint8Array<ArrayBuffer>;
  type: string;
}

/** Where apps/web's build is, when the package is installed beside the server; else null. */
export function builtAdminUi(): string | null {
  try {
    const pkg = createRequire(import.meta.url).resolve("@openhoard/web/package.json");
    const dist = join(dirname(pkg), "dist");
    return existsSync(join(dist, "index.html")) ? dist : null;
  } catch {
    return null;
  }
}

/** Every file of a build, by its path under the directory ("index.html", "assets/x.js"). */
function readBuild(dir: string): Map<string, Served> | "too-large" | null {
  const files = new Map<string, Served>();
  let bytes = 0;
  const walk = (at: string, prefix: string): boolean => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) {
        if (!walk(join(at, entry.name), `${name}/`)) return false;
        continue;
      }
      // A link could point anywhere on the machine: a build has none.
      if (!entry.isFile()) continue;
      const type = TYPES[extname(entry.name).toLowerCase()];
      if (type === undefined) continue;
      bytes += statSync(join(at, entry.name)).size;
      if (files.size + 1 > MAX_FILES || bytes > MAX_BYTES) return false;
      const read = readFileSync(join(at, entry.name));
      files.set(name, { body: new Uint8Array(read), type });
    }
    return true;
  };
  try {
    if (!walk(dir, "")) return "too-large";
  } catch {
    return null;
  }
  return files.has("index.html") ? files : null;
}

/**
 * Serves the build in `dir` at /admin/. Returns whether it did: without a build (a checkout
 * nobody ran `pnpm build` in) the server runs as before, and says so once.
 */
export function mountAdminUi(
  app: Hono<AuthEnv>,
  deps: { dir: string | null; log?: Logger },
): boolean {
  const files = deps.dir === null ? null : readBuild(deps.dir);
  if (files === null || files === "too-large") {
    deps.log?.warn(
      { dir: deps.dir },
      files === null
        ? "admin web app: no build found (pnpm build makes it); /admin/ is not served"
        : "admin web app: the directory holds more than a build would; /admin/ is not served",
    );
    return false;
  }
  const index = files.get("index.html") as Served;

  const headers = (file: Served, cache: string) => ({
    "content-type": file.type,
    "cache-control": cache,
    "content-security-policy": ADMIN_UI_CSP,
  });

  app.get("/admin", (c) => c.redirect("/admin/", 302));
  app.get("/admin/*", (c) => {
    const name = c.req.path.slice("/admin/".length);
    const file = name === "index.html" ? undefined : files.get(name);
    if (file) {
      // Under assets/ a file's name is its content's: it never changes. The rest are asked for
      // again each time.
      const cache = name.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache";
      return c.body(file.body, 200, headers(file, cache));
    }
    // A missing file is missing; any other path is one of the app's pages (a page's path may
    // have a dot in it: a source is named `finance.docs`).
    if (name.startsWith("assets/") || TYPES[extname(name).toLowerCase()] !== undefined) {
      return c.json({ error: "not found" }, 404);
    }
    return c.body(index.body, 200, headers(index, "no-cache"));
  });
  deps.log?.debug({ files: files.size }, "admin web app mounted at /admin/");
  return true;
}
