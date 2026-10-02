import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  connect,
  disconnect,
  fileName,
  pdfName,
  pkce,
  save,
  SaveError,
  serverOrigin,
  sourceHeader,
  type Connection,
  type Env,
} from "./lib.js";

/* The extension's side of the OAuth flow and the upload, against a stand-in server. */

const SERVER = "https://files.example.com";
const REDIRECT = "https://abcdefghijklmnop.chromiumapp.org/";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  credentials: string | undefined;
}

/** A server that behaves as OpenHoard's does, as far as the extension can tell. */
function world(
  over: Partial<{
    meta: Record<string, unknown> | null;
    authorize: (asked: URL) => string | Error;
    token: (form: URLSearchParams) => Response;
    upload: (call: Call, n: number) => Response;
    register: () => Response;
    revoke: () => Response;
  }> = {},
) {
  const calls: Call[] = [];
  let kept: Connection | null = null;
  let clock = 1_000_000;
  let uploads = 0;
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const meta =
    over.meta === undefined
      ? {
          issuer: SERVER,
          authorization_endpoint: `${SERVER}/oauth/authorize`,
          token_endpoint: `${SERVER}/oauth/token`,
          registration_endpoint: `${SERVER}/oauth/register`,
          revocation_endpoint: `${SERVER}/oauth/revoke`,
          scopes_supported: ["files:read", "files:tag", "files:add"],
        }
      : over.meta;
  let issued = 0;
  const env: Env = {
    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const call: Call = {
        url,
        method: init.method ?? "GET",
        headers: (init.headers ?? {}) as Record<string, string>,
        body: typeof init.body === "string" ? init.body : "(bytes)",
        credentials: init.credentials,
      };
      calls.push(call);
      const path = new URL(url).pathname;
      if (path === "/.well-known/oauth-authorization-server") {
        return meta === null ? new Response("no", { status: 404 }) : reply(meta);
      }
      if (path === "/oauth/register") {
        return over.register?.() ?? reply({ client_id: "ohdcr.client" }, 201);
      }
      if (path === "/oauth/token") {
        return (
          over.token?.(new URLSearchParams(call.body)) ??
          reply({
            access_token: `access-${++issued}`,
            refresh_token: `refresh-${issued}`,
            expires_in: 3600,
          })
        );
      }
      if (path === "/oauth/revoke") return over.revoke?.() ?? new Response(null, { status: 200 });
      if (path === "/api/uploads") {
        return (
          over.upload?.(call, ++uploads) ??
          reply({ object: "obj_1", title: "A page.md", created: true, newVersion: true }, 201)
        );
      }
      return new Response("?", { status: 404 });
    }) as typeof fetch,
    load: async () => kept,
    store: async (c) => {
      kept = c;
    },
    redirectUri: REDIRECT,
    authorize: async (url) => {
      const asked = new URL(url);
      const answer =
        over.authorize?.(asked) ??
        `${REDIRECT}?code=the-code&state=${asked.searchParams.get("state")}&iss=${encodeURIComponent(SERVER)}`;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    random: (n) => new Uint8Array(randomBytes(n)),
    sha256: async (d) => new Uint8Array(createHash("sha256").update(d).digest()),
    now: () => clock,
  };
  return {
    env,
    calls,
    reply,
    kept: () => kept,
    keep: (c: Connection | null) => void (kept = c),
    later: (ms: number) => void (clock += ms),
  };
}

const code = async (work: Promise<unknown>) =>
  work.then(
    () => "resolved",
    (e: unknown) => (e instanceof SaveError ? e.code : `threw ${String(e)}`),
  );

