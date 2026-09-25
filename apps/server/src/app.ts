import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { Database } from "@openhoard/core-db";
import type { Logger } from "pino";
import { mountAuth, type AuthEnv } from "./auth.js";
import type { Config } from "./config.js";
import { loginKey } from "./login-state.js";
import type { MetadataFetcher } from "./oauth/clients.js";
import { mountOAuth } from "./oauth/routes.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

export interface AppDeps {
  /** The database; needed when sign-in is configured. */
  db?: Database;
  /** Fetches MCP clients' metadata documents (tests pass their own). */
  fetchMetadata?: MetadataFetcher;
}

/** Builds the HTTP app. Kept free of listeners so tests can call it directly. */
export function createApp(config: Config, log?: Logger, deps: AppDeps = {}): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  // Baseline security headers on every response (nosniff, frame-deny, strict referrer, etc.).
  // `same-origin`, not the default `no-referrer`: under no-referrer browsers send `Origin: null`
  // on this server's own form posts (the OAuth consent), which the Origin check must see.
  app.use(secureHeaders({ referrerPolicy: "same-origin" }));

  if (log) {
    app.use(async (c, next) => {
      const started = performance.now();
      await next();
      log.info(
        {
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          ms: Math.round(performance.now() - started),
        },
        "request",
      );
    });
  }

  if (config.auth) {
    if (!deps.db) throw new Error("sign-in (auth) needs the database");
    const key = loginKey(config.auth.cookieKey);
    const shared = { auth: config.auth, db: deps.db, key, ...(log ? { log } : {}) };
    mountAuth(app, shared);
    // OpenHoard's OAuth authorization server for MCP clients (T-105), and the resource they reach.
    const { requireBearer } = mountOAuth(app, {
      ...shared,
      ...(deps.fetchMetadata ? { fetchMetadata: deps.fetchMetadata } : {}),
    });
    // Browser clients (the MCP Inspector) call /mcp across origins, with a bearer token and no
    // cookies, and must read the WWW-Authenticate challenge.
    app.use(
      "/mcp",
      cors({
        origin: "*",
        allowHeaders: ["authorization", "content-type", "mcp-protocol-version", "mcp-session-id"],
        exposeHeaders: ["www-authenticate", "mcp-session-id"],
      }),
    );
    // The MCP server arrives with T-801; until then /mcp only proves a token.
    app.all("/mcp", requireBearer(), (c) => {
      const bearer = c.get("bearer");
      return c.json(
        {
          error: "the MCP server arrives with T-801",
          signedInAs: bearer?.principal.userId,
          client: bearer?.client,
          scopes: bearer?.scopes,
        },
        501,
      );
    });
  }

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  // Deliberately minimal (security review #11): no Node/OS/database details for fingerprinting.
  app.get("/version", (c) => c.json({ name: "openhoard", version: pkg.version }));
  app.get("/", (c) =>
    c.json({
      name: "OpenHoard",
      tagline: "The AI filesystem that remembers everything and guards it all.",
    }),
  );

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    // Never echo internal error details to clients; log them instead.
    log?.error({ err }, "unhandled error");
    return c.json({ error: "internal error" }, 500);
  });
  return app;
}
