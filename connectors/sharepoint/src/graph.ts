import { ConnectorError, isAbortError } from "@openhoard/sdk";
import type { GraphAuth } from "./auth.js";
import { retryAfterMs, textOf } from "./http.js";
import { costOf, DEFAULT_THROTTLE_MS, pacer, PaceWait, type Pacer } from "./pace.js";

/*
 * Requests to Microsoft Graph as the app (T-303): the token put on, an answer read up to a
 * limit, and what went wrong said in the connector contract's terms, so the sync runner knows
 * what to do next without reading messages.
 *
 * | Graph answers                    | means                                  | code        |
 * | -------------------------------- | -------------------------------------- | ----------- |
 * | 401, again with a new token      | the app's token is refused             | auth        |
 * | 403                              | the app isn't granted this site        | auth        |
 * | 404                              | the item (or drive, or site) is gone   | not-found   |
 * | 410                              | a delta link can't be used any more    | resync      |
 * | 429, or 503/504 with Retry-After | slow down, for that long (else 30 s)   | throttled   |
 * | other 5xx, no answer             | a failure of the moment                | retryable   |
 * | an answer cut short, or not JSON | the same, not asked again here         | retryable   |
 *
 * (Throttles and failures of the moment are first waited out and asked again: see below.)
 * | a redirect, any other 4xx        | this request will never succeed        | permanent   |
 *
 * A request goes to Graph's origin and nowhere else: a link Graph handed back (a next page, a
 * delta link) is followed only when it is on that origin, and no redirect is followed with the
 * token on.
 *
 * Requests are paced (pace.ts, T-306): each waits its turn in the app's budget. A throttled
 * answer is waited out here and the request asked again, as long as the waiting for this one
 * request stays within `maxWaitMs`: past that it is thrown as `throttled`, for the runner to
 * come back later. A failure of the moment (no answer, a 5xx) is asked again twice, a little
 * later each time, before it is thrown as `retryable`.
 */

export interface GraphClientOptions {
  auth: GraphAuth;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Milliseconds. Default `Date.now`. */
  now?: () => number;
  /** The longest JSON answer read, in bytes. Default 16 MiB (a page of 999 items is far less). */
  maxJsonBytes?: number;
  /** What paces the requests. Default: a pacer of its own, with the default budget. */
  pacer?: Pacer;
  /**
   * How long one request may wait in place, in all (for its turn in the budget, for its own
   * throttles and behind others'), before it is given up as `throttled`, in ms. Default 60 s.
   * (Waits of up to a second for the budget are always taken.)
   */
  maxWaitMs?: number;
}

export interface GraphClient {
  /** Graph's origin, without a slash at the end. */
  readonly origin: string;
  /** What paces its requests: told of throttles met elsewhere (a download), asked its rate. */
  readonly pacer: Pacer;
  /**
   * GET a path (`/v1.0/…`) or a link Graph gave, with the app's token. Returns the response
   * for a 2xx, and for a status listed in `pass` (a 302 to follow without the token, a 404 the
   * caller reads as an answer); anything else throws as the table above says.
   */
  get(
    target: string,
    signal: AbortSignal,
    options?: { pass?: readonly number[]; headers?: Record<string, string> },
  ): Promise<Response>;
  /** GET, and the answer as a JSON object. An answer that isn't one is `retryable`. */
  json(
    target: string,
    signal: AbortSignal,
    options?: { headers?: Record<string, string> },
  ): Promise<Record<string, unknown>>;
  /** Whether a link is on Graph's origin: only such a link is ever followed. */
  owns(link: string): boolean;
}

/** Times a request is asked again after a failure of the moment, and the first wait. */
const RETRIES = 2;
const RETRY_MS = 1000;
/** Times one request is asked again after a throttle, however short the waits. */
const MAX_THROTTLES = 8;

/** A failure Graph answered with, with the status it gave: some callers read it. */
export class GraphError extends ConnectorError {
  readonly status: number;
  constructor(
    code: ConstructorParameters<typeof ConnectorError>[0],
    status: number,
    message: string,
    options: { retryAfterMs?: number } = {},
  ) {
    super(code, message, options);
    this.status = status;
  }
}

/** Whether `e` is Graph refusing this one thing (403), as opposed to the app's token (401). */
export const isForbidden = (e: unknown): boolean => e instanceof GraphError && e.status === 403;