describe("serverOrigin", () => {
  it("takes https addresses, bare hosts, and http only on this machine", () => {
    expect(serverOrigin("  https://files.example.com/app/?x=1 ")).toBe("https://files.example.com");
    expect(serverOrigin("files.example.com")).toBe("https://files.example.com");
    expect(serverOrigin("http://localhost:7420/")).toBe("http://localhost:7420");
    expect(serverOrigin("http://127.0.0.1:7420")).toBe("http://127.0.0.1:7420");
    // A bare name of this machine is http; any other bare host is https.
    expect(serverOrigin("localhost:7420")).toBe("http://localhost:7420");
    expect(serverOrigin("127.0.0.1:7420/app/")).toBe("http://127.0.0.1:7420");
    expect(serverOrigin("localhost.example.com")).toBe("https://localhost.example.com");
    for (const bad of [
      "http://files.example.com",
      "ftp://x.example",
      "https://me:pw@x.example",
      "",
      "http://",
    ]) {
      expect(() => serverOrigin(bad), bad).toThrow(SaveError);
    }
  });
});

describe("pkce", () => {
  it("makes a verifier and its S256 challenge", async () => {
    const { verifier, challenge } = await pkce(world().env);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });
});

describe("connect", () => {
  it("registers, asks for files:add with PKCE, and keeps the tokens", async () => {
    const w = world();
    const connection = await connect(w.env, "files.example.com");
    expect(connection).toMatchObject({
      server: SERVER,
      clientId: "ohdcr.client",
      tokenEndpoint: `${SERVER}/oauth/token`,
      revocationEndpoint: `${SERVER}/oauth/revoke`,
      resource: `${SERVER}/mcp`,
      access: "access-1",
      refresh: "refresh-1",
      expiresAt: 1_000_000 + 3_600_000,
    });
    expect(w.kept()).toEqual(connection);
    const [, register, token] = w.calls as [Call, Call, Call];
    expect(JSON.parse(register.body)).toEqual({
      client_name: "OpenHoard browser extension",
      redirect_uris: [REDIRECT],
    });
    const form = new URLSearchParams(token.body);
    expect(Object.fromEntries(form)).toMatchObject({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: REDIRECT,
      client_id: "ohdcr.client",
      resource: `${SERVER}/mcp`,
    });
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // No cookie rides along on anything.
    expect(w.calls.every((c) => c.credentials === "omit")).toBe(true);
  });

  it("asks the authorization endpoint for exactly what it needs", async () => {
    let asked: URL | undefined;
    const w = world({
      authorize: (url) => {
        asked = url;
        return `${REDIRECT}?code=c&state=${url.searchParams.get("state")}`;
      },
    });
    await connect(w.env, SERVER);
    expect(`${asked?.origin}${asked?.pathname}`).toBe(`${SERVER}/oauth/authorize`);
    expect(Object.fromEntries(asked?.searchParams ?? [])).toMatchObject({
      response_type: "code",
      client_id: "ohdcr.client",
      redirect_uri: REDIRECT,
      code_challenge_method: "S256",
      scope: "files:add",
      resource: `${SERVER}/mcp`,
    });
  });

  it("refuses a server that isn't one, or that names endpoints elsewhere", async () => {
    expect(await code(connect(world({ meta: null }).env, SERVER))).toBe("server");
    const elsewhere = {
      issuer: SERVER,
      authorization_endpoint: `${SERVER}/oauth/authorize`,
      token_endpoint: "https://evil.example/token",
      registration_endpoint: `${SERVER}/oauth/register`,
      scopes_supported: ["files:add"],
    };
    expect(await code(connect(world({ meta: elsewhere }).env, SERVER))).toBe("server");
    expect(
      await code(
        connect(world({ meta: { ...elsewhere, issuer: "https://other.example" } }).env, SERVER),
      ),
    ).toBe("server");
    expect(
      await code(
        connect(world({ meta: { ...elsewhere, token_endpoint: "not a url" } }).env, SERVER),
      ),
    ).toBe("server");
    expect(await code(connect(world().env, "http://files.example.com"))).toBe("address");
    expect(
      await code(
        connect(world({ register: () => new Response("no", { status: 400 }) }).env, SERVER),
      ),
    ).toBe("server");
  });

  it("says when the server doesn't take files", async () => {
    const meta = {
      issuer: SERVER,
      authorization_endpoint: `${SERVER}/oauth/authorize`,
      token_endpoint: `${SERVER}/oauth/token`,
      registration_endpoint: `${SERVER}/oauth/register`,
      scopes_supported: ["files:read", "files:tag"],
    };
    const w = world({ meta });
    await expect(connect(w.env, SERVER)).rejects.toThrow(/doesn't take files yet/);
    // Nothing was registered or asked for.
    expect(w.calls).toHaveLength(1);
  });

  it("takes only this sign-in's answer, from this server", async () => {
    const answers: ((asked: URL) => string | Error)[] = [
      () => new Error("closed"),
      () => `${REDIRECT}?code=c&state=someone-elses`,
      (a) =>
        `${REDIRECT}?code=c&state=${a.searchParams.get("state")}&iss=https%3A%2F%2Fevil.example`,
      (a) => `https://evil.example/?code=c&state=${a.searchParams.get("state")}`,
      (a) => `${REDIRECT}?error=access_denied&state=${a.searchParams.get("state")}`,
    ];
    for (const authorize of answers) {
      const w = world({ authorize });
      expect(await code(connect(w.env, SERVER))).toBe("refused");
      expect(w.kept()).toBeNull();
      expect(w.calls.some((c) => c.url.endsWith("/oauth/token"))).toBe(false);
    }
    const noToken = world({ token: () => new Response("{}", { status: 400 }) });
    expect(await code(connect(noToken.env, SERVER))).toBe("refused");
    for (const token of [
      () => new Response("not json", { status: 200 }),
      () => new Response("down", { status: 503 }),
    ]) {
      expect(await code(connect(world({ token }).env, SERVER))).toBe("refused");
    }
    // A server that says it names itself in the answer must.
    const says = world({
      meta: {
        issuer: SERVER,
        authorization_endpoint: `${SERVER}/oauth/authorize`,
        token_endpoint: `${SERVER}/oauth/token`,
        registration_endpoint: `${SERVER}/oauth/register`,
        scopes_supported: ["files:add"],
        authorization_response_iss_parameter_supported: true,
      },
      authorize: (a) => `${REDIRECT}?code=c&state=${a.searchParams.get("state")}`,
    });
    expect(await code(connect(says.env, SERVER))).toBe("refused");
  });
});

describe("save", () => {
  const file = {
    name: "A page.md",
    type: "text/markdown; charset=utf-8",
    body: "# A page\n",
    url: "https://example.com/a?b=c&d#section",
  };

  it("uploads with the token, the name and the address, and no cookie", async () => {
    const w = world();
    await connect(w.env, SERVER);
    const saved = await save(w.env, file);
    expect(saved).toEqual({ object: "obj_1", title: "A page.md", created: true, newVersion: true });
    const call = w.calls.at(-1) as Call;
    const url = new URL(call.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${SERVER}/api/uploads`);
    // The address rides in a header (addresses hold secrets; queries get logged), without
    // its fragment.
    expect(Object.fromEntries(url.searchParams)).toEqual({ name: "A page.md" });
    expect(call).toMatchObject({
      method: "POST",
      credentials: "omit",
      headers: {
        authorization: "Bearer access-1",
        "content-type": file.type,
        "x-openhoard-source-url": "https://example.com/a?b=c&d",
      },
      body: "# A page\n",
    });
  });

  it("asks to connect when there is no connection", async () => {
    expect(await code(save(world().env, file))).toBe("connect");
  });

  it("renews a token about to run out before using it", async () => {
    const w = world();
    await connect(w.env, SERVER);
    w.later(3_600_000 - 30_000);
    await save(w.env, { name: "x.pdf", type: "application/pdf", body: new Blob(["%PDF"]) });
    const [refresh, upload] = w.calls.slice(-2) as [Call, Call];
    expect(Object.fromEntries(new URLSearchParams(refresh.body))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: "ohdcr.client",
      resource: `${SERVER}/mcp`,
    });
    expect(upload.headers.authorization).toBe("Bearer access-2");
    expect("x-openhoard-source-url" in upload.headers).toBe(false);
    expect(w.kept()).toMatchObject({ access: "access-2", refresh: "refresh-2" });
  });

  it("renews once when the server says the token ran out, and sends again", async () => {
    const w = world({
      upload: (_call, n) =>
        n === 1
          ? new Response("{}", { status: 401 })
          : new Response(
              JSON.stringify({ object: "obj_2", title: "t", created: false, newVersion: false }),
              { status: 200 },
            ),
    });
    await connect(w.env, SERVER);
    expect(await save(w.env, file)).toMatchObject({ object: "obj_2", created: false });
    expect(w.calls.slice(-3).map((c) => new URL(c.url).pathname)).toEqual([
      "/api/uploads",
      "/oauth/token",
      "/api/uploads",
    ]);
  });

  it("forgets a connection the server no longer honours", async () => {
    // The refresh is refused.
    const gone = world({
      upload: () => new Response("{}", { status: 401 }),
      token: (form) =>
        form.get("grant_type") === "refresh_token"
          ? new Response("{}", { status: 400 })
          : new Response(
              JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
            ),
    });
    await connect(gone.env, SERVER);
    expect(await code(save(gone.env, file))).toBe("connect");
    expect(gone.kept()).toBeNull();
    // The refresh works and the new token is refused too.
    const still = world({ upload: () => new Response("{}", { status: 401 }) });
    await connect(still.env, SERVER);
    expect(await code(save(still.env, file))).toBe("connect");
    expect(still.kept()).toBeNull();
    // No refresh token at all.
    const none = world({ upload: () => new Response("{}", { status: 401 }) });
    await connect(none.env, SERVER);
    none.keep({ ...(none.kept() as Connection), refresh: null });
    expect(await code(save(none.env, file))).toBe("connect");
  });

  it("renews once for two saves at the same moment", async () => {
    const w = world();
    await connect(w.env, SERVER);
    w.later(3_600_000);
    const both = await Promise.all([save(w.env, file), save(w.env, file)]);
    expect(both).toHaveLength(2);
    // The server takes a refresh token once: presented twice, it would end the grant.
    const renewals = w.calls.filter((c) => c.body.includes("grant_type=refresh_token"));
    expect(renewals).toHaveLength(1);
    expect(w.calls.slice(-2).map((c) => c.headers.authorization)).toEqual([
      "Bearer access-2",
      "Bearer access-2",
    ]);
  });

  it("keeps the connection when the server can't renew just now", async () => {
    for (const status of [500, 502, 429]) {
      const w = world({
        token: (form) =>
          form.get("grant_type") === "refresh_token"
            ? new Response("busy", { status })
            : new Response(
                JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
              ),
      });
      await connect(w.env, SERVER);
      w.later(3_600_000);
      expect(await code(save(w.env, file))).toBe("failed");
      expect(w.kept()).toMatchObject({ access: "a", refresh: "r" });
    }
  });

  it("leaves a disconnect made during a renewal standing", async () => {
    const w: ReturnType<typeof world> = world({
      token: (form) => {
        // The person disconnects (on the options page) while the server answers.
        if (form.get("grant_type") === "refresh_token") w.keep(null);
        return new Response(
          JSON.stringify({ access_token: "new", refresh_token: "new-r", expires_in: 3600 }),
        );
      },
    });
    await connect(w.env, SERVER);
    w.later(3_600_000);
    expect(await code(save(w.env, file))).toBe("connect");
    expect(w.kept()).toBeNull();
  });

  it("sends no address that isn't a web one, and saves all the same", async () => {
    const w = world();
    await connect(w.env, SERVER);
    for (const url of [
      "file:///C:/notes.html",
      "chrome-extension://abc/page.html",
      "https://me:pw@x.example/",
      `https://x.example/${"p".repeat(5000)}`,
      "nope",
    ]) {
      await save(w.env, { ...file, url });
      expect("x-openhoard-source-url" in (w.calls.at(-1) as Call).headers, url).toBe(false);
    }
    expect(sourceHeader("https://x.example/a b#frag")).toBe("https://x.example/a%20b");
  });

  it("keeps the connection when the server can't be reached", async () => {
    const w = world();
    await connect(w.env, SERVER);
    const before = w.kept();
    const down: Env = {
      ...w.env,
      fetch: (() => Promise.reject(new TypeError("offline"))) as typeof fetch,
    };
    expect(await code(save(down, file))).toBe("failed");
    w.later(3_600_000);
    expect(await code(save(down, file))).toBe("failed");
    expect(w.kept()).toEqual(before);
  });

  it("says why the server didn't take a file", async () => {
    const big = world({ upload: () => new Response("{}", { status: 413 }) });
    await connect(big.env, SERVER);
    expect(await code(save(big.env, file))).toBe("too-large");
    const refused = world({
      upload: () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    await connect(refused.env, SERVER);
    await expect(save(refused.env, file)).rejects.toThrow("The server didn't take it: forbidden.");
    const odd = world({ upload: () => new Response("<html>", { status: 502 }) });
    await connect(odd.env, SERVER);
    await expect(save(odd.env, file)).rejects.toThrow("refused (502)");
    const bare = world({ upload: () => new Response("[]", { status: 201 }) });
    await connect(bare.env, SERVER);
    expect(await save(bare.env, file)).toEqual({
      object: "",
      title: "A page.md",
      created: false,
      newVersion: false,
    });
  });
});

describe("disconnect", () => {
  it("forgets the connection and tells the server", async () => {
    const w = world();
    await connect(w.env, SERVER);
    await disconnect(w.env);
    expect(w.kept()).toBeNull();
    const call = w.calls.at(-1) as Call;
    expect(call.url).toBe(`${SERVER}/oauth/revoke`);
    expect(Object.fromEntries(new URLSearchParams(call.body))).toEqual({
      token: "refresh-1",
      client_id: "ohdcr.client",
    });
  });

  it("forgets it whether or not the server hears", async () => {
    const w = world();
    await disconnect(w.env);
    expect(w.calls).toEqual([]);
    await connect(w.env, SERVER);
    w.keep({ ...(w.kept() as Connection), revocationEndpoint: null });
    await disconnect(w.env);
    expect(w.kept()).toBeNull();
    await connect(w.env, SERVER);
    w.keep({ ...(w.kept() as Connection), refresh: null });
    const down: Env = {
      ...w.env,
      fetch: (() => Promise.reject(new TypeError("offline"))) as typeof fetch,
    };
    await disconnect(down);
    expect(w.kept()).toBeNull();
  });
});

describe("names", () => {
  it("makes a file name from a title", () => {
    expect(fileName('What: a "title" / of <sorts>?', "md")).toBe("What a title of sorts.md");
    expect(fileName("  ", "md")).toBe("Saved page.md");
    expect([...fileName("x".repeat(300), "md")].length).toBe(123);
    expect(fileName("tab\there", "md")).toBe("tab here.md");
  });

  it("names a PDF by its address", () => {
    expect(pdfName("https://example.com/papers/Attention%20Is%20All.pdf?dl=1")).toBe(
      "Attention Is All.pdf",
    );
    expect(pdfName("https://example.com/download")).toBe("download.pdf");
    expect(pdfName("https://example.com/")).toBe("example.com.pdf");
    expect(pdfName("https://example.com/%E0%A4%A.pdf")).toBe("example.com.pdf");
    expect(pdfName("not an address")).toBe("document.pdf");
  });
});
