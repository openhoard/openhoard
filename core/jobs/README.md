# @openhoard/core-jobs

Part of the OpenHoard trusted core. See [../README.md](../README.md) and
[docs/architecture.md](../../docs/architecture.md). Background jobs on
[pg-boss](https://github.com/timgit/pg-boss) ([ADR-0008](../../docs/adr/0008-job-queue.md)): the
enrichment pipeline (T-401) and scheduled maintenance.

```ts
import { startJobs } from "@openhoard/core-jobs";

const jobs = await startJobs(db); // creates pg-boss's schema and queues, starts the workers
const result = await db.withTenant(tenantId, (tx) => ingest(tx, tenantId, item));
await jobs.enqueueAfterIngest(tenantId, result); // after the commit, never inside withTenant()
// …
await jobs.stop(); // before db.close()
```

- [`enrich.ts`](src/enrich.ts): the pipeline, its steps and what a job does.
- [`maintenance.ts`](src/maintenance.ts): pruning and the sweep, per tenant, in bounded batches.
- [`jobs.ts`](src/jobs.ts): pg-boss, the queues, the workers and the schedule.

**pg-boss is pinned to exactly 12.33.1.** It was the newest release more than a week old when
this was written (2026-09-17), and jobs.ts depends on internals that aren't covered by pg-boss's
semver promises, only read from its source (`dist/plans.js`, `dist/manager.js`). Before moving to
another release, read these again and rerun this package's tests on PGlite and PostgreSQL:

- **`job_i3`**, the `stately` unique index on (name, state, singleton key) for created, retry and
  active: one job per key and state is what collapses duplicate enqueues.
- **`failJobsBody`**, the fail path: a failing job is deleted and re-inserted as `retry` with
  `ON CONFLICT DO NOTHING`, and falls through to `failed` and the dead letter queue (`dlq_jobs`,
  which copies the payload and singleton key) when that insert conflicts. That is why no second
  job may wait beside a retry, and why dead letters can be found by payload.
- **`upsert()` / `updateJob`**: it updates a created or retry job with the singleton key (keeping
  `start_after` unless `startAfter` is given) and inserts one only when none matched, retrying the
  update after a conflicting insert. Enqueueing is built on that.
- **The `pglite` backend** (`attorney.js`: embedded, no compatibility flags), and which
  statements pg-boss sends without parameters (blocks with their own BEGIN/COMMIT, index DDL done
  CONCURRENTLY), which core-db's PGlite adapter relies on. Also that it sends no `set_config`,
  role or `app.*` statement, which the adapter refuses.

## Where the queue lives

pg-boss keeps its queues in the `pgboss` schema of OpenHoard's own database, so enqueueing needs
no other service. The application's role creates that schema on first start, as the owner of the
database (core/db refuses a superuser or a `BYPASSRLS` role). It reaches the database through
`queueConnectionOf(db)` from `@openhoard/core-db/queue`, an internal entry point only this
package imports; the `Database` every caller holds has no such door.

- **PostgreSQL:** the URL the database was opened with, and the application pool's session
  settings (UTC, statement and idle-in-transaction timeouts). pg-boss opens its own small pool
  (`poolSize`, default 4) as the same role.
- **PGlite:** the same embedded instance. Its statements run one at a time, between the
  application's transactions; a block of pg-boss's that fails half way rolls back before
  anyone else runs. Statements that obviously change the shared session (`app.*` settings,
  `set_config`, the role) trip an error: a check against mistakes, not a boundary (quoting gets
  past it). What holds is core/db's: `withTenant()` refuses to run unless the session is still
  the application's role. A call made inside a `withTenant()` callback would wait for that
  transaction forever, so it throws `NestedWorkError`.

That schema is outside row-level security. So every job carries its tenant id, and every
handler does all catalog work inside `db.withTenant(tenantId, …)`.

## Enrichment

Until enrichment finishes a version (core/catalog `markProcessed()`), its object is hidden from
non-readers and metadata-only (T-603). The pipeline is what lets it out:

```text
ingest commits → enqueue (tenant, version) → a worker runs the steps in order
               → markProcessed({ versionId, title the job saw })
```

**Enqueueing.** `enqueueAfterIngest(tenantId, result)` enqueues when ingest made a version or
renamed the object, which both leave it unprocessed, and does nothing otherwise. Call it after
the ingest transaction commits: an enqueue inside it would not be part of it (pg-boss commits on
its own connection), and on PGlite it would deadlock. `enqueueVersion(tenantId, versionId)`
enqueues one version.

**One job per version.** The `enrich` queue is `stately`, keyed by tenant and version: at most
one job per key in each of the states created, retry and active. Enqueueing goes through
pg-boss's `upsert()`: a job that waits for the key, queued or waiting out a retry delay, is
reused (and `enqueueVersion` returns null); otherwise a new one is queued, also while one runs,
since the version may have changed since that one started. Never a second job beside a retry:
pg-boss would fail that one straight to the dead letter queue the first time it failed (its
retry collides with the other on the key), its retries unused. One narrow race is left (see
jobs.ts): if it happens, the version is still enriched by the retry.

A new version or a rename (`enqueueAfterIngest`, `enqueueVersion`) brings a waiting job forward
to run now: the content may have changed what failed. The sweep only joins it, leaving its
start alone, so a failing version keeps its backoff and doesn't spend a retry every sweep.

**Steps.** An `EnrichStep` has a `name` and `run({ target, read, write, signal })`. Steps run in
order, each after the one before succeeded. `target` is the version as the job read it when it
started: tenant, object, version, seq, title, media type, blob. The default set,
`defaultEnrichSteps()`, is the rule tagger (`ruleTagStep`, core/catalog T-403), first so rule
tags are on a file before any model sees it, then, when the server passes `content` (where
versions' bytes are read: core/storage `blobContentSource()`, connectors' sources), text
extraction (`extractStep`, below). Model steps (T-404, T-405) join the list later.

**Text extraction** (`extract-text`, [extract.ts](src/extract.ts), T-402). The step reads the
version's bytes through the `ContentSource` (core/catalog), extracts them in a limited child
process ([@openhoard/enricher-extract](../../enrichers/extract/README.md)), and stores the result
per version with core/catalog `saveExtract()` through `write`:

| The extractor answers                                       | Stored        | The job           |
| ----------------------------------------------------------- | ------------- | ----------------- |
| text and metadata                                           | `extracted`   | goes on           |
| a type it doesn't read (checked before any byte is read)    | `unsupported` | goes on           |
| no source reaches the bytes (an indexed zone before T-301)  | `unavailable` | goes on           |
| the file's own failure: malformed, encrypted, a zip bomb, a | `failed`      | goes on           |
| timeout, out of memory, a crash                             |               |                   |
| the source failed part way, or no process could start       | nothing       | fails and retries |

So a hostile file costs one child process once, never the job's retries, and its version is
processed like any other. The step names no provider: the content goes to OpenHoard's own
process on the same machine and nowhere else, so it runs whatever the file's exposure,
`metadata-only` included; what reads the stored text later (a model step) is what exposure
gates. It runs after the rule tagger: rules decide from the title and media type, and nothing
they match on comes from the content yet.

**Writes only for the current version.** A step writes only through `write(tx => …)`. It opens a
short transaction, takes the object's lock and checks, with core/catalog `lockCurrentVersion()`,
that the job's version is still the object's current one and the title unchanged. Ingest adds
versions and renames under the same lock, so while the step writes neither can happen. If
either did, nothing is written and `write` throws `StaleTargetError`: the job ends
`superseded` or `renamed`. So a slow job for a version that a newer one replaced can't overwrite
what the newer version's job wrote after it. `read(tx => …)` is a read-only transaction.

**Every step is idempotent.** A job runs again after a failure, a crash, a rename, the sweep
or an operator's redrive, from the first step. So whatever a step writes must be keyed: a tag
(applied once per object and value), a card per version, never an append. Rule tagging already
is: `applyRuleTags()` makes the object's rule tags exactly what the rules give. The tests run a
completed job again, and a job that failed half way, and check that nothing was added.

**Content goes to a model only as far as the file's exposure lets it (T-604).** A step that sends
the version's content out of this process names its `provider` (`{ id, kind }`, kind `local`,
`commercial` or `consumer`; `startJobs()` refuses any other). Before running it, the pipeline
reads the exposure the file's tags give it at that moment (core/catalog `enrichmentExposure()`:
trusted tags decide, the rest only tighten, else the tenant default; not the unprocessed file's
`metadata-only`, which would stop every model) and asks core/policy `mayProcess()`:

- `full` goes to any provider, `commercial-only` to commercial and local ones, `local-only` to
  local ones only, `metadata-only` to none;
- a step the exposure doesn't let through is skipped (the job still finishes and marks the
  version processed), and the job's output (`withheld: [{ step, provider, exposure }]`) and the
  log say so;
- `context.mayProcess(provider)` asks the same question at any time: a step that takes long
  before it sends, or sends to more than one provider, asks again right before each send;
- the rule tagger runs first, so its tags count before any model sees the file, and so does a
  model's guess that the file is sensitive, the moment it is recorded;
- a file no trusted tag has given an exposure yet goes by the tenant default, capped at
  `commercial-only`: however permissive the default, an unclassified file's content never goes
  to a `consumer` provider (a stricter default, such as `local-only`, stays). A trusted tag
  (a rule's, a pack's, a person's, or a reviewed model tag) decides from then on, `full`
  included.

A step without a provider (the rule tagger, a text extractor) sends nothing out; one that does
must declare it (T-404 adds the providers).

**Short transactions.** A step does its slow work (extracting, calling a model) outside any
transaction. A transaction held open blocks the embedded database for everyone, and pins a
pooled connection on PostgreSQL. Transactions don't nest: `withTenant()` refuses to open one
inside another's callback.

**Marking it processed.** After the last step, the job calls `markProcessed({ versionId, title })`
with the title it read at the start. That makes the same check under the object's lock: it marks
only the current version, under that title.

| When the job ends                                | Outcome             | What happens                                            |
| ------------------------------------------------ | ------------------- | ------------------------------------------------------- |
| the version is marked now                        | `processed`         | non-readers see what the levels allow                   |
| it was marked already (a re-run)                 | `already-processed` | nothing more                                            |
| a newer version replaced it (at start, or later) | `superseded`        | the old version is marked superseded; never re-enqueued |
| the object was renamed after the job read it     | `renamed`           | the version is enqueued again for the new title         |
| the version or the tenant doesn't exist any more | `gone`              | nothing                                                 |
| the payload doesn't name a tenant and a version  | `invalid`           | nothing, and a warning in the log                       |

Superseded is checked before renamed, so a replaced version is never enqueued again. The outcome
is stored as the job's output.

**Superseded versions are given up on** (core/catalog `markSuperseded()` sets `superseded_at`),
so they leave the pending set, its partial index (unprocessed and not superseded) and the sweep
for good. They stay unprocessed: `processed` in `listVersions()` and `openContent()` means
enriched. Nothing about access changes: levels, listings and search read only the current
version, and a version that was replaced never becomes current again.

**Retries and dead letters.** A step that throws fails the job (`EnrichStepError`, naming the
step). It runs again after `retryDelaySeconds` (default 30), doubling each time up to
`retryDelayMaxSeconds` (default 1 hour), at most `retryLimit` more times (default 5). A job that
runs longer than `expireInSeconds` (default 15 minutes), because its worker died, is put back
for a retry by the next supervisor pass (`superviseIntervalSeconds`, default 60). A job that runs
out of retries goes to `enrich-failed`, the dead letter queue (in a partition of its own), which
nothing works: an operator looks at it and redrives it (`jobs.boss.redrive()`). Its version
stays unprocessed, so hidden from non-readers: fail-closed.

Two known gaps. The rule tagger sees the title and media type, not the path or site: neither is
stored yet, and a step must decide from stored facts only, or a re-run would take off tags the
first run gave. And a rename doesn't change rule tags until the job that follows it runs.

## Maintenance

With `worker` on, pg-boss's cron starts `maintenance` hourly (`17 * * * *` UTC;
`maintenance.cron` changes it). A node with `maintenance: false` doesn't keep the schedule or work
its queues, and leaves the schedule alone: it is the cluster's, and another node may keep it.
The job pages through every tenant with `db.tenantIds()` and sends one `maintenance-tenant` job
each (`stately`, keyed by tenant). Per tenant, each batch in a short transaction of its own:

| Task                                  | Setting                                             |
| ------------------------------------- | --------------------------------------------------- |
| sessions that ended long enough ago   | `sessionRetentionDays`, default 30                  |
| OAuth codes, tokens and ended grants  | `oauthRetentionDays`, default 30                    |
| revoked or expired SCIM tokens        | `scimTokenRetentionDays`, default 90                |
| activity events older than retention  | `activityRetentionDays`, default 400                |
| the sweep: lost enrichment jobs       | `sweepAfterMinutes` (60), `sweepLimit` (100)        |
| how far the sweep looks per run       | `sweepScanLimit` (1,000), skipped versions included |
| rows per transaction, batches per run | `batchSize` (1,000), `maxBatches` (10)              |

What doesn't fit in one run waits for the next, so one tenant's backlog never holds a
transaction open for long or starves the others.

Every one of those decisions is in the audit log; the rows only matter while they can still be
used, and a while after. OAuth rows are kept 30 days after they end so a replayed code or refresh
token is still recognized (and revokes what it made); an OAuth grant goes only once no code
points at it. After that, a replayed code or refresh token is just unknown, with no replay
revocation: acceptable, as a code lives a minute and needs its PKCE verifier, and a grant is
pruned only once it has ended, leaving nothing to revoke. SCIM tokens stay listed for admins 90 days after they stop working.

