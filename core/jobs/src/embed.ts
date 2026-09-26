import { createHash } from "node:crypto";
import {
  MAX_EMBEDDINGS_PER_VERSION,
  readCard,
  readEmbeddings,
  readExtract,
  saveEmbeddings,
  type EmbeddingItem,
} from "@openhoard/core-catalog";
import {
  dailyTokenBudget,
  embeddingModelId,
  estimateTokens,
  ModelError,
  reserveTokens,
  settleTokens,
  type ModelClient,
  type ModelRouter,
  type TokenBudget,
} from "@openhoard/core-models";
import type { EnrichContext, EnrichStep } from "./enrich.js";
import type { JobsLogger } from "./jobs.js";

/*
 * Embeddings as an enrichment step, `embed` (T-407), after summarize:
 *
 *   extract-text → injection-flag → rule-tags → summarize → embed
 *
 * For one version it embeds the model summary (when there is one) and chunks of the extracted
 * text: windows of `chunkChars` characters overlapping by `overlapChars`, cut at a space where
 * one is near, at most `maxChunks` of them, spread evenly over a longer text (its start, its end
 * and between), each cut to the provider's `maxInputChars`. The vectors are stored per version
 * and model (core/catalog saveEmbeddings()), named `<provider id>/<model>`.
 *
 * - Which provider: the router's `embed` order (local first by default; the user's choice is a
 *   local Ollama model, which every exposure but metadata-only allows), the first the file's
 *   exposure allows now (`context.mayProcess`), asked again by the client right before the
 *   call. A commercial provider gets only files whose exposure allows it; none gets a
 *   metadata-only file, which includes every file flagged `risk:injection` (T-408): the
 *   pipeline skips this step for them, so a flagged file has no content vectors, only what its
 *   card shows can match it (T-604).
 * - Idempotent: each text's SHA-256 is stored with its vector, so a re-run embeds only what
 *   changed (a new summary) and writes nothing when nothing did. Another model (a changed
 *   `embedModel`, another provider first) has no vectors yet, so it embeds everything under the
 *   new name, beside the old model's (core/jobs reembed() does the rest of the tenant).
 * - Budget: the texts' token estimate is reserved from the tenant's daily budget and settled
 *   with what the provider reported; a spent budget skips the step with a warning.
 * - Failures: an answer that won't do (`bad-response`, vectors of mixed or zero sizes, a
 *   refusal, `too-large`) is logged and the version is processed without vectors (keyword
 *   search still finds it). A provider down, rate-limited or slow fails the step so the job
 *   retries, except on the job's last attempt, when the version is processed without them.
 * - Time: `budgetMs` (default 2 minutes) on top of the extract step's 13 and summarize's 8,
 *   under the job's 25-minute lease.
 * - Logs carry ids, the provider, counts and codes; never text.
 */

export interface EmbedStepOptions {
  router: ModelRouter;
  /** The tenants' daily token budgets. Default dailyTokenBudget(): 5 M tokens each. */
  budget?: TokenBudget;
  /** The step's time for its model call, in ms. Default 2 minutes. */
  budgetMs?: number;
  /** Characters per chunk. Default 1,200. */
  chunkChars?: number;
  /** Characters two chunks share. Default 200. */
  overlapChars?: number;
  /** Chunks per version at most. Default 16. */
  maxChunks?: number;
  log?: JobsLogger;
}

/** The step's default time for its model call. */
export const EMBED_BUDGET_MS = 2 * 60_000;
export const CHUNK_DEFAULTS = { chunkChars: 1_200, overlapChars: 200, maxChunks: 16 } as const;

/** A chunk of text: its place among the chunks kept (0, 1, 2…), and the text. */
export interface Chunk {
  seq: number;
  text: string;
}

/**
 * The most chunks a version keeps: with its summary, what core/catalog saveEmbeddings() takes.
 * A long text has thousands of windows; `seq` numbers the ones kept, so it stays small.
 */
export const MAX_CHUNKS = MAX_EMBEDDINGS_PER_VERSION - 1;

/**
 * Windows of `text` (see above): `chunkChars` long, the next starting `chunkChars -
 * overlapChars` on, each ending at the last whitespace in its final fifth when there is one.
 * Blank windows are dropped. More than `maxChunks` (at most {@link MAX_CHUNKS}): that many,
 * evenly spread, the first and the last included. The same text and settings always give the
 * same chunks, numbered in order by `seq`.
 */
