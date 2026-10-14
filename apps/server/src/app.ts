import { readFileSync } from "node:fs";
import { Hono, type Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { Database } from "@openhoard/core-db";
import type { Logger } from "pino";
import { mountAdminApi } from "./admin-api.js";
import { builtAdminUi, mountAdminUi } from "./admin-ui.js";
import { mountAuth, type AuthEnv } from "./auth.js";
import { adminGroupOf, type Config } from "./config.js";
import type { UnavailableSource } from "./sources.js";
import { loginKey } from "./login-state.js";
import { mountMcp, type EmbedDeps, type McpTool } from "./mcp.js";
import type { MetadataFetcher } from "./oauth/clients.js";
import { mountOAuth } from "./oauth/routes.js";
import { mountReviewApi } from "./review-api.js";
import { mountScim, type ScimOptions } from "./scim/routes.js";
import { mountUploads, type UploadDeps } from "./uploads.js";
import { mountShareFallback, mountWebApp } from "./web-app.js";

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
  /** Query embeddings for the MCP `find` tool, when an embeddings model is configured. */
  embed?: EmbedDeps;
  /** Configured sources this server couldn't start (sources.ts prepareSources()). */
  unavailableSources?: readonly UnavailableSource[];
  /** True once the server is shutting down: /healthz then says unavailable. */
  stopping?: () => boolean;
  /** Where uploads go (T-1206); needed when `uploads` is configured. */
  uploads?: Pick<UploadDeps, "store" | "tenantKey" | "enqueue">;
  /** SCIM limits (tests lower or raise them). */
  scim?: ScimOptions;
  /**
   * The directory of the admin web app's build (T-901), or null to serve none. By default, the
   * build of `@openhoard/web` installed beside the server.
   */
  adminUi?: string | null;
}

/** What each app must finish before the database closes (see closeApp()). */
const closers = new WeakMap<object, (() => Promise<void>)[]>();

/**
 * Finishes what the app keeps in memory for the database (SCIM's pending audit summaries). Call
 * it at shutdown, after the listener stops and before the database closes.
 */
export async function closeApp(app: object): Promise<void> {
  const pending = closers.get(app) ?? [];
  closers.delete(app);
  await Promise.all(pending.map((close) => close()));
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
    const scim = mountScim(app, {
      db: deps.db,
      ...(log ? { log } : {}),
      ...(config.auth
        ? { publicUrl: config.auth.publicUrl, adminGroup: adminGroupOf(config.auth) }
        : {}),
      options: { trustedProxies: config.scim.trustedProxies, ...deps.scim },
    });
    closers.set(app, [() => scim.close()]);
  }

  if (config.auth) {
    if (!deps.db) throw new Error("sign-in (auth) needs the database");
    const key = loginKey(config.auth.cookieKey);
    const shared = { auth: config.auth, db: deps.db, key, ...(log ? { log } : {}) };
    // Before sign-in's checks: a share the browser didn't take acts for nobody (web-app.ts).
    if (config.uploads) mountShareFallback(app);
    // The admin web app (T-901): static files that need no session. What it shows it asks
    // /auth/me and the admin API for.
    mountAdminUi(app, {
      dir: deps.adminUi === undefined ? builtAdminUi() : deps.adminUi,
      ...(log ? { log } : {}),
    });
    mountAuth(app, shared);
    // Tenant administration (T-106), behind the session and its CSRF check.
    mountAdminApi(app, {
      auth: config.auth,
      db: deps.db,
      sources: config.sources,
      ...(deps.unavailableSources ? { unavailable: deps.unavailableSources } : {}),
      ...(log ? { log } : {}),
    });
    // The tag review inbox, for whoever is signed in (T-903).
    mountReviewApi(app, { auth: config.auth, db: deps.db, ...(log ? { log } : {}) });
    // OpenHoard's OAuth authorization server for MCP clients (T-105), and the resource they reach.
    const { requireBearer } = mountOAuth(app, {
      ...shared,
      uploads: config.uploads !== undefined,
      ...(deps.fetchMetadata ? { fetchMetadata: deps.fetchMetadata } : {}),
    });
    // Uploads into a managed zone, and the installable page that shares into them (T-1206);
    // an approved client its person let add files uploads too (T-1207).
    if (config.uploads) {
      if (!deps.uploads) throw new Error("uploads need the blob store");
      mountUploads(app, {
        db: deps.db,
        uploads: config.uploads,
        ...deps.uploads,
        requireBearer,
        ...(log ? { log } : {}),
      });
      mountWebApp(app, { maxBytes: config.uploads.maxBytes });
    }
    // The MCP server (T-801), behind the bearer check.
    mountMcp(app, {
      db: deps.db,
      requireBearer,
      version: pkg.version,
      publicUrl: config.auth.publicUrl,
      origins: config.auth.mcpOrigins,
      ...(log ? { log } : {}),
      ...(deps.mcpTools ? { tools: deps.mcpTools } : {}),
      ...(deps.embed ? { embed: deps.embed } : {}),
    });
  }

  app.get("/healthz", healthz(deps));
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

/** How long /healthz waits for the database before it says unavailable. */
export const HEALTH_TIMEOUT_MS = 5_000;
/** How long one answer of /healthz stands: a load balancer polling it doesn't load the database. */
const HEALTH_CACHE_MS = 2_000;

/**
 * GET /healthz: 200 `{ status: "ok" }` while this process can serve (the database answers within
 * {@link HEALTH_TIMEOUT_MS}, and it isn't shutting down), else 503 `{ status: "unavailable" }`.
 * Nothing else: it is unauthenticated, so no tenant, source or error detail (admins see sources
 * at /api/admin/sources). Without a database (sign-in not configured), only the shutdown counts.
 *
 * One check at a time: requests while one runs wait for it, so polling a slow database doesn't
 * pile transactions onto it. On PGlite (in this process, one transaction at a time) a check that
 * doesn't finish in time is a long transaction ahead of it, not a database down: only an error
 * fails it there.
 */
function healthz(deps: AppDeps) {
  let last: { at: number; ok: boolean } | null = null;
  let running: Promise<boolean> | null = null;
  const ask = async (db: Database): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    const slow = db.kind === "pglite";
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(slow), HEALTH_TIMEOUT_MS);
    });
    try {
      const ok = await Promise.race([
        db.tenantIds({ limit: 1 }).then(
          () => true,
          () => false,
        ),
        timeout,
      ]);
      last = { at: Date.now(), ok };
      return ok;
    } finally {
      clearTimeout(timer);
      running = null;
    }
  };
  const check = async (): Promise<boolean> => {
    if (deps.stopping?.() === true) return false;
    if (!deps.db) return true;
    if (last !== null && Date.now() - last.at < HEALTH_CACHE_MS) return last.ok;
    running ??= ask(deps.db);
    return running;
  };
  return async (c: Context) =>
    (await check())
      ? c.json({ status: "ok" }, 200, { "cache-control": "no-store" })
      : c.json({ status: "unavailable" }, 503, { "cache-control": "no-store" });
}
