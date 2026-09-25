import {
  applyRuleTags,
  markProcessed,
  tenantRules,
  type IngestResult,
} from "@openhoard/core-catalog";
import { isId, objects, versions, type Database, type Tx } from "@openhoard/core-db";
import { and, eq, max } from "drizzle-orm";
import type { PgTransactionConfig } from "drizzle-orm/pg-core";

/*
 * The enrichment pipeline (T-401): what happens to a version after ingest records it, until
 * core/catalog's markProcessed() lets its tags and the tenant's defaults decide who sees it.
 * Until then the object is hidden from non-readers and metadata-only (T-603): fail-closed.
 *
 *   ingest commits → enqueue (tenant, version) → a worker runs the steps in order
 *                  → markProcessed({ versionId, title the job saw })
 *
 * - One job per version and tenant. The queue collapses duplicates by key (jobs.ts), and a job
 *   runs again after a failure (retries, with backoff), a crash (its lease expires), a rename or
 *   the sweep. So every step must be idempotent: whatever it writes is keyed (a tag, a card per
 *   version), and a second run changes nothing the first one did. The tests run a completed job
 *   again and a job that failed half way, and count the tags.
 * - A step does its slow work (extracting text, calling a model) outside any transaction and
 *   opens short ones with `withTenant` to write: a transaction held open blocks the embedded
 *   database for everyone, and pins a pooled connection on PostgreSQL.
 * - The job reads the object's title once, before the steps, and marks the version processed
 *   under that title. markProcessed() compares and sets under the object's lock, so a rename that
 *   committed meanwhile makes it refuse: the job enqueues the version again (ingest will have
 *   too) and the next run enriches the new title.
 * - Only the current version is enriched: a job for a version that a newer one replaced ends
 *   without doing anything (the newer one has its own job).
 *
 * Payloads carry the tenant: pg-boss keeps its queue in its own schema, outside row-level
 * security, and the worker does all catalog work inside db.withTenant(tenantId, …).
 */

/** What one enrichment job is about, as read when it started. */
export interface EnrichTarget {
  tenantId: string;
  objectId: string;
  versionId: string;
  seq: number;
  /** The object's title when the job started: the one markProcessed() is given. */
  title: string;
  mime: string;
  blobId: string;
}

export interface EnrichContext {
  readonly target: EnrichTarget;
  /** A short transaction on the job's tenant: `db.withTenant(target.tenantId, work, config)`. */
  withTenant<T>(work: (tx: Tx) => Promise<T>, config?: PgTransactionConfig): Promise<T>;
  /** Aborted when the job's lease expires or the worker stops: stop, and throw. */
  readonly signal: AbortSignal;
}

/**
 * One step of the pipeline. Steps run in the order given, each after the one before succeeded;
 * a step that throws fails the job, which runs again from the first step later.
 */
export interface EnrichStep {
  /** A short, stable name for logs and errors: `rule-tags`, `extract-text`… */
  readonly name: string;
  /**
   * Does this step's work for one version. It may run more than once for the same version, so
   * everything it writes must be keyed: a second run changes nothing.
   */
  run(context: EnrichContext): Promise<void>;
}

/**
 * The rule tagger (core/catalog rules.ts, T-403) as a step, first in the pipeline so rule tags
 * are on the file before any model sees it. It applies the tenant's pack rules to the title the
 * job saw and the version's media type: applyRuleTags() makes the object's rule tags exactly
 * what the rules give, so running it twice changes nothing.
 *
 * Rules on the path or the site don't match yet: neither is stored on the object, and a step
 * must decide from stored facts only (a re-run or the sweep has nothing else), or it would take
 * off tags a first run gave.
 */
export const ruleTagStep: EnrichStep = {
  name: "rule-tags",
  async run({ target, withTenant }) {
    await withTenant(async (tx) => {
      const rules = await tenantRules(tx, target.tenantId);
      await applyRuleTags(tx, target.tenantId, target.objectId, rules, {
        title: target.title,
        mime: target.mime,
      });
    });
  },
};

/**
 * The steps a server runs unless told otherwise: the rule tagger. Extractors (T-402) and model
 * steps (T-404, T-405) join here.
 */
export function defaultEnrichSteps(): EnrichStep[] {
  return [ruleTagStep];
}

/** A job's data: which version of which tenant. */
export interface EnrichPayload {
  tenantId: string;
  versionId: string;
}

