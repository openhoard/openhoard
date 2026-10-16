import { blobs, tenantStorage, type Database, type Tx } from "@openhoard/core-db";
import { and, asc, eq, gt, gte, isNotNull } from "drizzle-orm";
import type { Readable } from "node:stream";
import { classifyStorageError } from "./probe.js";
import { openSecret, sealSecret } from "./secrets.js";
import {
  samePlace,
  secretOf,
  settingsOf,
  StorageChoiceError,
  storeConfigOf,
  type StorageChoice,
  type StorageSettings,
} from "./settings.js";
import {
  BlobNotFoundError,
  BlobStore,
  type PutOptions,
  type PutResult,
  type Range,
  type StorageConfig,
  type TenantBlobKey,
} from "./store.js";

/*
 * Where each tenant's blobs live (tenant_storage): the server's own disk unless the tenant's
 * admin chose a bucket of the tenant's own, on S3 or Azure Blob, in the admin app.
 *
 * A change of place is a move. The new place takes every new blob at once; the blobs already
 * kept are copied over by a job (moveTenantBlobs()), each checked against its id as it is
 * written; meanwhile, and until the admin removes the old copies (cleanTenantBlobs()), a blob
 * not found in the new place is read from the old one. One move at a time: a tenant whose old
 * copies are still kept removes them before moving again.
 *
 * A server reads the choice at most `ttlMs` (10 s) after another server changed it, so a blob
 * put on a server that hasn't seen the change yet lands in the old place. Removing the old
 * copies copies any such blob over first.
 */

export type StorageKind = "local" | "s3" | "azblob";
export type StoragePhase = "moving" | "active" | "cleaning";

/** A tenant's storage as an admin sees it: never its secret. */
export interface TenantStorageView {
  kind: StorageKind;
  settings: StorageSettings;
  /** Whether a key is kept for it (never shown again). */
  hasSecret: boolean;
  phase: StoragePhase;
  /** Where the blobs were before, while its copies are kept. */
  previous: { kind: StorageKind; settings: StorageSettings } | null;
  version: number;
  total: number;
  done: number;
  failed: number;
  /** Blobs in neither place: lost before the move. */
  lost: number;
  lastError: string | null;
  changedAt: Date | null;
  changedBy: string | null;
}

/** A change refused because one is underway, or the old copies of the last are still kept. */
export class StorageBusyError extends Error {
  constructor(readonly reason: "moving" | "cleaning" | "old-copies") {
    super(
      reason === "old-copies"
        ? "the copies from the last move are still kept: remove them before moving again"
        : `a ${reason === "moving" ? "move" : "removal of old copies"} is underway`,
    );
    this.name = "StorageBusyError";
  }
}

const LOCAL: TenantStorageView = {
  kind: "local",
  settings: {},
  hasSecret: false,
  phase: "active",
  previous: null,
  version: 0,
  total: 0,
  done: 0,
  failed: 0,
  lost: 0,
  lastError: null,
  changedAt: null,
  changedBy: null,
};

/** What a sealed secret is for: it opens for this tenant and kind only. */
const sealContext = (tenantId: string, kind: StorageKind) =>
  `openhoard-storage:${tenantId}:${kind}`;

/** The tenant's storage, as an admin sees it; the server's disk when none was chosen. */
export async function tenantStorageOf(tx: Tx, tenantId: string): Promise<TenantStorageView> {
  const [row] = await tx.select().from(tenantStorage).where(eq(tenantStorage.tenantId, tenantId));
  if (!row) return LOCAL;
  return {
    kind: row.kind,
    settings: row.settings,
    hasSecret: row.secret !== null,
    phase: row.phase,
    previous: row.previous ? { kind: row.previous.kind, settings: row.previous.settings } : null,
    version: row.version,
    total: row.total,
    done: row.done,
    failed: row.failed,
    lost: row.lost,
    lastError: row.lastError,
    changedAt: row.changedAt,
    changedBy: row.changedBy,
  };
}

export type StorageChange =
  /** The same place, the same key: nothing to do. */
  | { outcome: "unchanged" }
  /** The same place with a new key: no blob moves. */
  | { outcome: "rekeyed"; version: number }
  /** Another place: the blobs are to be copied over (moveTenantBlobs() for `version`). */
  | { outcome: "moving"; version: number };

