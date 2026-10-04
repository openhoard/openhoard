/*
 * Pacing requests to Microsoft Graph (T-306).
 *
 * Graph limits an app in a tenant by resource units a minute, not by requests: a permissions
 * list costs five, a list of children two, an item one (Microsoft's "Avoid getting throttled or
 * blocked in SharePoint Online"). Past the limit it answers 429 with how long to wait, and an
 * app that keeps asking is throttled longer. So the connector:
 *
 * - **keeps a budget**: units a minute, shared by every source that signs in as the same app in
 *   the same tenant (they are throttled together), spent before a request is sent. A request
 *   waits its turn rather than being sent to be refused;
 * - **waits when told**: a throttled answer stops every request of that app for as long as
 *   Graph said (30 s when it didn't say), and the request is then asked again, in place, as
 *   long as the waiting stays within what the caller allows;
 * - **adapts**: each throttle (one a pause, however many requests met it) halves the rate it
 *   allows itself, down to a tenth of the budget, and every stretch without one (fifty
 *   answers, or a minute) gives a tenth back. Graph's own warning that most of the
 *   limit is used (`RateLimit-Remaining`) halves it for as long as the warning says.
 *
 * Nothing here knows about tokens or content: it is told a cost, and when to slow down.
 */

/**
 * Units a minute an app may spend unless told otherwise: under the smallest tenant's limits as
 * Microsoft documented them when this was written, the one a minute and the one a day (which
 * a crawl that runs all day would otherwise pass).
 */
