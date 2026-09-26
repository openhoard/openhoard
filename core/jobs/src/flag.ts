import { applyInjectionFlag, readExtract } from "@openhoard/core-catalog";
import { detectInjection, type InjectionVerdict } from "@openhoard/core-summarize";
import type { EnrichStep, EnrichTarget } from "./enrich.js";

/*
 * Injection flagging as an enrichment step, `injection-flag` (T-408): after text extraction and
 * before any tag rule or model, it scores the version for prompt injection (core/summarize
 * detectInjection(): the file name, the extracted text, the extractor's hidden-text signals and
 * the file's own metadata) and makes the object's `risk:injection` flag match (core/catalog
 * applyInjectionFlag()): flagged, the file is metadata-only for AI clients and its content
 * reaches no model, since the pipeline asks the exposure before every model step; not flagged
 * (a later clean version), the detector takes its own flag off again.
 *
 * It sends nothing anywhere and names no provider. Without an extraction (an unsupported type,
 * a failed one, a zone that isn't extracted) it scores the name alone. The job's output and log
 * carry the verdict's pattern ids and score, never the text that matched.
 *
 * A tenant without the `risk:injection` vocabulary can't be flagged: the step throws
 * (RiskVocabularyError) and the job retries, leaving the version unprocessed (hidden,
 * metadata-only) until an admin applies the starter pack. Clean files are unaffected.
 */

export interface FlagStepOptions {
  /** Told of every verdict (tests, and the job's log). Codes and numbers only. */
  onVerdict?: (target: EnrichTarget, verdict: InjectionVerdict) => void;
}

/** Scores a version as the step does: name, extracted text, signals and metadata. */
export async function scoreVersion(
  target: EnrichTarget,
  read: Parameters<EnrichStep["run"]>[0]["read"],
): Promise<InjectionVerdict> {
  const extract = await read((tx) => readExtract(tx, target.tenantId, target.versionId));
  return detectInjection({
    name: target.title,
    ...(extract?.status === "extracted"
      ? { text: extract.text, signals: extract.signals, metadata: extract.metadata }
      : {}),
  });
}

/** The injection-flag step: see above. */
export function injectionFlagStep(options: FlagStepOptions = {}): EnrichStep {
  return {
    name: "injection-flag",
    async run({ target, read, write }) {
      const verdict = await scoreVersion(target, read);
      options.onVerdict?.(target, verdict);
      await write((tx) =>
        applyInjectionFlag(tx, target.tenantId, target.objectId, verdict.flagged),
      );
    },
  };
}
