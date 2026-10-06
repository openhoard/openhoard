import {
  blobIdOf,
  ingest,
  IngestError,
  markSourceItemSeen,
  noteSourceFacts,
  removeFromSource,
  sourceItemState,
  type IngestInput,
  type IngestResult,
} from "@openhoard/core-catalog";
import {
  insideWithTenant,
  isId,
  isRetryable,
  lockPrincipals,
  NestedWorkError,
  objects,
  sourceRefs,
  sourceSyncs,
  zones,
  type Database,
  type Tx,
} from "@openhoard/core-db";
import {
  acceptAcl,
  canonicalUrl,
  changedError,
  checkDescription,
  checkEvent,
  ConnectorError,
  isAbortError,
  isConnectorError,
  refOf,
  retryDelayMs,
  storableText,
  titleOf,
  type Connector,
  type ConnectorDescription,
  type ConnectorErrorCode,
  type ItemAcl,
  type SourceItem,
  type SourceUser,
  type SyncEvent,
} from "@openhoard/sdk";
import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { aclResolver, applySourceAcl, withdrawSourceGrants, type AclOutcome } from "./acl.js";
import type { JobsLogger } from "./jobs.js";

/*
 * The sync runner (T-301): drives one connector over one source into the catalog, and keeps
 * where it got to, so a sync killed at any point resumes there (T-303).
 *
 *   crawl (from the start, or a checkpoint) ── done ──▶ delta, delta, delta…
 *        ▲                                                   │
 *        └── resync: a token the connector can't use any more ┘
 *
 * It follows core/catalog's ingest contract:
 *
 * - One item per transaction, in the source's order, run again on deadlock or serialization
 *   failure (40P01, 40001). Slow work (reading and hashing bytes) happens outside transactions.
 * - Unchanged items are skipped before anything is read: sourceItemState() has the eTag the
 *   last ingest recorded. An item whose eTag changed but whose contentVersion didn't (a rename,
 *   a move) is recorded with the content it already has, without reading it. Only new content
 *   is read, counted against the size the connector reported, hashed with the tenant's blob key
 *   (core/catalog blobIdOf()) and ingested.
 * - A connector that imports permissions (aclImport()) is asked for an item's each time the
 *   source mentions it, changed or not, and the grants the source made on the object are made
 *   equal to them (acl.ts), in the transaction that records the item. A file is never recorded
 *   with permissions that couldn't be read. An item that can't be recorded this time still has
 *   its permissions applied to what it already is here; when they couldn't be read either, the
 *   source's grants on it are withdrawn (unknown is not allowed) until the item is next
 *   mentioned: by a delta when it changes, by the next crawl at the latest. A connector that
 *   imports none leaves only the owner: grants an earlier import made are taken back when the
 *   run starts.
 * - Deletes are soft (removeFromSource()); a later ingest of the item restores it.
 * - Enrichment is enqueued after each ingest commits (Jobs.enqueueAfterIngest), never inside.
 * - A checkpoint or cursor is saved (source_syncs) only after everything before it committed.
 *   Items after the last checkpoint come again after a kill, and are skipped as unchanged.
 * - A crawl from the beginning records when it started (`reconcile_from`). When it is done, the
 *   source's items it didn't record since then are removed: they left the source while nobody
 *   followed its deltas (a first sync over items already known, a resync, a connector without
 *   delta, whose every sync is a crawl). While it runs, every item is recorded (nothing skipped
 *   as unchanged), and every item it mentions but can't record (skipped, invalid) is marked seen
 *   (markSourceItemSeen()), so only items it never mentioned count as gone.
 * - A reconcile can't empty a source by mistake (a folder not mounted, a lost state, a
 *   connector that says `done` too soon): when it would remove more than `reconcileGuard`
 *   allows (by default over 25% of the source's items and either over 50 of them or half the
 *   source), or anything at all when the crawl mentioned no item, it removes nothing, records
 *   how many it would have (`reconcile_held`) and fails (`reconcile-guard`), every run, deltas
 *   included, until an admin confirms that many (`admin source confirm-reconcile`) or discards
 *   it (`admin source discard-reconcile`: a clean crawl from the beginning, guarded again).
 *   Up to 2 always pass (routine deletions in a small source).
 * - A delta can't either: its items and deletes are applied a checkpoint at a time, once the
 *   deletes among them, with those it made before, are counted against the same guard. Past
 *   it, nothing since the last checkpoint is applied and the run fails (`delete-guard`), held
 *   the same way (`delta_deletes` keeps the count across runs until the delta is done).
 * - An item a `warning` names is taken as mentioned by the crawl: a reconcile doesn't remove it.
 * - A crawl that met a place it couldn't read (a `warning` `unreadable`) removes nothing: its
 *   reconcile is deferred (`reconcile_deferred`, said in every report) to the next crawl from the
 *   beginning, which the runner can't narrow to the readable part (it keeps no tree).
 * - A connector with identity() binds the source to what it answers (a folder's inode and birth
 *   time): another answer later (another disk mounted at the path) fails the run
 *   (`source-identity`) until an admin accepts it, which starts a crawl from the beginning.
 *
 * The connector is plugin code: each event is checked (SDK checkEvent()) before the catalog sees
 * it, and a bad one skipped and reported. Its failures are sorted by their code (SDK errors.ts);
 * anything it throws that isn't a ConnectorError counts as retryable. Reports carry codes, never
 * messages. An enqueue that keeps failing ends the run with `retry` (`enqueue`). The runner
 * throws only for its own failures (the database unreachable, a bug), for
 * the job to retry.
 *
 * One run per source at a time: the job running it (T-303) is keyed by tenant and source. Two
 * at once couldn't corrupt the catalog (ingest serializes each item), but could save each
 * other's tokens out of order.
 */

