import {
  modelVocabulary,
  proposeDisplayTitle,
  proposeTag,
  readCard,
  readExtract,
  reviewedNotInjection,
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
import type { Tx } from "@openhoard/core-db";
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
 *    doesn't match, and records `skipped` for `model-output` if the repair doesn't either;
 * 7. filters it (instructions, links, markup, tags outside the vocabulary, the `risk` facet) and
 *    stores, in one guarded write: the card, the settled token count, the tags (through
 *    proposeTag() as the model's: unreviewed, and anything sensitive waits for a person) and a
 *    display title proposal (which non-readers never see before the owner confirms it).
 *
 * Time: the step gives itself `budgetMs` (default 8 minutes) on top of the extract step's 13,
 * under the job's 25-minute lease (jobs.ts). With the defaults (60 s per attempt, 2 retries,
 * backoff up to 30 s) two calls fit in it.
 *
 * Failures (skipReasonFor()): an answer that won't do (`model-output`, `bad-response`,
 * `too-large`) or a refusal (`refused`: a content filter, a wrong key, a blocked address) is
 * recorded as `skipped` with its reason and a warning, and the version is processed without a
 * summary: asking again the same way costs money and changes nothing. A provider that is
 * rate-limited, down or slow past its retries fails the step, so the job retries with its
 * backoff; on the job's last attempt it is recorded as `unavailable` instead, so no version is
 * dead-lettered and left hidden for want of a summary. The reservation is always settled.
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
      // An admin decided this content is not an injection (core/catalog markNotInjection()).
      const reviewed = await read((tx) => reviewedNotInjection(tx, tenantId, objectId));
      if (verdict.flagged && !reviewed) return skip("flagged");

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

      // What went out and what it cost, as the calls come back; always settled (finally).
      const tally = { used: 0, calls: 0 };
      let settled = false;
      const settle = (tx: Tx) => settleTokens(tx, tenantId, reservation, tally.used, tally.calls);
      try {
        let answered: Awaited<ReturnType<typeof ask>>;
        try {
          answered = await ask(context, client, prompt, budgetMs, perCall * 2, tally);
        } catch (e) {
          // The file's exposure no longer allows this provider: nothing was sent; nothing to do.
          if (e instanceof ModelError && e.code === "withheld") return;
          const reason = skipReasonFor(e, context);
          if (reason === null) throw e;
          // The model gave nothing usable, and trying again won't help (or no retry is left):
          // the version is processed without a summary, and a person can see why.
          log?.warn?.(
            { tenantId, versionId, provider: client.id, reason },
            "no usable summary from the model: skipped",
          );
          await write(async (tx) => {
            await settle(tx);
            await saveCard(tx, tenantId, {
              objectId,
              versionId,
              status: "skipped",
              reason,
              promptVersion: PROMPT_VERSION,
            });
          });
          settled = true;
          return;
        }
        const out = filterCardOutput(answered.raw, {
          vocabulary: new Set(vocabulary.map((v) => v.tag)),
          title: target.title,
        });
        await write(async (tx) => {
          await settle(tx);
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
        settled = true;
      } finally {
        // What was spent, spent; the rest of the reservation goes back, however the step ended
        // (a stale target's write() refuses: the reservation stays, which only over-counts).
        if (!settled) await write((tx) => settle(tx)).catch(() => {});
      }
    },
  };
}

/**
 * Why to record a failed call as `skipped` instead of failing the job, or null to fail it (and
 * retry). A bad answer, a refusal (a content filter, a wrong key, a blocked address) or an
 * oversized one won't get better by asking again the same way; a provider that was rate-limited,
 * down or slow might, so those fail the job, except on its last attempt, when the version is
 * processed without a summary rather than dead-lettered and left hidden. The job's own end
 * (lease, shutdown) always fails it.
 */
function skipReasonFor(e: unknown, context: EnrichContext): CardSkipReason | null {
  if (context.signal.aborted) return null;
  if (e instanceof ModelOutputError) return "model-output";
  if (e instanceof ModelError) {
    switch (e.code) {
      case "refused":
      case "auth":
      case "blocked":
      case "unsupported":
        return "refused";
      case "bad-response":
        return "bad-response";
      case "too-large":
        return "too-large";
      default:
        return context.finalAttempt ? "unavailable" : null;
    }
  }
  // The step's own time budget ran out (not the job's): as a slow provider.
  if (e instanceof DOMException && e.name === "TimeoutError") {
    return context.finalAttempt ? "unavailable" : null;
  }
  return null;
}

/**
 * Asks the model, validates, repairs once. Every request that goes out and every call's tokens
 * go to `tally` as they happen, so a failure settles the budget with what was actually used.
 * Reported usage is clamped (whole, not negative, at most `cap` a call): a provider reporting
 * nonsense can't blow the budget, or the database's integer columns.
 */
async function ask(
  context: EnrichContext,
  client: ModelClient,
  prompt: ReturnType<typeof buildSummaryPrompt>,
  budgetMs: number,
  cap: number,
  tally: { used: number; calls: number },
) {
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(budgetMs)]);
  const guard = () => context.mayProcess(client);
  const onAttempt = () => {
    tally.calls++;
  };
  const clamp = (n: number) =>
    Number.isFinite(n) ? Math.min(cap, Math.max(0, Math.floor(n))) : cap;
  const usage = { inputTokens: 0, outputTokens: 0 };
  const count = (r: ChatResult) => {
    const input = clamp(r.usage.inputTokens);
    const output = clamp(r.usage.outputTokens);
    usage.inputTokens += input;
    usage.outputTokens += output;
    tally.used += Math.min(cap, input + output);
  };
  const first = await client.chat({
    system: prompt.system,
    user: prompt.user,
    json: true,
    signal,
    guard,
    onAttempt,
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
      onAttempt,
    });
    count(second);
    // A second miss throws ModelOutputError: the step records `model-output`.
    return { raw: validateCardOutput(second.text), usage };
  }
}
