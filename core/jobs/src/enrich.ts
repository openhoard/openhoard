import {
  applyRuleTags,
  enrichmentExposure,
  lockCurrentVersion,
  markProcessed,
  markSuperseded,
  tenantRules,
  type ContentSource,
  type IngestResult,
  type VersionStanding,
} from "@openhoard/core-catalog";
import { isId, objects, versions, type Database, type Tx } from "@openhoard/core-db";
import { mayProcess, type Exposure, type ProviderKind } from "@openhoard/core-policy";
import { and, eq, max } from "drizzle-orm";
import { extractStep, type ExtractStepOptions } from "./extract.js";

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
 * - A step does its slow work (extracting text, calling a model) outside any transaction, and
 *   writes in short ones through `write`: a transaction held open blocks the embedded database
 *   for everyone, and pins a pooled connection on PostgreSQL.
 * - The job reads the version and the object's title once, before the steps. What a step writes
 *   is for that version and that title only, so `write` takes the object's lock and checks both
 *   are still current before it runs the step's writes (core/catalog lockCurrentVersion()).
 *   Ingest adds versions and renames under the same lock, so a job that read a version a newer
 *   one has replaced, or a title a rename has changed, writes nothing: a slow job for an old
 *   version can't overwrite what the new version's job wrote after it. markProcessed() makes
 *   the same check. The job then ends:
 *   - superseded: the newer version has its own job; the old one is marked given up on
 *     (markSuperseded(): superseded_at, still unprocessed) so it leaves the sweep for good;
 *   - renamed: the version is enqueued again (ingest will have too) for the new title.
 *   Superseded is checked first, so a replaced version is never enqueued again.
 *
 * Payloads carry the tenant: pg-boss keeps its queue in its own schema, outside row-level
 * security, and the worker does all catalog work inside db.withTenant(tenantId, …).
 *
 * Content goes to a model only as far as the file's exposure lets it (T-604). A step that sends
 * the content out names its `provider`, and the pipeline asks core/policy mayProcess() with the
 * exposure the file's tags give it at that moment (core/catalog enrichmentExposure(): trusted
 * tags decide, the rest only tighten, else the tenant default; not the unprocessed file's
 * `metadata-only`, which would stop every model). A step the exposure doesn't let through is
 * skipped, and the job's output and the log say so; `local-only` content reaches local providers
 * only, `metadata-only` content none. The rule tagger runs first, so its tags count before any
 * model sees the file. For a file no trusted tag has given an exposure, the tenant default
 * decides, capped at `commercial-only`: an unclassified file never goes to a consumer provider.
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
  /** A short read-only transaction on the job's tenant. */
  read<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * A short transaction on the job's tenant for the step's writes. It first takes the object's
   * lock and checks that the target is still the object's current version under the title the
   * job read; while the lock is held, neither can change. If either did, `work` doesn't run and
   * this throws {@link StaleTargetError}: let it propagate, the job ends without writing. The
   * object's lock comes first in the transaction, so `work` must not take a source item's or a
   * tag value's lock (core/catalog locks.ts); tagging and rule tagging don't.
   */
  write<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Whether the version's content may go to this provider now (T-604): the file's exposure, as
   * its tags give it at this moment (core/catalog enrichmentExposure()), against the provider's
   * kind (core/policy mayProcess()). The pipeline asks before a step that names a provider; a
   * step that takes long before it sends, or sends to more than one provider, asks again right
   * before each send. False for a file that is gone.
   */
  mayProcess(provider: ModelProvider): Promise<boolean>;
  /** Aborted when the job's lease expires or the worker stops: stop, and throw. */
  readonly signal: AbortSignal;
}

/**
 * A model provider an enrichment step sends content to (T-404 adds them): where it runs decides
 * which files' content it may have (core/policy mayProcess()): `local` on the tenant's own
 * machines, `commercial` under a business agreement, `consumer` on consumer terms.
 */
export interface ModelProvider {
  /** A short, stable name for logs: `ollama-llama3`, `azure-openai`… */
  readonly id: string;
  readonly kind: ProviderKind;
}

/**
 * One step of the pipeline. Steps run in the order given, each after the one before succeeded;
 * a step that throws fails the job, which runs again from the first step later.
 */
