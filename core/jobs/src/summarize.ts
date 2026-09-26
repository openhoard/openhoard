import {
  modelVocabulary,
  proposeDisplayTitle,
  proposeTag,
  readCard,
  readExtract,
  saveCard,
  TagError,
  type CardSkipReason,
} from "@openhoard/core-catalog";
import {
  dailyTokenBudget,
  estimateTokens,
  ModelError,
  reserveTokens,
  settleTokens,
  type ChatResult,
  type ModelClient,
  type ModelRouter,
  type TokenBudget,
} from "@openhoard/core-models";
import {
  buildRepairPrompt,
  buildSummaryPrompt,
  detectInjection,
  filterCardOutput,
  ModelOutputError,
  PROMPT_VERSION,
  validateCardOutput,
} from "@openhoard/core-summarize";
import type { EnrichContext, EnrichStep } from "./enrich.js";
import type { JobsLogger } from "./jobs.js";

/*
 * Summaries and model tags as an enrichment step, `summarize` (T-405). Last in the pipeline:
 * extract-text → injection-flag → rule-tags → summarize. For one version it:
 *
 * 1. stops if the version has a card from this prompt already (enrichment at most once per
 *    version: a re-run, a rename's job or the sweep spend nothing);
 * 2. records `skipped` and stops when there is no extracted text (`no-text`), when the injection
 *    detector flags it (`flagged`: checked here again, whatever the tag says), or when no
 *    configured provider may have the content (`no-provider`);
 * 3. picks the provider (core/models router: the task's order, local first by default, the
 *    first one the file's exposure allows, as the pipeline's `mayProcess` says now);
 * 4. reserves tokens from the tenant's daily budget, for the call and one repair; a spent
 *    budget records `skipped` for `budget` and logs a warning (the version is still processed);
 * 5. asks the model, with the document as delimited, untrusted data and the tenant's approved
 *    vocabulary (core/summarize buildSummaryPrompt()); the client asks `mayProcess` again right
 *    before every HTTP attempt, and withholds the content if the answer changed;
 * 6. validates the answer against the card schema, asks once more with the problems if it
 *    doesn't match, and fails the step with ModelOutputError if the repair doesn't either (the
 *    job retries later: models are not deterministic);
 * 7. filters it (instructions, links, markup, tags outside the vocabulary, the `risk` facet) and
 *    stores, in one guarded write: the card, the settled token count, the tags (through
 *    proposeTag() as the model's: unreviewed, and anything sensitive waits for a person) and a
 *    display title proposal (which non-readers never see before the owner confirms it).
 *
 * Time: the step gives itself `budgetMs` (default 8 minutes) on top of the extract step's 13,
 * under the job's 25-minute lease (jobs.ts). With the defaults (60 s per attempt, 2 retries,
 * backoff up to 30 s) two calls fit in it.
 *
 * Failures: a provider that stays rate-limited, down or slow past its retries fails the step
 * (ModelError, retryable): the job retries with its own backoff and the version stays
 * unprocessed meanwhile (fail closed). Wrong keys and refused requests fail the same way, and
 * dead-letter after the retries, for an operator to see.
 */

export interface SummarizeStepOptions {
  router: ModelRouter;
  /** The tenants' daily token budgets. Default dailyTokenBudget(): 5 M tokens each. */
  budget?: TokenBudget;
  /** The step's time for its model calls, in ms. Default 8 minutes. */
  budgetMs?: number;
  /** Vocabulary entries offered to the model at most. Default 300. */
  vocabularyLimit?: number;
  /** Model tags below this go to review (core/catalog proposeTag()). Default its own. */
  minConfidence?: number;
  log?: JobsLogger;
}

/** The step's default time for its model calls. */
export const SUMMARIZE_BUDGET_MS = 8 * 60_000;

