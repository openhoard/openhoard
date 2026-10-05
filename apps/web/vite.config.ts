import { defineConfig } from "vite";

/*
 * The admin web app is built to static files the server serves at /admin/ (apps/server
 * admin-ui.ts), under a Content-Security-Policy that allows this origin's own files and nothing
 * else. So: nothing inlined into the page or the styles (no data: URLs), and no source maps
 * pointing anywhere.
 *
 * `pnpm dev` serves it with reloads, sending /auth and /api to a server on this machine
 * (OPENHOARD_DEV_SERVER, http://127.0.0.1:7420 by default). Sign in at that server first: the
 * session cookie is the host's, so the dev page has it too.
 */
export default defineConfig({
  base: "/admin/",
  esbuild: { jsx: "automatic" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
  server: {
    proxy: Object.fromEntries(
      ["/auth", "/api"].map((path) => [
        path,
        {
          target: process.env.OPENHOARD_DEV_SERVER ?? "http://127.0.0.1:7420",
          changeOrigin: false,
        },
      ]),
    ),
  },
});