export interface EnrichStep {
  /** A short, stable name for logs and errors: `rule-tags`, `extract-text`… */
  readonly name: string;
  /**
   * The model provider this step sends the version's content to, if any (T-604). A step that
   * sends content anywhere outside this process must name it: the pipeline runs the step only
   * if the file's exposure allows that provider (core/policy mayProcess(), with the exposure
   * the file's tags give it), and skips it otherwise. A step without one (the rule tagger, a
   * text extractor) sends nothing out.
   */
  readonly provider?: ModelProvider;
  /**
   * Does this step's work for one version. It may run more than once for the same version, so
   * everything it writes must be keyed: a second run changes nothing. It writes only through
   * `context.write`.
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
  async run({ target, write }) {
    await write(async (tx) => {
      const rules = await tenantRules(tx, target.tenantId);
      await applyRuleTags(tx, target.tenantId, target.objectId, rules, {
        title: target.title,
        mime: target.mime,
      });
    });
  },
};

/**
 * The steps a server runs unless told otherwise: the rule tagger, then, when the server has
 * somewhere to read versions' bytes from (`content`), text extraction (T-402, extract.ts).
 * Model steps (T-404, T-405) join here.
 */
export function defaultEnrichSteps(
  options: { content?: ContentSource; extract?: Omit<ExtractStepOptions, "content"> } = {},
): EnrichStep[] {
  const { content, extract } = options;
  return content ? [ruleTagStep, extractStep({ ...extract, content })] : [ruleTagStep];
}

/** A step the pipeline skipped: the file's exposure keeps its content from the step's provider. */
export interface WithheldStep {
  step: string;
  provider: ModelProvider;
  /** The file's exposure then; null if the file was gone. */
  exposure: Exposure | null;
}

/** Reads the exposure in one snapshot (core/catalog's levels need one). */
const SNAPSHOT = { isolationLevel: "repeatable read", accessMode: "read only" } as const;

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
  /** The object was renamed after the job read it: the version was enqueued again. */
  | "renamed"
  /** A newer version replaced this one: nothing written; the old one is marked superseded. */
  | "superseded"
  /** The version no longer exists (its object was purged), or the tenant doesn't. */
  | "gone"
  /** The payload doesn't name a tenant and a version: nothing to do. */
  | "invalid";

/**
 * Thrown by `context.write` when the job's target is no longer current: a newer version
 * replaced it, the object was renamed, or it is gone. The job ends with that outcome.
 */
export class StaleTargetError extends Error {
  constructor(readonly standing: Exclude<VersionStanding, "current">) {
    super(`the version this enrichment job read is ${standing}: nothing was written`);
    this.name = "StaleTargetError";
  }
}

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
  options: {
    signal: AbortSignal;
    requeue: (payload: EnrichPayload) => Promise<unknown>;
    /** A step skipped because the file's exposure keeps its content from the step's provider. */
    onWithheld?: (withheld: WithheldStep) => void;
  },
): Promise<EnrichOutcome> {
  if (!isEnrichPayload(payload)) return "invalid";
  const { tenantId, versionId } = payload;
  const target = await db.withTenant(tenantId, (tx) => readTarget(tx, tenantId, versionId), {
    accessMode: "read only",
  });
  if (target === "gone") return "gone";
  if (target === "superseded") return finish(db, payload, "superseded", options.requeue);

  /** The file's exposure now, as its tags give it; null when it is gone. */
  const exposure = () =>
    db.withTenant(tenantId, (tx) => enrichmentExposure(tx, tenantId, target.objectId), SNAPSHOT);
  // Set by write() when the target went stale, whether or not the step lets the error through.
  let stale: Exclude<VersionStanding, "current"> | undefined;
  const context: EnrichContext = {
    target,
    read: (work) => db.withTenant(tenantId, work, { accessMode: "read only" }),
    async mayProcess(provider) {
      const level = await exposure();
      return level !== null && mayProcess(level, provider.kind);
    },
    async write(work) {
      if (stale) throw new StaleTargetError(stale);
      const done = await db.withTenant(tenantId, async (tx) => {
        const standing = await lockCurrentVersion(tx, tenantId, {
          versionId,
          title: target.title,
        });
        return standing === "current"
          ? { standing, value: await work(tx) }
          : { standing, value: undefined };
      });
      if (done.standing !== "current") {
        stale = done.standing;
        throw new StaleTargetError(stale);
      }
      return done.value as Awaited<ReturnType<typeof work>>;
    },
    signal: options.signal,
  };
  for (const step of steps) {
    options.signal.throwIfAborted();
    if (step.provider !== undefined) {
      // Content goes to a provider only as far as the file's exposure lets it (T-604): a step
      // whose provider it doesn't reach is skipped, and the rest of the pipeline runs on.
      const level = await exposure();
      if (level === null || !mayProcess(level, step.provider.kind)) {
        options.onWithheld?.({ step: step.name, provider: step.provider, exposure: level });
        continue;
      }
    }
    try {
      await step.run(context);
    } catch (e) {
      if (!stale) throw new EnrichStepError(step.name, e);
    }
    if (stale) return finish(db, payload, stale, options.requeue);
  }
  options.signal.throwIfAborted();

  const marked = await db.withTenant(tenantId, (tx) =>
    markProcessed(tx, tenantId, { versionId, title: target.title }),
  );
  if (marked) return "processed";
  // markProcessed() says no for a version that is gone, replaced, renamed, or marked already.
  const standing = await db.withTenant(tenantId, (tx) =>
    lockCurrentVersion(tx, tenantId, { versionId, title: target.title }),
  );
  return standing === "current"
    ? "already-processed"
    : finish(db, payload, standing, options.requeue);
}

/** Ends a job whose target went stale: superseded before renamed, so it never re-enqueues. */
async function finish(
  db: Database,
  payload: EnrichPayload,
  standing: Exclude<VersionStanding, "current">,
  requeue: (payload: EnrichPayload) => Promise<unknown>,
): Promise<EnrichOutcome> {
  const { tenantId, versionId } = payload;
  if (standing === "superseded") {
    await db.withTenant(tenantId, (tx) => markSuperseded(tx, tenantId, versionId));
  }
  if (standing === "renamed") await requeue(payload);
  return standing;
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
