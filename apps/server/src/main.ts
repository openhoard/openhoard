import { join } from "node:path";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { openDatabase } from "@openhoard/core-db";
import { startJobs, type Jobs } from "@openhoard/core-jobs";
import { BlobStore, blobContentSource } from "@openhoard/core-storage";
import { adminArgument, runAdmin } from "./admin.js";
import { closeApp, createApp } from "./app.js";
import { ensureDataDir, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createServerModels, modelsStartupWarning } from "./models.js";
import { prepareSources, type ServerSources } from "./sources.js";
import { blobsIn, tenantKeyStore } from "./tenant-keys.js";

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

// Each tenant's blob key, kept in <dataDir>/keys (outside the database).
// Made only for a tenant with no content yet; a lost one stops the server (tenant-keys.ts).
const tenantKey = tenantKeyStore(config.dataDir, { hasContent: blobsIn(db) });

// The configured folders (T-303): their zones, bindings and connectors. A source that can't be
// set up stops the server, naming it.
let sources: ServerSources;
try {
  sources = await prepareSources(db, config, {
    tenantKey,
    // What OpenHoard holds itself (managed zones, none yet in M1), before the connectors.
    blobs: blobContentSource(BlobStore.open({ kind: "fs", root: join(config.dataDir, "blobs") }), {
      tenantKey,
    }),
    log: log.child({ component: "sources" }),
  });
  // Every syncing tenant's key now, so a lost one is said at start, not in every job.
  for (const tenantId of new Set(sources.scheduled.map((s) => s.tenantId)))
    await tenantKey(tenantId);
} catch (err) {
  log.fatal({ err }, "cannot set up the configured sources");
  await db.close().catch(() => {});
  process.exit(1);
}

// Background jobs (core/jobs on pg-boss, in the same database). Every node can enqueue; with
// jobs.worker (the default) this one also runs enrichment, the sources' syncs and the
// maintenance schedule.
let jobs: Jobs;
let models: ReturnType<typeof createServerModels>;
try {
  // Model providers (T-404) from `models`, keys from OPENHOARD_MODEL_<ID>_API_KEY; none, no model.
  models = createServerModels(config.models, process.env, log.child({ component: "models" }));
  // Content is read only from sources that opted in (`extract`): say so when models can't run.
  const warning = modelsStartupWarning(models, sources.content !== null);
  if (warning !== null) log.warn(warning);
  jobs = await startJobs(db, {
    worker: config.jobs.worker,
    log: log.child({ component: "jobs" }),
    ...(sources.content === null
      ? {}
      : { content: sources.content, extract: { indexedZones: true } }),
    ...(sources.scheduled.length === 0 ? {} : { sync: { sources: sources.scheduled, tenantKey } }),
    ...(models === null
      ? {}
      : {
          summarize: {
            router: models.router,
            budget: models.budget,
            log: log.child({ component: "summarize" }),
            ...models.summarize,
          },
          // Embeddings (T-407) when a provider has an embeddings model; none, keyword search only.
          embed: {
            router: models.router,
            budget: models.budget,
            log: log.child({ component: "embed" }),
          },
        }),
  });
} catch (err) {
  log.fatal({ err }, "cannot start the job queue");
  await db.close().catch(() => {});
  process.exit(1);
}
log.info({ worker: config.jobs.worker, sources: sources.scheduled.length }, "job queue ready");
// An item that changed since it was recorded: sync its source now, not at its next schedule.
sources.onStale((tenantId, source) => {
  jobs
    .requestSync(tenantId, source)
    .catch((err: unknown) => log.warn({ err, tenantId, source }, "could not request a sync"));
});

// The MCP `find` tool embeds queries with the same providers (local ones only, by default).
const app = createApp(config, log, {
  db,
  ...(models === null ? {} : { embed: { router: models.router, budget: models.budget } }),
});
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