export function chunkText(
  text: string,
  options: { chunkChars?: number; overlapChars?: number; maxChunks?: number } = {},
): Chunk[] {
  const size = options.chunkChars ?? CHUNK_DEFAULTS.chunkChars;
  const overlap = options.overlapChars ?? CHUNK_DEFAULTS.overlapChars;
  const most = options.maxChunks ?? CHUNK_DEFAULTS.maxChunks;
  if (!Number.isSafeInteger(size) || size < 50 || size > 100_000) {
    throw new RangeError("chunkChars is 50 to 100000");
  }
  if (!Number.isSafeInteger(overlap) || overlap < 0 || overlap >= size / 2) {
    throw new RangeError("overlapChars is 0 to less than half of chunkChars");
  }
  if (!Number.isSafeInteger(most) || most < 1 || most > MAX_CHUNKS) {
    throw new RangeError(`maxChunks is 1 to ${MAX_CHUNKS}`);
  }
  const step = size - overlap;
  const starts: number[] = [];
  for (let at = 0; at < text.length; at += step) {
    starts.push(at);
    if (at + size >= text.length) break;
  }
  const picked =
    starts.length <= most
      ? starts.map((_, i) => i)
      : [
          ...new Set(
            Array.from({ length: most }, (_, i) =>
              Math.round((i * (starts.length - 1)) / Math.max(1, most - 1)),
            ),
          ),
        ];
  const out: Chunk[] = [];
  for (const window of picked) {
    let start = starts[window] as number;
    // Never start or end between the halves of a surrogate pair.
    const first = text.charCodeAt(start);
    if (first >= 0xdc00 && first <= 0xdfff) start++;
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      // A word cut in two embeds as two strange words: end at a space when one is near.
      const space = lastSpace(text, start + Math.floor(size * 0.8), end);
      if (space > start) end = space;
    }
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
    const chunk = text.slice(start, end);
    if (chunk.trim() !== "") out.push({ seq: out.length, text: chunk });
  }
  return out;
}

