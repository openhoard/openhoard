import { mayProcess, type ProviderKind } from "@openhoard/core-policy";
import { ModelError } from "./errors.js";
import { postJson, type Lookup } from "./http.js";
import type {
  Adapter,
  ChatRequest,
  ChatResult,
  EmbedRequest,
  EmbedResult,
  ModelClient,
  ModelsLogger,
  ProviderConfig,
  TokenUsage,
} from "./types.js";

/*
 * The adapters (T-404). Each turns a ChatRequest into its API's request, and its API's answer
 * into text and token counts, checking every field it reads: an answer of the wrong shape is a
 * `bad-response`, never a crash or a guess. The shapes, as of 2026-09 (pinned by the tests
 * against fake servers):
 *
 * - Anthropic Messages: POST {base}/v1/messages, `x-api-key` and `anthropic-version:
 *   2023-06-01`; {model, max_tokens, system, messages: [{role: "user", content}], temperature}
 *   → {content: [{type: "text", text}], stop_reason, usage: {input_tokens, output_tokens}}.
 * - OpenAI chat completions (and LM Studio, vLLM, Azure OpenAI's v1 API): POST
 *   {base}/chat/completions, `authorization: Bearer` (or Azure's `api-key`); {model, messages,
 *   max_tokens | max_completion_tokens, temperature, response_format: {type: "json_object"}} →
 *   {choices: [{message: {content}, finish_reason}], usage: {prompt_tokens, completion_tokens}}.
 *   Embeddings: POST {base}/embeddings {model, input} → {data: [{index, embedding}], usage}.
 * - Ollama: POST {base}/api/chat {model, messages, stream: false, format: "json", options:
 *   {temperature, num_predict}} → {message: {content}, done_reason, prompt_eval_count,
 *   eval_count}. Embeddings: POST {base}/api/embed {model, input} → {embeddings}.
 * - The stub answers in-process (tests, CI, trying OpenHoard without a model).
 *
 * Every client also checks, before its first attempt, that its kind may have content at the
 * exposure the guard is about (the guard does that) and nothing else about the content: which
 * provider a file may reach is the router's and the pipeline's to decide.
 */

export const DEFAULTS = {
  timeoutMs: 60_000,
  maxRetries: 2,
  maxRetryAfterMs: 60_000,
  maxInputChars: 24_000,
  maxOutputTokens: 800,
  maxResponseBytes: 1024 * 1024,
  concurrency: 2,
} as const;

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Checks a provider's settings; returns what is wrong (empty when fine). */
export function checkProviderConfig(config: ProviderConfig, apiKey?: string): string[] {
  const problems: string[] = [];
  const at = `provider ${config.id}`;
  if (!PROVIDER_ID.test(config.id)) problems.push(`${at}: id must be a lower-case slug`);
  if (!["local", "commercial", "consumer"].includes(config.kind)) {
    problems.push(`${at}: kind must be local, commercial or consumer`);
  }
  if (!(["stub", "openai", "anthropic", "ollama"] as string[]).includes(config.adapter)) {
    problems.push(`${at}: unknown adapter`);
  }
  if (typeof config.chatModel !== "string" || config.chatModel.length < 1) {
    problems.push(`${at}: chatModel is required`);
  }
  if (config.adapter !== "stub") {
    if (config.baseUrl === undefined) problems.push(`${at}: baseUrl is required`);
    else {
      let url: URL | undefined;
      try {
        url = new URL(config.baseUrl);
      } catch {
        problems.push(`${at}: baseUrl is not a URL`);
      }
      if (url) {
        const loopback = LOOPBACK.has(url.hostname);
        if (url.protocol !== "https:" && url.protocol !== "http:") {
          problems.push(`${at}: baseUrl must be http(s)`);
        } else if (url.protocol === "http:" && !loopback && config.kind !== "local") {
          // A key or a document must not cross a network in the clear.
          problems.push(`${at}: baseUrl must be https unless it is loopback or a local provider`);
        }
        if (url.username || url.password || url.search || url.hash) {
          problems.push(`${at}: baseUrl must not carry credentials, a query or a fragment`);
        }
      }
    }
  }
  if (config.adapter === "anthropic" && !apiKey) {
    problems.push(`${at}: needs an API key (${apiKeyVariable(config.id)})`);
  }
  if (config.adapter === "anthropic" && config.embedModel !== undefined) {
    problems.push(`${at}: Anthropic's API has no embeddings`);
  }
  if (config.adapter === "anthropic" && config.kind === "local") {
    problems.push(`${at}: Anthropic's API is not a local provider`);
  }
  const range = (name: keyof ProviderConfig, min: number, max: number) => {
    const v = config[name];
    if (
      v !== undefined &&
      !(Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max)
    ) {
      problems.push(`${at}: ${name} must be a whole number from ${min} to ${max}`);
    }
  };
  range("timeoutMs", 1_000, 600_000);
  range("maxRetries", 0, 10);
  range("maxRetryAfterMs", 0, 600_000);
  range("maxInputChars", 1_000, 2_000_000);
  range("maxOutputTokens", 64, 32_000);
  range("maxResponseBytes", 4_096, 64 * 1024 * 1024);
  range("concurrency", 1, 64);
  return problems;
}

