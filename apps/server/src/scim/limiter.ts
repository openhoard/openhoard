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

/**
 * Token ids that authenticated recently, so an address or tenant block (anyone's guesses,
 * behind a shared proxy address) never turns away the identity provider's real token. A
 * token's own failures still count against it. Bounded: the least recently seen go first.
 */
export class RecentTokens {
  readonly #seen = new Map<string, number>();

  constructor(
    readonly ttlMs: number,
    readonly max = 1000,
    readonly now: () => number = Date.now,
  ) {}

  add(tokenId: string): void {
    this.#seen.delete(tokenId);
    this.#seen.set(tokenId, this.now() + this.ttlMs);
    while (this.#seen.size > this.max) {
      this.#seen.delete(this.#seen.keys().next().value as string);
    }
  }

  has(tokenId: string): boolean {
    const until = this.#seen.get(tokenId);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.#seen.delete(tokenId);
    return false;
  }
}

/**
 * Refusals of token ids a tenant doesn't have (guesses: tenant ids aren't secret), counted per
 * tenant and written as one summary per tenant per window, so guessing can't grow the audit log
 * or queue on its lock. At most `maxTenants` tenants are counted at once; beyond that, only the
 * count of dropped ones is kept (returned by note()).
 */
export class RefusalSummary {
  readonly #counts = new Map<string, number>();

  constructor(
    readonly windowMs: number,
    readonly flush: (tenantId: string, count: number) => Promise<void>,
    readonly maxTenants = 10_000,
  ) {}

  /** Counts one refusal; false when it couldn't be counted (too many tenants at once). */
  note(tenantId: string): boolean {
    const count = this.#counts.get(tenantId);
    if (count !== undefined) {
      this.#counts.set(tenantId, count + 1);
      return true;
    }
    if (this.#counts.size >= this.maxTenants) return false;
    this.#counts.set(tenantId, 1);
    setTimeout(() => {
      const total = this.#counts.get(tenantId) ?? 0;
      this.#counts.delete(tenantId);
      void this.flush(tenantId, total);
    }, this.windowMs).unref();
    return true;
  }

  get pending(): number {
    return this.#counts.size;
  }
}
