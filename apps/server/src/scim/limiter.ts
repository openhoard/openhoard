/*
 * Failed authentications, counted per key (a client address, a token id) in fixed windows, in
 * this process's memory. A key with `max` failures is refused until its window ends, before its
 * token is even looked at, so guessing costs the guesser and not the database or the audit log.
 * Successes aren't counted. Several servers each count their own, which is enough to make
 * guessing a 256-bit secret pointless and keep a misconfigured client from flooding the log.
 */
export class FailureLimiter {
  readonly #counts = new Map<string, { failures: number; resetAt: number }>();

  constructor(
    readonly max: number,
    readonly windowMs: number,
    readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(max) || max < 1) throw new RangeError("max must be at least 1");
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
      throw new RangeError("windowMs must be at least 1");
    }
  }

  /** Milliseconds until `key` may try again, or 0 if it may now. */
  blockedFor(key: string): number {
    const entry = this.#counts.get(key);
    if (!entry) return 0;
    const left = entry.resetAt - this.now();
    if (left <= 0) {
      this.#counts.delete(key);
      return 0;
    }
    return entry.failures >= this.max ? left : 0;
  }

  /** Counts a failure for each key. */
  fail(...keys: string[]): void {
    const now = this.now();
    if (this.#counts.size > 100_000) this.#prune(now);
    for (const key of keys) {
      const entry = this.#counts.get(key);
      if (!entry || entry.resetAt <= now) {
        this.#counts.set(key, { failures: 1, resetAt: now + this.windowMs });
      } else {
        entry.failures++;
      }
    }
  }

  get size(): number {
    return this.#counts.size;
  }

  #prune(now: number): void {
    for (const [key, entry] of this.#counts) if (entry.resetAt <= now) this.#counts.delete(key);
    // Still full of live keys (many addresses failing at once): start over rather than grow.
    if (this.#counts.size > 100_000) this.#counts.clear();
  }
}
