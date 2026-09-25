import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { Database } from "@openhoard/core-db";
import type { Logger } from "pino";
import { mountAuth, type AuthEnv } from "./auth.js";
import type { Config } from "./config.js";
import { loginKey } from "./login-state.js";
import { mountMcp, type McpTool } from "./mcp.js";
import type { MetadataFetcher } from "./oauth/clients.js";
import { mountOAuth } from "./oauth/routes.js";
import { mountScim, type ScimOptions } from "./scim/routes.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

export interface AppDeps {
  /** The database; needed when sign-in is configured, and for SCIM. */
  db?: Database;
  /** Fetches MCP clients' metadata documents (tests pass their own). */
  fetchMetadata?: MetadataFetcher;
  /** The MCP tools to serve; mcp.ts TOOLS by default. */
  mcpTools?: readonly McpTool[];
  /** SCIM limits (tests lower or raise them). */
  scim?: ScimOptions;
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

  // SCIM first: its requests carry a bearer token, never the session cookie.
  if (deps.db && config.scim.enabled) {
    mountScim(app, {
      db: deps.db,
      ...(log ? { log } : {}),
      ...(config.auth ? { publicUrl: config.auth.publicUrl } : {}),
      ...(deps.scim ? { options: deps.scim } : {}),
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
    // The MCP server (T-801), behind the bearer check.
    mountMcp(app, {
      db: deps.db,
      requireBearer,
      version: pkg.version,
      publicUrl: config.auth.publicUrl,
      origins: config.auth.mcpOrigins,
      ...(log ? { log } : {}),
      ...(deps.mcpTools ? { tools: deps.mcpTools } : {}),
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