/**
 * Records `choice` as where the tenant's blobs go, `by` (an actor, `user:…`), its secret sealed
 * with `sealKey`. Throws StorageBusyError while a move or a removal is underway, or the old
 * copies of the last move are still kept; StorageChoiceError for a bucket choice with no key
 * where none is kept for that place. Test the place first (probeStorage()): this doesn't connect.
 */
export async function changeTenantStorage(
  tx: Tx,
  tenantId: string,
  choice: StorageChoice,
  options: { by: string; sealKey: Uint8Array },
): Promise<StorageChange> {
  const [row] = await tx
    .select()
    .from(tenantStorage)
    .where(eq(tenantStorage.tenantId, tenantId))
    .for("update");
  if (row && row.phase !== "active") throw new StorageBusyError(row.phase);
  const current = row
    ? { kind: row.kind, settings: row.settings, secret: row.secret }
    : { kind: "local" as const, settings: {}, secret: null };
  const next = { kind: choice.kind, settings: settingsOf(choice) };
  const given = secretOf(choice);
  const same = samePlace(current, next);
  // The same place, the same key: nothing to do. Another access key ID needs its secret.
  const sameKey = same && current.settings.accessKeyId === next.settings.accessKeyId;
  if (sameKey && given === undefined) return { outcome: "unchanged" };
  let secret: string | null = null;
  if (choice.kind !== "local") {
    if (given !== undefined)
      secret = sealSecret(options.sealKey, sealContext(tenantId, choice.kind), given);
    else if (sameKey) secret = current.secret;
    if (secret === null) {
      throw new StorageChoiceError(
        choice.kind === "s3" ? "secretAccessKey" : "accountKey",
        choice.kind === "s3" ? "the secret access key is needed" : "the account key is needed",
      );
    }
  }
  const version = (row?.version ?? 0) + 1;
  if (same) {
    await tx
      .update(tenantStorage)
      .set({
        secret,
        settings: next.settings,
        version,
        changedAt: new Date(),
        changedBy: options.by,
      })
      .where(eq(tenantStorage.tenantId, tenantId));
    return { outcome: "rekeyed", version };
  }
  if (row?.previous) throw new StorageBusyError("old-copies");
  const values = {
    kind: next.kind,
    settings: next.settings,
    secret,
    previous: current,
    phase: "moving" as const,
    version,
    total: 0,
    done: 0,
    failed: 0,
    lost: 0,
    lastError: null,
    changedAt: new Date(),
    changedBy: options.by,
  };
  if (row) {
    await tx.update(tenantStorage).set(values).where(eq(tenantStorage.tenantId, tenantId));
  } else {
    await tx.insert(tenantStorage).values({ tenantId, ...values });
  }
  return { outcome: "moving", version };
}

/**
 * Starts removing the old copies of the last move (cleanTenantBlobs() for the version
 * returned); while a removal is underway, its own version again (to queue it again, should its
 * job have been lost: it goes on where it stopped). Throws StorageBusyError while a move is
 * underway; RangeError when there are no old copies, or the move left blobs it couldn't copy
 * (try the move again first).
 */
export async function startCleaning(
  tx: Tx,
  tenantId: string,
  by: string,
): Promise<{ version: number }> {
  const [row] = await tx
    .select()
    .from(tenantStorage)
    .where(eq(tenantStorage.tenantId, tenantId))
    .for("update");
  if (row?.phase === "cleaning") return { version: row.version };
  if (row && row.phase !== "active") throw new StorageBusyError(row.phase);
  if (!row?.previous) throw new RangeError("there are no old copies to remove");
  if (row.failed > 0) throw new RangeError("some blobs weren't copied: move them again first");
  const version = row.version + 1;
  await tx
    .update(tenantStorage)
    .set({
      phase: "cleaning",
      version,
      total: 0,
      done: 0,
      failed: 0,
      lost: 0,
      lastError: null,
      changedAt: new Date(),
      changedBy: by,
    })
    .where(eq(tenantStorage.tenantId, tenantId));
  return { version };
}

/**
 * Starts the last move again (after blobs failed to copy, or a move whose job was lost): the
 * version to run moveTenantBlobs() for; blobs already over are skipped. RangeError when there
 * is no move to repeat.
 */
