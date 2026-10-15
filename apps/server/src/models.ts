import {
  apiKeyVariable,
  checkProviderConfig,
  createModelClient,
  createModelRouter,
  dailyTokenBudget,
  embeddingModelId,
  type ModelRouter,
  type ModelsLogger,
  type ProviderConfig,
  type TokenBudget,
} from "@openhoard/core-models";
import type { ProviderKind } from "@openhoard/core-policy";
import type { Config } from "./config.js";

/*
 * The server's model providers (T-404): built from `models` in the configuration, with API keys
 * from the environment only (OPENHOARD_MODEL_<ID>_API_KEY). The key goes into the provider's
 * client and nowhere else: not into the configuration object (which may be logged or dumped),
 * not into errors (they name the variable, never its value).
 *
 * With no providers configured, there is nothing to route to, and enrichment runs no model
 * (the cost guard: nothing reads the whole corpus through a model unless an admin says so).
 */

/** Anthropic's Haiku-class model: the default for the anthropic adapter, configurable. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5";

const DEFAULT_BASE_URL: Partial<Record<ProviderConfig["adapter"], string>> = {
  anthropic: "https://api.anthropic.com",
  ollama: "http://localhost:11434",
};

export interface ServerModels {
  router: ModelRouter;
  budget: TokenBudget;
  /** The summarize step's settings from `models.summarize`. */
  summarize: { budgetMs?: number; vocabularyLimit?: number };
  /** The provider kinds a search query may be embedded by (`models.queryKinds`). */
  queryKinds: readonly ProviderKind[];
}

/**
 * The configured providers, router and budget, or null when no provider is usable. Throws an
 * Error listing what is wrong (a missing model, an http URL for a commercial provider…), never a
 * key.
 *
 * A provider whose only problem is a missing API key is left out instead, with a warning naming
 * its variable (`log.warn`): the server starts, that provider runs nothing, and search still
 * works by keywords. A person trying OpenHoard out gets a working server before they have a
 * key; any other misconfiguration still refuses. Task orders (`models.tasks`) naming a provider
 * left out skip it; with no provider left, there is no model at all (null).
 */
export function createServerModels(
  models: Config["models"],
  env: NodeJS.ProcessEnv,
  log?: ModelsLogger,
): ServerModels | null {
  if (models.providers.length === 0) return null;
  const problems: string[] = [];
  const keyless = new Set<string>();
  const clients = models.providers.flatMap((p) => {
    const chatModel =
      p.chatModel ??
      (p.adapter === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : p.adapter === "stub" ? "stub" : "");
    if (chatModel === "") {
      problems.push(`models.providers ${p.id}: chatModel is required for ${p.adapter}`);
      return [];
    }
    const baseUrl = p.baseUrl ?? DEFAULT_BASE_URL[p.adapter];
    const apiKey = env[apiKeyVariable(p.id)];
    const { baseUrl: _configured, ...rest } = stripUndefined(p);
    const config: ProviderConfig = {
      ...(rest as Omit<ProviderConfig, "chatModel" | "baseUrl">),
      chatModel,
      ...(baseUrl === undefined ? {} : { baseUrl }),
    };
    // Missing its key and nothing else: fine with any key, not without one.
    if (
      !apiKey &&
      checkProviderConfig(config).length > 0 &&
      checkProviderConfig(config, "a key").length === 0
    ) {
      keyless.add(p.id);
      const variable = apiKeyVariable(p.id);
      log?.warn?.(
        { provider: p.id, variable },
        `model provider ${p.id} has no API key (${variable} isn't set): it runs nothing until ` +
          `the key is set and the server restarted; search still works by keywords`,
      );
      return [];
    }
    try {
      return [
        createModelClient(config, {
          ...(apiKey ? { apiKey } : {}),
          ...(log ? { log } : {}),
        }),
      ];
    } catch (e) {
      problems.push(`models.providers: ${(e as Error).message}`);
      return [];
    }
  });
  if (problems.length === 0 && clients.length === 0) return null;
  let router: ModelRouter | undefined;
  if (problems.length === 0) {
    try {
      const tasks = Object.fromEntries(
        Object.entries(stripUndefined(models.tasks)).map(([task, ids]) => [
          task,
          ids.filter((id) => !keyless.has(id)),
        ]),
      );
      router = createModelRouter(clients, tasks);
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  if (problems.length > 0 || router === undefined) {
    throw new Error(`invalid OpenHoard config:\n  ${problems.join("\n  ")}`);
  }
  return {
    router,
    budget: dailyTokenBudget(models.dailyTokenBudget, models.tenantBudgets),
    summarize: stripUndefined(models.summarize),
    queryKinds: models.queryKinds,
  };
}

/**
 * What to warn about at startup, each a line for the log:
 * - model providers configured where no summary can run, because this server reads no
 *   version's bytes (no source opted in with `extract`);
 * - files embedded by providers no search query may go to (`models.queryKinds`): their vectors
 *   are stored, and search never uses them.
 */
export function modelsStartupWarnings(
  models: ServerModels | null,
  hasContentSource: boolean,
): string[] {
  if (models === null) return [];
  const out: string[] = [];
  if (!hasContentSource) {
    out.push(
      "model providers are configured, but this server reads no file content (no source has `extract: true`): no summaries will run",
    );
  }
  // A file gets vectors from the first embeddings provider its exposure allows (core/jobs
  // embed.ts), so the first in the order embeds most files: if no query may go to it, search
  // compares queries with vectors almost no file has.
  const embedders = models.router
    .candidates("embed")
    .filter((c) => c.embed !== undefined && embeddingModelId(c) !== null);
  const first = embedders[0];
  if (first !== undefined && !models.queryKinds.includes(first.kind)) {
    const asked = embedders.filter((c) => models.queryKinds.includes(c.kind));
    out.push(
      `files are embedded first by ${first.id} (${first.kind}), but search queries go to ${models.queryKinds.join(", ")} providers only (models.queryKinds)` +
        (asked.length === 0
          ? ": search finds by keywords only."
          : `: they are embedded by ${asked.map((c) => c.id).join(", ")}, whose vectors only files ${first.id} may not have carry, so search by meaning finds little.`) +
        ` Add "${first.kind}" to models.queryKinds to let search queries go to ${first.id} too, or put a ${models.queryKinds.join(" or ")} provider first in models.tasks.embed`,
    );
  }
  return out;
}

/** `o` without its undefined properties, typed so (exactOptionalPropertyTypes). */
function stripUndefined<T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