/** The environment variable a provider's API key comes from. */
export function apiKeyVariable(id: string): string {
  return `OPENHOARD_MODEL_${id.toUpperCase().replaceAll("-", "_")}_API_KEY`;
}

/** A simple counting semaphore: at most `n` calls in flight. */
function limiter(n: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> => {
    if (active >= n) {
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal.removeEventListener("abort", stop);
          resolve();
        };
        const stop = () => {
          const i = waiting.indexOf(go);
          if (i >= 0) waiting.splice(i, 1);
          reject(signal.reason as Error);
        };
        if (signal.aborted) return stop();
        waiting.push(go);
        signal.addEventListener("abort", stop, { once: true });
      });
    } else {
      active++;
    }
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/** Han, kana and Hangul: about a token a character in every tokenizer we know of. */
const DENSE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/**
 * An estimate of tokens for text: a token for each Chinese, Japanese or Korean character, four
 * other characters a token, rounded up. Deliberately high rather than low: it sizes budget
 * reservations, and CJK text at four characters a token would be undercounted about fourfold.
 */
export function estimateTokens(text: string): number {
  const dense = text.length - text.replace(DENSE, "").length;
  return dense + Math.ceil((text.length - dense) / 4);
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;

/** The stub's answer: given the request, the text to return. */
export type StubResponder = (request: { system: string; user: string }) => string;

export interface ClientOptions {
  /** From the environment (apiKeyVariable()), never from a file. */
  apiKey?: string;
  log?: ModelsLogger;
  /** The stub's answer. Default {@link echoResponder}. */
  stub?: StubResponder;
  /** Tests shorten the backoff between retries. */
  backoffBaseMs?: number;
  /** Tests resolve host names their own way (the private-address check). */
  lookup?: Lookup;
}

/**
 * The default stub: an answer shaped like a real one, built from the document's first 60
 * words, with no tags and no display title. It copies text from the document, as an obedient
 * model would, which is what the output filter is tested against in CI.
 */
export const echoResponder: StubResponder = ({ user }) => {
  const lines = user.split("\n");
  const begin = lines.findIndex((l) => l.startsWith("BEGIN-DOCUMENT-"));
  const end = lines.findIndex((l) => l.startsWith("END-DOCUMENT-"));
  const body = begin >= 0 && end > begin ? lines.slice(begin + 2, end).join(" ") : user;
  const words = body.split(/\s+/).filter(Boolean).slice(0, 60).join(" ");
  return JSON.stringify({ summary: words, tags: [], displayTitle: null });
};

/**
 * A provider client for `config`. Throws TypeError when the settings are wrong (see
 * checkProviderConfig()), naming the setting, never a key's value.
 */
export function createModelClient(
  config: ProviderConfig,
  options: ClientOptions = {},
): ModelClient {
  const problems = checkProviderConfig(config, options.apiKey);
  if (problems.length > 0) throw new TypeError(problems.join("; "));
  const settings = {
    timeoutMs: config.timeoutMs ?? DEFAULTS.timeoutMs,
    maxRetries: config.maxRetries ?? DEFAULTS.maxRetries,
    maxRetryAfterMs: config.maxRetryAfterMs ?? DEFAULTS.maxRetryAfterMs,
    maxResponseBytes: config.maxResponseBytes ?? DEFAULTS.maxResponseBytes,
  };
  const maxInputChars = config.maxInputChars ?? DEFAULTS.maxInputChars;
  const maxOutputTokens = config.maxOutputTokens ?? DEFAULTS.maxOutputTokens;
  const limit = limiter(config.concurrency ?? DEFAULTS.concurrency);
  let base = config.baseUrl ?? "";
  while (base.endsWith("/")) base = base.slice(0, -1);
  const key = options.apiKey;
  const post = (
    path: string,
    headers: Record<string, string>,
    body: unknown,
    r: ChatRequest | EmbedRequest,
  ) =>
    postJson({
      providerId: config.id,
      url: `${base}${path}`,
      headers,
      body,
      signal: r.signal,
      guard: r.guard,
      ...settings,
      ...(options.log ? { log: options.log } : {}),
      ...(options.backoffBaseMs === undefined ? {} : { backoffBaseMs: options.backoffBaseMs }),
      ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
      ...("onAttempt" in r && r.onAttempt !== undefined ? { onAttempt: r.onAttempt } : {}),
    });
  const bad = () => new ModelError("bad-response", config.id);
  const cap = (r: ChatRequest) => Math.min(r.maxOutputTokens ?? maxOutputTokens, maxOutputTokens);
  const estimate = (r: ChatRequest, text: string): TokenUsage => ({
    inputTokens: estimateTokens(r.system) + estimateTokens(r.user),
    outputTokens: estimateTokens(text),
  });

  const adapters: Record<Adapter, (r: ChatRequest) => Promise<ChatResult>> = {
    async stub(r) {
      if (!(await r.guard())) throw new ModelError("withheld", config.id);
      r.signal.throwIfAborted();
      r.onAttempt?.();
      const text = (options.stub ?? echoResponder)({ system: r.system, user: r.user });
      return { text, usage: estimate(r, text), truncated: false };
    },
    async anthropic(r) {
      const answer = await post(
        "/v1/messages",
        { "x-api-key": key ?? "", "anthropic-version": "2023-06-01" },
        {
          model: config.chatModel,
          max_tokens: cap(r),
          system: r.system,
          messages: [{ role: "user", content: r.user }],
          temperature: 0,
        },
        r,
      );
      const a = answer as {
        content?: unknown;
        stop_reason?: unknown;
        usage?: { input_tokens?: unknown; output_tokens?: unknown };
      };
      if (!Array.isArray(a.content)) throw bad();
      const text = a.content
        .filter((b): b is { type: "text"; text: string } => {
          const block = b as { type?: unknown; text?: unknown } | null;
          return block?.type === "text" && typeof block.text === "string";
        })
        .map((b) => b.text)
        .join("");
      if (text === "") throw bad();
      const input = num(a.usage?.input_tokens);
      const output = num(a.usage?.output_tokens);
      return {
        text,
        usage:
          input === null || output === null
            ? estimate(r, text)
            : { inputTokens: input, outputTokens: output },
        truncated: a.stop_reason === "max_tokens",
      };
    },
    async openai(r) {
      const headers: Record<string, string> = {};
      if (key) {
        if (config.auth === "api-key") headers["api-key"] = key;
        else headers.authorization = `Bearer ${key}`;
      }
      const answer = await post(
        "/chat/completions",
        headers,
        {
          model: config.chatModel,
          messages: [
            { role: "system", content: r.system },
            { role: "user", content: r.user },
          ],
          [config.maxTokensField ?? "max_tokens"]: cap(r),
          temperature: 0,
          ...(r.json && config.jsonMode !== false
            ? { response_format: { type: "json_object" } }
            : {}),
        },
        r,
      );
      const a = answer as {
        choices?: unknown;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      };
      const choice = Array.isArray(a.choices)
        ? (a.choices[0] as { message?: { content?: unknown }; finish_reason?: unknown } | undefined)
        : undefined;
      const text = choice?.message?.content;
      if (typeof text !== "string" || text === "") throw bad();
      const input = num(a.usage?.prompt_tokens);
      const output = num(a.usage?.completion_tokens);
      return {
        text,
        usage:
          input === null || output === null
            ? estimate(r, text)
            : { inputTokens: input, outputTokens: output },
        truncated: choice?.finish_reason === "length",
      };
    },
    async ollama(r) {
      const answer = await post(
        "/api/chat",
        {},
        {
          model: config.chatModel,
          messages: [
            { role: "system", content: r.system },
            { role: "user", content: r.user },
          ],
          stream: false,
          ...(r.json ? { format: "json" } : {}),
          options: { temperature: 0, num_predict: cap(r) },
        },
        r,
      );
      const a = answer as {
        message?: { content?: unknown };
        done_reason?: unknown;
        prompt_eval_count?: unknown;
        eval_count?: unknown;
      };
      const text = a.message?.content;
      if (typeof text !== "string" || text === "") throw bad();
      const input = num(a.prompt_eval_count);
      const output = num(a.eval_count);
      return {
        text,
        usage:
          input === null || output === null
            ? estimate(r, text)
            : { inputTokens: input, outputTokens: output },
        truncated: a.done_reason === "length",
      };
    },
  };

  const embedders: Partial<
    Record<Adapter, (r: EmbedRequest, model: string) => Promise<EmbedResult>>
  > = {
    async stub(r) {
      if (!(await r.guard())) throw new ModelError("withheld", config.id);
      // Deterministic 8-dimensional vectors from character codes: enough for plumbing tests.
      const vectors = r.texts.map((t) => {
        const v = new Array<number>(8).fill(0);
        for (let i = 0; i < t.length; i++) v[i % 8] = (v[i % 8] ?? 0) + (t.charCodeAt(i) % 17);
        const norm = Math.hypot(...v) || 1;
        return v.map((x) => x / norm);
      });
      const tokens = r.texts.reduce((n, t) => n + estimateTokens(t), 0);
      return { vectors, usage: { inputTokens: tokens, outputTokens: 0 } };
    },
    async openai(r, model) {
      const headers: Record<string, string> = {};
      if (key) {
        if (config.auth === "api-key") headers["api-key"] = key;
        else headers.authorization = `Bearer ${key}`;
      }
      const answer = (await post("/embeddings", headers, { model, input: r.texts }, r)) as {
        data?: unknown;
        usage?: { prompt_tokens?: unknown };
      };
      if (!Array.isArray(answer.data) || answer.data.length !== r.texts.length) throw bad();
      const vectors: number[][] = new Array<number[]>(r.texts.length);
      for (const item of answer.data) {
        const { index, embedding } = item as { index?: unknown; embedding?: unknown };
        if (
          typeof index !== "number" ||
          !Number.isInteger(index) ||
          index < 0 ||
          index >= r.texts.length ||
          !isVector(embedding)
        ) {
          throw bad();
        }
        vectors[index] = embedding;
      }
      // A duplicate index leaves a hole (which some() would skip).
      for (let i = 0; i < vectors.length; i++) if (vectors[i] === undefined) throw bad();
      const tokens = num(answer.usage?.prompt_tokens);
      return {
        vectors,
        usage: {
          inputTokens: tokens ?? r.texts.reduce((n, t) => n + estimateTokens(t), 0),
          outputTokens: 0,
        },
      };
    },
    async ollama(r, model) {
      const answer = (await post("/api/embed", {}, { model, input: r.texts }, r)) as {
        embeddings?: unknown;
        prompt_eval_count?: unknown;
      };
      const vectors = answer.embeddings;
      if (!Array.isArray(vectors) || vectors.length !== r.texts.length) throw bad();
      if (!vectors.every(isVector)) throw bad();
      const tokens = num(answer.prompt_eval_count);
      return {
        vectors: vectors as number[][],
        usage: {
          inputTokens: tokens ?? r.texts.reduce((n, t) => n + estimateTokens(t), 0),
          outputTokens: 0,
        },
      };
    },
  };

  const chat = adapters[config.adapter];
  const embedModel = config.embedModel;
  const embedder = embedModel === undefined ? undefined : embedders[config.adapter];
  const kind: ProviderKind = config.kind;
  return {
    id: config.id,
    kind,
    adapter: config.adapter,
    chatModel: config.chatModel,
    maxInputChars,
    maxOutputTokens,
    chat: (r) => limit(r.signal, () => chat(r)),
    ...(embedder === undefined || embedModel === undefined
      ? {}
      : { embed: (r: EmbedRequest) => limit(r.signal, () => embedder(r, embedModel)) }),
  };
}

function isVector(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.length <= 16_384 &&
    v.every((x) => typeof x === "number" && Number.isFinite(x))
  );
}

/**
 * Whether a client may have content at this exposure (core/policy mayProcess()), for callers
 * without a pipeline context. Enrichment asks through its context instead, which re-reads the
 * file's exposure each time.
 */
export function clientMayProcess(
  client: Pick<ModelClient, "kind">,
  exposure: Parameters<typeof mayProcess>[0],
): boolean {
  return mayProcess(exposure, client.kind);
}