export async function restartMove(
  tx: Tx,
  tenantId: string,
  by: string,
): Promise<{ version: number }> {
  const [row] = await tx
    .select()
    .from(tenantStorage)
    .where(eq(tenantStorage.tenantId, tenantId))
    .for("update");
  if (row && row.phase === "cleaning") throw new StorageBusyError("cleaning");
  if (!row?.previous) throw new RangeError("there is no move to repeat");
  const version = row.version + 1;
  await tx
    .update(tenantStorage)
    .set({
      phase: "moving",
      version,
      total: 0,
      done: 0,
      failed: 0,
      lost: 0,
      lastError: null,
      changedAt: new Date(),
      changedBy: by,
    })
    .where(eq(tenantStorage.tenantId, tenantId));
  return { version };
}

// --- The stores ------------------------------------------------------------------------------

/** What uploads, mail-in and enrichment need of a store. */
export interface BlobStorage {
  put(
    tenant: TenantBlobKey,
    content: Uint8Array | AsyncIterable<Uint8Array>,
    options?: PutOptions,
  ): Promise<PutResult>;
  open(tenantId: string, blobId: string, range?: Range): Promise<Readable>;
}

interface Resolved {
  current: BlobStore;
  previous: BlobStore | null;
  phase: StoragePhase;
  version: number;
  at: number;
}

export interface TenantStoresOptions {
  db: Database;
  /** The server's own disk: where a tenant with no choice keeps its blobs. */
  local: BlobStore;
  /** The server's storage key, which seals tenants' secrets (read when first needed). */
  sealKey: () => Uint8Array;
  /** How long a tenant's choice is kept before it is read again. Default 10 s. */
  ttlMs?: number;
  /** Opens a store (tests give their own). Default BlobStore.open. */
  openStore?: (config: StorageConfig) => BlobStore;
}

/**
 * Each tenant's blobs, in the place it chose: put() writes to that place; open() reads from it,
 * then from the old place while its copies are kept.
 */
export class TenantBlobStores implements BlobStorage {
  private readonly cache = new Map<string, Resolved>();
  private readonly ttlMs: number;
  private readonly openStore: (config: StorageConfig) => BlobStore;

  constructor(private readonly options: TenantStoresOptions) {
    this.ttlMs = options.ttlMs ?? 10_000;
    this.openStore = options.openStore ?? ((config) => BlobStore.open(config));
  }

  /** The tenant's stores now: where blobs go, and where they were while kept. */
  async storesOf(tenantId: string): Promise<Resolved> {
    const known = this.cache.get(tenantId);
    if (known && Date.now() - known.at < this.ttlMs) return known;
    const [row] = await this.options.db.withTenant(
      tenantId,
      (tx) => tx.select().from(tenantStorage).where(eq(tenantStorage.tenantId, tenantId)),
      { accessMode: "read only" },
    );
    if (known && row && known.version === row.version && known.phase === row.phase) {
      known.at = Date.now();
      return known;
    }
    const resolved: Resolved = row
      ? {
          current: this.storeFor(tenantId, row.kind, row.settings, row.secret),
          previous: row.previous
            ? this.storeFor(tenantId, row.previous.kind, row.previous.settings, row.previous.secret)
            : null,
          phase: row.phase,
          version: row.version,
          at: Date.now(),
        }
      : {
          current: this.options.local,
          previous: null,
          phase: "active",
          version: 0,
          at: Date.now(),
        };
    this.cache.set(tenantId, resolved);
    return resolved;
  }

