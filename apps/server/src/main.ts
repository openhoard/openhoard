import { join } from "node:path";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { openDatabase } from "@openhoard/core-db";
import { defaultEnrichSteps } from "@openhoard/ai-enrich";
import { startJobs, type Jobs } from "@openhoard/core-jobs";
import {
  BlobStore,
  blobContentSource,
  cleanTenantBlobs,
  moveTenantBlobs,
  TenantBlobStores,
  type StorageConfig,
} from "@openhoard/core-storage";
import { closeApp, createApp } from "./app.js";
import { ensureDataDir, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { checkMailboxes, startMailIn } from "./mail-in.js";
import { createServerModels, modelsStartupWarnings } from "./models.js";
import { keepSubscriptions } from "./notifications.js";
import { prepareSources, type ServerSources } from "./sources.js";
import { blobsIn, storageKeyStore, tenantKeyStore } from "./tenant-keys.js";
import { watchSources } from "./watch.js";

// This entry point only serves. The operator commands (admin, init --solo, connect, tunnel) are
// the `openhoard` CLI's (apps/cli, T-1407): an argument that isn't an option is refused, saying so.
const word = parseArgs({
  options: { "data-dir": { type: "string" } },
  strict: false,
  allowPositionals: true,
}).positionals[0];
if (word !== undefined) {
  process.stderr.write(
    `"${word}" is a command of the openhoard CLI now: node apps/cli/dist/bin.js [--data-dir <dir>] ${word} …\n`,
  );
  process.exit(2);
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

// The configured sources (T-303): their zones, bindings and connectors. A source that can't be
// set up stops the server, naming it.
let sources: ServerSources;
// What OpenHoard holds itself (managed zones: uploads, T-1206): on the server's disk, in
// <dataDir>/blobs, unless a tenant's admin chose a bucket of its own (core/storage
// tenant-storage.ts), whose key is sealed with <dataDir>/keys/storage.key.
const localStorage: StorageConfig = { kind: "fs", root: join(config.dataDir, "blobs") };
const storageKey = storageKeyStore(config.dataDir);
const blobStore = new TenantBlobStores({
  db,
  local: BlobStore.open(localStorage),
  sealKey: storageKey.open,
});
const blobs = blobContentSource(blobStore, { tenantKey });
const storageLog = log.child({ component: "storage" });
try {
  sources = await prepareSources(db, config, {
    tenantKey,
    // Before the connectors: a version OpenHoard holds is read from its own store.
    blobs,
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
// What enrichment may read: the folders that opted in, and, with uploads, what OpenHoard holds.
const content = sources.content ?? (config.uploads || config.mailIn.length > 0 ? blobs : null);
try {
  // Model providers (T-404) from `models`, keys from OPENHOARD_MODEL_<ID>_API_KEY; none, no model.
  models = createServerModels(config.models, process.env, log.child({ component: "models" }));
  // Content is read only from sources that opted in (`extract`): say so when models can't run.
  for (const warning of modelsStartupWarnings(models, content !== null)) log.warn(warning);
  jobs = await startJobs(db, {
    // Tenants' storage moves and removals of old copies (core/storage), as admins start them.
    storage: {
      async run(job, signal) {
        const tenant = { id: job.tenantId, key: await tenantKey(job.tenantId) };
        const options = { log: storageLog, signal };
        const ran =
          job.task === "move"
            ? await moveTenantBlobs(db, blobStore, tenant, job.version, options)
            : await cleanTenantBlobs(db, blobStore, tenant, job.version, options);
        return { ran };
      },
    },
    worker: config.jobs.worker,
    log: log.child({ component: "jobs" }),
    ...(sources.scheduled.length === 0 ? {} : { sync: { sources: sources.scheduled, tenantKey } }),
    // The enrichment steps (ai/enrich): text extraction, then the core's injection flag and rule
    // tagger, then summaries and embeddings when models are configured.
    steps: defaultEnrichSteps({
      // Folders' content only where a folder opted in; what OpenHoard holds, always.
      ...(content === null ? {} : { content, extract: { indexedZones: sources.content !== null } }),
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
// A file saved into a folder: sync its source within seconds, not at its next schedule (T-1203).
// Only on a worker, which runs the syncs: any node could request one, but one set of watchers
// per cluster is enough, and a serving-only node needn't hold the folders open.
const watching = config.jobs.worker
  ? watchSources(
      config.sources.filter((s) => s.connector === "fs"),
      {
        request: (tenantId, source) => jobs.requestSync(tenantId, source),
        log: log.child({ component: "watch" }),
      },
    )
  : null;

// Mailboxes read over IMAP (T-1208): on a worker, as the folders' syncs are. One whose tenant
// isn't there stops the server, naming it, as a folder's does; a lost key is said now too.
try {
  await checkMailboxes(db, config.mailIn);
  for (const tenantId of new Set(config.mailIn.map((m) => m.tenantId))) await tenantKey(tenantId);
} catch (err) {
  log.fatal({ err }, "cannot set up the configured mailboxes");
  await jobs.stop({ timeoutMs: 1000, graceMs: 500 }).catch(() => {});
  await db.close().catch(() => {});
  process.exit(1);
}
const mailIn =
  config.jobs.worker && config.mailIn.length > 0
    ? startMailIn(
        {
          db,
          store: blobStore,
          tenantKey,
          enqueue: (tenantId, result) => jobs.enqueueAfterIngest(tenantId, result),
          log: log.child({ component: "mail-in" }),
        },
        config.mailIn,
        process.env,
      )
    : null;

// Set when shutdown starts: /healthz says unavailable from then on.
let stopping = false;
// The MCP `find` tool embeds queries with the same providers (local ones only, by default).
const app = createApp(config, log, {
  db,
  unavailableSources: sources.unavailable,
  stopping: () => stopping,
  storage: {
    stores: blobStore,
    keys: storageKey,
    allowEndpoints: config.storage.allowEndpoints,
    local: localStorage,
    requestJob: (job) => jobs.requestStorageJob(job),
    keepsFiles: config.uploads !== undefined || config.mailIn.length > 0,
  },
  ...(config.uploads
    ? {
        uploads: {
          store: blobStore,
          tenantKey,
          enqueue: (tenantId, result) => jobs.enqueueAfterIngest(tenantId, result),
        },
      }
    : {}),
  ...(models === null
    ? {}
    : { embed: { router: models.router, budget: models.budget, queryKinds: models.queryKinds } }),
  ...(sources.notifying.size === 0
    ? {}
    : {
        notifications: {
          sourceOf: (tenantId, source) => sources.notifying.get(`${tenantId}/${source}`),
          request: (tenantId, source) => jobs.requestSync(tenantId, source),
          log: log.child({ component: "notifications" }),
        },
      }),
});
// Graph's change notifications (T-304): kept on a worker, once Graph can reach this server.
let notifying: ReturnType<typeof keepSubscriptions> | null = null;
const server = serve(
  {
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
    // A large upload over a slow link takes longer than Node's five minutes for a request
    // (its headers still have one minute).
    ...(config.uploads ? { serverOptions: { requestTimeout: 60 * 60_000 } } : {}),
  },
  (info) => {
    log.info({ address: info.address, port: info.port, dataDir: config.dataDir }, "listening");
    if (config.jobs.worker && sources.notifying.size > 0) {
      notifying = keepSubscriptions(sources.notifying, log.child({ component: "notifications" }));
    }
  },
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
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "shutting down");
  setTimeout(() => {
    log.warn("shutdown timed out; forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  if ("closeIdleConnections" in server) server.closeIdleConnections();
  // The watchers first: no sync is requested of a queue that is stopping.
  const stopped = Promise.all([watching?.close(), mailIn?.close(), notifying?.close()])
    .then(() => jobs.stop({ timeoutMs: JOBS_STOP_TIMEOUT_MS, graceMs: JOBS_GRACE_MS }))
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
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => shutdown(signal));
// Started by `tunnel` (tunnel.ts), which holds a channel to this process: when it closes the
// channel, or is gone, stop as on a signal. (Windows has no signal a parent can send that a
// process may answer: this is how the server is stopped cleanly there.)
// Only then: another parent's channel (a process manager's) closing means nothing here.
if (process.send !== undefined && process.env.OPENHOARD_TUNNEL_URL) {
  process.on("disconnect", () => shutdown("disconnect"));
}
