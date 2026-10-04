import { errorCode } from "@openhoard/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { graphAuth } from "./auth.js";
import { graphClient, type GraphClient } from "./graph.js";
import { pacer } from "./pace.js";
import {
  AUTHORITY,
  CLIENT_ID,
  fakes,
  GRAPH,
  SECRET,
  UNPACED,
  type Fakes,
} from "./testing/fakes.js";

/*
 * T-303: what Graph answers, in the connector contract's terms, and where a request may go.
 */

let f: Fakes;
const never = new AbortController().signal;

beforeEach(() => {
  f = fakes();
  f.entra.registerApp({ clientId: CLIENT_ID, secret: SECRET, appRoles: ["Sites.Read.All"] });
});

/** A client whose Graph answers every request with this; Entra as it is. */
function client(
  answer?: (url: string, init?: RequestInit) => Response | Promise<Response>,
  { maxWaitMs, ...pacing }: { maxWaitMs?: number; unitsPerMinute?: number } = {},
): GraphClient {
  const send: typeof fetch = (input, init) =>
    answer && String(input).startsWith(GRAPH)
      ? Promise.resolve(answer(String(input), init))
      : f.fetch(input, init);
  return graphClient({
    auth: graphAuth({
      tenant: f.tenant.domain,
      clientId: CLIENT_ID,
      credential: { kind: "secret", secret: SECRET },
      authority: AUTHORITY,
      graph: GRAPH,
      fetch: send,
      now: () => f.clock.now,
    }),
    fetch: send,
    now: () => f.clock.now,
    maxJsonBytes: 1024,
    pacer: pacer({ now: () => f.clock.now, sleep: f.sleep, unitsPerMinute: UNPACED, ...pacing }),
    ...(maxWaitMs === undefined ? {} : { maxWaitMs }),
  });
}
const failure = (work: Promise<unknown>) =>
  work.then(
    () => undefined,
    (e: unknown) => e as Error & { retryAfterMs?: number },
  );
const says = (status: number, headers: Record<string, string> = {}) =>
  client(() => new Response("{}", { status, headers }));

