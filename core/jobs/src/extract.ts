import {
  contentRef,
  saveExtract,
  type ContentSource,
  type VersionExtract,
} from "@openhoard/core-catalog";
import {
  extract,
  EXTRACTOR_VERSION,
  mayExtract,
  type Extraction,
  type ExtractLimits,
} from "@openhoard/enricher-extract";
import type { EnrichStep } from "./enrich.js";

/*
 * Text extraction as an enrichment step (T-402): reads the version's bytes through a
 * ContentSource, extracts them in a limited child process (@openhoard/enricher-extract), and
 * stores the result for the version (core/catalog saveExtract(): one row per version, rewritten
 * on every run) through the pipeline's guarded write, so a job for a replaced or renamed
 * version stores nothing.
 *
 * It names no provider: the content goes to a process of OpenHoard's own on the same machine
 * and nowhere else, so it runs whatever the file's exposure. What reads the stored text later
 * (a model step, T-405) is what the exposure gates.
 *
 * What happens, by what the extractor answers:
 *
 * | Answer                                          | Stored                  | The job     |
 * | ----------------------------------------------- | ----------------------- | ----------- |
 * | text and metadata                               | `extracted`             | goes on     |
 * | a type with no extractor                        | `unsupported`           | goes on     |
 * | no source reaches the bytes                     | `unavailable`           | goes on     |
 * | the file's own failure (malformed, encrypted,   | `failed` and the code   | goes on     |
 * | a zip bomb, a timeout, out of memory, a crash)  |                         |             |
 * | reading the bytes failed, or no process started | nothing                 | fails, and  |
 * |                                                 |                         | retries     |
 *
 * So a hostile or broken file costs one child process once, and never the job's retries: its
 * failure is recorded (`failed`) and the version is marked processed like any other.
 */

export interface ExtractStepOptions {
  /** Where versions' bytes are read from (core/storage blobContentSource(), connectors). */
  content: ContentSource;
  /** Changes to the extractor's limits (DEFAULT_LIMITS in @openhoard/enricher-extract). */
  limits?: Partial<ExtractLimits>;
}

type Outcome = Omit<VersionExtract, "extractor">;

const NONE = { kind: null, text: "", truncated: false, metadata: {}, signals: [], warnings: [] };

/** The extract step, `extract-text`: see above. */
export function extractStep(options: ExtractStepOptions): EnrichStep {
  const { content, limits } = options;
  return {
    name: "extract-text",
    async run({ target, read, write, signal }) {
      const ref = await read((tx) => contentRef(tx, target.tenantId, target.versionId));
      // Gone since the job started: there is nothing to store, and write() would refuse.
      if (ref === null) return;
      const hint = { mime: target.mime, name: target.title };
      let outcome: Outcome;
      if (!mayExtract(hint)) {
        outcome = { status: "unsupported", failure: null, ...NONE };
      } else {
        const stream = await content.open(ref, signal);
        if (stream === null) {
          outcome = { status: "unavailable", failure: null, ...NONE };
        } else {
          const result = await extract(stream, hint, {
            size: ref.size,
            signal,
            ...(limits ? { limits } : {}),
          });
          if (result.ok) outcome = extracted(result.extraction);
          else if (!result.permanent) {
            throw new Error(`extraction could not run (${result.failure}); it will be retried`);
          } else if (result.failure === "unsupported") {
            outcome = { status: "unsupported", failure: null, ...NONE };
          } else {
            outcome = { status: "failed", failure: result.failure, ...NONE };
          }
        }
      }
      await write((tx) =>
        saveExtract(tx, target.tenantId, {
          objectId: target.objectId,
          versionId: target.versionId,
          extractor: EXTRACTOR_VERSION,
          ...outcome,
        }),
      );
    },
  };
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
