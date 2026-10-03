import { constants, generateKeyPairSync, verify, X509Certificate } from "node:crypto";
import { errorCode, isConnectorError } from "@openhoard/sdk";
import { selfSignedCertificate } from "@openhoard/testkit";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expiryOf, graphAuth, GraphAuthError, type GraphAuthOptions } from "./auth.js";
import { retryAfterMs } from "./http.js";
import {
  AUTHORITY,
  CLIENT_ID,
  fakes,
  GRAPH,
  SECRET,
  TENANT_GUID,
  type Fakes,
} from "./testing/fakes.js";

/*
 * T-302: both kinds of Graph token, with both kinds of credential, against the testkit's fake
 * Entra (which checks requests as Entra does and refuses with its error shapes).
 */

let f: Fakes;
let cert: ReturnType<typeof selfSignedCertificate>;
const never = new AbortController().signal;

beforeAll(() => {
  cert = selfSignedCertificate();
});

beforeEach(() => {
  f = fakes();
  f.entra.registerApp({
    clientId: CLIENT_ID,
    secret: SECRET,
    certificate: cert.certificate,
    appRoles: ["Sites.Selected"],
    delegatedScopes: ["Sites.Selected", "User.Read"],
  });
});

const options = (over: Partial<GraphAuthOptions> = {}): GraphAuthOptions => ({
  tenant: f.tenant.domain,
  clientId: CLIENT_ID,
  credential: { kind: "secret", secret: SECRET },
  authority: AUTHORITY,
  graph: GRAPH,
  fetch: f.fetch,
  now: () => f.clock.now,
  ...over,
});
const tokenRequests = () => f.sent.filter((s) => s.url.startsWith(AUTHORITY));
const refusal = async (work: Promise<unknown>) => {
  const e = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(e, "it should have been refused").toBeDefined();
  return e as GraphAuthError;
};
/** A `fetch` that answers every request with this. */
const answering =
  (make: () => Response | Promise<Response>): typeof fetch =>
  () =>
    Promise.resolve(make());
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const token = (name: string, expires = 3600) =>
  json({ token_type: "Bearer", expires_in: expires, access_token: name });

