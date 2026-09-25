import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { openDatabase } from "@openhoard/core-db";
import { createApp } from "./app.js";
import { ensureDataDir, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

// `--data-dir` overrides OPENHOARD_DATA_DIR; the dev script points it at the repo root.
const { values } = parseArgs({ options: { "data-dir": { type: "string" } }, strict: false });
const dataDir = typeof values["data-dir"] === "string" ? values["data-dir"] : undefined;
const config = loadConfig(dataDir ? { ...process.env, OPENHOARD_DATA_DIR: dataDir } : process.env);
const log = createLogger(config);
ensureDataDir(config.dataDir);

// Checks the server against the requirements (spike S2) and applies pending migrations. The
// embedded default keeps its files in <dataDir>/pgdata; only one process may open them at a time.
let db: Awaited<ReturnType<typeof openDatabase>>;
try {
  db = await openDatabase({ url: config.database.url, dataDir: config.dataDir });
} catch (err) {
  log.fatal({ err }, "cannot open the database");
  process.exit(1);
}
log.info({ database: db.kind }, "database ready");

const server = serve(
  { fetch: createApp(config, log, { db }).fetch, hostname: config.host, port: config.port },
  (info) =>
    log.info({ address: info.address, port: info.port, dataDir: config.dataDir }, "listening"),
);

/**
 * Graceful shutdown (security review #14): stop accepting connections, close idle keep-alive
 * sockets so close() can finish, and force-exit after 10 s if something still hangs.
 */
const SHUTDOWN_TIMEOUT_MS = 10_000;
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "shutting down");
    setTimeout(() => {
      log.warn("shutdown timed out; forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    server.close(() => {
      db.close().then(
        () => process.exit(0),
        (err: unknown) => {
          log.error({ err }, "closing the database failed");
          process.exit(1);
        },
      );
    });
    if ("closeIdleConnections" in server) server.closeIdleConnections();
  });
}
