/*
 * How a connector says what went wrong, so the runner knows what to do next without reading
 * messages. Every failure a connector reports is a ConnectorError with one of these codes; the
 * runner treats anything else as `retryable` (a bug, or a failure the connector didn't classify)
 * and gives up after a few attempts, so an unknown failure never loops forever and never passes
 * silently.
 *
 * | code        | means                                              | the runner                     |
 * | ----------- | -------------------------------------------------- | ------------------------------ |
 * | retryable   | a failure of the moment: network, 5xx, a busy file | tries again, then later        |
 * | throttled   | the source asks to slow down (`retryAfterMs`)      | waits that long, then again    |
 * | auth        | credentials refused, expired or lacking consent    | stops the sync; an admin fixes |
 * | permanent   | this request will never succeed as it is           | skips the item, or stops       |
 * | not-found   | the item is gone                                   | skips it; delta reports it     |
 * | changed     | the item is not the version asked for any more     | skips it; delta reports it     |
 * | resync      | a checkpoint or cursor can't be used any more      | crawls everything again        |
 *
 * Cancellation is not an error of the source: a connector whose signal aborted rejects with the
 * signal's reason (an AbortError by default), which {@link isAbortError} recognizes.
 *
 * Messages are for logs. Say what failed, not secrets or tokens: a message can reach an admin's
 * screen.
 */

export const CONNECTOR_ERROR_CODES = [
  "retryable",
  "throttled",
  "auth",
  "permanent",
  "not-found",
  "changed",
  "resync",
] as const;
export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number];

/** The longest wait a `throttled` error may ask for: an hour. Longer asks are capped. */
export const MAX_RETRY_AFTER_MS = 3_600_000;

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  /** `throttled`: how long the source asked to wait, in milliseconds (0 to an hour). */
  readonly retryAfterMs: number | undefined;

  constructor(
    code: ConnectorErrorCode,
    message: string,
    options: { retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ConnectorError";
    this.code = CONNECTOR_ERROR_CODES.includes(code) ? code : "retryable";
    const wait = options.retryAfterMs;
    this.retryAfterMs =
      this.code === "throttled"
        ? typeof wait === "number" && Number.isFinite(wait) && wait > 0
          ? Math.min(Math.ceil(wait), MAX_RETRY_AFTER_MS)
          : 0
        : undefined;
  }

  /** Whether trying the same thing again later can succeed. */
  get retryable(): boolean {
    return this.code === "retryable" || this.code === "throttled";
  }
}

/** A failure of the moment: try again. */
export const retryableError = (message: string, cause?: unknown) =>
  new ConnectorError("retryable", message, { cause });
/** The source asked to slow down for `retryAfterMs`. */
export const throttledError = (retryAfterMs: number, message = "throttled by the source") =>
  new ConnectorError("throttled", message, { retryAfterMs });
export const authError = (message: string, cause?: unknown) =>
  new ConnectorError("auth", message, { cause });
export const permanentError = (message: string, cause?: unknown) =>
  new ConnectorError("permanent", message, { cause });
export const notFoundError = (message = "the item is gone", cause?: unknown) =>
  new ConnectorError("not-found", message, { cause });
export const changedError = (message = "the item changed since it was crawled", cause?: unknown) =>
  new ConnectorError("changed", message, { cause });
export const resyncError = (message = "the token can't be used any more; crawl again") =>
  new ConnectorError("resync", message);

/**
 * Whether `e` is a ConnectorError, also one from another copy of this package (a plugin bundles
 * its own): by shape, not by class.
 */
export function isConnectorError(e: unknown): e is ConnectorError {
  if (e instanceof ConnectorError) return true;
  if (typeof e !== "object" || e === null) return false;
  const { name, code } = e as { name?: unknown; code?: unknown };
  return (
    name === "ConnectorError" &&
    typeof code === "string" &&
    (CONNECTOR_ERROR_CODES as readonly string[]).includes(code)
  );
}

/** The code of a connector's failure: its own when it is a ConnectorError, else `retryable`. */
export function errorCode(e: unknown): ConnectorErrorCode {
  return isConnectorError(e) ? e.code : "retryable";
}

/**
 * Whether `e` is a cancellation: the reason of `signal` (when given and aborted), or an error
 * named AbortError (what fetch, streams and Node's APIs throw when their signal aborts).
 */
export function isAbortError(e: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted && e === signal.reason) return true;
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";
}

/**
 * How long to wait before attempt `attempt + 1` (attempt counts from 1): what a `throttled`
 * error asked for, else exponential backoff from `baseMs`, capped at `maxMs`, with jitter so
 * many workers don't retry in step.
 */
export function retryDelayMs(
  e: unknown,
  attempt: number,
  { baseMs = 1_000, maxMs = 60_000, random = Math.random } = {},
): number {
  if (isConnectorError(e) && e.code === "throttled") return e.retryAfterMs ?? 0;
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + (random() * exp) / 2);
}
