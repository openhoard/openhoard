import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConnectorError, isAbortError } from "@openhoard/sdk";
import { GraphError, type GraphClient } from "./graph.js";

/*
 * Change notifications (T-304): Graph told to POST to OpenHoard when something in one of the
 * site's libraries changes, so a change is synced within a minute or two, not at the next
 * scheduled sync. A notification says only "this library changed": the sync that follows asks
 * the delta what, as a scheduled one does. A notification lost or late costs nothing but time:
 * the schedule still runs.
 *
 * One subscription a library, on its root (`drives/{id}/root`), kept in `subscriptions.json` in
 * the source's state directory, so a restart renews what it made rather than making more.
 * keep() makes what is missing, renews what lapses within a day ({@link RENEW_BEFORE_MS}) to
 * {@link LIFETIME_MS} from now, and removes those of libraries no longer there; called again
 * when it says, at most six hours on. A subscription Graph has forgotten (lapsed while the
 * server was down) is made again. A damaged file means starting again: the old subscriptions
 * lapse by themselves within three days, and a notification from one only syncs early.
 *
 * Graph checks the address before it makes a subscription (it POSTs a `validationToken` there,
 * which must come back as it was): the server must be reachable at its publicUrl.
 *
 * Each notification carries the `clientState` it was made with, which only this source and
 * Graph know: changed() says whether one does, and nothing else in it is believed.
 */

/** How long a subscription is made for: Graph allows driveItems up to about 29 days. */
export const LIFETIME_MS = 3 * 24 * 3600_000;
/** A subscription lapsing sooner than this is renewed. */
export const RENEW_BEFORE_MS = 24 * 3600_000;
/** The longest keep() says to wait before it is called again, and the shortest. */
const MAX_WAIT_MS = 6 * 3600_000;
const MIN_WAIT_MS = 60_000;
const FILE = "subscriptions.json";

export interface Subscriptions {
  /**
   * Makes, renews and removes the site's subscriptions as above. Resolves to how long until it
   * should be called again, in ms. Throws as the Graph client does; a refused subscription
   * (Graph couldn't reach the address) is `permanent`.
   */
  keep(signal: AbortSignal): Promise<number>;
  /** Whether a notification's body is one for this source: its clientState is this one's. */
  changed(body: unknown): boolean;
}

export interface SubscriptionOptions {
  client: GraphClient;
  /** The site's libraries' ids, now. */
  drives: (signal: AbortSignal) => Promise<string[]>;
  /** The source's state directory. */
  stateDir: string;
  /** Where Graph POSTs: an https address that reaches this server. */
  url: string;
  /** Up to 128 characters, the same wherever the server runs (notifications reach any node). */
  clientState: string;
  now: () => number;
}

interface Kept {
  id: string;
  /** When it lapses, in ms. */
  expires: number;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const digest = (s: string) => createHash("sha256").update(s).digest();

export function graphSubscriptions(o: SubscriptionOptions): Subscriptions {
  const { client, url, clientState, now } = o;
  if (!/^https:\/\//.test(url)) throw new RangeError("notifications go to an https address");
  if (clientState.length < 16 || clientState.length > 128) {
    throw new RangeError("clientState is 16 to 128 characters");
  }
  const file = join(o.stateDir, FILE);
  const expected = digest(clientState);

  /** What the file holds for `url`; nothing when it is missing, damaged or for another. */
  function read(): { subs: Map<string, Kept>; other: Kept[] } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return { subs: new Map(), other: [] };
    }
    const subs = new Map<string, Kept>();
    if (!isObject(parsed) || parsed.v !== 1 || !isObject(parsed.subs)) return { subs, other: [] };
    for (const [drive, s] of Object.entries(parsed.subs)) {
      if (isObject(s) && typeof s.id === "string" && typeof s.expires === "number") {
        subs.set(drive, { id: s.id, expires: s.expires });
      }
    }
    // Made for another address (publicUrl changed): removed, and made again for this one.
    return parsed.url === url
      ? { subs, other: [] }
      : { subs: new Map(), other: [...subs.values()] };
  }

