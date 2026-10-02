import { crc32, deflateSync } from "node:zlib";
import type { Hono } from "hono";
import type { AuthEnv } from "./auth.js";
import { escapeHtml } from "./oauth/pages.js";

/*
 * The installable page (T-1206), until the web app (T-901): `/app/` uploads files, and, once
 * installed (a PWA), puts OpenHoard in the share sheet of Android, Windows and ChromeOS (Web
 * Share Target). Mounted with uploads (`uploads` in the config).
 *
 *   GET  /app/                       the page: pick or drop files; lists the caller's uploads
 *   GET  /app/app.js                 its script
 *   GET  /app/sw.js                  its service worker (scope /app/)
 *   GET  /app/manifest.webmanifest   the manifest, with the share target
 *   GET  /app/icon-192.png, -512.png the icon, drawn here
 *   POST /app/share                  where the system sends a share: the service worker's
 *
 * - A share never reaches the server as a form. The service worker takes the system's POST in
 *   the browser, keeps the files in a cache of its own, and opens the page, which shows what
 *   was shared and, on Save, uploads each one as any other file (uploads.ts), dropping it from
 *   the cache once the server has it. So the upload is an ordinary same-origin request (the
 *   CSRF check holds), and a share made while signed out waits in the browser through the
 *   sign-in instead of being lost.
 * - Save is a click on purpose. Any site can post a form to `/app/share` in a browser that has
 *   the page, and the worker can't tell that from the system's share (it sees no Origin). Sent
 *   on arrival, another site's files would land in the person's hoard, under their name, for
 *   models to read. Shown first, they are named and one tap from being discarded; Save sends
 *   what the list showed, not what arrived since. The worker also leaves alone a POST that
 *   isn't a page's navigation or says it comes from another site, and keeps 50 files at most.
 * - Shared text or a link, with no file, becomes a small text file.
 * - The page and the assets hold nothing of anyone's: only the page needs a session, and what
 *   it shows it fetches from the API.
 * - Installing needs https (or localhost); so does a service worker. Over plain http on a LAN
 *   the page still uploads; it only can't be a share target.
 */

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem;color:#1d1d1f;background:#fafaf7}
h1{font-size:1.4rem}h2{font-size:1.05rem;margin-top:1.5rem}
#oh-drop{border:2px dashed #8a5a00;border-radius:10px;padding:1.5rem 1rem;text-align:center}
#oh-drop.over{background:#fff3cd}
input[type=file]{font:inherit;max-width:100%}
ul{padding-left:1.2rem}li{overflow-wrap:anywhere}.muted{color:#666;font-size:.9rem}
button{font:inherit;padding:.5rem 1rem;margin:.25rem .5rem .25rem 0;border-radius:6px;border:1px solid #888;background:#fff;color:inherit;cursor:pointer}
button.primary{background:#8a5a00;border-color:#8a5a00;color:#fff}
#oh-shared{border:1px solid #e0c060;background:#fff3cd;border-radius:10px;padding:.25rem 1rem;margin-top:1rem}
@media (prefers-color-scheme:dark){body{background:#17171a;color:#eee}#oh-drop.over{background:#3a3000}.muted{color:#aaa}button{background:#222}#oh-shared{background:#3a3000}}`;

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; " +
  "img-src 'self'; manifest-src 'self'; worker-src 'self'; form-action 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'";

function appPage(maxBytes: number): string {
  const mib = Math.floor(maxBytes / (1024 * 1024));
  const limit = mib >= 1 ? `${mib} MB` : `${maxBytes} bytes`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><meta name="theme-color" content="#8a5a00"><title>OpenHoard</title><link rel="manifest" href="/app/manifest.webmanifest"><link rel="icon" href="/app/icon-192.png"><link rel="apple-touch-icon" href="/app/icon-192.png"><style>${STYLE}</style><script src="/app/app.js" defer></script></head><body>
<h1>OpenHoard</h1>
<div id="oh-drop" data-max="${maxBytes}"><p><label for="oh-files">Add files to OpenHoard</label></p><p><input type="file" id="oh-files" multiple></p><p class="muted">Or drop them here. Up to ${escapeHtml(limit)} each. Only you can read what you add, until you share it.</p></div>
<div id="oh-shared" hidden><h2>Shared with OpenHoard</h2><ul id="oh-shared-list"></ul><p><button type="button" id="oh-save" class="primary">Save</button><button type="button" id="oh-discard">Discard</button></p></div>
<p id="oh-status" role="status"></p>
<ul id="oh-sent"></ul>
<h2>Your uploads</h2>
<ul id="oh-recent"><li class="muted">Loading…</li></ul>
<p class="muted">Install this page (the browser's menu: Install, or Add to Home screen) and OpenHoard appears where you share from other apps.</p>
<noscript><p>Adding files here needs JavaScript.</p></noscript>
</body></html>`;
}

/** The share cache's name, and the header a kept file's name rides in: the worker's and the page's. */
const SHARED = "oh-shared-v1";

export const APP_SCRIPT = `(() => {
  "use strict";
  const SHARED = ${JSON.stringify(SHARED)};
  const $ = (id) => document.getElementById(id);
  const sent = $("oh-sent"), recent = $("oh-recent"), status = $("oh-status"), drop = $("oh-drop"), input = $("oh-files");
  const box = $("oh-shared"), boxList = $("oh-shared-list"), save = $("oh-save"), discard = $("oh-discard");
  const max = Number(drop.dataset.max) || 0;
  const line = (text) => { const li = document.createElement("li"); li.textContent = text; sent.prepend(li); return li; };
  let busy = Promise.resolve();
  let leaving = false;

  // "kept": the server has it. "gone": it will never take it. "later": worth another try
  // (it stays where it is). "sign-in": nobody is signed in; the page is leaving for that.
  async function send(blob, name, type) {
    if (leaving) return "sign-in";
    const li = line(name + ": sending…");
    if (max && blob.size > max) { li.textContent = name + ": too large"; return "gone"; }
    let res;
    try {
      // (A name with half a character in it can't be encoded: that throws here, too.)
      res = await fetch("/api/uploads?name=" + encodeURIComponent(name), {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": type || "application/octet-stream" },
        body: blob,
      });
    } catch (e) {
      if (e instanceof URIError) { li.textContent = name + ": its name can't be sent"; return "gone"; }
      li.textContent = name + ": could not reach the server";
      return "later";
    }
    if (res.status === 401) {
      leaving = true;
      li.textContent = name + ": sign in first";
      location.assign("/auth/sign-in?return_to=" + encodeURIComponent("/app/"));
      return "sign-in";
    }
    if (res.ok) {
      li.textContent = name + (res.status === 201 ? ": saved" : ": already here");
      return "kept";
    }
    let why = "refused (" + res.status + ")";
    if (res.status === 413) why = "too large";
    else { try { why = (await res.json()).error || why; } catch {} }
    li.textContent = name + ": " + why;
    // Only what the file itself is refused for: anything else (who is asking, how the server
    // is set up) may be different next time.
    return res.status === 400 || res.status === 413 || res.status === 415 ? "gone" : "later";
  }

  async function list() {
    try {
      const res = await fetch("/api/uploads", { credentials: "same-origin" });
      if (!res.ok) { recent.replaceChildren(); return; }
      const { uploads } = await res.json();
      recent.replaceChildren();
      for (const u of uploads) {
        const li = document.createElement("li");
        li.textContent = u.title;
        // Saved from the web: a link back to where it is from.
        if (typeof u.url === "string" && /^https?:\\/\\//.test(u.url)) {
          const a = document.createElement("a");
          a.href = u.url; a.rel = "noopener noreferrer"; a.target = "_blank"; a.textContent = "original";
          li.append(" (", a, ")");
        }
        recent.append(li);
      }
      if (uploads.length === 0) {
        const li = document.createElement("li");
        li.className = "muted";
        li.textContent = "Nothing yet.";
        recent.append(li);
      }
    } catch {}
  }

  function add(files) {
    busy = busy.then(async () => {
      for (const f of files) if ((await send(f, f.name || "Untitled", f.type)) === "sign-in") return;
      await list();
    }).catch(() => {});
  }

  // What the service worker kept from a share: shown, and sent when the person says so.
  const nameOf = (res) => {
    try { return decodeURIComponent(res.headers.get("x-oh-name") || "") || "Shared"; } catch { return "Shared"; }
  };
  async function waiting() {
    if (!("caches" in window)) return [];
    const cache = await caches.open(SHARED);
    const found = [];
    for (const key of await cache.keys()) {
      const res = await cache.match(key);
      if (res) found.push({ cache, key, res, name: nameOf(res) });
    }
    return found;
  }
  // What the list shows, by cache key: Save sends these and nothing that arrived since.
  let shown = new Set();
  async function show() {
    const found = await waiting();
    shown = new Set(found.map((f) => f.key.url));
    boxList.replaceChildren();
    for (const f of found) {
      const li = document.createElement("li");
      li.textContent = f.name;
      boxList.append(li);
    }
    box.hidden = found.length === 0;
    save.disabled = discard.disabled = false;
  }
  function act(keep) {
    save.disabled = discard.disabled = true;
    const these = shown;
    busy = busy.then(async () => {
      let left = 0;
      try {
        for (const f of await waiting()) {
          if (!these.has(f.key.url)) continue;
          const done = keep ? await send(await f.res.blob(), f.name, f.res.headers.get("content-type")) : "gone";
          if (done === "sign-in") return;
          if (done === "later") left++;
          else await f.cache.delete(f.key);
        }
      } finally {
        if (!leaving) {
          status.textContent = left ? "Some of what was shared isn't saved yet: Save tries again." : "";
          await show().catch(() => {});
          await list();
        }
      }
    }).catch(() => {});
  }
  save.addEventListener("click", () => act(true));
  discard.addEventListener("click", () => act(false));

  input.addEventListener("change", () => { add([...input.files]); input.value = ""; });
  // A file dropped beside the box mustn't replace the page.
  for (const type of ["dragover", "drop"]) window.addEventListener(type, (e) => e.preventDefault());
  for (const type of ["dragenter", "dragover"]) drop.addEventListener(type, () => drop.classList.add("over"));
  for (const type of ["dragleave", "drop"]) drop.addEventListener(type, () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { if (e.dataTransfer) add([...e.dataTransfer.files]); });

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).catch(() => {});
  if (location.search.includes("shared=missed")) status.textContent = "That share didn't arrive. This page is ready now: share it again.";
  if (history.replaceState && location.search) history.replaceState(null, "", "/app/");
  show().catch(() => {});
  list();
})();
`;

export const SERVICE_WORKER = `"use strict";
const SHARED = ${JSON.stringify(SHARED)};
const MOST = 50;
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// A share from the system (the manifest's share_target): keep what came, then open the page,
// which shows it and sends it. Nothing else is handled here: every other request goes to the
// network.
async function keep(request) {
  const form = await request.formData();
  const cache = await caches.open(SHARED);
  // At most MOST wait at once, whatever sends them.
  const room = MOST - (await cache.keys()).length;
  const stamp = Date.now() + "-" + Math.random().toString(36).slice(2);
  // A name that can't be encoded (half a character) is no reason to lose the file.
  const header = (name) => { try { return encodeURIComponent(name); } catch { return "Shared"; } };
  const put = (n, body, name, type) =>
    cache.put("/app/shared/" + stamp + "-" + n, new Response(body, {
      headers: { "content-type": type || "application/octet-stream", "x-oh-name": header(name) },
    }));
  let n = 0;
  for (const f of form.getAll("files")) {
    if (typeof f === "string" || n >= room) continue;
    await put(n++, f, f.name || "Shared", f.type);
  }
  if (n === 0 && room > 0) {
    const text = (k) => { const v = form.get(k); return typeof v === "string" ? v.trim() : ""; };
    const parts = [text("title"), text("text"), text("url")].filter(Boolean);
    if (parts.length > 0) {
      const name = (text("title") || "Shared note").slice(0, 120) + ".txt";
      await put(n++, parts.join("\\n\\n") + "\\n", name, "text/plain; charset=utf-8");
    }
  }
  return n;
}

// Whether a request says it comes from another site. (The system's share names none.)
function foreign(request) {
  if (!request.referrer) return false;
  try { return new URL(request.referrer).origin !== self.location.origin; } catch { return true; }
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "POST" || url.origin !== self.location.origin || url.pathname !== "/app/share") return;
  // A share opens the page: a form posted into a frame, or by a script, isn't one.
  if (e.request.mode !== "navigate" || e.request.destination !== "document") return;
  if (foreign(e.request)) return;
  e.respondWith(
    keep(e.request).then(
      (n) => Response.redirect(n > 0 ? "/app/?shared=1" : "/app/", 303),
      () => Response.redirect("/app/?shared=missed", 303),
    ),
  );
});
`;

const MANIFEST = JSON.stringify({
  name: "OpenHoard",
  short_name: "OpenHoard",
  description: "Add files to OpenHoard.",
  id: "/app/",
  start_url: "/app/",
  scope: "/app/",
  display: "standalone",
  background_color: "#fafaf7",
  theme_color: "#8a5a00",
  icons: [
    { src: "/app/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/app/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/app/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
  share_target: {
    action: "/app/share",
    method: "POST",
    enctype: "multipart/form-data",
    params: {
      title: "title",
      text: "text",
      url: "url",
      files: [{ name: "files", accept: ["*/*"] }],
    },
  },
});

/**
 * The icon, as a PNG of `size` pixels: a white ring on the brand's amber, full-bleed with the
 * ring inside the middle 60 % (so a mask of any shape keeps it whole). Drawn here so the server
 * ships no binary file.
 */
export function iconPng(size: number): Uint8Array {
  const row = 1 + size * 3;
  const raw = Buffer.alloc(row * size);
  const mid = (size - 1) / 2;
  const [outer, inner] = [size * 0.3, size * 0.17];
  // Coverage of the ring at a distance from the centre: 1 inside it, fading over a pixel.
  const cover = (d: number) =>
    Math.max(0, Math.min(1, outer + 0.5 - d)) * Math.max(0, Math.min(1, d - inner + 0.5));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = cover(Math.hypot(x - mid, y - mid));
      const at = y * row + 1 + x * 3;
      raw[at] = Math.round(0x8a + (0xff - 0x8a) * a);
      raw[at + 1] = Math.round(0x5a + (0xff - 0x5a) * a);
      raw[at + 2] = Math.round(0x00 + 0xff * a);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits a channel, RGB, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function mountWebApp(app: Hono<AuthEnv>, deps: { maxBytes: number }): void {
  const icons = new Map<number, Uint8Array>();
  const asset = (type: string) => ({ "content-type": type, "cache-control": "no-cache" });

  app.get("/app", (c) => c.redirect("/app/", 302));
  app.get("/app/", (c) => {
    c.header("cache-control", "no-store");
    if (!c.get("auth")) {
      return c.redirect(`/auth/sign-in?return_to=${encodeURIComponent("/app/")}`, 302);
    }
    c.header("content-security-policy", CSP);
    return c.html(appPage(deps.maxBytes));
  });
  app.get("/app/app.js", (c) => c.body(APP_SCRIPT, 200, asset("text/javascript; charset=utf-8")));
  app.get("/app/sw.js", (c) =>
    c.body(SERVICE_WORKER, 200, asset("text/javascript; charset=utf-8")),
  );
  app.get("/app/manifest.webmanifest", (c) =>
    c.body(MANIFEST, 200, asset("application/manifest+json")),
  );
  for (const size of [192, 512]) {
    app.get(`/app/icon-${size}.png`, (c) => {
      let png = icons.get(size);
      if (!png) icons.set(size, (png = iconPng(size)));
      return c.body(png as Uint8Array<ArrayBuffer>, 200, {
        "content-type": "image/png",
        "cache-control": "public, max-age=86400",
      });
    });
  }
}

/**
 * A share the service worker didn't take (not yet active in this browser, or the request named
 * another site): to the page, which says so. Nothing of the request is read, and it changes
 * nothing, so it is mounted before sign-in's checks: the system's POST carries the person's
 * cookie and no Origin of this server's, and would get their refusal instead of the page.
 */
export function mountShareFallback(app: Hono<AuthEnv>): void {
  app.get("/app/share", (c) => c.redirect("/app/", 302));
  app.post("/app/share", (c) => c.redirect("/app/?shared=missed", 303));
}