  /** Reads the tenant's choice again on its next use (after a change on this server). */
  forget(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  /**
   * Stores `content` where the tenant's blobs go. If that changed while it was written (a long
   * upload over a move), it is copied to the new place too, so a move or a removal that has
   * gone past it doesn't leave it only where blobs no longer go.
   */
  async put(
    tenant: TenantBlobKey,
    content: Uint8Array | AsyncIterable<Uint8Array>,
    options?: PutOptions,
  ): Promise<PutResult> {
    const used = await this.storesOf(tenant.id);
    const put = await used.current.put(tenant, content, options);
    this.forget(tenant.id);
    const now = await this.storesOf(tenant.id);
    if (now.version !== used.version && now.current !== used.current) {
      await copyBlob(used.current, now.current, tenant, { id: put.blobId, size: put.size });
    }
    return put;
  }

  async open(tenantId: string, blobId: string, range?: Range): Promise<Readable> {
    const { current, previous } = await this.storesOf(tenantId);
    try {
      return await current.open(tenantId, blobId, range);
    } catch (e) {
      if (!(e instanceof BlobNotFoundError) || previous === null) throw e;
      return previous.open(tenantId, blobId, range);
    }
  }

  private storeFor(
    tenantId: string,
    kind: StorageKind,
    settings: StorageSettings,
    sealed: string | null,
  ): BlobStore {
    if (kind === "local") return this.options.local;
    if (sealed === null) throw new Error(`tenant ${tenantId}'s ${kind} storage has no key`);
    const secret = openSecret(this.options.sealKey(), sealContext(tenantId, kind), sealed);
    return this.openStore(storeConfigOf(kind, settings, secret));
  }
}

/** The store a choice names, to test it before it is kept (probeStorage() takes its config). */
export function choiceConfig(choice: StorageChoice, local: StorageConfig): StorageConfig | null {
  if (choice.kind === "local") return local;
  const secret = secretOf(choice);
  return secret === undefined ? null : storeConfigOf(choice.kind, settingsOf(choice), secret);
}

/**
 * The config for testing `choice` when its secret may be the one kept: for a choice of the
 * place already kept with no key given, the kept key, opened.
 */
export async function testConfig(
  tx: Tx,
  tenantId: string,
  choice: StorageChoice,
  /** `sealKey` is read only when the kept key is used. */
  options: { sealKey: () => Uint8Array; local: StorageConfig },
): Promise<StorageConfig | null> {
  const direct = choiceConfig(choice, options.local);
  if (direct !== null || choice.kind === "local") return direct;
  const [row] = await tx.select().from(tenantStorage).where(eq(tenantStorage.tenantId, tenantId));
  if (
    !row ||
    row.secret === null ||
    row.settings.accessKeyId !== settingsOf(choice).accessKeyId ||
    !samePlace(
      { kind: row.kind, settings: row.settings },
      { kind: choice.kind, settings: settingsOf(choice) },
    )
  ) {
    return null;
  }
  const secret = openSecret(options.sealKey(), sealContext(tenantId, choice.kind), row.secret);
  return storeConfigOf(choice.kind, settingsOf(choice), secret);
}

// --- Moving and removing -------------------------------------------------------------------

/** Blobs read a page at a time, by id. */
const PAGE = 200;

export interface MoveOptions {
  signal?: AbortSignal;
  log?: { warn?: (o: object, m: string) => void; info?: (o: object, m: string) => void };
}

/** The tenant's blobs that OpenHoard holds, a page at a time, by id. */
async function pageOfBlobs(
  db: Database,
  tenantId: string,
  after: string | undefined,
  since?: Date,
): Promise<{ id: string; size: number }[]> {
  return db.withTenant(
    tenantId,
    (tx) =>
      tx
        .select({ id: blobs.id, size: blobs.size })
        .from(blobs)
        .where(
          and(
            eq(blobs.tenantId, tenantId),
            isNotNull(blobs.location),
            ...(after === undefined ? [] : [gt(blobs.id, after)]),
            ...(since === undefined ? [] : [gte(blobs.createdAt, since)]),
          ),
        )
        .orderBy(asc(blobs.id))
        .limit(PAGE),
    { accessMode: "read only" },
  );
}

async function countBlobs(db: Database, tenantId: string): Promise<number> {
  let n = 0;
  let after: string | undefined;
  for (;;) {
    const page = await pageOfBlobs(db, tenantId, after);
    n += page.length;
    if (page.length < PAGE) return n;
    after = page.at(-1)?.id;
  }
}

/** Records how the job is doing; false when the tenant's storage changed under it (stop). */
async function progress(
  db: Database,
  tenantId: string,
  version: number,
  values: { total?: number; done: number; failed: number; lost: number; lastError?: string | null },
  finish?: { phase: "active"; clearPrevious: boolean },
): Promise<boolean> {
  return db.withTenant(tenantId, async (tx) => {
    const done = await tx
      .update(tenantStorage)
      .set({
        ...values,
        ...(values.lastError === undefined
          ? {}
          : { lastError: values.lastError === null ? null : values.lastError.slice(0, 1024) }),
        ...(finish ? { phase: finish.phase } : {}),
        ...(finish?.clearPrevious ? { previous: null } : {}),
      })
      .where(and(eq(tenantStorage.tenantId, tenantId), eq(tenantStorage.version, version)))
      .returning({ v: tenantStorage.version });
    return done.length === 1;
  });
}

/**
 * Copies `blobId` from `from` to `to`, checked against its id as it is written (BlobStore.put
 * hashes it with the tenant's key). True when `to` has it now.
 */
async function copyBlob(
  from: BlobStore,
  to: BlobStore,
  tenant: TenantBlobKey,
  blob: { id: string; size: number },
  force = false,
): Promise<void> {
  if (!force && (await to.size(tenant.id, blob.id)) === blob.size) return;
  const stream = await from.open(tenant.id, blob.id);
  const put = await to.put(tenant, stream as AsyncIterable<Uint8Array>);
  if (put.blobId !== blob.id) {
    if (put.created) await to.delete(tenant.id, put.blobId).catch(() => {});
    throw new Error(`the old copy of ${blob.id} doesn't match its id`);
  }
}

/** The stores of a move or removal: from where, to where. Null when it no longer applies. */
async function storesFor(
  db: Database,
  stores: TenantBlobStores,
  tenantId: string,
  version: number,
  phase: StoragePhase,
): Promise<{ from: BlobStore; to: BlobStore } | null> {
  stores.forget(tenantId);
  const s = await stores.storesOf(tenantId);
  if (s.version !== version || s.phase !== phase || s.previous === null) return null;
  return { from: s.previous, to: s.current };
}

/** What a blob's failure is kept as: its id and the problem, never the store's own text. */
function failureText(blobId: string, e: unknown): string {
  const { problem, code } = classifyStorageError(e);
  return `${blobId}: ${e instanceof BlobMismatch ? "its old copy doesn't match its id" : problem}${code ? ` (${code})` : ""}`;
}

/** The old copy doesn't hash to its id. */
class BlobMismatch extends Error {}

/** Whether a blob is in neither place: lost before the move. */
async function inNeither(
  pair: { from: BlobStore; to: BlobStore },
  tenantId: string,
  blobId: string,
): Promise<boolean> {
  return (
    (await pair.to.size(tenantId, blobId)) === undefined &&
    (await pair.from.size(tenantId, blobId)) === undefined
  );
}

/**
 * Copies the tenant's blobs from where they were to where they go now (`version`'s move), each
 * checked against its id, recording progress as it goes; a blob already there is skipped, so
 * running it again goes on where it stopped. A blob in neither place is counted as lost, not
 * failed. Ends the move (`active`), the old copies kept, with how many failed. If both places
 * turn out to be the same storage (one bucket under two addresses), nothing is copied and the
 * "old" place is let go, so that removing its copies can't remove the only ones. Returns false
 * when the tenant's storage changed meanwhile (it stops).
 */
export async function moveTenantBlobs(
  db: Database,
  stores: TenantBlobStores,
  tenant: TenantBlobKey,
  version: number,
  options: MoveOptions = {},
): Promise<boolean> {
  const tenantId = tenant.id;
  const pair = await storesFor(db, stores, tenantId, version, "moving");
  if (pair === null) return false;
  const total = await countBlobs(db, tenantId);
  const n = { done: 0, failed: 0, lost: 0 };
  let lastError: string | null = null;
  if (await pair.to.sameStorageAs(pair.from, tenantId)) {
    options.log?.warn?.({ tenantId }, "storage move: the old and new places are the same storage");
    const ended = await progress(
      db,
      tenantId,
      version,
      {
        total,
        done: total,
        failed: 0,
        lost: 0,
        lastError: "the old and new places are the same storage",
      },
      { phase: "active", clearPrevious: true },
    );
    stores.forget(tenantId);
    return ended;
  }
  if (!(await progress(db, tenantId, version, { total, ...n }))) return false;
  let after: string | undefined;
  for (;;) {
    options.signal?.throwIfAborted();
    const page = await pageOfBlobs(db, tenantId, after);
    for (const blob of page) {
      try {
        await copyBlob(pair.from, pair.to, tenant, blob);
        n.done++;
      } catch (e) {
        if (e instanceof BlobNotFoundError && (await inNeither(pair, tenantId, blob.id))) {
          n.lost++;
          continue;
        }
        n.failed++;
        lastError = failureText(blob.id, e);
        options.log?.warn?.(
          { tenantId, blobId: blob.id, err: e },
          "storage move: a blob wasn't copied",
        );
      }
    }
    if (!(await progress(db, tenantId, version, { ...n, lastError }))) return false;
    if (page.length < PAGE) break;
    after = page.at(-1)?.id;
  }
  const ended = await progress(
    db,
    tenantId,
    version,
    { total: Math.max(total, n.done + n.failed + n.lost), ...n, lastError },
    { phase: "active", clearPrevious: false },
  );
  stores.forget(tenantId);
  return ended;
}

/** How long before a removal started a blob still counts as possibly put in the old place. */
const LATE_MARGIN_MS = 5 * 60_000;

/**
 * Removes the old copies of the tenant's last move (`version`'s removal). For each blob, the
 * new place's copy is checked against its id (copied over again from the old place if it isn't
 * there or doesn't match: put on a server that hadn't seen the move yet), then the old copy is
 * deleted. Blobs recorded since shortly before the removal began are gone over again at the
 * end, for uploads that finished meanwhile. Ends with no old place to read from, unless some
 * failed, when it ends `active` with the old place still kept. Nothing is deleted if both places
 * turn out to be the same storage.
 */
export async function cleanTenantBlobs(
  db: Database,
  stores: TenantBlobStores,
  tenant: TenantBlobKey,
  version: number,
  options: MoveOptions = {},
): Promise<boolean> {
  const tenantId = tenant.id;
  const pair = await storesFor(db, stores, tenantId, version, "cleaning");
  if (pair === null) return false;
  const started = new Date(Date.now() - LATE_MARGIN_MS);
  const total = await countBlobs(db, tenantId);
  const n = { done: 0, failed: 0, lost: 0 };
  let lastError: string | null = null;
  if (await pair.to.sameStorageAs(pair.from, tenantId)) {
    options.log?.warn?.(
      { tenantId },
      "storage cleanup: the old and new places are the same storage",
    );
    const ended = await progress(
      db,
      tenantId,
      version,
      {
        total,
        done: total,
        failed: 0,
        lost: 0,
        lastError: "the old and new places are the same storage: nothing removed",
      },
      { phase: "active", clearPrevious: true },
    );
    stores.forget(tenantId);
    return ended;
  }
  if (!(await progress(db, tenantId, version, { total, ...n }))) return false;
  // The second pass goes over what the first did only when it is new to it.
  const seen = new Set<string>();
  const removeOld = async (blob: { id: string; size: number }) => {
    if (seen.has(blob.id)) return;
    seen.add(blob.id);
    try {
      if (!(await pair.to.has(tenantId, blob.id)) || !(await pair.to.verify(tenant, blob.id))) {
        if ((await pair.from.size(tenantId, blob.id)) === undefined) {
          if (await inNeither(pair, tenantId, blob.id)) {
            n.lost++;
            return;
          }
          throw new BlobMismatch();
        }
        await copyBlob(pair.from, pair.to, tenant, blob, true);
      }
      await pair.from.delete(tenantId, blob.id);
      n.done++;
    } catch (e) {
      n.failed++;
      lastError = failureText(blob.id, e);
      options.log?.warn?.(
        { tenantId, blobId: blob.id, err: e },
        "storage cleanup: a blob wasn't removed",
      );
    }
  };
  for (const since of [undefined, started]) {
    let after: string | undefined;
    for (;;) {
      options.signal?.throwIfAborted();
      const page = await pageOfBlobs(db, tenantId, after, since);
      for (const blob of page) await removeOld(blob);
      if (!(await progress(db, tenantId, version, { ...n, lastError }))) return false;
      if (page.length < PAGE) break;
      after = page.at(-1)?.id;
    }
  }
  const ended = await progress(
    db,
    tenantId,
    version,
    { total: Math.max(total, n.done + n.failed + n.lost), ...n, lastError },
    { phase: "active", clearPrevious: n.failed === 0 },
  );
  stores.forget(tenantId);
  return ended;
}
