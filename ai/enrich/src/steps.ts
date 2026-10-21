import type { ContentSource } from "@openhoard/core-catalog";
import { coreEnrichSteps, type EnrichStep } from "@openhoard/core-jobs";
import { embedStep, type EmbedStepOptions } from "./embed.js";
import { extractStep, type ExtractStepOptions } from "./extract.js";
import { summarizeStep, type SummarizeStepOptions } from "./summarize.js";

/**
 * The steps a server runs, in this order:
 *
 *   extract-text → injection-flag → rule-tags → summarize → embed
 *
 * - extract-text (T-402, extract.ts), when the server has somewhere to read versions' bytes
 *   from (`content`);
 * - injection-flag (T-408) and rule-tags (T-403), the core's (core/jobs coreEnrichSteps()),
 *   always: before any model sees the file; without an extraction the flag scores the name alone;
 * - summarize (T-405, summarize.ts), when models are configured (`summarize.router` with a
 *   provider for summaries) and there is extracted text. Off by default: the cost guard says no
 *   model runs across a corpus unless an admin configures one.
 * - embed (T-407, embed.ts), when an embeddings provider is configured (`embed.router`), after
 *   the summary so it embeds that too. Without one, search is keyword only.
 */
export function defaultEnrichSteps(
  options: {
    content?: ContentSource;
    extract?: Omit<ExtractStepOptions, "content">;
    summarize?: SummarizeStepOptions;
    embed?: EmbedStepOptions;
  } = {},
): EnrichStep[] {
  const { content, extract, summarize, embed } = options;
  const steps: EnrichStep[] = [];
  if (content) steps.push(extractStep({ ...extract, content }));
  steps.push(...coreEnrichSteps());
  if (content && summarize && summarize.router.candidates("summarize").length > 0) {
    steps.push(summarizeStep(summarize));
  }
  if (content && embed && embed.router.candidates("embed").length > 0) {
    steps.push(embedStep(embed));
  }
  return steps;
}
