import {
  apiKeyVariable,
  createModelClient,
  createModelRouter,
  dailyTokenBudget,
  type ModelRouter,
  type ModelsLogger,
  type ProviderConfig,
  type TokenBudget,
} from "@openhoard/core-models";
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
}

/**
 * The configured providers, router and budget, or null when no provider is configured. Throws
 * an Error listing what is wrong (a missing model, a missing key's variable name, an http URL
 * for a commercial provider…), never a key.
 */
export function createServerModels(
  models: Config["models"],
  env: NodeJS.ProcessEnv,
  log?: ModelsLogger,
): ServerModels | null {
  if (models.providers.length === 0) return null;
  const problems: string[] = [];
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
  let router: ModelRouter | undefined;
  if (problems.length === 0) {
    try {
      router = createModelRouter(clients, stripUndefined(models.tasks));
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
  };
}

/** `o` without its undefined properties, typed so (exactOptionalPropertyTypes). */
function stripUndefined<T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
