import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
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
 * - no redirects: a 3xx fails the call at once as `refused` (a key must not follow one to
 *   another host, and a redirect is not something to retry);
 * - over plain http, only private addresses: loopback, RFC 1918, carrier-grade NAT (Tailscale),
 *   link-local, and IPv6 unique local or link-local; never a cloud metadata service. The check runs on the addresses DNS returned, inside the connection's
 *   own lookup, so the socket connects to an address that was checked: a name that resolves
 *   elsewhere a second later (DNS rebinding) changes nothing. An IP literal is checked as given.
 *   Anything else fails as `blocked`, before a byte is sent;
 * - a cap on the response body, read as a stream and cut off past it;
 * - errors and log lines that carry the provider's id, the status and the attempt, never the
 *   request, the response or the headers (the key is in them).
 *
 * Node's own http client, not fetch: it lets the lookup be checked and pinned, and never follows
 * redirects.
 */

/** A dns.lookup-shaped resolver (tests replace it). */
export type Lookup = (
  hostname: string,
  options: LookupOptions & { all: true },
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

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
  /** Called each time a request is actually sent (retries count). */
  onAttempt?: () => void;
  /** Tests shorten the backoff. Default 1,000 ms, doubled per retry, capped at 30 s. */
  backoffBaseMs?: number;
  /** Tests resolve names their own way. Default dns.lookup. */
  lookup?: Lookup;
}

/** HTTP statuses tried again. 529 is Anthropic's "overloaded". */
const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

const PRIVATE = new BlockList();
PRIVATE.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE.addSubnet("169.254.0.0", 16, "ipv4");
// Carrier-grade NAT: Tailscale and similar overlay networks hand these out to a tenant's machines.
PRIVATE.addSubnet("100.64.0.0", 10, "ipv4");
PRIVATE.addAddress("::1", "ipv6");
PRIVATE.addSubnet("fc00::", 7, "ipv6");
PRIVATE.addSubnet("fe80::", 10, "ipv6");

/**
 * Cloud instance metadata services, inside the ranges above: never a model server, and a
 * request to one can hand out the host's credentials. AWS, GCP and Azure (169.254.169.254, and
 * AWS's IPv6 fd00:ec2::254), AWS ECS task metadata (169.254.170.2), Alibaba (100.100.100.200).
 */
const METADATA = new BlockList();
METADATA.addAddress("169.254.169.254", "ipv4");
METADATA.addAddress("169.254.170.2", "ipv4");
METADATA.addAddress("100.100.100.200", "ipv4");
METADATA.addAddress("fd00:ec2::254", "ipv6");

/**
 * Whether an address is loopback, RFC 1918, carrier-grade NAT (100.64.0.0/10), link-local or
 * IPv6 unique local (IPv4-mapped too), and not a cloud metadata service.
 */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  const v4 = mapped?.[1] ?? (isIP(address) === 4 ? address : undefined);
  if (v4 !== undefined) return PRIVATE.check(v4, "ipv4") && !METADATA.check(v4, "ipv4");
  if (isIP(address) === 6) {
    return PRIVATE.check(address, "ipv6") && !METADATA.check(address, "ipv6");
  }
  return false;
}

/** Thrown inside the lookup when an address isn't private: the request never connects. */
class BlockedAddress extends Error {}

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

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** One HTTP request; resolves with the whole (capped) answer. */
function send(
  url: URL,
  headers: Record<string, string>,
  payload: string,
  signal: AbortSignal,
  options: { privateOnly: boolean; lookup: Lookup; max: number; providerId: string },
): Promise<Answer> {
  return new Promise<Answer>((resolve, reject) => {
    const checkedLookup = (
      hostname: string,
      lookupOptions: LookupOptions,
      callback: (
        err: NodeJS.ErrnoException | null,
        address: string | LookupAddress[],
        family?: number,
      ) => void,
    ) => {
      options.lookup(hostname, { ...lookupOptions, all: true }, (err, addresses) => {
        if (err) return callback(err, "");
        if (addresses.length === 0 || addresses.some((a) => !isPrivateAddress(a.address))) {
          return callback(new BlockedAddress(), "");
        }
        if (lookupOptions.all === true) return callback(null, addresses);
        const first = addresses[0] as LookupAddress;
        callback(null, first.address, first.family);
      });
    };
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers,
          "content-length": String(Buffer.byteLength(payload)),
        },
        signal,
        // A fresh connection per request: nothing half-read from a cut-off answer is reused.
        agent: false,
        ...(options.privateOnly ? { lookup: checkedLookup as never } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > options.max) {
          // Rejected before the destroy, whose own errors then change nothing.
          reject(new ModelError("too-large", options.providerId, { status }));
          res.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > options.max) {
            reject(new ModelError("too-large", options.providerId, { status }));
            res.destroy();
          } else {
            chunks.push(chunk);
          }
        });
        res.on("end", () =>
          resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
        res.on("aborted", () => reject(new Error("aborted")));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

/**
 * POSTs `body` as JSON and returns the parsed JSON answer. Throws ModelError, or the caller's
 * signal's reason when it aborts.
 */
export async function postJson(options: PostOptions): Promise<unknown> {
  const { providerId, signal, log } = options;
  const base = options.backoffBaseMs ?? 1_000;
  const payload = JSON.stringify(options.body);
  const url = new URL(options.url);
  const privateOnly = url.protocol === "http:";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // An IP literal never goes through the lookup: checked here.
  if (privateOnly && isIP(host) !== 0 && !isPrivateAddress(host)) {
    throw new ModelError("blocked", providerId);
  }
  const lookup = options.lookup ?? (dnsLookup as unknown as Lookup);
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
    options.onAttempt?.();
    let answer: Answer;
    try {
      answer = await send(url, options.headers, payload, both, {
        privateOnly,
        lookup,
        max: options.maxResponseBytes,
        providerId,
      });
    } catch (e) {
      signal.throwIfAborted();
      if (e instanceof ModelError) throw e;
      if (e instanceof BlockedAddress) throw new ModelError("blocked", providerId);
      last = new ModelError(timeout.aborted ? "timeout" : "network", providerId);
      continue;
    }
    const { status } = answer;
    if (status >= 200 && status < 300) {
      try {
        return JSON.parse(answer.body);
      } catch {
        throw new ModelError("bad-response", providerId, { status });
      }
    }
    // A redirect is refused outright: never followed, never retried.
    if (status >= 300 && status < 400) throw new ModelError("refused", providerId, { status });
    if (status === 401 || status === 403) throw new ModelError("auth", providerId, { status });
    if (!RETRY_STATUS.has(status)) throw new ModelError("refused", providerId, { status });
    const header = answer.headers["retry-after"];
    const retryAfter = parseRetryAfter(typeof header === "string" ? header : null);
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