export interface SyncOptions {
  tenantId: string;
  /** The connection's name: a lower-case slug, the `source` of its items (`fs-finance`). */
  source: string;
  /** The zone its items go to. A source stays in the zone it was first synced into. */
  zoneId: string;
  connector: Connector;
  /** Who owns new objects: `user:` and a user's id (a person; ingest refuses anyone else). */
  ownerId: string;
  /** The tenant's 32-byte blob key: blob ids are keyed by it (core/catalog blobIdOf()). */
  tenantKey: (tenantId: string) => Uint8Array | Promise<Uint8Array>;
  /** Enqueues enrichment after an ingest commits: `jobs.enqueueAfterIngest`. */
  enqueue: (
    tenantId: string,
    result: Pick<IngestResult, "versionId" | "created" | "renamed">,
  ) => Promise<unknown>;
  /**
   * The OpenHoard user (`user:usr_…`) the source's last editor is, or undefined (T-305 maps
   * them). Without it no edit is recorded.
   */
  authorOf?: (user: SourceUser) => string | undefined;
  signal?: AbortSignal;
  /** Tries per item before the run stops, to be run again later. Default 3. */
  attempts?: number;
  /** The longest the run waits in place for a throttle or a retry, in ms. Default 30 s. */
  maxWaitMs?: number;
  /**
   * Stops at the first checkpoint after this long (ms), with status `partial`, so one run fits
   * its job's lease; the next run goes on from there. Default: no limit.
   */
  budgetMs?: number;
  /**
   * Stops at the first checkpoint after this many items (and deletes) in one run, with status
   * `partial`. Like `budgetMs`, it can only stop at a checkpoint: a connector that never yields
   * one runs until its stream ends or the run's signal aborts. Default: no limit.
   */
  maxItems?: number;
  /**
   * When a reconcile is held for an admin (see the header): more than `maxFraction` (default
   * 0.25) of the source's items and more than `minItems` (default 50). Per source, from its
   * connection's configuration.
   */
  reconcileGuard?: { maxFraction?: number; minItems?: number };
  /**
   * The largest file read ({@link SYNC_MAX_FILE_BYTES} by default). A larger one is left out
   * (`too-large` in the report's skips) without being read: a file that takes longer to read
   * than a run lasts would be met again by every run, and nothing after it, the source's
   * permission changes included, would ever be applied.
   */
  maxFileBytes?: number;
  log?: JobsLogger;
  /** How the run waits; tests replace it. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export type SyncStatus =
  /** A crawl or a delta ran to its end: everything the source said is recorded. */
  | "done"
  /** Stopped at a checkpoint to keep within `budgetMs`: run again now to go on. */
  | "partial"
  /** Stopped for a failure of the moment (throttled, unreachable): run again after `retryAfterMs`. */
  | "retry"
  /** Stopped for a failure a retry won't fix (credentials, configuration): an admin must act. */
  | "failed"
  /** The signal aborted. The next run resumes from the last saved checkpoint. */
  | "cancelled";

export interface SyncReport {
  status: SyncStatus;
  /** What ran last: a crawl, or a delta. */
  phase: "crawl" | "delta";
  /** `retry`: how long to wait before the next run, in ms. */
  retryAfterMs?: number;
  /**
   * `retry` and `failed`: why, as a code. The connector's (`throttled`, `retryable`, `auth`,
   * `permanent`, `resync`) or the runner's: `invalid-connector`, `unknown-zone`, `zone-kind` (not an
   * indexed zone, or one the connector can't serve), `zone-mismatch` and `connector-mismatch` (the
   * source was synced into another zone, or by another connector), `source-identity` (the
   * source is not the one first synced), `reconcile-guard` and `delete-guard` (see
   * `reconcileHeld`), `invalid-token`, `incomplete` (a stream ended without `done`), `database`, `enqueue`
   * (enqueueing enrichment kept failing: the committed items wait for the sweep).
   */
  error?: string;
  /**
   * `reconcile-guard` and `delete-guard`: how many items the reconcile or the delta would have
   * removed, held for an admin.
   */
  reconcileHeld?: number;
  counts: {
    /** File events seen. */
    files: number;
    /** Folder events seen (the catalog records files). */
    folders: number;
    /** Files recorded: new, changed, renamed, moved or restored. */
    ingested: number;
    /** Files skipped as unchanged. */
    unchanged: number;
    /** Items skipped for a reason listed in `skipped`. */
    skipped: number;
    /** Items removed because the source said they were deleted. */
    deleted: number;
    /** Items removed because a crawl from the beginning didn't find them. */
    reconciled: number;
    /** Grants made because the source lets someone see an item (acl.ts). */
    grantsAdded: number;
    /** Grants revoked because the source no longer does. */
    grantsRevoked: number;
    /** Distinct users and guests the source names that match nobody here: they see nothing. */
    unmappedUsers: number;
    /** Distinct groups the source names that match no group here: their members see nothing. */
    unmappedGroups: number;
  };
  /** Items left out, and why (the first {@link MAX_REPORTED_SKIPS}). */
  skipped: { externalId?: string; reason: string }[];
  /**
   * What the connector warned of (`unreadable`, `hard-link`…), and the runner's own
   * (`reconcile-deferred`: a crawl met an unreadable place, so the source's reconcile waits for
   * the next crawl from the beginning), the first {@link MAX_REPORTED_SKIPS}.
   */
  warnings: { code: string; externalId?: string }[];
}

/** How many skipped items a report lists (it counts them all). */
export const MAX_REPORTED_SKIPS = 100;
/** Items looked up per transaction when reconciling. */
const RECONCILE_BATCH = 500;

/** The largest file a sync reads by default: 2 GiB. */
export const SYNC_MAX_FILE_BYTES = 2 * 1024 ** 3;

/** No permissions of the source's: nobody but the object's owner. */
const NO_ACL: ItemAcl = Object.freeze({ basis: "owner-only", entries: [] });

/** The connector's answer to aclImport() wasn't an ACL. */
class InvalidAcl extends Error {}

/** Distinct unmapped principals a run counts: beyond that, "at least this many". */
const MAX_UNMAPPED = 10_000;

/** Why a run ends early. */
class Stop {
  constructor(
    readonly status: Exclude<SyncStatus, "done">,
    readonly error?: string,
    readonly retryAfterMs?: number,
  ) {}
}

type Phase = "crawl" | "delta";

/** Runs one sync of a source (see the header) and reports how it went. */
export async function runSync(db: Database, options: SyncOptions): Promise<SyncReport> {
  if (insideWithTenant()) throw new NestedWorkError("runSync()");
  const { tenantId, source, zoneId, connector } = options;
  if (!isId("tenant", tenantId) || !isId("zone", zoneId)) {
    throw new TypeError("runSync: expects a tenant id and a zone id");
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(source)) {
    throw new TypeError("runSync: source must be a lower-case slug");
  }
  const signal = options.signal ?? new AbortController().signal;
  const attempts = options.attempts ?? 3;
  const maxWaitMs = options.maxWaitMs ?? 30_000;
  const sleep = options.sleep ?? abortableSleep;
  const log = options.log ?? {};
  const started = Date.now();
  const report: SyncReport = {
    status: "done",
    phase: "crawl",
    counts: {
      files: 0,
      folders: 0,
      ingested: 0,
      unchanged: 0,
      skipped: 0,
      deleted: 0,
      reconciled: 0,
      grantsAdded: 0,
      grantsRevoked: 0,
      unmappedUsers: 0,
      unmappedGroups: 0,
    },
    skipped: [],
    warnings: [],
  };
  const maxItems = options.maxItems ?? Infinity;
  const maxFileBytes = options.maxFileBytes ?? SYNC_MAX_FILE_BYTES;
  const guard = {
    maxFraction: options.reconcileGuard?.maxFraction ?? 0.25,
    minItems: options.reconcileGuard?.minItems ?? 50,
  };
  if (
    !(guard.maxFraction >= 0 && guard.maxFraction <= 1) ||
    !(guard.minItems >= 0) ||
    !(maxItems >= 1)
  ) {
    throw new RangeError("runSync: reconcileGuard or maxItems out of range");
  }
  /** Items and deletes applied in this run. */
  let applied = 0;
  /** A crawl from the beginning is running: record every item it yields. */
  let reconciling = false;
  /** How many of the source's items the delta now running has removed (source_syncs). */
  let deltaDeletes = 0;
  let description: ConnectorDescription | undefined;
  /** The source's permissions become grants (acl.ts) when its connector imports them. */
  let importing = false;
  const resolver = aclResolver(tenantId);
  /** Who the source names that matches nobody here, as far as it is worth remembering. */
  const unmapped = { users: new Set<string>(), groups: new Set<string>() };
  let key: Promise<Uint8Array> | undefined;
  const tenantKey = () => (key ??= Promise.resolve(options.tenantKey(tenantId)));

  const skip = (reason: string, externalId?: string) => {
    report.counts.skipped++;
    if (report.skipped.length < MAX_REPORTED_SKIPS) {
      report.skipped.push(externalId === undefined ? { reason } : { externalId, reason });
    }
  };
  const warn = (code: string, externalId?: string) => {
    if (report.warnings.length < MAX_REPORTED_SKIPS) {
      report.warnings.push(externalId === undefined ? { code } : { code, externalId });
    }
  };
  const end = (stop: Stop | null): SyncReport => {
    report.counts.unmappedUsers = unmapped.users.size;
    report.counts.unmappedGroups = unmapped.groups.size;
    if (unmapped.groups.size + unmapped.users.size > 0) {
      // Groups by the source's ids, for an admin to provision; people only counted.
      log.warn?.(
        {
          tenantId,
          source,
          unmappedUsers: unmapped.users.size,
          unmappedGroups: [...unmapped.groups].slice(0, 20),
        },
        "sync: the source grants access to people or groups unknown here, who get none",
      );
    }
    report.status = stop?.status ?? "done";
    if (stop?.error !== undefined) report.error = stop.error;
    if (stop?.retryAfterMs !== undefined) report.retryAfterMs = stop.retryAfterMs;
    const { skipped: _list, warnings: _warnings, ...summary } = report;
    log.info?.({ tenantId, source, ...summary }, "sync ended");
    return report;
  };

  /** One transaction, run again after a deadlock or a serialization failure. */
  const transaction = async <T>(work: (tx: Tx) => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await db.withTenant(tenantId, work);
      } catch (e) {
        if (!isRetryable(e) || attempt >= 5) throw e;
        await sleep(10 * attempt + Math.random() * 20, signal);
      }
    }
  };
  const where = () => and(eq(sourceSyncs.tenantId, tenantId), eq(sourceSyncs.source, source));
  /** Saves a checkpoint or cursor, and how many items the delta has removed so far. */
  const save = (phase: Phase, token: string, ended = false) =>
    transaction((tx) =>
      tx
        .update(sourceSyncs)
        .set({
          phase,
          token,
          deltaDeletes: phase === "delta" && !ended ? deltaDeletes : 0,
          // A delta at its end is past what its guard held.
          ...(ended && phase === "delta" ? { reconcileHeld: null, reconcileConfirmed: null } : {}),
          updatedAt: sql`now()`,
        })
        .where(where()),
    );
  /** Starts a crawl from the beginning, noting when, for the reconcile after it. */
  const restart = async () => {
    await transaction((tx) =>
      tx
        .update(sourceSyncs)
        .set({
          phase: "crawl",
          token: null,
          reconcileFrom: sql`now()`,
          deltaDeletes: 0,
          updatedAt: sql`now()`,
        })
        .where(where()),
    );
    reconciling = true;
    deltaDeletes = 0;
  };

  try {
    // ── The connector, the zone, and where the source's sync stands ────────────────────────
    try {
      description = connector.describe();
    } catch {
      return end(new Stop("failed", "invalid-connector"));
    }
    if (checkDescription(description).length > 0) {
      return end(new Stop("failed", "invalid-connector"));
    }
    const described: ConnectorDescription = description;
    importing = described.capabilities.aclImport && connector.aclImport !== undefined;
    const zone = await transaction(async (tx) => {
      const [row] = await tx
        .select({ kind: zones.kind })
        .from(zones)
        .where(and(eq(zones.tenantId, tenantId), eq(zones.id, zoneId)));
      return row;
    });
    if (!zone) return end(new Stop("failed", "unknown-zone"));
    // Indexed zones only: this runner reads and hashes bytes on the server and keeps no copy.
    // A managed zone stores them first (M3); a local-only zone's content never reaches the
    // server (the local agent syncs it).
    if (zone.kind !== "indexed" || !description.zoneKinds.includes(zone.kind)) {
      return end(new Stop("failed", "zone-kind"));
    }
    const state = await transaction(async (tx) => {
      // A source seen for the first time starts with a crawl that reconciles: it may have
      // items already (its state was lost), and those the crawl doesn't find must go.
      await tx
        .insert(sourceSyncs)
        .values({
          tenantId,
          source,
          zoneId,
          connector: described.id,
          phase: "crawl",
          token: null,
          reconcileFrom: sql`now()`,
        })
        .onConflictDoNothing();
      const [row] = await tx.select().from(sourceSyncs).where(where());
      if (!row) throw new Error("source_syncs row vanished");
      return row;
    });
    if (state.zoneId !== zoneId) return end(new Stop("failed", "zone-mismatch"));
    if (state.connector !== description.id) return end(new Stop("failed", "connector-mismatch"));
    if (connector.identity) {
      let identity: string;
      try {
        identity = await connector.identity(signal, state.sourceIdentity ?? undefined);
      } catch (e) {
        throw fromConnector(e);
      }
      if (!storableText(identity) || identity.length === 0 || identity.length > 1024) {
        return end(new Stop("failed", "invalid-connector"));
      }
      if (state.sourceIdentity === null) {
        await transaction((tx) =>
          tx.update(sourceSyncs).set({ sourceIdentity: identity }).where(where()),
        );
      } else if (state.sourceIdentity !== identity) {
        return end(new Stop("failed", "source-identity"));
      }
    }
    // A source whose permissions aren't imported (any more) leaves its files to their owner:
    // what an earlier import granted is taken back now, not as each file comes round.
    if (!importing) {
      report.counts.grantsRevoked += await transaction((tx) =>
        withdrawSourceGrants(tx, tenantId, source),
      );
    }
    let phase: Phase = state.phase;
    let token = state.token;
    reconciling = phase === "crawl" && state.reconcileFrom !== null;
    deltaDeletes = phase === "delta" ? state.deltaDeletes : 0;
    // Said every run until a crawl from the beginning reconciles.
    if (state.reconcileDeferred) warn("reconcile-deferred");
    // A run that stopped between a crawl's `done` and the end of its reconcile finishes it.
    if (phase === "delta" && state.reconcileFrom !== null) await reconcile();

    // ── A crawl or a delta, and one resync when the connector asks for it ──────────────────
    for (let resynced = false; ;) {
      if (phase === "delta" && !(description.capabilities.delta && connector.delta)) {
        // Without delta, every sync crawls it all again, and reconciles.
        await restart();
        phase = "crawl";
        token = null;
      }
      report.phase = phase;
      try {
        let stream: AsyncIterable<SyncEvent>;
        try {
          stream =
            phase === "delta" && connector.delta
              ? connector.delta(token as string, signal)
              : connector.crawl(token, signal);
        } catch (e) {
          throw fromConnector(e);
        }
        return end(await follow(stream, phase));
      } catch (e) {
        if (!(isConnectorError(e) && e.code === "resync") || resynced) throw e;
        resynced = true;
        log.info?.({ tenantId, source }, "sync: the connector asked to crawl again");
        await restart();
        phase = "crawl";
        token = null;
      }
    }
  } catch (e) {
    if (e instanceof Stop) return end(e);
    if (signal.aborted) return end(new Stop("cancelled"));
    if (isConnectorError(e)) return end(stopFor(e.code, e, 1));
    if (isRetryable(e)) return end(new Stop("retry", "database", 1_000));
    throw e;
  }

  /**
   * Applies a stream's events in order: null when it reached `done`, else why it stopped.
   *
   * A delta's items and deletes wait until its next checkpoint (or `done`): the deletes among
   * them are counted first, with those the delta already made, and when they would remove more
   * of the source than the guard allows, nothing since the last checkpoint is applied and the
   * run is held (`delete-guard`) like a reconcile. A connector that never checkpoints a delta
   * has the whole delta counted before anything of it is applied.
   */
  async function follow(stream: AsyncIterable<SyncEvent>, phase: Phase): Promise<Stop | null> {
    const events = stream[Symbol.asyncIterator]();
    const pending: SyncEvent[] = [];
    let finished = false;
    /** Applies what waits, unless the guard holds it. */
    const flush = async (): Promise<Stop | null> => {
      const deletes = pending.flatMap((e) => (e.type === "deleted" ? [e.externalId] : []));
      if (deletes.length > 0) {
        const removing = await liveAmong(deletes);
        const total = deltaDeletes + removing;
        // The source as it was when the delta began: what is live now and what it removed.
        const size = (await liveItems()) + deltaDeletes;
        if (removing > 0 && tooManyGone(total, size)) {
          const [row] = await transaction((tx) =>
            tx
              .select({ confirmed: sourceSyncs.reconcileConfirmed })
              .from(sourceSyncs)
              .where(where()),
          );
          const confirmed = row?.confirmed ?? null;
          if (!(confirmed !== null && total <= confirmed)) {
            await transaction((tx) =>
              tx
                .update(sourceSyncs)
                .set({ reconcileHeld: total, updatedAt: sql`now()` })
                .where(where()),
            );
            report.reconcileHeld = total;
            log.warn?.({ tenantId, source, held: total, size }, "sync: delta deletes held");
            return new Stop("failed", "delete-guard");
          }
        }
        deltaDeletes = total;
      }
      for (const event of pending.splice(0)) await applyEvent(event);
      return null;
    };
    try {
      for (;;) {
        let next: IteratorResult<SyncEvent>;
        try {
          next = await events.next();
        } catch (e) {
          finished = true;
          throw fromConnector(e);
        }
        if (next.done) {
          finished = true;
          // A stream that ends without `done` is the connector's bug; its checkpoints stand.
          return signal.aborted ? new Stop("cancelled") : new Stop("retry", "incomplete", 60_000);
        }
        if (signal.aborted) return new Stop("cancelled");
        const event = next.value;
        if (checkEvent(event, description) !== null) {
          const type = (event as { type?: unknown } | null)?.type;
          if (type === "checkpoint" || type === "done") return new Stop("failed", "invalid-token");
          const id = idIn(event);
          skip("invalid", id);
          if (id !== undefined && type === "item") await seen(id);
          continue;
        }
        switch (event.type) {
          case "item":
          case "deleted":
            if (phase === "delta") pending.push(event);
            else await applyEvent(event);
            break;
          case "checkpoint": {
            const held = await flush();
            if (held) return held;
            await save(phase, event.token);
            // Who is who is asked afresh from here: the directory may have changed.
            resolver.clear();
            if (
              (options.budgetMs !== undefined && Date.now() - started >= options.budgetMs) ||
              applied >= maxItems
            ) {
              return new Stop("partial");
            }
            break;
          }
          case "warning":
            warn(event.code, event.externalId);
            // An item a warning names is there (the connector couldn't serve it this time):
            // mentioned, so a reconcile doesn't take it for gone.
            if (event.externalId !== undefined) await seen(event.externalId);
            if (event.code === "unreadable" && reconciling) {
              // Unknown is not gone: this crawl removes nothing, and the next crawl from the
              // beginning reconciles instead (the runner keeps no tree, so it can't reconcile
              // all but what is under the unreadable place).
              await transaction((tx) =>
                tx
                  .update(sourceSyncs)
                  .set({ reconcileFrom: null, reconcileDeferred: true, updatedAt: sql`now()` })
                  .where(where()),
              );
              reconciling = false;
              warn("reconcile-deferred");
            }
            break;
          case "done": {
            const held = await flush();
            if (held) return held;
            await save("delta", event.cursor, phase === "delta");
            deltaDeletes = 0;
            if (reconciling) await reconcile();
            return null;
          }
        }
      }
    } finally {
      // Stopped early: let the connector close what it holds.
      if (!finished) await events.return?.().catch(() => undefined);
    }
  }

  /** Applies one item or delete. */
  async function applyEvent(event: SyncEvent): Promise<void> {
    if (event.type === "item") {
      applied++;
      if (event.item.kind === "folder") report.counts.folders++;
      else await apply(event.item);
    } else if (event.type === "deleted") {
      applied++;
      const removed = await transaction((tx) =>
        removeFromSource(tx, tenantId, source, event.externalId),
      );
      if (removed !== null) report.counts.deleted++;
    }
  }

  /**
   * Whether removing `gone` of a source of `size` items is more than the guard lets through
   * without an admin: more than `maxFraction` of it, and either more than `minItems` or half of
   * it. Up to 2 always pass: routine deletions in a small source.
   */
  function tooManyGone(gone: number, size: number): boolean {
    return (
      gone > 2 && gone > guard.maxFraction * size && (gone > guard.minItems || gone >= 0.5 * size)
    );
  }

  /** How many of the source's items are live (not removed). */
  async function liveItems(): Promise<number> {
    const [row] = await transaction((tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(sourceRefs)
        .innerJoin(
          objects,
          and(eq(objects.tenantId, sourceRefs.tenantId), eq(objects.id, sourceRefs.objectId)),
        )
        .where(
          and(
            eq(sourceRefs.tenantId, tenantId),
            eq(sourceRefs.source, source),
            isNull(objects.deletedAt),
          ),
        ),
    );
    return Number(row?.n ?? 0);
  }

  /** How many of these external ids are live items of the source. */
  async function liveAmong(externalIds: readonly string[]): Promise<number> {
    const ids = [...new Set(externalIds)];
    let n = 0;
    for (let at = 0; at < ids.length; at += 1_000) {
      const chunk = ids.slice(at, at + 1_000);
      const [row] = await transaction((tx) =>
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(sourceRefs)
          .innerJoin(
            objects,
            and(eq(objects.tenantId, sourceRefs.tenantId), eq(objects.id, sourceRefs.objectId)),
          )
          .where(
            and(
              eq(sourceRefs.tenantId, tenantId),
              eq(sourceRefs.source, source),
              inArray(sourceRefs.externalId, chunk),
              isNull(objects.deletedAt),
            ),
          ),
      );
      n += Number(row?.n ?? 0);
    }
    return n;
  }

  /** Records one file, or skips it (see the header). */
  async function apply(item: SourceItem): Promise<void> {
    report.counts.files++;
    /** The ingest that committed: a retry after its enqueue failed only enqueues it again. */
    let committed: IngestResult | undefined;
    /** What the catalog has of the item, as last looked up. */
    let known: Awaited<ReturnType<typeof sourceItemState>> | undefined;
    /** Who the source lets see it: asked once, however many attempts recording it takes. */
    let acl: ItemAcl | undefined;
    /**
     * The item can't be recorded this time. What it already is here doesn't keep grants the
     * source no longer makes: its permissions as just read are applied all the same, and when
     * they couldn't be read, the source's grants on it are withdrawn until they can.
     */
    const skipSeen = async (reason: string) => {
      if (known && !known.deleted && (importing || acl !== undefined)) {
        const objectId = known.objectId;
        tally(await transaction((tx) => grant(tx, objectId, acl ?? NO_ACL)));
      }
      skip(reason, item.externalId);
      await seen(item.externalId);
    };
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      try {
        if (committed) {
          await enqueue(committed);
          return;
        }
        const state = await transaction((tx) =>
          sourceItemState(tx, tenantId, source, item.externalId),
        );
        known = state;
        // Who the source lets see it, asked every time the item is mentioned: its permissions
        // can change without its eTag changing.
        const permissions = (acl ??= await permissionsOf(item));
        if (state && !state.deleted && state.etag === item.etag && !reconciling) {
          // What the source says of it that isn't recorded yet (an item recorded before this
          // was kept), without recording the item again.
          const facts = factsOf(item);
          const said =
            (facts.modifiedAt?.getTime() ?? null) === (state.facts.modifiedAt?.getTime() ?? null) &&
            (facts.sourceModifiedBy ?? null) === state.facts.sourceModifiedBy &&
            (facts.sourceCreatedBy ?? null) === state.facts.sourceCreatedBy;
          // (A source with none of its own is looked at when the item is next recorded.)
          if (permissions.basis !== "owner-only" || !said) {
            const outcome = await transaction(async (tx) => {
              // Grants first: they may take the principals' lock, which comes before the item.
              const granted =
                permissions.basis === "owner-only"
                  ? undefined
                  : await grant(tx, state.objectId, permissions);
              if (!said) await noteSourceFacts(tx, tenantId, source, item.externalId, facts);
              return granted;
            });
            if (outcome) tally(outcome);
          }
          report.counts.unchanged++;
          return;
        }
        /** The item recorded and its grants made equal to the source's, in one transaction. */
        const record = async (content: { blobId: string; size: number }) => {
          const recorded = await transaction(async (tx) => {
            // The lock order (core/catalog locks.ts): principals before the item, whenever
            // grants may change: the source names someone, or the item may hold its grants.
            if (permissions.entries.length > 0 || (state && permissions.basis !== "owner-only")) {
              await lockPrincipals(tx, tenantId);
            }
            const ingested = await ingest(tx, tenantId, input(item, content));
            return { ingested, granted: await grant(tx, ingested.objectId, permissions) };
          });
          tally(recorded.granted);
          return recorded.ingested;
        };
        let result: IngestResult | undefined;
        const current = state?.current;
        if (current && current.sourceVersion === item.contentVersion) {
          // Only its name, place or eTag changed: the content is the one already recorded.
          try {
            result = await record({ blobId: current.blobId, size: item.size as number });
          } catch (e) {
            // Recorded with another size after all: read it.
            if (!(e instanceof IngestError && e.code === "blob-mismatch")) throw e;
          }
        }
        if (result === undefined && (item.size as number) > maxFileBytes) {
          return skipSeen("too-large");
        }
        result ??= await record(await readContent(item));
        report.counts.ingested++;
        committed = result;
        await enqueue(result);
        return;
      } catch (e) {
        if (e instanceof IngestError) return skipSeen(`ingest-${e.code}`);
        // Permissions that aren't any: nothing of the item is recorded on their word.
        if (e instanceof InvalidAcl) return skipSeen("invalid-acl");
        if (signal.aborted || e instanceof Stop) throw e;
        if (e instanceof EnqueueFailed) {
          // Committed, not enqueued: try the enqueue again; the sweep is the last resort.
          if (attempt >= attempts) {
            log.warn?.({ tenantId, source }, "sync: enqueueing enrichment keeps failing");
            throw new Stop(
              "retry",
              "enqueue",
              retryDelayMs(e.cause, attempt, { maxMs: 3_600_000 }),
            );
          }
          await sleep(retryDelayMs(e.cause, attempt, { baseMs: 500, maxMs: maxWaitMs }), signal);
          continue;
        }
        if (!isConnectorError(e) && !isRetryable(e)) throw e;
        if (isConnectorError(e)) {
          switch (e.code) {
            case "changed":
            case "not-found":
            case "permanent":
            case "resync":
              // Gone, changed or unreadable: the next delta reports it again if it is there, and
              // a reconcile doesn't take it for gone meanwhile.
              return skipSeen(e.code);
            case "auth":
              throw stopFor(e.code, e, attempt);
          }
        }
        // A throttle, an unreachable source, a deadlock that outlasted its retries.
        const wait = retryDelayMs(e, attempt, { baseMs: 500, maxMs: maxWaitMs });
        if (attempt >= attempts || wait > maxWaitMs) {
          throw stopFor(isConnectorError(e) ? e.code : "retryable", e, attempt);
        }
        await sleep(wait, signal);
      }
    }
  }

  /**
   * Who the source lets see the item, checked. A connector that imports no permissions has
   * none to give: only the owner, and any grant an earlier import made is withdrawn when the
   * item is next recorded.
   */
  async function permissionsOf(item: SourceItem): Promise<ItemAcl> {
    if (!importing || !connector.aclImport) return NO_ACL;
    let said: unknown;
    try {
      said = await connector.aclImport(refOf(item), signal);
    } catch (e) {
      throw fromConnector(e);
    }
    try {
      return acceptAcl(said);
    } catch {
      throw new InvalidAcl();
    }
  }

  function grant(tx: Tx, objectId: string, acl: ItemAcl): Promise<AclOutcome> {
    return applySourceAcl(tx, tenantId, { source, objectId, acl, resolver });
  }

  /** Counts what a committed transaction did to the grants. */
  function tally(outcome: AclOutcome): void {
    report.counts.grantsAdded += outcome.added;
    report.counts.grantsRevoked += outcome.revoked;
    for (const [seen, ids] of [
      [unmapped.users, outcome.unmappedUsers],
      [unmapped.groups, outcome.unmappedGroups],
    ] as const) {
      for (const id of ids) if (seen.size < MAX_UNMAPPED) seen.add(id);
    }
  }

  async function enqueue(result: IngestResult): Promise<void> {
    try {
      await options.enqueue(tenantId, result);
    } catch (e) {
      throw new EnqueueFailed(e);
    }
  }

  /** While reconciling, notes that the crawl mentioned an item it couldn't record. */
  async function seen(externalId: string): Promise<void> {
    if (!reconciling) return;
    await transaction((tx) => markSourceItemSeen(tx, tenantId, source, externalId));
  }

  /** The item's bytes, read and hashed: exactly as many as it said it has. */
  async function readContent(item: SourceItem): Promise<{ blobId: string; size: number }> {
    const expected = item.size as number;
    const blobKey = await tenantKey();
    let size = 0;
    try {
      const result = await connector.read(refOf(item), signal);
      // A connector must refuse another version; saying it read one is the same.
      if (result.contentVersion !== item.contentVersion || result.size !== expected) {
        throw changedError();
      }
      async function* counted() {
        for await (const chunk of result.body) {
          if (!(chunk instanceof Uint8Array)) throw changedError("the connector sent no bytes");
          size += chunk.byteLength;
          if (size > expected) throw changedError();
          yield chunk;
        }
      }
      const { blobId } = await blobIdOf(blobKey, counted());
      if (size !== expected) throw changedError();
      return { blobId, size };
    } catch (e) {
      throw fromConnector(e);
    }
  }

  /** What the source says of the item besides its content, as the catalog keeps it. */
  function factsOf(item: SourceItem) {
    const at = item.modifiedAt === undefined ? NaN : Date.parse(item.modifiedAt);
    const kept = (id: string | undefined) =>
      id !== undefined && id !== "" && [...id].length <= 1024 && !id.includes("\0")
        ? id
        : undefined;
    return {
      // Only times the catalog records (1970 to 9999); others are left out, not refused.
      modifiedAt: at >= 0 && at < Date.UTC(10000, 0, 1) ? new Date(at) : undefined,
      sourceModifiedBy: kept(item.modifiedBy?.id),
      sourceCreatedBy: kept(item.createdBy?.id),
    };
  }

  function input(item: SourceItem, content: { blobId: string; size: number }): IngestInput {
    const author = item.modifiedBy ? options.authorOf?.(item.modifiedBy) : undefined;
    const facts = factsOf(item);
    return {
      source,
      externalId: item.externalId,
      zoneId,
      title: titleOf(item),
      ownerId: options.ownerId,
      content,
      ...(item.mediaType === undefined ? {} : { mime: item.mediaType }),
      ...(author !== undefined && author.startsWith("user:") && isId("user", author.slice(5))
        ? { authorId: author }
        : {}),
      ...(facts.modifiedAt === undefined ? {} : { modifiedAt: facts.modifiedAt }),
      ...(facts.sourceModifiedBy === undefined ? {} : { sourceModifiedBy: facts.sourceModifiedBy }),
      ...(facts.sourceCreatedBy === undefined ? {} : { sourceCreatedBy: facts.sourceCreatedBy }),
      ...(item.contentVersion === undefined ? {} : { sourceVersion: item.contentVersion }),
      etag: item.etag,
      // The parser's text, which is what was checked, never the connector's.
      ...(item.url === undefined ? {} : { url: canonicalUrl(item.url) }),
    };
  }

  /**
   * Removes the source's items the crawl from the beginning didn't record (synced before it
   * started), then clears `reconcile_from`. Compared in SQL, the database's clock on both sides.
   */
  async function reconcile(): Promise<void> {
    const joined = () =>
      and(
        eq(sourceRefs.tenantId, tenantId),
        eq(sourceRefs.source, source),
        eq(sourceSyncs.tenantId, sourceRefs.tenantId),
        eq(sourceSyncs.source, sourceRefs.source),
      );
    const [counts] = await transaction((tx) =>
      tx
        .select({
          live: sql<number>`(count(*) filter (where ${objects.deletedAt} is null))::int`,
          stale: sql<number>`(count(*) filter (where ${objects.deletedAt} is null and ${sourceRefs.syncedAt} < ${sourceSyncs.reconcileFrom}))::int`,
          seen: sql<number>`(count(*) filter (where ${sourceRefs.syncedAt} >= ${sourceSyncs.reconcileFrom}))::int`,
          confirmed: sql<number | null>`max(${sourceSyncs.reconcileConfirmed})`,
        })
        .from(sourceRefs)
        .innerJoin(
          objects,
          and(eq(objects.tenantId, sourceRefs.tenantId), eq(objects.id, sourceRefs.objectId)),
        )
        .innerJoin(sourceSyncs, joined()),
    );
    const stale = Number(counts?.stale ?? 0);
    const live = Number(counts?.live ?? 0);
    const confirmed = counts?.confirmed == null ? null : Number(counts.confirmed);
    // Held when the crawl mentioned nothing, or past the guard (tooManyGone()): a small source
    // emptied by a lost state (one placeholder file left) is held as surely as a large one.
    const tooMany = Number(counts?.seen ?? 0) === 0 || tooManyGone(stale, live);
    if (stale > 0 && tooMany && !(confirmed !== null && stale <= confirmed)) {
      await transaction((tx) =>
        tx
          .update(sourceSyncs)
          .set({ reconcileHeld: stale, updatedAt: sql`now()` })
          .where(where()),
      );
      report.reconcileHeld = stale;
      log.warn?.({ tenantId, source, held: stale, live }, "sync: reconcile held for an admin");
      throw new Stop("failed", "reconcile-guard");
    }
    for (;;) {
      if (signal.aborted) throw new Stop("cancelled");
      const stale = await transaction((tx) =>
        tx
          .select({ externalId: sourceRefs.externalId })
          .from(sourceRefs)
          .innerJoin(
            objects,
            and(eq(objects.tenantId, sourceRefs.tenantId), eq(objects.id, sourceRefs.objectId)),
          )
          .innerJoin(
            sourceSyncs,
            and(
              eq(sourceSyncs.tenantId, sourceRefs.tenantId),
              eq(sourceSyncs.source, sourceRefs.source),
            ),
          )
          .where(
            and(
              eq(sourceRefs.tenantId, tenantId),
              eq(sourceRefs.source, source),
              isNull(objects.deletedAt),
              lt(sourceRefs.syncedAt, sourceSyncs.reconcileFrom),
            ),
          )
          .orderBy(asc(sourceRefs.externalId))
          .limit(RECONCILE_BATCH),
      );
      if (stale.length === 0) break;
      for (const { externalId } of stale) {
        const removed = await transaction((tx) =>
          removeFromSource(tx, tenantId, source, externalId),
        );
        if (removed !== null) report.counts.reconciled++;
      }
    }
    await transaction((tx) =>
      tx
        .update(sourceSyncs)
        .set({
          reconcileFrom: null,
          reconcileHeld: null,
          reconcileConfirmed: null,
          reconcileDeferred: false,
          updatedAt: sql`now()`,
        })
        .where(where()),
    );
    reconciling = false;
  }

  /** How a failure with this code ends the run, after `attempt` tries. */
  function stopFor(code: ConnectorErrorCode, e: unknown, attempt: number): Stop {
    switch (code) {
      case "auth":
      case "permanent":
        return new Stop("failed", code);
      case "resync":
        return new Stop("retry", code, 0);
      default:
        return new Stop("retry", code, retryDelayMs(e, attempt, { maxMs: 3_600_000 }));
    }
  }

  /** A connector's failure as a ConnectorError: anything else it throws counts as retryable. */
  function fromConnector(e: unknown): unknown {
    if (isConnectorError(e) || e instanceof Stop || signal.aborted || isAbortError(e)) return e;
    log.warn?.({ tenantId, source }, "sync: the connector failed without a code");
    return new ConnectorError("retryable", "the connector failed");
  }
}

/** The enqueue after a committed ingest failed: `cause` is why. */
class EnqueueFailed extends Error {
  constructor(override readonly cause: unknown) {
    super("enqueueing enrichment failed");
  }
}

/** An event's item id, when it has a usable one, for the report. */
function idIn(event: unknown): string | undefined {
  const e = event as { externalId?: unknown; item?: { externalId?: unknown } } | null;
  const id = e?.item?.externalId ?? e?.externalId;
  return storableText(id) && id.length > 0 && id.length <= 2048 ? id : undefined;
}

/** Waits `ms`, or less if the signal aborts. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