  function write(subs: Map<string, Kept>): void {
    mkdirSync(o.stateDir, { recursive: true, mode: 0o700 });
    const tmp = join(o.stateDir, `.${FILE}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      writeFileSync(tmp, JSON.stringify({ v: 1, url, subs: Object.fromEntries(subs) }), {
        mode: 0o600,
      });
      renameSync(tmp, file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  const path = (id: string) => `/v1.0/subscriptions/${encodeURIComponent(id)}`;
  const until = () => new Date(now() + LIFETIME_MS).toISOString();
  function keptOf(answer: Record<string, unknown>): Kept {
    const expires = Date.parse(String(answer.expirationDateTime));
    if (typeof answer.id !== "string" || answer.id === "" || Number.isNaN(expires)) {
      throw new ConnectorError("retryable", "Graph's answer wasn't a subscription");
    }
    return { id: answer.id, expires };
  }

  async function make(drive: string, signal: AbortSignal): Promise<Kept> {
    try {
      return keptOf(
        await client.json("/v1.0/subscriptions", signal, {
          method: "POST",
          body: {
            changeType: "updated",
            notificationUrl: url,
            resource: `drives/${drive}/root`,
            expirationDateTime: until(),
            clientState,
          },
        }),
      );
    } catch (e) {
      if (e instanceof GraphError && e.status === 400) {
        throw new ConnectorError(
          "permanent",
          `Graph couldn't check the notification address ${url}: the server's publicUrl must be reachable from the internet`,
          { cause: e },
        );
      }
      throw e;
    }
  }

  /** The subscription renewed, or undefined when Graph has none of that id any more. */
  async function renew(kept: Kept, signal: AbortSignal): Promise<Kept | undefined> {
    try {
      return keptOf(
        await client.json(path(kept.id), signal, {
          method: "PATCH",
          body: { expirationDateTime: until() },
        }),
      );
    } catch (e) {
      if (e instanceof ConnectorError && e.code === "not-found") return undefined;
      throw e;
    }
  }

  async function keep(signal: AbortSignal): Promise<number> {
    const { subs: had, other } = read();
    const drives = await o.drives(signal);
    // Libraries gone, or an address no longer used: removed first (else they lapse by
    // themselves), so a library failing below doesn't leave them unknown and unremoved.
    const gone = [...had].filter(([drive]) => !drives.includes(drive)).map(([, s]) => s);
    for (const s of [...gone, ...other]) {
      await client.get(path(s.id), signal, { method: "DELETE", pass: [404] }).then(
        (r) => r.body?.cancel(),
        (e: unknown) => {
          if (isAbortError(e, signal)) throw e;
        },
      );
    }
    const subs = new Map<string, Kept>();
    try {
      for (const drive of drives) {
        const kept = had.get(drive);
        if (kept && kept.expires - now() > RENEW_BEFORE_MS) subs.set(drive, kept);
        else subs.set(drive, (kept && (await renew(kept, signal))) ?? (await make(drive, signal)));
      }
    } finally {
      // What was made is kept even when a later library failed, so it isn't made twice.
      for (const drive of drives) {
        const kept = had.get(drive);
        if (!subs.has(drive) && kept) subs.set(drive, kept);
      }
      write(subs);
    }
    const soonest = Math.min(...[...subs.values()].map((s) => s.expires - RENEW_BEFORE_MS));
    return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, soonest - now()));
  }

  return {
    keep,
    changed(body) {
      if (!isObject(body) || !Array.isArray(body.value)) return false;
      return body.value.some(
        (n) =>
          isObject(n) &&
          typeof n.clientState === "string" &&
          timingSafeEqual(digest(n.clientState), expected),
      );
    },
  };
}
