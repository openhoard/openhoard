# @openhoard/core-jobs

Part of the OpenHoard trusted core. See [../README.md](../README.md) and
[docs/architecture.md](../../docs/architecture.md). Background jobs on
[pg-boss](https://github.com/timgit/pg-boss) ([ADR-0008](../../docs/adr/0008-job-queue.md)): the
enrichment pipeline (T-401), scheduled maintenance, and the connector sync runner (T-301).

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
- [`sync.ts`](src/sync.ts): `runSync()`, one connector over one source into the catalog.
- [`connector-content.ts`](src/connector-content.ts): `connectorContentSource()`, indexed
  zones' bytes read through their connector for enrichment.

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

| The extractor answers                                            | Stored        | The job           |
| ---------------------------------------------------------------- | ------------- | ----------------- |
| text and metadata                                                | `extracted`   | goes on           |
| a type it doesn't read (checked before any byte is read)         | `unsupported` | goes on           |
| no source reaches the bytes (no connector serves the source)     | `unavailable` | goes on           |
| the file's own failure: malformed, encrypted, a zip bomb, out of | `failed`      | goes on           |
| memory, a crash                                                  |               |                   |
| a timeout, or killed by a signal nobody sent: tried once more    | the second    | goes on           |
| (a timeout with twice the time, if that fits the step's budget)  | answer        |                   |
| the source failed, stalled, or sent the wrong size (or hash)     | nothing       | fails and retries |
| no process could start                                           | nothing       | fails and retries |

So a hostile file costs at most two child processes, never the job's retries, and its version
is processed like any other. Each row names the extractor's version. A job that runs again for
the same version (a later step failed, a rename, the sweep) skips extraction when the row is
this extractor version's and final (`extracted`, `failed`, `unsupported`); `unavailable` is
tried again. A newer extractor can find the rows it would do better (failed, unsupported, or
simply older) and re-run them; no job for that exists yet. Each attempt's ContentSource gets a signal the step aborts when the attempt
ends, so a stalled store stream is closed.

Only a managed zone's content is read by default. `startJobs({ content, extract: {
indexedZones: true } })` opts indexed zones in (their bytes come from the customer's store);
local-only and code zones are never read on the server. `extract.limits` and
`extract.budgetMs` (13 minutes, under the job's lease) tune the rest.

**The job's lease** (`enrich.expireInSeconds`, 15 minutes) covers every step of one job: the
extract step's budget is sized to fit it alone. When model steps (T-404, T-405) join the same
job, the lease must grow by their time (or the extract budget shrink), or a slow file's job
expires mid-run and is retried from the first step.

The step names no provider: the content goes to OpenHoard's own process on the same machine and
nowhere else, so it runs whatever the file's exposure, `metadata-only` included; what reads the
stored text later (a model step, search) is what levels and exposure gate. It runs after the
rule tagger: rules decide from the title and media type, and nothing they match on comes from
the content yet.

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

## Connector sync

`runSync(db, { tenantId, source, zoneId, connector, ownerId, tenantKey, enqueue })` drives one
connector ([@openhoard/sdk](../../packages/sdk/README.md) interface v1) over one source (a
configured connection, the `source` of its items) into one zone, and keeps where it got to in
`source_syncs` (core/db migrations 0039, 0040: one row per tenant and source, forced RLS):

```text
crawl (from the start, or a checkpoint) ── done ──▶ delta, delta, delta…
     ▲                                                   │
     └── resync: a token the connector can't use any more ┘
```

- **The ingest contract** (core/catalog): one item per transaction, in the source's order,
  retried on 40P01/40001; slow work (reading, hashing) outside transactions. An item whose eTag
  is the one recorded is skipped before anything is read (`sourceItemState()`); one whose eTag
  changed but whose contentVersion didn't (a rename, a move) is ingested with the content it
  already has, unread; new content is read, counted against the reported size, hashed with the
  tenant's blob key and ingested. Deletes are soft (`removeFromSource()`). `enqueue`
  (`jobs.enqueueAfterIngest`) runs after each ingest commits.
- **Checkpoints and cursors** are saved only after everything before them committed. After a
  kill, the items after the last checkpoint come again and are skipped as unchanged.
- **Reconcile.** A crawl from the beginning records when it started (`reconcile_from`): a new
  source, a `resync`, or any sync of a connector without delta. While it runs every item is
  ingested (none skipped); when it is `done`, the source's items not synced since are removed
  (they left the source while nobody followed its deltas), then `reconcile_from` is cleared. A
  run that dies in between finishes the reconcile first next time. An item the crawl mentions but
  can't record (it changed while read, it can't be read, a field is refused, the event is
  malformed) is marked seen (core/catalog `markSourceItemSeen()`), so only items it never
  mentioned count as gone.
- **Unknown is not gone.** A crawl that meets a place it can't read (a `warning` `unreadable`:
  a folder it may not list, a busy file, another disk mounted inside) removes nothing: its
  reconcile is deferred (`reconcile_deferred`, and `reconcile-deferred` in every report after)
  to the next crawl from the beginning. That is the safer of the two ways: the runner keeps no
  tree (paths aren't stored), so it can't reconcile everything but what is under the unreadable
  place. The next crawl from the beginning comes by itself for a connector without delta, after
  a `resync`, or when an admin asks for it (`discard-reconcile`, below).
- **The reconcile guard.** A reconcile that would remove more than `reconcileGuard` allows, or
  anything when the crawl mentioned no item at all, removes nothing. Allowed: at most
  `maxFraction` (25%) of the source's items, or more only when that is at most `minItems` (50)
  items and less than half the source; per source, from its connection's configuration. So a
  small source emptied but for a placeholder (40 of 41) is held as surely as a large one. It
  records the count (`reconcile_held`), fails with `reconcile-guard` (`reconcileHeld` in the
  report), and does so every run: **while a reconcile is held, the source's deltas are held
  too**. A folder not mounted, a lost state, an admin's reset or a connector that says `done`
  too soon can't empty a source. Once an admin has checked the source:
  - `openhoard admin source confirm-reconcile`: the next sync removes up to that many (a larger
    count is held again);
  - `openhoard admin source discard-reconcile`: nothing is removed, and the source is crawled
    afresh from the beginning, from a clean state; that crawl's reconcile is guarded again (it
    also runs a deferred reconcile);
  - `openhoard admin source accept-identity`: for a source that is now another one (below).
    All three are audited.
- **The source's identity.** A connector with `identity()` (fs: the root's inode, birth time and
  file system type; never a device number, which a remount changes) binds the source to its
  answer, recorded in `source_syncs` on the first sync, outside the connector's own state. The
  runner passes the recorded answer back, so a connector that can tell it is still the same
  source (fs, without birth times: its files are still there) keeps it. Another answer fails
  the run (`source-identity`) until an admin accepts it (`openhoard admin source
