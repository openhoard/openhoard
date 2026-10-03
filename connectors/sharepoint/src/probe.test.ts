import { errorCode } from "@openhoard/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { graphAuth, type GraphAuth } from "./auth.js";
import { probeSites, sitePath } from "./probe.js";
import { AUTHORITY, CLIENT_ID, fakes, GRAPH, SECRET, type Fakes } from "./testing/fakes.js";

/*
 * T-302: with Sites.Selected, the app reaches the sites it was granted and no others, and the
 * probe says which is which.
 */

let f: Fakes;
let auth: GraphAuth;
const never = new AbortController().signal;

beforeEach(() => {
  f = fakes();
  f.entra.registerApp({ clientId: CLIENT_ID, secret: SECRET, appRoles: ["Sites.Selected"] });
  auth = graphAuth({
    tenant: f.tenant.domain,
    clientId: CLIENT_ID,
    credential: { kind: "secret", secret: SECRET },
    authority: AUTHORITY,
    graph: GRAPH,
    fetch: f.fetch,
    now: () => f.clock.now,
  });
});

const probe = (sites: string[], send: typeof fetch = f.fetch) =>
  probeSites(auth, sites, never, { fetch: send, now: () => f.clock.now });
const failing = async (work: Promise<unknown>) =>
  work.then(
    () => undefined,
    (e: unknown) => e as Error & { retryAfterMs?: number },
  );
/** Graph answering every request with this status; Entra as it is. */
const graphSays =
  (status: number, headers: Record<string, string> = {}): typeof fetch =>
  (input, init) =>
    String(input).startsWith(GRAPH)
      ? Promise.resolve(new Response("{}", { status, headers }))
      : f.fetch(input, init);

