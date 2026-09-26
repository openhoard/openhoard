/**
 * Why a model call failed. Messages are fixed sentences with the provider's id and an HTTP
 * status at most: never the request, the response body, a URL's query or a key, so the error can
 * go to logs, job output and dead letters as it is.
 */
export const MODEL_ERROR_CODES = [
  /** The file's exposure doesn't let its content go to this provider (checked before sending). */
  "withheld",
  /** The tenant's daily token budget is spent. */
  "budget",
  /** 429 after the retries, or a Retry-After longer than the call may wait. */
  "rate-limited",
  /** 5xx after the retries. */
  "server",
  /** No answer in time, after the retries. */
  "timeout",
  /** The connection failed, after the retries. */
  "network",
  /** 401 or 403: the key is missing, wrong or not allowed. */
  "auth",
  /** Another 4xx: the request was refused (a bad model name, say). Not retried. */
  "refused",
  /** The answer wasn't the API's shape, or had no text. */
  "bad-response",
  /** The answer was larger than `maxResponseBytes`. */
  "too-large",
  /** The provider has no such operation (embeddings on Anthropic's API). */
  "unsupported",
  /** Plain http to an address that isn't loopback or private (checked on the resolved one). */
  "blocked",
] as const;
export type ModelErrorCode = (typeof MODEL_ERROR_CODES)[number];

/** Codes worth trying again later (the enrichment job's retry). */
const TRANSIENT: ReadonlySet<ModelErrorCode> = new Set([
  "rate-limited",
  "server",
  "timeout",
  "network",
]);

export class ModelError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly code: ModelErrorCode,
    readonly providerId: string,
    options: { status?: number; retryAfterMs?: number } = {},
  ) {
    const status = options.status === undefined ? "" : ` (HTTP ${options.status})`;
    super(`model provider ${providerId}: ${code}${status}`);
    this.name = "ModelError";
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = TRANSIENT.has(code);
  }
  readonly status: number | undefined;
  /** For `rate-limited`: how long the provider asked to wait. */
  readonly retryAfterMs: number | undefined;
}
