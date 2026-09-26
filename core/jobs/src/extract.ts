import {
  contentRef,
  saveExtract,
  type ContentRef,
  type ContentSource,
  type VersionExtract,
} from "@openhoard/core-catalog";
import {
  extract,
  EXTRACTOR_VERSION,
  mayExtract,
  resolveLimits,
  type Extraction,
  type ExtractLimits,
  type ExtractResult,
} from "@openhoard/enricher-extract";
import type { EnrichStep } from "./enrich.js";

/*
 * Text extraction as an enrichment step (T-402): reads the version's bytes through a
 * ContentSource, extracts them in a limited child process (@openhoard/enricher-extract), and
 * stores the result for the version (core/catalog saveExtract(): one row per version, rewritten
 * on every run) through the pipeline's guarded write, so a job for a replaced or renamed
 * version stores nothing.
 *
 * Which content is read at all, by zone: a managed zone's, always (OpenHoard holds it); an
 * indexed zone's only when the server opts in (`indexedZones`, default off: its bytes come from
 * the customer's own store); a local-only or code zone's, never on the server. For those,
 * nothing is read and nothing stored.
 *
 * It names no provider: the content goes to a process of OpenHoard's own on the same machine
 * and nowhere else, so it runs whatever the file's exposure. What reads the stored text later
 * (a model step, T-405; search, T-501) is what the levels and exposure gate.
 *
 * What happens, by what the extractor answers:
 *
 * | Answer                                             | Stored                | The job     |
 * | -------------------------------------------------- | --------------------- | ----------- |
 * | text and metadata                                  | `extracted`           | goes on     |
 * | a type with no extractor                           | `unsupported`         | goes on     |
 * | no source reaches the bytes                        | `unavailable`         | goes on     |
 * | the file's own failure (malformed, encrypted, a    | `failed` and the code | goes on     |
 * | zip bomb, out of memory, a crash)                  |                       |             |
 * | a timeout, or killed by a signal nobody sent:      | as the second answer  | goes on     |
 * | tried once more (a timeout with twice the time)    |                       |             |
 * | reading the bytes failed (unreachable, stalled,    | nothing               | fails, and  |
 * | the wrong size or hash), or no process started     |                       | retries     |
 *
 * So a hostile or broken file costs at most two child processes, never the job's retries: its
 * failure is recorded (`failed`) and the version is marked processed like any other. The row
 * names the extractor's version (EXTRACTOR_VERSION): when a newer extractor handles more, the
 * rows of older versions (failed, unsupported, or simply older) are what a re-run picks up.
 *
 * Each attempt gets its own AbortController, aborted when the attempt ends however it ends
 * (and when the job's signal aborts): a source that honours its signal, as blobContentSource()
 * does, closes its stream then, a stalled one included.
 */

export interface ExtractStepOptions {
  /** Where versions' bytes are read from (core/storage blobContentSource(), connectors). */
  content: ContentSource;
  /** Changes to the extractor's limits (DEFAULT_LIMITS in @openhoard/enricher-extract). */
  limits?: Partial<ExtractLimits>;
  /** Extract indexed zones' content too (read through their source). Default false. */
  indexedZones?: boolean;
  /**
   * The most time the step spends on one version, both attempts together, in milliseconds.
   * Default 13 minutes: under the enrichment job's 15-minute lease. A timeout is tried again
   * with twice the time only when that fits.
   */
  budgetMs?: number;
  /** The extractor; tests replace it. Default: `extract` from @openhoard/enricher-extract. */
  extractor?: typeof extract;
}

type Outcome = Omit<VersionExtract, "extractor">;

const NONE = { kind: null, text: "", truncated: false, metadata: {}, signals: [], warnings: [] };

/** Failures worth one more attempt: not the file's own, as far as anyone can tell. */
const TRY_AGAIN = new Set(["timeout", "killed"]);

/** Whether the step reads this zone's content at all. */
export function extractsZone(ref: ContentRef, indexedZones: boolean): boolean {
  return ref.zoneKind === "managed" || (ref.zoneKind === "indexed" && indexedZones);
}

/** The extract step, `extract-text`: see above. */
export function extractStep(options: ExtractStepOptions): EnrichStep {
  const { content, limits = {}, indexedZones = false, budgetMs = 13 * 60_000 } = options;
  const run = options.extractor ?? extract;
  return {
    name: "extract-text",
    async run({ target, read, write, signal }) {
      const ref = await read((tx) => contentRef(tx, target.tenantId, target.versionId));
      // Gone since the job started: there is nothing to store, and write() would refuse.
      if (ref === null || !extractsZone(ref, indexedZones)) return;
      const hint = { mime: target.mime, name: target.title };
      let outcome: Outcome;
      if (!mayExtract(hint)) {
        outcome = { status: "unsupported", failure: null, ...NONE };
      } else {
        const started = Date.now();
        let timeoutMs = resolveLimits(limits, ref.size).timeoutMs;
        let result: ExtractResult | null = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          result = await attemptOnce(ref, { ...limits, timeoutMs });
          if (result === null || result.ok || attempt === 2 || !TRY_AGAIN.has(result.failure)) {
            break;
          }
          const next = result.failure === "timeout" ? timeoutMs * 2 : timeoutMs;
          if (next > budgetMs - (Date.now() - started)) break;
          timeoutMs = next;
        }
        outcome = outcomeOf(result);
      }
      await write((tx) =>
        saveExtract(tx, target.tenantId, {
          objectId: target.objectId,
          versionId: target.versionId,
          extractor: EXTRACTOR_VERSION,
          ...outcome,
        }),
      );

      /** One attempt: open the content, extract it, and close the source whatever happened. */
      async function attemptOnce(
        ref: ContentRef,
        attemptLimits: Partial<ExtractLimits>,
      ): Promise<ExtractResult | null> {
        const controller = new AbortController();
        const stop = () => controller.abort(signal.reason);
        if (signal.aborted) stop();
        else signal.addEventListener("abort", stop, { once: true });
        try {
          const stream = await content.open(ref, controller.signal);
          if (stream === null) return null;
          return await run(stream, hint, {
            size: ref.size,
            signal: controller.signal,
            limits: attemptLimits,
          });
        } finally {
          signal.removeEventListener("abort", stop);
          controller.abort(new Error("the extraction ended"));
        }
      }
    },
  };
}

/** What to store for the last attempt's answer (null: no source reached the bytes). */
function outcomeOf(result: ExtractResult | null): Outcome {
  if (result === null) return { status: "unavailable", failure: null, ...NONE };
  if (result.ok) return extracted(result.extraction);
  if (result.failure === "unsupported") return { status: "unsupported", failure: null, ...NONE };
  // Killed twice is the file's doing after all; the rest of the transient ones are the moment's.
  if (!result.permanent && result.failure !== "killed") {
    throw new Error(`extraction could not run (${result.failure}); it will be retried`);
  }
  return { status: "failed", failure: result.failure, ...NONE };
}

function extracted(e: Extraction): Outcome {
  return {
    status: "extracted",
    kind: e.kind,
    text: e.text,
    truncated: e.truncated,
    metadata: e.metadata as Record<string, unknown>,
    signals: e.signals,
    warnings: e.warnings,
    failure: null,
  };
}