function lastSpace(text: string, from: number, to: number): number {
  for (let i = to - 1; i >= from; i--) if (/\s/.test(text.charAt(i))) return i;
  return -1;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The embed step: see above. */
export function embedStep(options: EmbedStepOptions): EnrichStep {
  const { router, log } = options;
  const budget = options.budget ?? dailyTokenBudget();
  const budgetMs = options.budgetMs ?? EMBED_BUDGET_MS;
  const candidates = router.candidates("embed");
  if (candidates.length === 0) throw new TypeError("embedStep: no provider for embeddings");
  // Checked now, not in the first job.
  chunkText("", options);
  return {
    name: "embed",
    providers: candidates,
    async run(context) {
      const { target, read, write } = context;
      const { tenantId, objectId, versionId } = target;
      const [extract, card] = await read(async (tx) => [
        await readExtract(tx, tenantId, versionId),
        await readCard(tx, tenantId, versionId),
      ]);
      const texts: { part: EmbeddingItem["part"]; seq: number; text: string }[] = [];
      if (card?.status === "summarized" && card.summary.trim() !== "") {
        texts.push({ part: "summary", seq: 0, text: card.summary });
      }
      if (extract?.status === "extracted") {
        for (const c of chunkText(extract.text, options)) texts.push({ part: "chunk", ...c });
      }
      if (texts.length === 0) return;

      const client = await router.pickAllowed("embed", (c) => context.mayProcess(c));
      if (client === null) return;
      const model = embeddingModelId(client) as string;
      const wanted = texts.map((t) => {
        const text = [...t.text].slice(0, client.maxInputChars).join("");
        return { part: t.part, seq: t.seq, text, textHash: sha256(text) };
      });
      const have = await read((tx) => readEmbeddings(tx, tenantId, versionId, model));
      const key = (w: { part: string; seq: number }) => `${w.part}:${w.seq}`;
      const missing = wanted.filter((w) => have.get(key(w))?.textHash !== w.textHash);
      if (missing.length === 0 && have.size === wanted.length) return;

      let fresh: number[][] = [];
      if (missing.length > 0) {
        const estimate = missing.reduce((n, w) => n + estimateTokens(w.text), 0);
        const reservation = await write((tx) =>
          reserveTokens(tx, tenantId, estimate, budget.limitFor(tenantId)),
        );
        if (reservation === null) {
          log?.warn?.(
            { tenantId, versionId, provider: client.id },
            "model token budget spent for today: embeddings skipped",
          );
          return;
        }
        const tally = { used: 0, calls: 0 };
        let settled = false;
        try {
          try {
            fresh = await ask(context, client, missing, budgetMs, estimate, tally);
          } catch (e) {
            if (e instanceof ModelError && e.code === "withheld") return;
            if (!skippable(e, context)) throw e;
            log?.warn?.(
              {
                tenantId,
                versionId,
                provider: client.id,
                code: e instanceof ModelError ? e.code : "bad-vectors",
              },
              "no usable embeddings from the model: skipped",
            );
            return;
          }
          const vectors = new Map(missing.map((w, i) => [key(w), fresh[i] as number[]]));
          const items: EmbeddingItem[] = wanted.map((w) => ({
            part: w.part,
            seq: w.seq,
            textHash: w.textHash,
            embedding: vectors.get(key(w)) ?? (have.get(key(w))?.embedding as number[]),
          }));
          const sizes = new Set(items.map((i) => i.embedding.length));
          if (sizes.size !== 1) {
            // The model's size changed under the same name: start over with every text.
            log?.warn?.(
              { tenantId, versionId, provider: client.id, code: "size-changed" },
              "embedding size changed under the same model name: skipped",
            );
            return;
          }
          await write(async (tx) => {
            await settleTokens(tx, tenantId, reservation, tally.used, tally.calls);
            await saveEmbeddings(tx, tenantId, {
              objectId,
              versionId,
              model,
              providerKind: client.kind,
              items,
            });
          });
          settled = true;
        } finally {
          if (!settled) {
            await write((tx) =>
              settleTokens(tx, tenantId, reservation, tally.used, tally.calls),
            ).catch(() => {});
          }
        }
        return;
      }
      // Only rows to drop (fewer chunks than before): no call needed.
      await write((tx) =>
        saveEmbeddings(tx, tenantId, {
          objectId,
          versionId,
          model,
          providerKind: client.kind,
          items: wanted.map((w) => ({
            part: w.part,
            seq: w.seq,
            textHash: w.textHash,
            embedding: have.get(key(w))?.embedding as number[],
          })),
        }),
      );
    },
  };
}

/** Thrown for vectors that can't be stored: mixed sizes, zeros, the wrong count. */
class BadVectorsError extends Error {
  constructor() {
    super("the provider's vectors can't be stored");
    this.name = "BadVectorsError";
  }
}

/** One call for every missing text; the guard re-reads the file's exposure before it goes. */
async function ask(
  context: EnrichContext,
  client: ModelClient,
  texts: readonly { text: string }[],
  budgetMs: number,
  cap: number,
  tally: { used: number; calls: number },
): Promise<number[][]> {
  const embed = client.embed;
  if (embed === undefined) throw new ModelError("unsupported", client.id);
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(budgetMs)]);
  tally.calls++;
  const result = await embed({
    texts: texts.map((t) => t.text),
    signal,
    guard: () => context.mayProcess(client),
  });
  const used = result.usage.inputTokens;
  tally.used = Number.isFinite(used) ? Math.min(cap, Math.max(0, Math.floor(used))) : cap;
  const { vectors } = result;
  if (vectors.length !== texts.length) throw new BadVectorsError();
  const size = vectors[0]?.length;
  for (const v of vectors) {
    if (v.length !== size || v.every((x) => x === 0)) throw new BadVectorsError();
  }
  return vectors;
}

/**
 * Whether a failed call is recorded (logged, the version processed without vectors) rather
 * than failing the job: an answer that won't get better by asking again, or no retry left.
 */
function skippable(e: unknown, context: EnrichContext): boolean {
  if (context.signal.aborted) return false;
  if (e instanceof BadVectorsError) return true;
  if (e instanceof ModelError) {
    if (
      ["refused", "auth", "blocked", "unsupported", "bad-response", "too-large"].includes(e.code)
    ) {
      return true;
    }
    return context.finalAttempt;
  }
  if (e instanceof DOMException && e.name === "TimeoutError") return context.finalAttempt;
  return false;
}