/** The summarize step: see above. */
export function summarizeStep(options: SummarizeStepOptions): EnrichStep {
  const { router, log } = options;
  const budget = options.budget ?? dailyTokenBudget();
  const budgetMs = options.budgetMs ?? SUMMARIZE_BUDGET_MS;
  const candidates = router.candidates("summarize");
  if (candidates.length === 0) throw new TypeError("summarizeStep: no provider for summaries");
  return {
    name: "summarize",
    providers: candidates,
    async run(context) {
      const { target, read, write } = context;
      const { tenantId, objectId, versionId } = target;
      const done = await read((tx) => readCard(tx, tenantId, versionId));
      if (done?.status === "summarized" && done.promptVersion === PROMPT_VERSION) return;
      const skip = (reason: CardSkipReason) =>
        write((tx) =>
          saveCard(tx, tenantId, {
            objectId,
            versionId,
            status: "skipped",
            reason,
            promptVersion: PROMPT_VERSION,
          }),
        );

      const extract = await read((tx) => readExtract(tx, tenantId, versionId));
      if (extract?.status !== "extracted" || extract.text.trim() === "") return skip("no-text");
      // Checked again here, whatever the flag step wrote: flagged content reaches no model.
      const verdict = detectInjection({
        name: target.title,
        text: extract.text,
        signals: extract.signals,
        metadata: extract.metadata,
      });
      if (verdict.flagged) return skip("flagged");

      const client = await router.pickAllowed("summarize", (c) => context.mayProcess(c));
      if (client === null) return skip("no-provider");

      const vocabulary = await read((tx) =>
        modelVocabulary(tx, tenantId, options.vocabularyLimit ?? 300),
      );
      const prompt = buildSummaryPrompt({
        title: target.title,
        text: extract.text,
        vocabulary,
        maxChars: client.maxInputChars,
        extractTruncated: extract.truncated,
      });
      // The call and one repair, each at its most.
      const perCall =
        estimateTokens(prompt.system) + estimateTokens(prompt.user) + client.maxOutputTokens;
      const reservation = await write((tx) =>
        reserveTokens(tx, tenantId, perCall * 2, budget.limitFor(tenantId)),
      );
      if (reservation === null) {
        log?.warn?.(
          { tenantId, versionId, provider: client.id },
          "model token budget spent for today: summary skipped",
        );
        return skip("budget");
      }

      let used = 0;
      let answered: Awaited<ReturnType<typeof ask>> | undefined;
      try {
        answered = await ask(context, client, prompt, budgetMs, (n) => (used += n));
      } catch (e) {
        // What was spent, spent; the rest goes back. Not when the target went stale: write()
        // refuses then, and the job ends anyway.
        if (!(e instanceof Error && e.name === "StaleTargetError")) {
          await write((tx) => settleTokens(tx, tenantId, reservation, used)).catch(() => {});
        }
        // The file's exposure no longer allows this provider: nothing was sent; nothing to do.
        if (e instanceof ModelError && e.code === "withheld") return;
        throw e;
      }
      const out = filterCardOutput(answered.raw, {
        vocabulary: new Set(vocabulary.map((v) => v.tag)),
        title: target.title,
      });
      await write(async (tx) => {
        await settleTokens(tx, tenantId, reservation, used);
        let filtered = out.filtered;
        for (const t of out.tags) {
          try {
            await proposeTag(
              tx,
              tenantId,
              {
                objectId,
                tag: t.tag,
                source: "model",
                appliedBy: `model:${client.id}`,
                confidence: t.confidence,
              },
              options.minConfidence === undefined ? {} : { minConfidence: options.minConfidence },
            );
          } catch (e) {
            // A facet removed since the vocabulary was read: the tag is dropped, not the card.
            if (!(e instanceof TagError)) throw e;
            filtered++;
          }
        }
        if (out.displayTitle !== null) {
          await proposeDisplayTitle(tx, tenantId, {
            objectId,
            title: out.displayTitle,
            by: `model:${client.id}`,
            forTitle: target.title,
          });
        }
        await saveCard(tx, tenantId, {
          objectId,
          versionId,
          status: "summarized",
          summary: out.summary,
          providerId: client.id,
          providerKind: client.kind,
          model: client.chatModel,
          promptVersion: PROMPT_VERSION,
          filtered,
          inputTokens: answered.usage.inputTokens,
          outputTokens: answered.usage.outputTokens,
        });
      });
    },
  };
}

/**
 * Asks the model, validates, repairs once. Every call's tokens go to `spent` as they come back,
 * so a failure settles the budget with what was actually used.
 */
async function ask(
  context: EnrichContext,
  client: ModelClient,
  prompt: ReturnType<typeof buildSummaryPrompt>,
  budgetMs: number,
  spent: (tokens: number) => void,
) {
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(budgetMs)]);
  const guard = () => context.mayProcess(client);
  const usage = { inputTokens: 0, outputTokens: 0 };
  const count = (r: ChatResult) => {
    usage.inputTokens += r.usage.inputTokens;
    usage.outputTokens += r.usage.outputTokens;
    spent(r.usage.inputTokens + r.usage.outputTokens);
  };
  const first = await client.chat({
    system: prompt.system,
    user: prompt.user,
    json: true,
    signal,
    guard,
  });
  count(first);
  try {
    return { raw: validateCardOutput(first.text), usage };
  } catch (e) {
    if (!(e instanceof ModelOutputError)) throw e;
    const second = await client.chat({
      system: prompt.system,
      user: buildRepairPrompt(first.text, e),
      json: true,
      signal,
      guard,
    });
    count(second);
    // A second miss fails the step with ModelOutputError; the job retries later.
    return { raw: validateCardOutput(second.text), usage };
  }
}
