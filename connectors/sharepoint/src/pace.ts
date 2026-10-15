/*
 * Pacing requests to Microsoft Graph (T-306).
 *
 * Graph limits an app in a tenant by resource units a minute, not by requests: a permissions
 * list costs five, a list of children two, an item one (Microsoft's "Avoid getting throttled or
 * blocked in SharePoint Online"). Past the limit it answers 429 with how long to wait. So the
 * connector keeps a budget (units a minute, spent before a request is sent, shared by every
 * source signed in as the same app) and, when told to slow down, sends nothing for as long as
 * Graph said. Nothing here knows about tokens or content: it is told a cost, and when to wait.
 */

/**
 * Units a minute an app may spend unless told otherwise: under the smallest tenant's limits as
 * Microsoft documented them when this was written.
 */
export const DEFAULT_UNITS_PER_MINUTE = 800;
/** The longest a throttle stops requests, whatever Graph (or something in between) says. */
export const MAX_PAUSE_MS = 3_600_000;
/** How long a throttle stops requests when Graph doesn't say. */
export const DEFAULT_THROTTLE_MS = 30_000;
/** A wait this short is taken whatever limit a caller set: it is pacing, not being throttled. */
const SHORT_WAIT_MS = 1000;
/** The burst: how much of a minute's budget may be spent at once. */
const BURST_SECONDS = 10;

export interface PacerOptions {
  /** Resource units a minute. Default {@link DEFAULT_UNITS_PER_MINUTE}. */
  unitsPerMinute?: number;
  /** Milliseconds. Default `Date.now`. */
  now?: () => number;
  /** How it waits. Default: a timer that the signal ends. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** A turn would take longer than its caller may wait: how long it would take from now. */
export class PaceWait extends Error {
  constructor(readonly waitMs: number) {
    super("the budget of requests is spent for now");
    this.name = "PaceWait";
  }
}

export interface Pacer {
  /**
   * Waits until `cost` units may be spent, and spends them. Rejects when the signal aborts, and
   * with a {@link PaceWait} as soon as the waiting, in all, would pass `limitMs` (default: no
   * limit): its own turn, or a throttle someone else met meanwhile. Waits of up to a second are
   * taken regardless.
   */
  turn(cost: number, signal: AbortSignal, limitMs?: number): Promise<void>;
  /** Graph answered "slow down": nothing is sent for `waitMs`. */
  throttled(waitMs: number): void;
  /** The units a minute it was given. */
  readonly budget: number;
  /** Waits, as the pacer waits (tests move a clock instead). */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

/** A timer the signal ends, rejecting with its reason. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason as Error);
    const done = () => {
      signal.removeEventListener("abort", stop);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** `work`, or the signal's reason as soon as it aborts. */
function aborting<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason as Error);
    signal.addEventListener("abort", stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

export function pacer(options: PacerOptions = {}): Pacer {
  const budget = options.unitsPerMinute ?? DEFAULT_UNITS_PER_MINUTE;
  if (!(Number.isFinite(budget) && budget >= 1)) {
    throw new RangeError("unitsPerMinute must be 1 or more");
  }
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const perMs = budget / 60_000;
  const capacity = perMs * BURST_SECONDS * 1000;
  /** Nothing is sent before this. */
  let pausedUntil = 0;
  /** Units ready to spend, and when that was counted. */
  let units = capacity;
  let countedAt = now();
  /** One at a time through turn(): callers are served in the order they came. */
  let queue: Promise<void> = Promise.resolve();

  const waitFor = (cost: number): number => {
    const at = now();
    // (A clock set back counts nothing. Nor does the time a throttle said to wait.)
    units = Math.min(capacity, units + Math.max(0, at - Math.max(countedAt, pausedUntil)) * perMs);
    countedAt = at;
    // A cost above the burst is let through when the burst is full: it then goes into debt.
    const need = Math.min(cost, capacity);
    const forUnits = units >= need ? 0 : Math.ceil((need - units) / perMs);
    return Math.max(forUnits, pausedUntil - at, 0);
  };

  return {
    budget,
    sleep,
    turn(cost, signal, limitMs = Infinity) {
      const ahead = queue;
      const mine = (async () => {
        const from = now();
        await aborting(ahead, signal);
        for (;;) {
          signal.throwIfAborted();
          const wait = waitFor(cost);
          if (wait <= 0) break;
          // Asked again each time round: a throttle met by someone else meanwhile counts.
          if (wait > SHORT_WAIT_MS && Math.max(0, now() - from) + wait > limitMs) {
            throw new PaceWait(wait);
          }
          await sleep(wait, signal);
        }
        units -= cost;
      })();
      queue = Promise.allSettled([ahead, mine]).then(() => undefined);
      return mine;
    },
    throttled(waitMs) {
      const wait = Math.min(Math.max(SHORT_WAIT_MS, waitMs), MAX_PAUSE_MS);
      pausedUntil = Math.max(pausedUntil, now() + wait);
      // What was ready goes: Graph said the budget is spent.
      units = Math.min(units, 0);
    },
  };
}

const shared = new Map<string, Pacer>();

/**
 * The pacer of an app in a tenant (`account`), made on first use and shared from then on by
 * every connector in this process that names the same account. The first to ask sets its
 * budget and clock.
 */
export function sharedPacer(account: string, options: PacerOptions = {}): Pacer {
  let found = shared.get(account);
  if (!found) shared.set(account, (found = pacer(options)));
  return found;
}

/**
 * What a GET costs in Graph's resource units, from its path: a permissions list 5, a list of
 * several items 2 (children, a site's drives, a delta from its beginning), anything else 1.
 */
export function costOf(url: string): number {
  let path: string;
  let query: string;
  try {
    const parsed = new URL(url, "https://graph.invalid");
    path = parsed.pathname;
    query = parsed.search;
  } catch {
    return 1;
  }
  if (/\/permissions$/.test(path)) return 5;
  if (/\/delta$/.test(path)) return /[?&]token=/.test(query) ? 1 : 2;
  if (/\/(children|drives)$/.test(path)) return 2;
  return 1;
}
