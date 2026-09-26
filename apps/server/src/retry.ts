import { isRetryable } from "@openhoard/core-db";

/** Tries a transaction this many times in all before its error stands. */
export const TRANSACTION_ATTEMPTS = 3;

/**
 * Runs a whole transaction (a `db.withTenant(…)`) again when it failed as a deadlock or a
 * serialization failure (core/db isRetryable()): the database rolled it back, and running it
 * from the start can succeed. For requests that end people's access (SCIM's disable and delete,
 * an admin's decisions), which take locks in the core's order but may still meet a transaction
 * that doesn't. `work` must start its transaction afresh on each call and have no effect outside
 * it. Waits a little, more each time, between tries.
 */
export async function retrying<T>(
  work: () => Promise<T>,
  attempts = TRANSACTION_ATTEMPTS,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (e) {
      if (attempt >= attempts || !isRetryable(e)) throw e;
      await new Promise((r) => setTimeout(r, 10 * attempt + Math.random() * 20));
    }
  }
}
