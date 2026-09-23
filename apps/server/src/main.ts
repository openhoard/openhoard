import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { ensureDataDir, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

// `--data-dir` overrides OPENHOARD_DATA_DIR; the dev script points it at the repo root.
const { values } = parseArgs({ options: { "data-dir": { type: "string" } }, strict: false });
const dataDir = typeof values["data-dir"] === "string" ? values["data-dir"] : undefined;
const config = loadConfig(dataDir ? { ...process.env, OPENHOARD_DATA_DIR: dataDir } : process.env);
const log = createLogger(config);
ensureDataDir(config.dataDir);

const server = serve(
  { fetch: createApp(config, log).fetch, hostname: config.host, port: config.port },
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
    server.close(() => process.exit(0));
    if ("closeIdleConnections" in server) server.closeIdleConnections();
  });
}
