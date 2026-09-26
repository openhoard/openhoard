import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { openDatabase } from "@openhoard/core-db";
import { startJobs, type Jobs } from "@openhoard/core-jobs";
import { adminArgument, runAdmin } from "./admin.js";
import { closeApp, createApp } from "./app.js";
import { ensureDataDir, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createServerModels } from "./models.js";

// `main.js [options] admin …` runs an admin command (admin.ts) instead of the server, then exits.
// `admin` is the first argument that isn't an option (`--data-dir x admin …` is admin too).
const adminAt = adminArgument(process.argv.slice(2));
if (adminAt !== undefined) {
  const args = process.argv.slice(2);
  const code = await runAdmin([...args.slice(0, adminAt), ...args.slice(adminAt + 1)], {
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
  });
  // Let what was written (the one-time token) reach a pipe before exiting: on Windows pipes
  // are asynchronous, and exit() would cut it off.
  await Promise.all(
    [process.stdout, process.stderr].map((s) => new Promise((done) => s.write("", done))),
  );
  process.exit(code);
}

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

// Background jobs (core/jobs on pg-boss, in the same database). Every node can enqueue; with
// jobs.worker (the default) this one also runs enrichment and the maintenance schedule.
let jobs: Jobs;
try {
  // Model providers (T-404) from `models`, keys from OPENHOARD_MODEL_<ID>_API_KEY; none, no model.
  const models = createServerModels(config.models, process.env, log.child({ component: "models" }));
  jobs = await startJobs(db, {
    worker: config.jobs.worker,
    log: log.child({ component: "jobs" }),
    ...(models === null
      ? {}
      : {
          summarize: {
            router: models.router,
            budget: models.budget,
            log: log.child({ component: "summarize" }),
            ...models.summarize,
          },
        }),
  });
} catch (err) {
  log.fatal({ err }, "cannot start the job queue");
  await db.close().catch(() => {});
  process.exit(1);
}
log.info({ worker: config.jobs.worker }, "job queue ready");

const app = createApp(config, log, { db });
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) =>
  log.info({ address: info.address, port: info.port, dataDir: config.dataDir }, "listening"),
);

/**
 * Graceful shutdown (security review #14): stop accepting connections, close idle keep-alive
 * sockets so close() can finish, and force-exit after 10 s if something still hangs. The job
 * queue stops at the same time: running jobs get 5 s to finish (any still running then are
 * failed, retried by whichever worker runs next, and told to stop), then up to 2 s more for
 * their handlers to return. Once both are done, the app writes what it still holds (SCIM's
 * pending audit summaries, closeApp()), and then the database closes, so nothing polls it or
 * writes to it after; 7 s and the close fit in the 10 s.
 */
const SHUTDOWN_TIMEOUT_MS = 10_000;
const JOBS_STOP_TIMEOUT_MS = 5_000;
const JOBS_GRACE_MS = 2_000;
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
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    if ("closeIdleConnections" in server) server.closeIdleConnections();
    const stopped = jobs
      .stop({ timeoutMs: JOBS_STOP_TIMEOUT_MS, graceMs: JOBS_GRACE_MS })
      .catch((err: unknown) => log.error({ err }, "stopping the job queue failed"));
    void Promise.all([closed, stopped])
      // What the app still holds for the database (SCIM's audit summaries), then the database.
      .then(() => closeApp(app))
      .then(() => db.close())
      .then(
        () => process.exit(0),
        (err: unknown) => {
          log.error({ err }, "closing the database failed");
          process.exit(1);
        },
      );
  });
}