export const DEFAULT_UNITS_PER_MINUTE = 800;
/** The longest a throttle stops requests, whatever Graph (or something in between) says. */
export const MAX_PAUSE_MS = 3_600_000;
/** How long a throttle stops requests when Graph doesn't say. */
export const DEFAULT_THROTTLE_MS = 30_000;
/** The least the pacer slows itself to, as a share of the budget. */
const FLOOR = 0.1;
/** Requests answered without a throttle before a tenth of the budget is given back. */
const RECOVER_AFTER = 50;
/** And time without one that gives a tenth back, asked or not. */
const RECOVER_MS = 60_000;
/** A wait this short is taken whatever limit a caller set: it is pacing, not being throttled. */
const SHORT_WAIT_MS = 1000;
/** The least a throttle pauses for, so several answers of one throttle are one pause. */
const MIN_PAUSE_MS = 1000;
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
   * limit): whatever the reason, its own turn or a throttle someone else met meanwhile. Waits of
   * up to a second are taken regardless.
   */
  turn(cost: number, signal: AbortSignal, limitMs?: number): Promise<void>;
  /** Graph answered "slow down": nothing is sent for `waitMs`, and the rate is halved. */
  throttled(waitMs: number): void;
  /** Graph answered. `remaining` is its warning of how much of the limit is left (0 to 1). */
  answered(remaining?: { share: number; resetMs: number }): void;
  /** How long from now until a request could be sent, in ms (0: now). For callers that decide whether to wait. */
  waitFor(cost: number): number;
  /** The share of the budget it allows itself now (0.1 to 1). */
  readonly rate: number;
  /** The units a minute it was given. */
  readonly budget: number;
  /** The units a minute it allows itself now: the budget, slowed by throttles and warnings. */
  readonly allowance: number;
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
  /** The share of the budget allowed now. */
  let rate = 1;
  /** Until when Graph's warning halves the rate. */
  let warnedUntil = 0;
  /** Nothing is sent before this. */
  let pausedUntil = 0;
  /** Units ready to spend, and when that was counted. */
  let units = (budget / 60) * BURST_SECONDS;
  let countedAt = now();
  let quiet = 0;
  /** When the rate last changed: time without a throttle gives it back too. */
  let ratedAt = now();
  /** One at a time through turn(): callers are served in the order they came. */
  let queue: Promise<void> = Promise.resolve();

  /** Gives back a tenth of the rate for each minute since it last changed, unless paused. */
  const recover = () => {
    const at = now();
    if (rate >= 1 || at < pausedUntil) return;
    const tenths = Math.floor(Math.max(0, at - Math.max(ratedAt, pausedUntil)) / RECOVER_MS);
    if (tenths > 0) {
      rate = Math.min(1, rate + tenths / 10);
      ratedAt = at;
    }
  };
  const perMs = () => ((budget / 60_000) * rate) / (now() < warnedUntil ? 2 : 1);
  const capacity = () => perMs() * BURST_SECONDS * 1000;
  const refill = () => {
    recover();
    const at = now();
    // (A clock set back counts nothing, and is counted from there.)
    // Nor does the time a throttle said to wait: it comes back with nothing saved up.
    const from = Math.max(countedAt, pausedUntil);
    units = Math.min(capacity(), units + Math.max(0, at - from) * perMs());
    countedAt = at;
  };
  const waitFor = (cost: number): number => {
    refill();
    // A cost above the burst is let through when the burst is full: it then goes into debt.
    const need = Math.min(cost, capacity());
    const forUnits = units >= need ? 0 : Math.ceil((need - units) / perMs());
    return Math.max(forUnits, pausedUntil - now(), 0);
  };

  return {
    get rate() {
      recover();
      return rate;
    },
    budget,
    get allowance() {
      recover();
      return perMs() * 60_000;
    },
    sleep,
    waitFor,
    turn(cost, signal, limitMs = Infinity) {
      const ahead = queue;
      const mine = (async () => {
        const from = now();
        // In line behind those who came before; a caller whose signal aborts leaves at once.
        await aborting(ahead, signal);
        for (;;) {
          signal.throwIfAborted();
          const wait = waitFor(cost);
          if (wait <= 0) break;
          // Asked again each time round: a throttle met by someone else meanwhile counts. (A
          // wait of a moment, for the budget to fill, is always taken.)
          if (wait > SHORT_WAIT_MS && Math.max(0, now() - from) + wait > limitMs) {
            throw new PaceWait(wait);
          }
          await sleep(wait, signal);
        }
        units -= cost;
      })();
      // The next in line waits for those ahead of this one too, whether or not it stayed.
      queue = Promise.allSettled([ahead, mine]).then(() => undefined);
      return mine;
    },
    throttled(waitMs) {
      const at = now();
      // Once a pause: the requests that were already on their way meet the same throttle.
      if (at >= pausedUntil) rate = Math.max(FLOOR, rate / 2);
      const wait = Math.min(Math.max(MIN_PAUSE_MS, waitMs), MAX_PAUSE_MS);
      pausedUntil = Math.max(pausedUntil, at + wait);
      ratedAt = pausedUntil;
      quiet = 0;
      // What was ready goes: it was counted at the old rate.
      units = Math.min(units, 0);
    },
    answered(remaining) {
      if (remaining && remaining.share < 0.2) {
        warnedUntil = Math.max(warnedUntil, now() + Math.max(0, remaining.resetMs));
      }
      if (++quiet >= RECOVER_AFTER && rate < 1) {
        refill();
        rate = Math.min(1, rate + 0.1);
        ratedAt = now();
        quiet = 0;
      }
    },
  };
}

const shared = new Map<string, Pacer>();

/**
 * The pacer of an app in a tenant (`account`), made on first use and shared from then on by
 * every connector in this process that names the same account. The first to ask sets its
 * budget and clock. (A process: several nodes each have their own, and together spend that
 * many times the budget.)
 */
export function sharedPacer(account: string, options: PacerOptions = {}): Pacer {
  let found = shared.get(account);
  if (!found) shared.set(account, (found = pacer(options)));
  return found;
}

/**
 * What a GET costs in Graph's resource units, from its path: a permissions list 5, a list of
 * several items 2 (children, a site's drives, a delta from its beginning), anything else 1 (an
 * item, a delta with a token, content).
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