**The sweep.** Enqueueing happens after ingest commits, so a crash in between loses the job, and
the file would stay hidden for good. The sweep enqueues current versions left unprocessed for
longer than `sweepAfterMinutes`, oldest first (a partial index keeps it cheap). A version whose
job still waits gets that job brought forward, not a second one; one whose job runs costs an
idempotent re-run. It skips versions whose job is in the dead letter queue, read once per tenant
and run from that queue's own partition: those wait for an operator, or until pg-boss's
retention drops the dead letter (14 days), when the sweep tries once more. It pages past what it
skips, until it has enqueued `sweepLimit` or looked at `sweepScanLimit`, so a pile of dead letters
can't hide the lost versions behind them.

**Listing tenants.** `tenants` is under forced row-level security like every table. The
`tenant_directory` policy (core/db migration 0031) lets a transaction with no tenant set that
asks for it select `tenants` rows, and nothing else: `db.tenantIds()` does that, in a read-only
transaction that returns ids. The work itself goes through `withTenant()`, one tenant at a time.

## Running it

`startJobs(db, options)`:

| Option                     | Default                | What                                                                |
| -------------------------- | ---------------------- | ------------------------------------------------------------------- |
| `worker`                   | true                   | work the queues and keep the schedule in this process               |
| `steps`                    | `defaultEnrichSteps()` | the enrichment steps, in order                                      |
| `content`                  | none                   | where versions' bytes are read; the default steps then extract text |
| `enrich`                   | see above              | concurrency (2, or 1 on PGlite), retries, expiry                    |
| `maintenance`              | the defaults above     | or false                                                            |
| `pollingIntervalSeconds`   | 2                      | how often an idle worker looks for jobs                             |
| `superviseIntervalSeconds` | 60                     | how often expired jobs are put back                                 |
| `poolSize`                 | 4                      | pg-boss's connections on PostgreSQL                                 |
| `log`                      | none                   | a pino-style logger; pg-boss errors and warnings go to it           |

Every process that ingests can enqueue; `worker: false` suits one that should only serve
requests. Several workers share the queues through the database, and pg-boss makes sure one
schedule fires once. `stop({ timeoutMs, graceMs })` stops working and closes pg-boss's
connections. Running jobs get `timeoutMs` (default 20 s) to finish; any still running are then
failed (they run again later) and told to stop through their signal, and `stop()` waits up to
`graceMs` more (default 2 s) for their handlers to return. Stop it before closing the database.
The server does this on SIGINT and SIGTERM (`jobs.worker` in its config).

## Tests

```sh
pnpm --filter @openhoard/core-jobs test
```

The tests start pg-boss on a fresh database, on PGlite by default and on PostgreSQL with
`OPENHOARD_TEST_POSTGRES_URL` (see core/db). They cover enqueue dedupe, a retry brought forward
instead of doubled, retries after a failing step, re-running a completed job and a crashed one
without duplicates, `markProcessed` and what non-readers see afterwards, the rename race, a slow
job for a replaced version that must not overwrite the newer one's tags, superseded and
dead-lettered versions, the maintenance fan-out, the sweep paging past dead letters, the
schedule left alone, pg-boss's session settings on PostgreSQL, and a graceful stop. The extract
step's tests (extract.test.ts) store an extraction and re-run it into the same row, record
broken files as `failed` without a retry, store unsupported and unreachable content, retry when
the source fails, store nothing for a version replaced mid-extraction, and run from
`startJobs({ content })`.