describe("probing the configured sites", () => {
  it("tells a granted site from one that isn't, and from one that doesn't exist", async () => {
    const granted = f.tenant.sites[0] as (typeof f.tenant.sites)[0];
    const other = f.tenant.sites[1] as { id: string };
    f.entra.grantSite(CLIENT_ID, granted.id);
    expect(await probe([granted.id, other.id, "s-nowhere"])).toEqual([
      {
        site: granted.id,
        status: "ok",
        id: granted.id,
        name: granted.displayName,
        webUrl: granted.webUrl,
      },
      { site: other.id, status: "denied" },
      { site: "s-nowhere", status: "not-found" },
    ]);
    // One token for the three; each request follows no redirect.
    expect(f.sent.filter((s) => s.url.startsWith(AUTHORITY))).toHaveLength(1);
    expect(
      f.sent.filter((s) => s.url.startsWith(GRAPH)).every((s) => s.init?.redirect === "manual"),
    ).toBe(true);
    // A grant taken back is seen at once: Graph decides, not the token.
    f.entra.revokeSite(CLIENT_ID, granted.id);
    expect((await probe([granted.id]))[0]?.status).toBe("denied");
  });

  it("with Sites.Selected can't list sites; a tenant-wide permission reaches them all", async () => {
    const bearer = await auth.appToken(never);
    const list = () =>
      f.fetch(`${GRAPH}/v1.0/sites`, { headers: { authorization: `Bearer ${bearer}` } });
    expect((await list()).status).toBe(403);
    f.entra.registerApp({ clientId: CLIENT_ID, secret: SECRET, appRoles: ["Sites.Read.All"] });
    auth.forget(bearer);
    f.clock.now += 1000;
    const all = await probe(f.tenant.sites.map((s) => s.id));
    expect(all.every((p) => p.status === "ok")).toBe(true);
    const wide = await auth.appToken(never);
    const listed = await f.fetch(`${GRAPH}/v1.0/sites`, {
      headers: { authorization: `Bearer ${wide}` },
    });
    expect(((await listed.json()) as { value: unknown[] }).value).toHaveLength(
      f.tenant.sites.length,
    );
    // An app with no permission at all reaches nothing.
    f.entra.registerApp({ clientId: CLIENT_ID, secret: SECRET });
    auth.forget(wide);
    f.clock.now += 1000;
    expect((await probe([f.tenant.sites[0]?.id as string]))[0]?.status).toBe("denied");
  });

  it("on behalf of a user reaches a granted site only when the user does", async () => {
    f.entra.registerApp({
      clientId: CLIENT_ID,
      secret: SECRET,
      delegatedScopes: ["Sites.Selected"],
    });
    const site = f.tenant.sites.find(
      (s) => s.readerGroups.length > 0,
    ) as (typeof f.tenant.sites)[0];
    const groups = new Set([...site.readerGroups, ...site.writerGroups]);
    const members = new Set(
      f.tenant.groups.filter((g) => groups.has(g.id)).flatMap((g) => g.members),
    );
    const inside = f.tenant.users.find((u) => u.active && members.has(u.id)) as { id: string };
    const outside = f.tenant.users.find((u) => u.active && !members.has(u.id)) as { id: string };
    const get = async (userId: string) => {
      const bearer = await auth.onBehalfOf(await f.entra.userToken(userId, CLIENT_ID), never);
      const headers = { authorization: `Bearer ${bearer}` };
      return [
        (await f.fetch(`${GRAPH}/v1.0/sites/${site.id}`, { headers })).status,
        (await f.fetch(`${GRAPH}/v1.0/drives/${site.driveId}/root/children`, { headers })).status,
      ];
    };
    // Not granted to the app: nobody reaches it through the app.
    expect(await get(inside.id)).toEqual([403, 403]);
    f.entra.grantSite(CLIENT_ID, site.id);
    expect(await get(inside.id)).toEqual([200, 200]);
    expect(await get(outside.id)).toEqual([403, 403]);
    // The app's own token has no "me".
    const own = await auth.appToken(never);
    expect(
      (await f.fetch(`${GRAPH}/v1.0/me`, { headers: { authorization: `Bearer ${own}` } })).status,
    ).toBe(400);
  });

  it("asks for a new token once when Graph refuses the one it has", async () => {
    const site = f.tenant.sites[0] as { id: string };
    f.entra.grantSite(CLIENT_ID, site.id);
    let refused = 0;
    const once: typeof fetch = (input, init) => {
      if (String(input).startsWith(GRAPH) && refused++ === 0) {
        return Promise.resolve(new Response("{}", { status: 401 }));
      }
      return f.fetch(input, init);
    };
    f.clock.now += 1000;
    expect((await probe([site.id], once))[0]?.status).toBe("ok");
    expect(f.entra.requests).toHaveLength(2);
    // Refused again with a new token: the app's to fix, and that token isn't kept either.
    f.clock.now += 1000;
    const before = f.entra.requests.length;
    const e = await failing(probe([site.id], graphSays(401)));
    expect(errorCode(e)).toBe("auth");
    expect(f.entra.requests).toHaveLength(before + 1);
    f.clock.now += 1000;
    expect((await probe([site.id]))[0]?.status).toBe("ok");
    expect(f.entra.requests).toHaveLength(before + 2);
  });

  it("reports a busy, broken or unreachable Graph as the runner expects", async () => {
    const site = f.tenant.sites[0]?.id as string;
    const throttled = await failing(probe([site], graphSays(429, { "retry-after": "4" })));
    expect([errorCode(throttled), throttled?.retryAfterMs]).toEqual(["throttled", 4000]);
    const busy = await failing(probe([site], graphSays(503)));
    expect([errorCode(busy), busy?.retryAfterMs]).toEqual(["throttled", 30_000]);
    expect(errorCode(await failing(probe([site], graphSays(500))))).toBe("retryable");
    expect(errorCode(await failing(probe([site], graphSays(400))))).toBe("permanent");
    const down: typeof fetch = (input, init) =>
      String(input).startsWith(GRAPH)
        ? Promise.reject(new TypeError("fetch failed"))
        : f.fetch(input, init);
    const unreachable = await failing(probe([site], down));
    expect([errorCode(unreachable), unreachable?.message]).toEqual([
      "retryable",
      "Graph couldn't be reached",
    ]);
    // "OK" from something that isn't Graph is not a site reached.
    for (const body of ["not json", "[]", '{"displayName":"no id"}', "x".repeat(70_000)]) {
      const fake: typeof fetch = (input, init) =>
        String(input).startsWith(GRAPH)
          ? Promise.resolve(new Response(body, { status: 200 }))
          : f.fetch(input, init);
      const e = await failing(probe([site], fake));
      expect([errorCode(e), e?.message]).toEqual(["retryable", "Graph's answer wasn't a site"]);
    }
    // A redirect isn't followed (the request holds a token), and isn't Graph.
    const moved = await failing(probe([site], graphSays(302, { location: "https://evil.test/" })));
    expect(errorCode(moved)).toBe("permanent");
    // An answer cut short is tried again.
    const cut: typeof fetch = (input, init) =>
      String(input).startsWith(GRAPH)
        ? Promise.resolve(
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"id":'));
                  controller.error(new Error("connection reset"));
                },
              }),
              { status: 200 },
            ),
          )
        : f.fetch(input, init);
    const short = await failing(probe([site], cut));
    expect([errorCode(short), short?.message]).toEqual([
      "retryable",
      "Graph's answer was cut short",
    ]);
  });

  it("finds a site by its host and path, as it is configured", async () => {
    const site = f.tenant.sites[0] as (typeof f.tenant.sites)[0];
    const other = f.tenant.sites[1] as (typeof f.tenant.sites)[0];
    f.entra.grantSite(CLIENT_ID, site.id);
    const named = (s: { webUrl: string }) => {
      const url = new URL(s.webUrl);
      return `${url.host}:${url.pathname}`;
    };
    expect(
      await probe([named(site), named(other), `${new URL(site.webUrl).host}:/sites/nowhere`]),
    ).toEqual([
      { site: named(site), status: "ok", id: site.id, name: site.displayName, webUrl: site.webUrl },
      { site: named(other), status: "denied" },
      { site: `${new URL(site.webUrl).host}:/sites/nowhere`, status: "not-found" },
    ]);
  });

  it("stops when its caller leaves, while asking or while reading the answer", async () => {
    const site = f.tenant.sites[0]?.id as string;
    const leaving = new AbortController();
    const hang: typeof fetch = (input, init) =>
      String(input).startsWith(GRAPH)
        ? new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error));
            leaving.abort(new Error("gone"));
          })
        : f.fetch(input, init);
    await expect(probeSites(auth, [site], leaving.signal, { fetch: hang })).rejects.toThrow("gone");

    // The headers said OK and the body never ends: leaving is not "reached".
    const during = new AbortController();
    const stall: typeof fetch = (input, init) =>
      String(input).startsWith(GRAPH)
        ? Promise.resolve(
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"id":"s'));
                  init?.signal?.addEventListener("abort", () =>
                    controller.error(init.signal?.reason),
                  );
                  queueMicrotask(() => during.abort(new Error("left midway")));
                },
              }),
              { status: 200 },
            ),
          )
        : f.fetch(input, init);
    await expect(probeSites(auth, [site], during.signal, { fetch: stall })).rejects.toThrow(
      "left midway",
    );
  });
});