describe("an app-only token", () => {
  it("is issued for a client secret, and says what Entra consented", async () => {
    const auth = graphAuth(options());
    const bearer = await auth.appToken(never);
    expect(await f.entra.verify(bearer)).toEqual({
      appId: CLIENT_ID,
      roles: ["Sites.Selected"],
      scopes: [],
    });
    expect(f.entra.requests).toEqual([
      { grant: "client_credentials", clientId: CLIENT_ID, auth: "secret", status: 200 },
    ]);
    // The request holds the credential: it follows no redirect.
    expect(tokenRequests()[0]?.init?.redirect).toBe("manual");
    expect(auth.graph).toBe(GRAPH);
  });

  it("is issued for a certificate: a signed assertion, new each time, and never the key", async () => {
    const auth = graphAuth(
      options({ tenant: TENANT_GUID, credential: { kind: "certificate", ...cert } }),
    );
    const first = await auth.appToken(never);
    auth.forget(first);
    await auth.appToken(never);
    expect(f.entra.requests.map((r) => [r.auth, r.status])).toEqual([
      ["certificate", 200],
      ["certificate", 200],
    ]);
    const bodies = tokenRequests().map((sent) => new URLSearchParams(String(sent.init?.body)));
    const keyBody = cert.privateKey.split("\n").slice(1, 3).join("");
    for (const body of bodies) {
      expect(body.get("client_secret")).toBeNull();
      expect(body.toString()).not.toContain(encodeURIComponent(keyBody.slice(0, 40)));
    }
    const assertions = bodies.map((b) => b.get("client_assertion") as string);
    expect(assertions[0]).not.toBe(assertions[1]);

    // The assertion as Entra's documentation asks for it, checked without the fake's help.
    const [head, payload, signature] = (assertions[0] as string).split(".") as [
      string,
      string,
      string,
    ];
    const x509 = new X509Certificate(cert.certificate);
    expect(JSON.parse(Buffer.from(head, "base64url").toString())).toEqual({
      alg: "PS256",
      typ: "JWT",
      "x5t#S256": Buffer.from(x509.fingerprint256.replaceAll(":", ""), "hex").toString("base64url"),
    });
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<
      string,
      number | string
    >;
    const seconds = f.clock.now / 1000;
    expect(claims).toEqual({
      aud: `${AUTHORITY}/${TENANT_GUID}/oauth2/v2.0/token`,
      iss: CLIENT_ID,
      sub: CLIENT_ID,
      jti: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      nbf: seconds,
      iat: seconds,
      exp: seconds + 300,
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${head}.${payload}`),
        {
          key: x509.publicKey,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
        },
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });

  it("is kept until shortly before it lapses, then replaced", async () => {
    const auth = graphAuth(options());
    const first = await auth.appToken(never);
    f.clock.now += 54 * 60_000;
    expect(await auth.appToken(never)).toBe(first);
    expect(tokenRequests()).toHaveLength(1);
    f.clock.now += 2 * 60_000; // 56 minutes of 60: inside the last five
    const second = await auth.appToken(never);
    expect(second).not.toBe(first);
    expect(tokenRequests()).toHaveLength(2);
  });

  it("with a short life is replaced halfway through it", async () => {
    f = fakes({ lifetimeSeconds: 60 });
    f.entra.registerApp({ clientId: CLIENT_ID, secret: SECRET });
    const auth = graphAuth(options());
    const first = await auth.appToken(never);
    f.clock.now += 29_000;
    expect(await auth.appToken(never)).toBe(first);
    f.clock.now += 2_000;
    expect(await auth.appToken(never)).not.toBe(first);
  });

  it("is asked for once when callers arrive together, and anew once forgotten", async () => {
    const auth = graphAuth(options());
    const [a, b, c] = await Promise.all([
      auth.appToken(never),
      auth.appToken(never),
      auth.appToken(never),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(tokenRequests()).toHaveLength(1);
    auth.forget("some other token");
    await auth.appToken(never);
    expect(tokenRequests()).toHaveLength(1);
    auth.forget(a);
    f.clock.now += 1000; // a token issued in another second differs
    expect(await auth.appToken(never)).not.toBe(a);
    expect(tokenRequests()).toHaveLength(2);
  });

  it("stops for the caller who leaves, not for the others", async () => {
    let release: (r: Response) => void = () => undefined;
    const auth = graphAuth(
      options({ fetch: () => new Promise<Response>((resolve) => (release = resolve)) }),
    );
    const leaving = new AbortController();
    const left = auth.appToken(leaving.signal);
    const stayed = auth.appToken(never);
    leaving.abort(new Error("gone"));
    await expect(left).rejects.toThrow("gone");
    release(token("kept"));
    expect(await stayed).toBe("kept");
    // And one who had left before asking sends nothing.
    await expect(
      graphAuth(options()).appToken(AbortSignal.abort(new Error("early"))),
    ).rejects.toThrow("early");
    expect(tokenRequests()).toHaveLength(0);
  });
});

describe("a refusal by Entra", () => {
  it("of a wrong secret is the app's, says why, and never repeats the secret", async () => {
    const wrong = "not-the-secret-9f8e7d";
    const e = await refusal(
      graphAuth(options({ credential: { kind: "secret", secret: wrong } })).appToken(never),
    );
    expect(e).toBeInstanceOf(GraphAuthError);
    expect(errorCode(e)).toBe("auth");
    expect(isConnectorError(e)).toBe(true);
    expect(e.subject).toBe("app");
    expect(e.entraError).toBe("invalid_client");
    expect(e.entraCodes).toEqual([7000215]);
    expect(e.message).toContain("AADSTS7000215");
    expect(e.message).toContain("the secret's value, not its id");
    expect(JSON.stringify([e.message, String(e.stack), e.cause ?? ""])).not.toContain(wrong);
  });

  it("names an unknown app, an unknown tenant and an unregistered certificate", async () => {
    const other = "99999999-2222-4333-8444-555555555555";
    expect(
      (await refusal(graphAuth(options({ clientId: other })).appToken(never))).entraCodes,
    ).toEqual([700016]);
    const lost = await refusal(graphAuth(options({ tenant: "elsewhere.test" })).appToken(never));
    expect(lost.entraCodes).toEqual([90002]);
    expect(lost.message).toContain("no such tenant");
    const stranger = selfSignedCertificate();
    const e = await refusal(
      graphAuth(options({ credential: { kind: "certificate", ...stranger } })).appToken(never),
    );
    expect(e.entraCodes).toEqual([700027]);
    expect(e.subject).toBe("app");
  });

  it("is not kept: the next call asks again", async () => {
    const auth = graphAuth(options());
    f.entra.registerApp({ clientId: CLIENT_ID, secret: "rotated" });
    await refusal(auth.appToken(never));
    f.entra.registerApp({ clientId: CLIENT_ID, secret: SECRET });
    expect(await auth.appToken(never)).toEqual(expect.any(String));
  });
});

describe("a busy or broken Entra", () => {
  it("that throttles is waited for as long as it says", async () => {
    f.entra.failNext(429, 1, 7);
    const e = await refusal(graphAuth(options()).appToken(never));
    expect(errorCode(e)).toBe("throttled");
    expect((e as unknown as { retryAfterMs: number }).retryAfterMs).toBe(7000);
    // Without a time, half a minute.
    const bare = await refusal(
      graphAuth(options({ fetch: answering(() => json({ error: "throttled" }, 429)) })).appToken(
        never,
      ),
    );
    expect((bare as unknown as { retryAfterMs: number }).retryAfterMs).toBe(30_000);
  });

  it("that is unavailable is tried again, after its Retry-After when it gives one", async () => {
    f.entra.failNext(503);
    expect(errorCode(await refusal(graphAuth(options()).appToken(never)))).toBe("retryable");
    f.entra.failNext(503, 1, 3);
    const e = await refusal(graphAuth(options()).appToken(never));
    expect(errorCode(e)).toBe("throttled");
    expect((e as unknown as { retryAfterMs: number }).retryAfterMs).toBe(3000);
    // Entra's own word for it, whatever the status.
    const said = await refusal(
      graphAuth(
        options({ fetch: answering(() => json({ error: "temporarily_unavailable" }, 400)) }),
      ).appToken(never),
    );
    expect(errorCode(said)).toBe("retryable");
  });

  it("that can't be reached, or doesn't answer in time, is tried again", async () => {
    const down = await refusal(
      graphAuth(options({ fetch: () => Promise.reject(new TypeError("fetch failed")) })).appToken(
        never,
      ),
    );
    expect(errorCode(down)).toBe("retryable");
    expect(down.message).toBe("Entra couldn't be reached");
    const slow = await refusal(
      graphAuth(
        options({
          timeoutMs: 20,
          fetch: (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error));
            }),
        }),
      ).appToken(never),
    );
    expect(errorCode(slow)).toBe("retryable");
    expect(slow.message).toBe("Entra didn't answer within 20 ms");
  });

  it("whose answer holds no usable token is tried again", async () => {
    for (const body of [
      new Response("<html>proxy</html>", { status: 200 }),
      json({ token_type: "Bearer", expires_in: 3600 }),
      json({ token_type: "Bearer", expires_in: 0, access_token: "t" }),
      json({ token_type: "Bearer", expires_in: "Infinity", access_token: "t" }),
      json({ token_type: "mac", expires_in: 3600, access_token: "t" }),
      json(null),
      new Response(null, { status: 200 }),
      // Far longer than a token response: not read.
      json({ token_type: "Bearer", expires_in: 3600, access_token: "t".repeat(70_000) }),
      new Response("x".repeat(70_000), { status: 200, headers: { "content-length": "70000" } }),
    ]) {
      const e = await refusal(graphAuth(options({ fetch: answering(() => body) })).appToken(never));
      expect(errorCode(e)).toBe("retryable");
      expect(e.message).toBe("Entra's answer held no usable token");
    }
    // A refusal that doesn't say why, as Entra always does, is something on the way (a proxy):
    // tried again, not taken as the app's credentials being wrong.
    for (const status of [403, 408, 400]) {
      const page = await refusal(
        graphAuth(
          options({ fetch: answering(() => new Response("Forbidden", { status })) }),
        ).appToken(never),
      );
      expect(errorCode(page)).toBe("retryable");
      expect(page.message).toBe(`the token endpoint refused without saying why (${status})`);
    }
    // A redirect isn't followed (the request holds the credential), and isn't Entra.
    const moved = await refusal(
      graphAuth(
        options({
          fetch: answering(
            () => new Response(null, { status: 307, headers: { location: "https://evil.test/" } }),
          ),
        }),
      ).appToken(never),
    );
    expect(errorCode(moved)).toBe("permanent");
    expect(moved.message).toContain("redirect (307)");
    // Whatever was thrown, even nothing at all.
    const nothing = await refusal(
      graphAuth(options({ fetch: () => Promise.reject(null) })).appToken(never),
    );
    expect(errorCode(nothing)).toBe("retryable");
    // What Entra calls the refusal goes into a message: only what such a word is made of.
    const odd = await refusal(
      graphAuth(
        options({
          fetch: answering(() =>
            json({ error: "bad\n\u001b[31mthing", error_codes: [1.5, 7] }, 400),
          ),
        }),
      ).appToken(never),
    );
    expect(odd.message).toBe("Entra refused the app (bad???31mthing, AADSTS7)");
    // A life of years is kept a day.
    let asked = 0;
    const long = graphAuth(
      options({
        fetch: answering(() =>
          json({ token_type: "Bearer", expires_in: 1e9, access_token: `long${++asked}` }),
        ),
      }),
    );
    expect(await long.appToken(never)).toBe("long1");
    f.clock.now += 23 * 3_600_000;
    expect(await long.appToken(never)).toBe("long1");
    f.clock.now += 3_600_000;
    expect(await long.appToken(never)).toBe("long2");
    // A number given as text is a number.
    expect(
      await graphAuth(
        options({
          fetch: answering(() =>
            json({ token_type: "bearer", expires_in: "3600", access_token: "as-text" }),
          ),
        }),
      ).appToken(never),
    ).toBe("as-text");
  });
});

describe("a token on behalf of a user", () => {
  const member = () =>
    f.tenant.users.find((u) => u.active && !u.guest) as { id: string; upn: string };

  it("is the person's: Graph knows them, and gives the scopes consented", async () => {
    const auth = graphAuth(options());
    const assertion = await f.entra.userToken(member().id, CLIENT_ID);
    const bearer = await auth.onBehalfOf(assertion, never);
    expect(await f.entra.verify(bearer)).toEqual({
      appId: CLIENT_ID,
      roles: [],
      scopes: ["Sites.Selected", "User.Read"],
      userId: member().id,
    });
    const me = await f.fetch(`${GRAPH}/v1.0/me`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(((await me.json()) as { userPrincipalName: string }).userPrincipalName).toBe(
      member().upn,
    );
    const body = new URLSearchParams(String(tokenRequests()[0]?.init?.body));
    expect(Object.fromEntries(body)).toMatchObject({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      requested_token_use: "on_behalf_of",
      assertion,
      scope: `${GRAPH}/.default`,
    });
  });

  it("works with a certificate, and with scopes named one by one", async () => {
    const auth = graphAuth(
      options({
        credential: { kind: "certificate", ...cert },
        delegatedScopes: [`${GRAPH}/User.Read`],
      }),
    );
    const bearer = await auth.onBehalfOf(await f.entra.userToken(member().id, CLIENT_ID), never);
    expect((await f.entra.verify(bearer))?.scopes).toEqual(["User.Read"]);
    expect(f.entra.requests[0]?.auth).toBe("certificate");
  });

  it("is kept for that person only, and no longer than their own token lasts", async () => {
    const auth = graphAuth(options());
    const active = f.tenant.users.filter((u) => u.active);
    const one = active[0] as { id: string };
    const two = active[1] as { id: string };
    const mine = await f.entra.userToken(one.id, CLIENT_ID, { expiresInSeconds: 120 });
    const theirs = await f.entra.userToken(two.id, CLIENT_ID);
    const first = await auth.onBehalfOf(mine, never);
    expect(await auth.onBehalfOf(mine, never)).toBe(first);
    expect(await auth.onBehalfOf(theirs, never)).not.toBe(first);
    expect(tokenRequests()).toHaveLength(2);
    // The Graph token would last an hour; the person's own token lapses in two minutes, and
    // from then on nothing is handed out for it, and Entra isn't asked.
    f.clock.now += 119_000;
    expect(await auth.onBehalfOf(mine, never)).toBe(first);
    f.clock.now += 2_000;
    const e = await refusal(auth.onBehalfOf(mine, never));
    expect(e.subject).toBe("user");
    expect(e.message).toBe("the person's token has expired");
    expect(tokenRequests()).toHaveLength(2);
  });

  it("is asked for once when the same person's requests arrive together", async () => {
    const auth = graphAuth(options());
    const assertion = await f.entra.userToken(member().id, CLIENT_ID);
    const [a, b] = await Promise.all([
      auth.onBehalfOf(assertion, never),
      auth.onBehalfOf(assertion, never),
    ]);
    expect(a).toBe(b);
    expect(tokenRequests()).toHaveLength(1);
    auth.forget(a);
    f.clock.now += 1000;
    expect(await auth.onBehalfOf(assertion, never)).not.toBe(a);
  });

  it("is refused here, unasked, for what isn't a token that says when it lapses", async () => {
    let n = 0;
    const auth = graphAuth(options({ fetch: answering(() => token(`t${++n}`)) }));
    const jwt = (claims: unknown) =>
      `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
    for (const not of [
      "",
      "opaque-token",
      "two words",
      "a.b",
      "a.b.c.d",
      jwt({ sub: "no exp" }),
      jwt({ exp: f.clock.now / 1000 + 60, pad: "x".repeat(20_000) }), // far longer than a token
    ]) {
      const e = await refusal(auth.onBehalfOf(not, never));
      expect([e.subject, e.entraError], not.slice(0, 20)).toEqual(["user", "invalid_grant"]);
    }
    expect(n).toBe(0);
    expect(await auth.onBehalfOf(jwt({ exp: f.clock.now / 1000 + 60 }), never)).toBe("t1");
  });

  it("refused for good by Entra is refused here too for a minute, then asked again", async () => {
    const auth = graphAuth(options());
    const gone = f.tenant.users.find((u) => !u.active) as { id: string };
    const assertion = await f.entra.userToken(gone.id, CLIENT_ID);
    const first = await refusal(auth.onBehalfOf(assertion, never));
    expect(first.entraCodes).toEqual([50057]);
    f.clock.now += 59_000;
    expect(await refusal(auth.onBehalfOf(assertion, never))).toBe(first);
    expect(tokenRequests()).toHaveLength(1);
    f.clock.now += 2_000;
    expect(await refusal(auth.onBehalfOf(assertion, never))).not.toBe(first);
    expect(tokenRequests()).toHaveLength(2);
    // A clock set back an hour doesn't make that minute an hour.
    f.clock.now -= 3_600_000;
    await refusal(auth.onBehalfOf(assertion, never));
    expect(tokenRequests()).toHaveLength(3);
  });

  it("asks again at once after 'sign in again', a busy Entra, or the app's own refusal", async () => {
    const auth = graphAuth(options());
    const user = member();
    // The person may complete the sign-in and come back with the same token.
    f.entra.requireInteraction(user.id);
    const assertion = await f.entra.userToken(user.id, CLIENT_ID);
    await refusal(auth.onBehalfOf(assertion, never));
    f.entra.requireInteraction(user.id, false);
    expect(await auth.onBehalfOf(assertion, never)).toEqual(expect.any(String));
    const other = await f.entra.userToken(user.id, CLIENT_ID, { expiresInSeconds: 1800 });
    f.entra.failNext(503);
    expect(errorCode(await refusal(auth.onBehalfOf(other, never)))).toBe("retryable");
    expect(await auth.onBehalfOf(other, never)).toEqual(expect.any(String));
    // Consent missing is the app's: fixed by an admin, it works without a minute's wait.
    const third = await f.entra.userToken(user.id, CLIENT_ID, { expiresInSeconds: 900 });
    f.entra.registerApp({ clientId: CLIENT_ID, secret: SECRET });
    expect((await refusal(auth.onBehalfOf(third, never))).subject).toBe("app");
    f.entra.registerApp({ clientId: CLIENT_ID, secret: SECRET, delegatedScopes: ["User.Read"] });
    expect(await auth.onBehalfOf(third, never)).toEqual(expect.any(String));
  });

  it("takes a bounded number of exchanges at once", async () => {
    const waiting: ((r: Response) => void)[] = [];
    const auth = graphAuth(
      options({ fetch: () => new Promise<Response>((resolve) => waiting.push(resolve)) }),
    );
    const jwt = (i: number) =>
      `h.${Buffer.from(JSON.stringify({ exp: f.clock.now / 1000 + 600, i })).toString("base64url")}.s`;
    const asked = Array.from({ length: 64 }, (_, i) => auth.onBehalfOf(jwt(i), never));
    const e = await refusal(auth.onBehalfOf(jwt(64), never));
    expect([errorCode(e), (e as unknown as { retryAfterMs: number }).retryAfterMs]).toEqual([
      "throttled",
      1000,
    ]);
    expect(waiting).toHaveLength(64);
    waiting.forEach((answer, i) => answer(token(`t${i}`)));
    expect(await Promise.all(asked)).toHaveLength(64);
    waiting.length = 0;
    const late = auth.onBehalfOf(jwt(64), never);
    waiting[0]?.(token("late"));
    expect(await late).toBe("late");
  });

  it("keeps a bounded number of people", async () => {
    let n = 0;
    const auth = graphAuth(options({ fetch: answering(() => token(`t${++n}`)) }));
    const lasting = (i: number) =>
      `h.${Buffer.from(JSON.stringify({ exp: f.clock.now / 1000 + 3600, i })).toString("base64url")}.s`;
    for (let i = 0; i < 1001; i++) await auth.onBehalfOf(lasting(i), never);
    expect(n).toBe(1001);
    await auth.onBehalfOf(lasting(1000), never); // the newest is kept
    expect(n).toBe(1001);
    await auth.onBehalfOf(lasting(0), never); // the oldest made room
    expect(n).toBe(1002);
  });

  it("refused for the person is theirs to fix; refused for consent is the app's", async () => {
    const auth = graphAuth(options());
    const user = member();

    f.entra.requireInteraction(user.id);
    const theirs = await f.entra.userToken(user.id, CLIENT_ID);
    const mfa = await refusal(auth.onBehalfOf(theirs, never));
    // Neither the person's token nor the app's secret is in what is reported.
    const told = JSON.stringify([mfa.message, String(mfa.stack), mfa.claims, mfa.entraError]);
    expect(told).not.toContain(theirs);
    expect(told).not.toContain(theirs.split(".")[2]);
    expect(told).not.toContain(SECRET);
    expect(mfa.subject).toBe("user");
    expect(mfa.entraError).toBe("interaction_required");
    expect(mfa.claims).toContain("polids");
    expect(mfa.message).toContain("multifactor");
    f.entra.requireInteraction(user.id, false);

    const gone = f.tenant.users.find((u) => !u.active) as { id: string };
    const left = await refusal(auth.onBehalfOf(await f.entra.userToken(gone.id, CLIENT_ID), never));
    expect([left.subject, left.entraCodes]).toEqual(["user", [50057]]);

    // A token meant for another app can't be redeemed by this one.
    const misdirected = await f.entra.userToken(user.id, "66666666-2222-4333-8444-555555555555");
    const wrong = await refusal(auth.onBehalfOf(misdirected, never));
    expect([wrong.subject, wrong.entraCodes]).toEqual(["user", [500131]]);
    expect(wrong.message).toContain("its audience must be this app");

    // The app's own Graph token is for Graph, and names nobody to act for.
    const own = await auth.appToken(never);
    expect((await refusal(auth.onBehalfOf(own, never))).entraCodes).toEqual([500131]);

    const unconsented = graphAuth(options({ delegatedScopes: [`${GRAPH}/Files.ReadWrite.All`] }));
    const consent = await refusal(
      unconsented.onBehalfOf(await f.entra.userToken(user.id, CLIENT_ID), never),
    );
    expect([consent.subject, consent.entraError, consent.entraCodes]).toEqual([
      "app",
      "invalid_grant",
      [65001],
    ]);
    expect(consent.message).toContain("consented");

    await expect(auth.onBehalfOf("x", AbortSignal.abort(new Error("early")))).rejects.toThrow(
      "early",
    );
  });
});

describe("its configuration", () => {
  it("names a tenant and an app, and sends credentials to an origin only", () => {
    const bad = (over: Partial<GraphAuthOptions>, why: string | RegExp) =>
      expect(() => graphAuth(options(over))).toThrow(why);
    bad({ tenant: "common" }, /tenant must be/);
    bad({ tenant: "a b" }, /tenant must be/);
    bad({ clientId: "my-app" }, /clientId must be/);
    bad({ authority: "http://login.example.com" }, /must be https/);
    bad({ authority: "https://login.example.com/tenant" }, /without a path/);
    bad({ authority: "https://user:pw@login.example.com" }, /without credentials/);
    bad({ authority: "https://login.example.com/?x=1" }, /without credentials or a query/);
    bad({ authority: "login" }, /isn't a URL/);
    // What was typed isn't repeated: it may hold a password.
    for (const typed of ["http://user:hunter2@login.example.com", "https://user:hunter2@[bad"]) {
      expect(() => graphAuth(options({ authority: typed }))).toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining("hunter2") as string,
        }) as Error,
      );
    }
    bad({ graph: "ftp://graph.example.com" }, /graph must be https/);
    bad({ credential: { kind: "secret", secret: "" } }, /secret is empty/);
    bad({ delegatedScopes: [] }, /at least one scope/);
    bad({ delegatedScopes: ["a b"] }, /without spaces/);
    // A tenant's id works as its domain does, and this machine may be plain http (tests).
    expect(
      graphAuth(
        options({
          tenant: "0f0e0d0c-0b0a-4908-8706-050403020100",
          authority: "http://127.0.0.1:8080/",
        }),
      ).graph,
    ).toBe(GRAPH);
    expect(
      graphAuth({
        tenant: "contoso.onmicrosoft.com",
        clientId: CLIENT_ID,
        credential: { kind: "secret", secret: SECRET },
      }).graph,
    ).toBe("https://graph.microsoft.com");
  });

  it("refuses a certificate it can't sign with, without quoting the key", () => {
    const other = selfSignedCertificate();
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    const bad = (credential: GraphAuthOptions["credential"], why: RegExp) =>
      expect(() => graphAuth(options({ credential }))).toThrow(why);
    bad(
      { kind: "certificate", certificate: "nonsense", privateKey: cert.privateKey },
      /isn't a PEM X.509/,
    );
    bad(
      { kind: "certificate", certificate: cert.certificate, privateKey: "nonsense" },
      /isn't a PEM private key/,
    );
    bad(
      { kind: "certificate", certificate: cert.certificate, privateKey: other.privateKey },
      /isn't the certificate's/,
    );
    bad(
      { kind: "certificate", certificate: cert.certificate, privateKey: ec },
      /must be an RSA private key/,
    );
    const pub = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
    bad(
      { kind: "certificate", certificate: cert.certificate, privateKey: pub },
      /must be an RSA private key/,
    );
  });

  it("says when its certificate has expired, before asking Entra", async () => {
    const old = selfSignedCertificate({ from: new Date("2026-01-01T00:00:00Z"), days: 30 });
    f.entra.registerApp({ clientId: CLIENT_ID, certificate: old.certificate });
    const e = await refusal(
      graphAuth(options({ credential: { kind: "certificate", ...old } })).appToken(never),
    );
    expect(e).toBeInstanceOf(GraphAuthError);
    expect(e.subject).toBe("app");
    expect(e.message).toMatch(/the certificate expired on/);
    expect(tokenRequests()).toHaveLength(0);
  });
});

describe("its helpers", () => {
  it("read a Retry-After as seconds or as a date", () => {
    const now = Date.parse("2026-10-02T12:00:00Z");
    expect(retryAfterMs("12", now)).toBe(12_000);
    expect(retryAfterMs("-3", now)).toBe(0);
    expect(retryAfterMs("Fri, 02 Oct 2026 12:00:30 GMT", now)).toBe(30_000);
    expect(retryAfterMs("Fri, 02 Oct 2026 11:00:00 GMT", now)).toBe(0);
    expect(retryAfterMs(null, now)).toBeUndefined();
    expect(retryAfterMs(" ", now)).toBeUndefined();
    expect(retryAfterMs("soon", now)).toBeUndefined();
  });

  it("read when a token lapses without trusting it", () => {
    const jwt = (claims: unknown) =>
      `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
    expect(expiryOf(jwt({ exp: 1_800_000_000 }))).toBe(1_800_000_000_000);
    expect(expiryOf(jwt({ exp: "later" }))).toBeUndefined();
    expect(expiryOf(jwt(null))).toBeUndefined();
    expect(expiryOf("h.not-json.s")).toBeUndefined();
    expect(expiryOf("opaque")).toBeUndefined();
  });
});