export function graphClient(options: GraphClientOptions): GraphClient {
  const { auth } = options;
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const maxJsonBytes = options.maxJsonBytes ?? 16 * 1024 * 1024;
  const origin = auth.graph;
  const pace = options.pacer ?? pacer({ now });
  const maxWaitMs = options.maxWaitMs ?? 60_000;
  if (!(maxWaitMs >= 0)) throw new RangeError("maxWaitMs must be 0 or more");

  /** Graph's warning that most of the limit is used, when its answer carries one. */
  function remainingOf(headers: Headers): { share: number; resetMs: number } | undefined {
    const limit = Number(headers.get("ratelimit-limit"));
    const remaining = Number(headers.get("ratelimit-remaining"));
    const reset = Number(headers.get("ratelimit-reset"));
    if (!(limit > 0) || !(remaining >= 0) || headers.get("ratelimit-remaining") === null) {
      return undefined;
    }
    return {
      share: remaining / limit,
      resetMs: Number.isFinite(reset) && reset > 0 ? Math.min(reset, 300) * 1000 : 60_000,
    };
  }

  function owns(link: string): boolean {
    try {
      const url = new URL(link);
      return url.origin === origin && url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }

  function urlOf(target: string): string {
    if (target.startsWith("/") && !target.startsWith("//")) return `${origin}${target}`;
    if (owns(target)) return target;
    // Never the link itself in the message: it may hold a token of Graph's.
    throw new ConnectorError("permanent", "Graph gave a link that isn't Graph's: not followed");
  }

  async function once(
    url: string,
    token: string,
    signal: AbortSignal,
    extra: Record<string, string> = {},
  ) {
    // Built as Headers, so a caller's "Authorization" in any spelling is replaced, not added to.
    const headers = new Headers({ accept: "application/json", ...extra });
    headers.set("authorization", `Bearer ${token}`);
    try {
      return await send(url, {
        headers,
        // The request holds a token: it goes to Graph or nowhere.
        redirect: "manual",
        signal,
      });
    } catch (e) {
      if (isAbortError(e, signal)) throw e;
      throw new ConnectorError("retryable", "Graph couldn't be reached", { cause: e });
    }
  }

  /** One request with the app's token, asked once more with a new one when Graph refuses it. */
  async function authorized(
    url: string,
    signal: AbortSignal,
    headers: Record<string, string> | undefined,
  ): Promise<Response> {
    let token = await auth.appToken(signal);
    let response = await once(url, token, signal, headers);
    if (response.status === 401) {
      // Refused though Entra issued it (revoked meanwhile, or lapsed on the way): once more.
      await response.body?.cancel().catch(() => undefined);
      auth.forget(token);
      token = await auth.appToken(signal);
      response = await once(url, token, signal, headers);
      if (response.status === 401) auth.forget(token);
    }
    return response;
  }

  async function get(
    target: string,
    signal: AbortSignal,
    { pass = [], headers }: { pass?: readonly number[]; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    signal.throwIfAborted();
    const url = urlOf(target);
    const cost = costOf(url);
    /** How long this request has waited for throttles, and how often it was asked again. */
    let waited = 0;
    let throttles = 0;
    let failures = 0;
    for (;;) {
      // Waiting for a turn counts too: behind another source's throttle, or a budget run low.
      // More than this request may wait, in all, is the runner's to come back after.
      const before = now();
      try {
        await pace.turn(cost, signal, Math.max(0, maxWaitMs - waited));
      } catch (e) {
        if (!(e instanceof PaceWait)) throw e;
        throw new ConnectorError("throttled", "Graph's budget for this app is spent for now", {
          retryAfterMs: e.waitMs,
          cause: e,
        });
      }
      waited += Math.max(0, now() - before);
      let response: Response;
      try {
        response = await authorized(url, signal, headers);
      } catch (e) {
        // No answer: a failure of the moment, asked again a little later.
        if (!(e instanceof ConnectorError && e.code === "retryable") || failures >= RETRIES)
          throw e;
        await pace.sleep(RETRY_MS * 2 ** failures++, signal);
        continue;
      }
      const { status } = response;
      if ((status >= 200 && status < 300) || pass.includes(status)) {
        pace.answered(remainingOf(response.headers));
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
      const wait = retryAfterMs(response.headers.get("retry-after"), now());
      if (status === 429 || ((status === 503 || status === 504) && wait !== undefined)) {
        const asked = wait ?? DEFAULT_THROTTLE_MS;
        // Everyone signed in as this app waits, whoever goes on asking.
        pace.throttled(asked);
        if (waited + asked > maxWaitMs || throttles >= MAX_THROTTLES) {
          throw new GraphError("throttled", status, `Graph asked to slow down (${status})`, {
            retryAfterMs: asked,
          });
        }
        throttles++;
        continue; // its next turn comes when the wait is over, and is counted there
      }
      if (status >= 500 && failures < RETRIES) {
        await pace.sleep(RETRY_MS * 2 ** failures++, signal);
        continue;
      }
      pace.answered();
      if (status === 401) throw new GraphError("auth", status, "Graph refused the app's token");
      if (status === 403) {
        throw new GraphError(
          "auth",
          status,
          "Graph refused: the app isn't granted this site, or lacks the permission",
        );
      }
      if (status === 404) throw new GraphError("not-found", status, "Graph has no such item");
      if (status === 410) {
        throw new GraphError("resync", status, "Graph can't continue from this link: crawl again");
      }
      if (status >= 500) throw new GraphError("retryable", status, `Graph is busy (${status})`);
      if (status >= 300 && status < 400) {
        throw new GraphError(
          "permanent",
          status,
          `Graph's address answered with a redirect (${status}): it isn't Graph`,
        );
      }
      throw new GraphError("permanent", status, `Graph refused the request (${status})`);
    }
  }

  async function json(
    target: string,
    signal: AbortSignal,
    { headers }: { headers?: Record<string, string> } = {},
  ): Promise<Record<string, unknown>> {
    const response = await get(target, signal, headers === undefined ? {} : { headers });
    let text: string | undefined;
    try {
      text = await textOf(response, maxJsonBytes);
    } catch (e) {
      if (isAbortError(e, signal)) throw e;
      throw new ConnectorError("retryable", "Graph's answer was cut short", { cause: e });
    }
    try {
      const parsed: unknown = text === undefined ? undefined : JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // not JSON: said below
    }
    // "OK" from something that isn't Graph (a proxy's page), or far too long.
    throw new ConnectorError("retryable", "Graph's answer wasn't what was asked for");
  }

  return { origin, pacer: pace, get, json, owns };
}