accept-identity`, audited), which starts a crawl from the beginning.
- **Bindings.** A source stays with the zone and the connector it was first synced with
  (`zone-mismatch`, `connector-mismatch`). It syncs indexed zones only, of a kind the
  connector declares (`zone-kind`): it hashes bytes on the server and keeps no copy, so a managed
  zone (which stores them first, M3) and a local-only zone (whose content never reaches the
  server; the local agent syncs it) are refused.
- **The connector is plugin code.** Every event is checked (`checkEvent()`); a bad item is
  skipped and reported, a bad token fails the run. Its failures go by their code; anything else
  it throws counts as retryable. A read that says it returned another version, or sends more or
  fewer bytes than it reported, is `changed`.

It returns a `SyncReport`, codes only (no messages): `status` and what to do next.

| status      | means                                                         | the job then                    |
| ----------- | ------------------------------------------------------------- | ------------------------------- |
| `done`      | the crawl or delta reached its end                            | waits for the next schedule     |
| `partial`   | stopped at a checkpoint after `budgetMs` or `maxItems`        | runs again now                  |
| `retry`     | throttled, unreachable, or the queue down (`error`: the code) | runs again after `retryAfterMs` |
| `failed`    | `auth`, `permanent`, or a configuration it refuses (`error`)  | stops; an admin looks           |
| `cancelled` | the signal aborted                                            | resumes next time               |

Per item: `changed`, `not-found`, `permanent` and ingest refusals (`ingest-invalid`…) skip the
item (reported, the first 100 with their ids); a throttle or a retryable failure is waited out in
place up to `maxWaitMs` (30 s) and `attempts` (3), then the run stops with `retry`. An enqueue
that fails after its ingest committed is tried again for the committed version (never a second
ingest); one that keeps failing ends the run with `retry` (`enqueue`), and the item, ingested
but not enqueued, waits for the sweep. `runSync()` throws only for its own failures (the database
unreachable, a bug). Connector warnings are listed in `warnings`.

`budgetMs` and `maxItems` end a run at the first checkpoint after the time or the number of
items (`partial`). Both can only stop at a checkpoint: a connector that never yields one runs
until its stream ends, or until the job's signal aborts the run. The fs connector checkpoints
deltas as well as crawls.

**Reading indexed zones** (T-402): `connectorContentSource({ db, connectorFor, tenantKey,
onStale })` is the `ContentSource` for versions whose bytes stay in their source. It asks the
connector serving the version's source for exactly the version's source marker (its
contentVersion when recorded), checks the size (and, with the key, the BLAKE3 blob id), and
throws when the item changed or went since, so the enrichment job is retried after the next
sync has recorded what happened; `onStale` hears of it. It answers null for what it can't read
this way (a managed zone's bytes, a deleted object, a source no connector serves). Compose it
with core/storage's `blobContentSource()` using `firstOf(blobs, connectors)`. Indexed zones are
extracted only with `startJobs({ extract: { indexedZones: true } })`.

**Scheduling it (T-303).** Not wired into `startJobs()` yet; the plan:

- a `sync` queue, `stately`, keyed by tenant and source (one run per source at a time, which
  `runSync()` relies on), with a lease (`expireInSeconds`) above the `budgetMs` it passes;
- the server's connection config names each source's connector, root or site, zone, owner and
  schedule; a per-source cron (pg-boss `schedule`) sends the job, and `onStale` sends one early;
- the handler builds the connector and calls `runSync()` with the job's signal, then acts on the
  status: `partial` sends the next job now, `retry` one after `retryAfterMs`, `failed` records
  the error for admins (audited) and stops scheduling until they fix it;
- out-of-process connectors (the local agent's folders) push the same events through an ingest
  API instead, authenticated as the tenant's service account with a key scoped to their zones
  (T-111; the `ingest` action is still to add).

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
| `extract`                  | managed zones only     | the extract step's settings: `indexedZones`, `limits`, `budgetMs`   |
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
`startJobs({ content })`. The sync tests (sync.test.ts) run the fs connector over temporary
folders and the SDK's in-memory source for faults: first crawl, deltas skipping unchanged
items, edits, renames and moves (unread when the content version stays), soft deletes and
restores, a killed crawl resumed from its checkpoint without duplicates, simulated deadlocks
retried, lost state (resync and reconcile), a reconcile finished after a crash, zone and
connector bindings, throttles (waited out, or ending the run), refused credentials, a
connector without delta, bad events and tokens, the time budget, and indexed zones read through
the connector: exact bytes, changed ones refused, and text extracted by the pipeline.
