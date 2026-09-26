import type { Database } from "@openhoard/core-db";
import type { ProviderKind } from "@openhoard/core-policy";
import { reserveTokens, settleTokens, type TokenBudget } from "./budget.js";
import { embeddingModelId, estimateTokens } from "./clients.js";
import type { ModelRouter } from "./router.js";
import type { ModelsLogger } from "./types.js";

/*
 * A search query's embeddings (T-503). Stored vectors are compared only with vectors of their own
 * model, so the query is embedded once per embeddings provider, each result named like the
 * stored ones (`<provider id>/<model>`); core/catalog's search uses each against that model's
 * rows.
 *
 * The query is the caller's own words, not a file's content, so no file's exposure applies. It
 * may still say something sensitive, so by default it goes to local providers only (the user's
 * decision: embeddings come from a local model, which every exposure but metadata-only allows);
 * `kinds` widens that. A provider that fails is left out, and search goes on without its
 * vectors: keyword search never depends on a model (and with no embeddings configured at all,
 * this returns nothing and search is keyword only).
 *
 * Every call counts in the tenant's daily token budget (`budget`), local providers too, as
 * enrichment's calls do: tokens reserved from an estimate before the call, settled with what the
 * provider reported, and the request counted in `calls`. A spent budget leaves the model out.
 */

/** A query's embedding under one model. */
export interface QueryEmbedding {
  /** `<provider id>/<model>`, as the stored vectors are named. */
  model: string;
  vector: number[];
}

export interface EmbedQueryOptions {
  signal: AbortSignal;
  /** Provider kinds the query may go to. Default local only. */
  kinds?: readonly ProviderKind[];
  /** Longest query text sent, in characters. Default 1,000 (the search's own cap). */
  maxChars?: number;
  /**
   * The tenant's budget to count the calls in (core/models reserveTokens()): each in a short
   * transaction of its own, so call embedQuery() outside any withTenant() callback.
   */
  budget?: { db: Database; tenantId: string; budget: TokenBudget };
  log?: ModelsLogger;
}

/** The query's embedding under each embeddings provider of an allowed kind; see above. */
export async function embedQuery(
  router: ModelRouter,
  text: string,
  options: EmbedQueryOptions,
): Promise<QueryEmbedding[]> {
  const query = [...text.trim()].slice(0, options.maxChars ?? 1_000).join("");
  if (query === "") return [];
  const kinds = options.kinds ?? ["local"];
  const account = options.budget;
  const out: QueryEmbedding[] = [];
  const seen = new Set<string>();
  for (const client of router.candidates("embed")) {
    const model = embeddingModelId(client);
    if (model === null || seen.has(model) || !kinds.includes(client.kind) || !client.embed) {
      continue;
    }
    seen.add(model);
    const estimate = estimateTokens(query);
    const reservation =
      account === undefined
        ? undefined
        : await account.db.withTenant(account.tenantId, (tx) =>
            reserveTokens(
              tx,
              account.tenantId,
              estimate,
              account.budget.limitFor(account.tenantId),
            ),
          );
    if (reservation === null) {
      options.log?.warn?.(
        { provider: client.id, code: "budget" },
        "model token budget spent for today: searching without query embeddings",
      );
      continue;
    }
    let used = 0;
    try {
      const { vectors, usage } = await client.embed({
        texts: [query],
        signal: options.signal,
        // The caller's own words: which kinds may have them is `kinds`, checked above.
        guard: () => Promise.resolve(true),
      });
      used = Number.isFinite(usage.inputTokens) ? Math.min(estimate * 4, usage.inputTokens) : 0;
      const vector = vectors[0];
      if (vector !== undefined) out.push({ model, vector });
    } catch (e) {
      if (options.signal.aborted) throw e;
      // Search goes on without this model's vectors; the log says which, never the query.
      options.log?.warn?.(
        { provider: client.id, code: (e as { code?: unknown }).code ?? "error" },
        "query embedding failed: searching without it",
      );
    } finally {
      if (account !== undefined && reservation !== undefined) {
        await account.db
          .withTenant(account.tenantId, (tx) =>
            settleTokens(tx, account.tenantId, reservation, used, 1),
          )
          .catch(() => {});
      }
    }
  }
  return out;
}