describe("a site as configured", () => {
  it("is an id, or a host and a path, and nothing else", () => {
    expect(
      sitePath(
        "contoso.sharepoint.com,2c712604-1370-44e7-a1f5-426573a0b4a2,0d4c5f3f-b3c1-4d3a-b0a5-1c1e6a0f9d11",
      ),
    ).toBe(
      "/v1.0/sites/contoso.sharepoint.com,2c712604-1370-44e7-a1f5-426573a0b4a2,0d4c5f3f-b3c1-4d3a-b0a5-1c1e6a0f9d11",
    );
    expect(sitePath("s-finance")).toBe("/v1.0/sites/s-finance");
    expect(sitePath("root")).toBe("/v1.0/sites/root");
    expect(sitePath("contoso.sharepoint.com")).toBe("/v1.0/sites/contoso.sharepoint.com");
    expect(sitePath("contoso.sharepoint.com:/sites/Team Finance")).toBe(
      "/v1.0/sites/contoso.sharepoint.com:/sites/Team%20Finance",
    );
    expect(sitePath("contoso.sharepoint.com:/")).toBe("/v1.0/sites/contoso.sharepoint.com:/");
    for (const bad of [
      "",
      "a/b",
      "contoso.sharepoint.com:/sites/../admin",
      "contoso.sharepoint.com:/sites/x?$expand=y",
      "contoso.sharepoint.com:/sites/x#y",
      "contoso.sharepoint.com:sites/x",
      "https://contoso.sharepoint.com/sites/x",
      "contoso.sharepoint.com://evil.example/x",
      "localhost:/sites/x",
      "a,b,c,d",
      "a,b",
      ".",
      "..",
      "-x",
      "getAllSites",
      "microsoft.graph.getAllSites",
      "contoso.sharepoint.com:/sites/x:/drive",
      "contoso.sharepoint.com:/sites/a%2fb",
      "contoso.sharepoint.com:/sites/a*b",
      "delta",
      "contoso.sharepoint.com:/sites/a\nb",
      "contoso.sharepoint.com:/sites/\ud800",
      "a b",
    ]) {
      expect(() => sitePath(bad), bad).toThrow(/not a site/);
    }
  });

  it("is checked before anything is asked", async () => {
    await expect(probe([f.tenant.sites[0]?.id as string, "a/b"])).rejects.toThrow(/not a site/);
    expect(f.sent).toHaveLength(0);
  });
});