describe("a request to Graph", () => {
  it("carries the app's token, to Graph's origin, following no redirect", async () => {
    const site = f.tenant.sites[0] as { id: string };
    const json = await client().json(`/v1.0/sites/${site.id}`, never);
    expect(json.id).toBe(site.id);
    const sent = f.sent.find((s) => s.url === `${GRAPH}/v1.0/sites/${site.id}`);
    expect(sent?.init?.redirect).toBe("manual");
    expect(new Headers(sent?.init?.headers).get("authorization")).toMatch(/^Bearer ./);
    // A link Graph gave is followed when it is Graph's.
    expect((await client().json(`${GRAPH}/v1.0/sites/${site.id}`, never)).id).toBe(site.id);
    expect(client().origin).toBe(GRAPH);
  });

  it("goes nowhere but Graph", async () => {
    const c = client();
    for (const link of [
      "https://evil.test/v1.0/sites",
      "//evil.test/v1.0/sites",
      `${GRAPH}.evil.test/v1.0/sites`,
      GRAPH.replace("https://", "https://user:pw@") + "/v1.0/sites",
      GRAPH.replace("https://", "http://") + "/v1.0/sites",
      "v1.0/sites",
      "",
    ]) {
      const e = await failure(c.get(link, never));
      expect(errorCode(e), link).toBe("permanent");
      // Not the link: it may hold a token of Graph's.
      expect(e?.message).not.toContain("evil.test");
      expect(c.owns(link)).toBe(false);
    }
    expect(f.sent.some((s) => s.url.includes("evil.test"))).toBe(false);
    expect(c.owns(`${GRAPH}/v1.0/x?token=abc`)).toBe(true);
  });

  it("says what went wrong as the sync runner reads it", async () => {
    const code = async (c: GraphClient) => {
      const e = await failure(c.json("/v1.0/x", never));
      return [errorCode(e), e?.retryAfterMs];
    };
    expect(await code(says(403))).toEqual(["auth", undefined]);
    expect(await code(says(404))).toEqual(["not-found", undefined]);
    expect(await code(says(410))).toEqual(["resync", undefined]);
    expect(await code(says(429, { "retry-after": "9" }))).toEqual(["throttled", 9000]);
    expect(await code(says(429))).toEqual(["throttled", 30_000]);
    expect(await code(says(503, { "retry-after": "2" }))).toEqual(["throttled", 2000]);
    expect(await code(says(504, { "retry-after": "1" }))).toEqual(["throttled", 1000]);
    expect(await code(says(503))).toEqual(["retryable", undefined]);
    expect(await code(says(500))).toEqual(["retryable", undefined]);
    expect(await code(says(302, { location: "https://evil.test/" }))).toEqual([
      "permanent",
      undefined,
    ]);
    expect(await code(says(400))).toEqual(["permanent", undefined]);
    expect(await code(client(() => Promise.reject(new TypeError("fetch failed"))))).toEqual([
      "retryable",
      undefined,
    ]);
  });

  it("waits out a throttle and asks again, as long as the waiting stays within what it may", async () => {
    const answers = (statuses: [number, string?][]) => {
      let n = 0;
      const asked: number[] = [];
      const c = (more: { maxWaitMs?: number } = {}) =>
        client(() => {
          asked.push(f.clock.now);
          const [status, retryAfter] = statuses[Math.min(n++, statuses.length - 1)] as [
            number,
            string?,
          ];
          return new Response(status === 200 ? '{"ok":true}' : "{}", {
            status,
            headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
          });
        }, more);
      return { c, asked };
    };
    // Throttled twice, for 5 s and 20 s: asked again after each, never before it is over.
    const start = f.clock.now;
    const twice = answers([[429, "5"], [503, "20"], [200]]);
    expect(await twice.c().json("/v1.0/x", never)).toEqual({ ok: true });
    expect(twice.asked.map((at) => Math.round((at - start) / 1000))).toEqual([0, 5, 25]);

    // More waiting than it may do in place: the runner's to come back after.
    const long = answers([[429, "45"], [429, "45"], [200]]);
    const e = await failure(long.c().json("/v1.0/x", never));
    expect([errorCode(e), e?.retryAfterMs, long.asked.length]).toEqual(["throttled", 45_000, 2]);
    const none = answers([[429, "1"], [200]]);
    expect(errorCode(await failure(none.c({ maxWaitMs: 0 }).json("/v1.0/x", never)))).toBe(
      "throttled",
    );
    expect(none.asked).toHaveLength(1);
    // Graph throttling without end, a second at a time: given up after a few tries.
    const endless = answers([[429, "1"]]);
    expect(errorCode(await failure(endless.c().json("/v1.0/x", never)))).toBe("throttled");
    expect(endless.asked).toHaveLength(9);

    // A failure of the moment is asked again twice, a little later each time.
    const flaky = answers([[500], [502], [200]]);
    const from = f.clock.now;
    expect(await flaky.c().json("/v1.0/x", never)).toEqual({ ok: true });
    expect(flaky.asked.map((at) => at - from)).toEqual([0, 1000, 3000]);
    let failures = 0;
    const offline = client(() =>
      ++failures < 3 ? Promise.reject(new TypeError("fetch failed")) : new Response('{"ok":true}'),
    );
    expect(await offline.json("/v1.0/x", never)).toEqual({ ok: true });
  });

  it("shares a throttle with everyone on its pacer, and gives up rather than wait behind a long one", async () => {
    const shared = pacer({ now: () => f.clock.now, sleep: f.sleep, unitsPerMinute: UNPACED });
    const on = (answer: () => Response, maxWaitMs?: number) =>
      graphClient({
        auth: graphAuth({
          tenant: f.tenant.domain,
          clientId: CLIENT_ID,
          credential: { kind: "secret", secret: SECRET },
          authority: AUTHORITY,
          graph: GRAPH,
          fetch: f.fetch,
          now: () => f.clock.now,
        }),
        fetch: (input, init) =>
          String(input).startsWith(GRAPH) ? Promise.resolve(answer()) : f.fetch(input, init),
        now: () => f.clock.now,
        pacer: shared,
        ...(maxWaitMs === undefined ? {} : { maxWaitMs }),
      });
    // One source is told to wait ten minutes, and hands that to its runner.
    const told = on(() => new Response("{}", { status: 429, headers: { "retry-after": "600" } }));
    expect((await failure(told.json("/v1.0/a", never)))?.retryAfterMs).toBe(600_000);
    // Another source of the same app doesn't ask Graph at all meanwhile: it is throttled too,
    // and says for how long.
    let asked = 0;
    const other = on(() => {
      asked++;
      return new Response('{"ok":true}');
    });
    const behind = await failure(other.json("/v1.0/b", never));
    expect([errorCode(behind), behind?.retryAfterMs, asked]).toEqual(["throttled", 600_000, 0]);
    // A short one it waits out, behind the other's throttle, and then asks.
    f.clock.now += 570_000;
    const at = f.clock.now;
    expect(await other.json("/v1.0/b", never)).toEqual({ ok: true });
    expect(f.clock.now - at).toBeGreaterThanOrEqual(30_000);
    expect(asked).toBe(1);
  });

  it("slows while Graph warns that most of the limit is used", async () => {
    const mine = pacer({ now: () => f.clock.now, sleep: f.sleep, unitsPerMinute: 600 });
    const warned = graphClient({
      auth: graphAuth({
        tenant: f.tenant.domain,
        clientId: CLIENT_ID,
        credential: { kind: "secret", secret: SECRET },
        authority: AUTHORITY,
        graph: GRAPH,
        fetch: f.fetch,
        now: () => f.clock.now,
      }),
      fetch: (input, init) =>
        String(input).startsWith(GRAPH)
          ? Promise.resolve(
              new Response("{}", {
                headers: {
                  "ratelimit-limit": "1000",
                  "ratelimit-remaining": "50",
                  "ratelimit-reset": "40",
                },
              }),
            )
          : f.fetch(input, init),
      now: () => f.clock.now,
      pacer: mine,
    });
    const start = f.clock.now;
    // 100 at once, then five a second (half of ten) while the warning lasts.
    for (let i = 0; i < 200; i++) await warned.json("/v1.0/x", never);
    expect((f.clock.now - start) / 1000).toBeGreaterThan(18);
    expect((f.clock.now - start) / 1000).toBeLessThan(32);
  });

  it("asks for a new token once when Graph refuses the one it has", async () => {
    let n = 0;
    f.clock.now += 1000;
    const once = client(
      () => new Response(++n === 1 ? "{}" : '{"ok":true}', { status: n === 1 ? 401 : 200 }),
    );
    expect(await once.json("/v1.0/x", never)).toEqual({ ok: true });
    expect(f.entra.requests).toHaveLength(2);
    const e = await failure(says(401).json("/v1.0/x", never));
    expect(errorCode(e)).toBe("auth");
  });

  it("hands back the statuses its caller asked to read itself", async () => {
    const response = await says(302, { location: "https://files.test/x" }).get("/v1.0/x", never, {
      pass: [302],
    });
    expect([response.status, response.headers.get("location")]).toEqual([
      302,
      "https://files.test/x",
    ]);
    let seen = new Headers();
    await client((_url, init) => {
      seen = new Headers(init?.headers);
      return new Response("{}");
    }).json("/v1.0/x", never, { headers: { prefer: "x", Authorization: "mine" } });
    // A caller's header is sent; the token is never the caller's to replace, however spelled.
    expect(seen.get("prefer")).toBe("x");
    expect(seen.get("authorization")).toMatch(/^Bearer (?!mine)./);
  });

  it("takes only a JSON object for an answer, of a size it will read", async () => {
    for (const body of ["not json", "[1]", "7", "null", `{"big":"${"x".repeat(2000)}"}`]) {
      const e = await failure(client(() => new Response(body)).json("/v1.0/x", never));
      expect([errorCode(e), e?.message], body.slice(0, 12)).toEqual([
        "retryable",
        "Graph's answer wasn't what was asked for",
      ]);
    }
    const cut = client(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"id":'));
              controller.error(new Error("connection reset"));
            },
          }),
        ),
    );
    const e = await failure(cut.json("/v1.0/x", never));
    expect([errorCode(e), e?.message]).toEqual(["retryable", "Graph's answer was cut short"]);
  });

  it("stops when its caller leaves", async () => {
    await expect(client().get("/v1.0/x", AbortSignal.abort(new Error("early")))).rejects.toThrow(
      "early",
    );
    const leaving = new AbortController();
    const hang = client(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error));
          leaving.abort(new Error("gone"));
        }),
    );
    await expect(hang.json("/v1.0/x", leaving.signal)).rejects.toThrow("gone");
  });
});