/** How a job ended (the job's output). */
export type EnrichOutcome =
  /** The steps ran and the version is processed now. */
  | "processed"
  /** The steps ran again; the version was processed already (a re-run). */
  | "already-processed"
  /** The object was renamed while the steps ran: the version was enqueued again. */
  | "renamed"
  /** A newer version replaced this one: nothing to do. */
  | "superseded"
  /** The version no longer exists (its object was purged), or the tenant doesn't. */
  | "gone"
  /** The payload doesn't name a tenant and a version: nothing to do. */
  | "invalid";

/** Whether `data` is an {@link EnrichPayload}: ids of the right kinds, nothing else needed. */
export function isEnrichPayload(data: unknown): data is EnrichPayload {
  if (typeof data !== "object" || data === null) return false;
  const { tenantId, versionId } = data as Record<string, unknown>;
  return (
    typeof tenantId === "string" &&
    isId("tenant", tenantId) &&
    typeof versionId === "string" &&
    isId("version", versionId)
  );
}

/**
 * Whether an ingest result needs enrichment: a new version, or a rename, which ingest marks
 * unprocessed again (T-603). A restored object or a refreshed source reference doesn't.
 */
export function needsEnrichment(result: Pick<IngestResult, "created" | "renamed">): boolean {
  return result.created.version || result.renamed;
}

/**
 * Runs one enrichment job: reads the version, runs `steps` in order, and marks the version
 * processed under the title it read. `requeue` enqueues the version again (after a rename).
 * pg-boss calls it through the worker in jobs.ts; it needs nothing from pg-boss itself.
 */
export async function enrichVersion(
  db: Database,
  steps: readonly EnrichStep[],
  payload: unknown,
  options: { signal: AbortSignal; requeue: (payload: EnrichPayload) => Promise<unknown> },
): Promise<EnrichOutcome> {
  if (!isEnrichPayload(payload)) return "invalid";
  const { tenantId, versionId } = payload;
  const target = await db.withTenant(tenantId, (tx) => readTarget(tx, tenantId, versionId), {
    accessMode: "read only",
  });
  if (target === "gone" || target === "superseded") return target;

  const context: EnrichContext = {
    target,
    withTenant: (work, config) => db.withTenant(tenantId, work, config),
    signal: options.signal,
  };
  for (const step of steps) {
    options.signal.throwIfAborted();
    try {
      await step.run(context);
    } catch (e) {
      throw new EnrichStepError(step.name, e);
    }
  }
  options.signal.throwIfAborted();

  const marked = await db.withTenant(tenantId, (tx) =>
    markProcessed(tx, tenantId, { versionId, title: target.title }),
  );
  if (marked) return "processed";
  // markProcessed() says no for an unknown version, one marked already, or a rename.
  const [now] = await db.withTenant(
    tenantId,
    (tx) =>
      tx
        .select({ title: objects.title })
        .from(versions)
        .innerJoin(
          objects,
          and(eq(objects.tenantId, versions.tenantId), eq(objects.id, versions.objectId)),
        )
        .where(and(eq(versions.tenantId, tenantId), eq(versions.id, versionId))),
    { accessMode: "read only" },
  );
  if (!now) return "gone";
  if (now.title !== target.title) {
    await options.requeue({ tenantId, versionId });
    return "renamed";
  }
  return "already-processed";
}

async function readTarget(
  tx: Tx,
  tenantId: string,
  versionId: string,
): Promise<EnrichTarget | "gone" | "superseded"> {
  const [row] = await tx
    .select({
      objectId: versions.objectId,
      seq: versions.seq,
      mime: versions.mime,
      blobId: versions.blobId,
      title: objects.title,
    })
    .from(versions)
    .innerJoin(
      objects,
      and(eq(objects.tenantId, versions.tenantId), eq(objects.id, versions.objectId)),
    )
    .where(and(eq(versions.tenantId, tenantId), eq(versions.id, versionId)));
  if (!row) return "gone";
  const [latest] = await tx
    .select({ seq: max(versions.seq) })
    .from(versions)
    .where(and(eq(versions.tenantId, tenantId), eq(versions.objectId, row.objectId)));
  if (latest?.seq !== row.seq) return "superseded";
  return { tenantId, versionId, ...row };
}

/** A step failed; the job fails with this and runs again later. `cause` is the step's error. */
export class EnrichStepError extends Error {
  constructor(
    readonly step: string,
    cause: unknown,
  ) {
    super(
      `enrichment step ${step} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "EnrichStepError";
  }
}
