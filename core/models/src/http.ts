import { ModelError } from "./errors.js";
import type { ModelsLogger } from "./types.js";

/*
 * One JSON POST to a provider, with everything a call must have (T-404):
 *
 * - the guard, asked right before every attempt: content goes out only if the file's exposure
 *   allows this provider at that moment, not only when the job was planned;
 * - a timeout per attempt, and the caller's signal (the job's lease, the step's budget);
 * - retries with exponential backoff and jitter on 429, 5xx (and Anthropic's 529), timeouts and
 *   connection failures; a Retry-After (seconds or an HTTP date) is honoured when it is short
 *   enough, and ends the call as `rate-limited` when it isn't, so the job's own retry waits;
 * - a cap on the response body, read as a stream and cut off past it;
 * - errors and log lines that carry the provider's id, the status and the attempt, never the
 *   request, the response or the headers (the key is in them).
 */

export interface PostOptions {
  providerId: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
  guard: () => Promise<boolean>;
  timeoutMs: number;
  maxRetries: number;
  maxRetryAfterMs: number;
  maxResponseBytes: number;
  log?: ModelsLogger;
  /** Tests shorten the backoff. Default 1,000 ms, doubled per retry, capped at 30 s. */
  backoffBaseMs?: number;
}

/** HTTP statuses tried again. 529 is Anthropic's "overloaded". */
const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

/** Waits `ms`, or rejects with the signal's reason when it aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason as Error);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * A Retry-After header in milliseconds: delay-seconds or an HTTP date. Null when absent or
 * unreadable. Bounded: a huge number of seconds reads as "a long time", not an overflow.
 */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (/^\d{1,10}$/.test(v)) return Number(v) * 1000;
  if (v.length > 64) return null;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** Reads a response body up to `max` bytes; past it, cancels the stream and throws too-large. */
async function readCapped(response: Response, max: number, providerId: string): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => {});
    throw new ModelError("too-large", providerId, { status: response.status });
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new ModelError("too-large", providerId, { status: response.status });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * POSTs `body` as JSON and returns the parsed JSON answer. Throws ModelError, or the caller's
 * signal's reason when it aborts.
 */
export async function postJson(options: PostOptions): Promise<unknown> {
  const { providerId, signal, log } = options;
  const base = options.backoffBaseMs ?? 1_000;
  const payload = JSON.stringify(options.body);
  let last: ModelError | undefined;
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    signal.throwIfAborted();
    if (attempt > 0) {
      // Retry-After when the provider said, else exponential backoff with full jitter.
      const backoff = Math.min(30_000, base * 2 ** (attempt - 1));
      const wait = last?.retryAfterMs ?? Math.round(backoff / 2 + (Math.random() * backoff) / 2);
      log?.debug?.(
        { provider: providerId, attempt, waitMs: wait, code: last?.code },
        "model retry",
      );
      await sleep(wait, signal);
    }
    // Right before sending: the file's exposure may have tightened since the job planned this.
    if (!(await options.guard())) throw new ModelError("withheld", providerId);
    signal.throwIfAborted();
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const both = AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await fetch(options.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...options.headers },
        body: payload,
        signal: both,
        redirect: "error",
      });
    } catch {
      signal.throwIfAborted();
      last = new ModelError(timeout.aborted ? "timeout" : "network", providerId);
      continue;
    }
    let text: string;
    try {
      text = await readCapped(response, options.maxResponseBytes, providerId);
    } catch (e) {
      signal.throwIfAborted();
      if (e instanceof ModelError) throw e;
      last = new ModelError(timeout.aborted ? "timeout" : "network", providerId, {
        status: response.status,
      });
      continue;
    }
    if (response.ok) {
      try {
        return JSON.parse(text);
      } catch {
        throw new ModelError("bad-response", providerId, { status: response.status });
      }
    }
    const status = response.status;
    if (status === 401 || status === 403) throw new ModelError("auth", providerId, { status });
    if (!RETRY_STATUS.has(status)) throw new ModelError("refused", providerId, { status });
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    const code = status === 429 ? "rate-limited" : status === 408 ? "timeout" : "server";
    if (retryAfter !== null && retryAfter > options.maxRetryAfterMs) {
      // Longer than a call may wait: the job's own retry (with its backoff) comes back later.
      throw new ModelError("rate-limited", providerId, { status, retryAfterMs: retryAfter });
    }
    last = new ModelError(code, providerId, {
      status,
      ...(retryAfter === null ? {} : { retryAfterMs: retryAfter }),
    });
    log?.info?.({ provider: providerId, status, attempt }, "model call failed; may retry");
  }
  throw last ?? new ModelError("network", providerId);
}
