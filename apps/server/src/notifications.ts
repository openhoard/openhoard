import { setTimeout as sleep } from "node:timers/promises";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Subscriptions } from "@openhoard/connector-sharepoint";
import type { Logger } from "pino";
import type { AuthEnv } from "./auth.js";

/*
 * Where Graph's change notifications arrive (T-304): POST
 * /graph/notifications/<tenant>/<source>, without a session or a token, from Microsoft.
 *
 * - With `?validationToken=…`: Graph checking the address before it makes a subscription. The
 *   token goes back as it came, as text/plain (nosniff, from secureHeaders), for a source that
 *   takes notifications; any other address is 404.
 * - Otherwise a JSON body of notifications. One carrying the source's clientState (a secret only
 *   Graph and this server know) asks for a sync of the source soon; nothing else in it is
 *   believed, and the answer is 202 either way, so it tells a caller nothing.
 */

export interface NotificationDeps {
  /** The source's subscriptions, when it takes notifications. */
  sourceOf: (tenantId: string, source: string) => Subscriptions | undefined;
  /** Syncs the source soon (core/jobs requestSync()). */
  request: (tenantId: string, source: string) => Promise<unknown>;
  log?: Logger;
}

/** Graph's tokens are short; a notification batch is a few kB. */
const MAX_TOKEN = 1024;
const MAX_BODY = 256 * 1024;

export function mountGraphNotifications(app: Hono<AuthEnv>, deps: NotificationDeps): void {
  app.post(
    "/graph/notifications/:tenant/:source",
    bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: "body too large" }, 413) }),
    async (c) => {
      const tenantId = c.req.param("tenant");
      const source = c.req.param("source");
      const subscriptions = deps.sourceOf(tenantId, source);
      if (!subscriptions) return c.json({ error: "not found" }, 404);
      const token = c.req.query("validationToken");
      if (token !== undefined) {
        if (token.length > MAX_TOKEN) return c.json({ error: "validationToken too long" }, 400);
        return c.text(token, 200, { "cache-control": "no-store" });
      }
      const body: unknown = await c.req.json().catch(() => undefined);
      if (body === undefined) return c.json({ error: "a JSON body" }, 400);
      if (subscriptions.changed(body)) {
        await deps.request(tenantId, source).catch((err: unknown) => {
          deps.log?.warn({ err, tenantId, source }, "could not request a sync");
        });
      }
      return c.body(null, 202);
    },
  );
}

/** After a failure (Graph down, the address unreachable), when keep() is tried again. */
const RETRY_MS = 3600_000;

/**
 * Keeps each notifying source's subscriptions, on a worker, once the server is listening (Graph
 * checks the address as each is made): keep() now, and again when it says. A failure is logged
 * and tried again in an hour; meanwhile the schedule syncs the source as before.
 */
export function keepSubscriptions(
  notifying: ReadonlyMap<string, Subscriptions>,
  log?: Logger,
): { close(): Promise<void> } {
  const stop = new AbortController();
  const { signal } = stop;
  const loops = [...notifying].map(async ([source, subscriptions]) => {
    while (!signal.aborted) {
      let wait = RETRY_MS;
      try {
        wait = await subscriptions.keep(signal);
      } catch (err) {
        if (signal.aborted) return;
        log?.error({ err, source }, "could not keep the source's change notifications");
      }
      await sleep(wait, undefined, { signal }).catch(() => undefined);
    }
  });
  return {
    async close() {
      stop.abort();
      await Promise.allSettled(loops);
    },
  };
}
