import type { ProviderKind } from "@openhoard/core-policy";

/*
 * Model providers (T-404). A provider is a configured endpoint (an Ollama server, an
 * OpenAI-compatible API, Anthropic's API, or the stub) plus its kind, which says where it runs
 * and so which files' content it may have (core/policy mayProcess()): `local` on the tenant's
 * own machines, `commercial` under a business agreement, `consumer` on consumer terms.
 */

/** Which API a provider speaks. */
export const ADAPTERS = ["stub", "openai", "anthropic", "ollama"] as const;
export type Adapter = (typeof ADAPTERS)[number];

/** A provider's settings, as the server's configuration gives them (secrets aside). */
export interface ProviderConfig {
  /** A short, stable slug: logs, the card's provenance, OPENHOARD_MODEL_<ID>_API_KEY. */
  id: string;
  kind: ProviderKind;
  adapter: Adapter;
  /**
   * The API's base URL: Ollama `http://localhost:11434`; OpenAI `https://api.openai.com/v1`
   * (LM Studio `http://localhost:1234/v1`, vLLM `http://host:8000/v1`, Azure OpenAI
   * `https://<resource>.openai.azure.com/openai/v1`); Anthropic `https://api.anthropic.com`.
   * Unused by the stub.
   */
  baseUrl?: string;
  /** The model for chat (summaries and tags). */
  chatModel: string;
  /** The model for embeddings, where the API has them (not Anthropic's). */
  embedModel?: string;
  /** Per HTTP request, in milliseconds. Default 60,000. */
  timeoutMs?: number;
  /** Retries of one call after a 429, a 5xx or a timeout. Default 2. */
  maxRetries?: number;
  /** The longest Retry-After waited out inside a call, in ms; longer fails it. Default 60,000. */
  maxRetryAfterMs?: number;
  /** Document characters sent at most; longer input is cut. Default 24,000. */
  maxInputChars?: number;
  /** The answer's token cap. Default 800. */
  maxOutputTokens?: number;
  /** The largest response body read, in bytes. Default 1 MiB. */
  maxResponseBytes?: number;
  /** Calls in flight at once from this process. Default 2. */
  concurrency?: number;
  /** OpenAI-compatible only: how the key is sent. `api-key` for Azure OpenAI. Default bearer. */
  auth?: "bearer" | "api-key";
  /** OpenAI-compatible only: the name of the answer cap. Default `max_tokens`. */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** OpenAI-compatible only: ask for a JSON object (`response_format`). Default true. */
  jsonMode?: boolean;
}

/** One chat call: an instruction (`system`) and one user message. */
export interface ChatRequest {
  system: string;
  user: string;
  /** Ask the API for JSON where it can (OpenAI json_object, Ollama `format: "json"`). */
  json?: boolean;
  /** Overrides the provider's `maxOutputTokens` downwards. */
  maxOutputTokens?: number;
  /** Stops the call (the job's lease ended, or the step's time budget). */
  signal: AbortSignal;
  /**
   * Asked right before every HTTP attempt, retries included: may this content go to this
   * provider now? The caller re-reads the file's exposure (core/jobs `context.mayProcess`). A
   * false answer ends the call with ModelError `withheld`, before anything is sent. Required:
   * no call can skip the check.
   */
  guard: () => Promise<boolean>;
  /** Called each time a request actually goes out (retries count), for the budget's `calls`. */
  onAttempt?: () => void;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  text: string;
  /** What the provider reported, or an estimate (characters / 4) when it reported nothing. */
  usage: TokenUsage;
  /** The answer hit the token cap. */
  truncated: boolean;
}

export interface EmbedRequest {
  texts: readonly string[];
  signal: AbortSignal;
  guard: () => Promise<boolean>;
}

export interface EmbedResult {
  vectors: number[][];
  usage: TokenUsage;
}

/** A provider ready to call. */
export interface ModelClient {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly adapter: Adapter;
  readonly chatModel: string;
  /** The most document characters to send. */
  readonly maxInputChars: number;
  readonly maxOutputTokens: number;
  chat(request: ChatRequest): Promise<ChatResult>;
  /** Present when the provider has embeddings configured. */
  embed?(request: EmbedRequest): Promise<EmbedResult>;
}

/** A pino-shaped logger; every method optional. Only ids, codes and numbers go to it. */
export interface ModelsLogger {
  debug?(fields: object, message: string): void;
  info?(fields: object, message: string): void;
  warn?(fields: object, message: string): void;
}
