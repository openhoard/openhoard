/*
 * Database errors, the same on both drivers. Drizzle wraps a driver's error and keeps the
 * original, with its SQLSTATE, in `cause`; PGlite and node-postgres both put the SQLSTATE in
 * `code`.
 */

/** The SQLSTATE of a database error, however the driver wraps it; undefined for anything else. */
export function sqlState(e: unknown): string | undefined {
  if (e === null || typeof e !== "object") return undefined;
  const err = e as { code?: unknown; cause?: { code?: unknown } | null };
  const code = err.cause?.code ?? err.code;
  return typeof code === "string" ? code : undefined;
}

/** SQLSTATEs after which running the whole transaction again can succeed. */
export const RETRYABLE_SQLSTATES: readonly string[] = [
  "40001", // serialization_failure
  "40P01", // deadlock_detected
];

/**
 * Whether `e` is a serialization failure or a deadlock: the transaction was rolled back and
 * running it again from the start (a new withTenant()) can succeed.
 */
export function isRetryable(e: unknown): boolean {
  const code = sqlState(e);
  return code !== undefined && RETRYABLE_SQLSTATES.includes(code);
}
