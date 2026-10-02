/*
 * What the extension does that isn't the browser's (T-1207): connecting to a person's OpenHoard
 * server as an OAuth client, keeping its tokens fresh, and uploading what was captured. Everything
 * the browser provides comes in through `Env`, so this runs (and is tested) outside one.
 *
 * - The extension is a public OAuth 2.1 client of the person's own server: it registers itself
 *   (RFC 7591; its identity is where its codes go, the browser's redirect address for this
 *   extension), asks for `files:add` only, with PKCE (S256), and gets tokens for that server's
 *   resource. An admin of the server approves it once, on the page that opens; the person then
 *   allows it. It can add files as them and read nothing.
 * - Nothing leaves for anywhere but the server the person typed: its address is checked
 *   (https, or http on this machine only), and every endpoint its metadata names must be on it.
 * - Tokens live in the extension's own storage. The access token is renewed with the refresh
 *   token when it is about to run out, or once when the server says it has (401); one renewal
 *   at a time, since the server takes a refresh token once. When the server refuses the
 *   renewal the connection is forgotten, and the person connects again; when it just can't be
 *   reached, the connection stands.
 */

export const SCOPE = "files:add";
export const CLIENT_NAME = "OpenHoard browser extension";
/** Renewed when it has less than this left. */
const FRESH_MS = 60_000;

/** What is kept between runs. */
export interface Connection {
  /** The server's origin, e.g. `https://files.example.com`. */
  server: string;
  clientId: string;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
  /** The resource tokens are for (the server's MCP address). */
  resource: string;
  access: string;
  refresh: string | null;
  /** When the access token runs out (ms since the epoch). */
  expiresAt: number;
}

export interface Env {
  fetch: typeof fetch;
  load(): Promise<Connection | null>;
  store(connection: Connection | null): Promise<void>;
  /** Where the server sends the code: the browser's redirect address for this extension. */
  redirectUri: string;
  /** Shows `url` to the person and resolves with the address it ended at (the redirect). */
  authorize(url: string): Promise<string>;
  random(bytes: number): Uint8Array;
  sha256(data: Uint8Array): Promise<Uint8Array>;
  now(): number;
}

export type SaveErrorCode =
  /** The address isn't one the extension will talk to. */
  | "address"
  /** Not an OpenHoard server, or one that can't take files. */
  | "server"
  /** The person, or an admin, said no; or the window was closed. */
  | "refused"
  /** No connection, or one the server no longer honours: connect again. */
  | "connect"
  | "too-large"
  /** The server refused the file, or couldn't be reached. */
  | "failed";

export class SaveError extends Error {
  constructor(
    readonly code: SaveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SaveError";
  }
}

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The origin of the address a person typed: https, or http on this machine. Throws otherwise. */
export function serverOrigin(typed: string): string {
  const text = typed.trim();
  let url: URL;
  try {
    // A bare host is https, but for this machine's own names, which are http.
    const bare = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(text) ? "http" : "https";
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `${bare}://${text}`);
  } catch {
    throw new SaveError("address", "That isn't an address.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new SaveError("address", "An address without a name or password in it.");
  }
  const local = LOCAL.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new SaveError("address", "The server's address starts with https://.");
  }
  return url.origin;
}

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** A PKCE verifier and its S256 challenge. */
export async function pkce(env: Pick<Env, "random" | "sha256">) {
  const verifier = b64url(env.random(32));
  const challenge = b64url(await env.sha256(new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await res.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** An endpoint the metadata names, if it is on the server itself. */
function endpoint(server: string, value: unknown): string | null {
  const s = text(value);
  if (s === null) return null;
  try {
    return new URL(s).origin === server ? s : null;
  } catch {
    return null;
  }
}

interface Tokens {
  access: string;
  refresh: string | null;
  expiresAt: number;
}

/**
 * Asks the token endpoint. Null when it says no to what was presented (a 400 or 401: the code,
 * or the refresh token, is no good); throws when it couldn't be asked or answered oddly (a
 * failure in between, a 5xx, a 429), which says nothing about the grant.
 */
async function tokenRequest(
  env: Pick<Env, "fetch" | "now">,
  tokenEndpoint: string,
  form: Record<string, string>,
): Promise<Tokens | null> {
  const res = await env.fetch(tokenEndpoint, {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  if (res.status === 400 || res.status === 401) return null;
  if (!res.ok) throw new Error(`token endpoint answered ${res.status}`);
  const body = await json(res);
  const access = text(body.access_token);
  if (access === null) throw new Error("token endpoint gave no token");
  const seconds = typeof body.expires_in === "number" ? body.expires_in : 300;
  return { access, refresh: text(body.refresh_token), expiresAt: env.now() + seconds * 1000 };
}

/**
 * Connects to the server at `typed`: finds its endpoints, registers, sends the person there to
 * sign in and allow it, and keeps the tokens. Resolves with the connection.
 */
export async function connect(env: Env, typed: string): Promise<Connection> {
  const server = serverOrigin(typed);
  let meta: Record<string, unknown>;
  try {
    const res = await env.fetch(`${server}/.well-known/oauth-authorization-server`, {
      credentials: "omit",
    });
    if (!res.ok) throw new Error(String(res.status));
    meta = await json(res);
  } catch {
    throw new SaveError("server", `No OpenHoard server answered at ${server}.`);
  }
  const authorization = endpoint(server, meta.authorization_endpoint);
  const tokenEndpoint = endpoint(server, meta.token_endpoint);
  const registration = endpoint(server, meta.registration_endpoint);
  if (meta.issuer !== server || !authorization || !tokenEndpoint || !registration) {
    throw new SaveError("server", `${server} isn't an OpenHoard server this extension can use.`);
  }
  const scopes = Array.isArray(meta.scopes_supported) ? meta.scopes_supported : [];
  if (!scopes.includes(SCOPE)) {
    throw new SaveError(
      "server",
      `${server} doesn't take files yet: its admin turns that on ("uploads" in its config).`,
    );
  }

  const registered = await env
    .fetch(registration, {
      method: "POST",
      credentials: "omit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: CLIENT_NAME, redirect_uris: [env.redirectUri] }),
    })
    .then(async (res) => (res.ok ? text((await json(res)).client_id) : null))
    .catch(() => null);
  if (registered === null)
    throw new SaveError("server", `${server} didn't register the extension.`);

  const { verifier, challenge } = await pkce(env);
  const state = b64url(env.random(16));
  const resource = `${server}/mcp`;
  const ask = new URL(authorization);
  ask.search = new URLSearchParams({
    response_type: "code",
    client_id: registered,
    redirect_uri: env.redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: SCOPE,
    state,
    resource,
  }).toString();

  let ended: URL;
  try {
    ended = new URL(await env.authorize(ask.href));
  } catch {
    throw new SaveError("refused", "The sign-in window was closed before it finished.");
  }
  const answer = ended.searchParams;
  // The answer is this request's (state), from this server (RFC 9207: required of a server
  // that says it sends it, checked whenever it is there), at our own address.
  const iss = answer.get("iss");
  const issExpected = meta.authorization_response_iss_parameter_supported === true;
  if (
    `${ended.origin}${ended.pathname}` !== env.redirectUri.split("?")[0] ||
    answer.get("state") !== state ||
    (iss === null ? issExpected : iss !== server)
  ) {
    throw new SaveError("refused", "The answer wasn't the one this sign-in asked for.");
  }
  const code = answer.get("code");
  if (code === null) {
    const why = answer.get("error_description") ?? answer.get("error") ?? "no code";
    throw new SaveError("refused", `The server didn't allow it (${why.slice(0, 200)}).`);
  }
  const tokens = await tokenRequest(env, tokenEndpoint, {
    grant_type: "authorization_code",
    code,
    redirect_uri: env.redirectUri,
    client_id: registered,
    code_verifier: verifier,
    resource,
  }).catch(() => null);
  if (tokens === null) throw new SaveError("refused", "The server gave no token for the code.");

  const connection: Connection = {
    server,
    clientId: registered,
    tokenEndpoint,
    revocationEndpoint: endpoint(server, meta.revocation_endpoint),
    resource,
    ...tokens,
  };
  await env.store(connection);
  return connection;
}

/** Forgets the connection, telling the server to end it (best effort). */
export async function disconnect(env: Env): Promise<void> {
  const c = await env.load();
  await env.store(null);
  if (!c || c.revocationEndpoint === null) return;
  await env
    .fetch(c.revocationEndpoint, {
      method: "POST",
      credentials: "omit",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: c.refresh ?? c.access, client_id: c.clientId }).toString(),
    })
    .catch(() => undefined);
}

/** One renewal at a time: the server takes a refresh token once, and ends the grant if it sees it twice. */
let renewing: Promise<Connection | null> | null = null;

/**
 * Renews the access token `stale` holds; null (and the connection forgotten) when the server
 * won't. Two saves at once share one renewal, and a save that finds the token already renewed
 * (by the other one, or by another page of the extension) uses that.
 */
function renew(env: Env, stale: Connection): Promise<Connection | null> {
  renewing ??= (async () => {
    const c = await env.load();
    if (c === null) return null;
    if (c.access !== stale.access) return c;
    if (c.refresh === null) {
      await env.store(null);
      return null;
    }
    let tokens: Tokens | null;
    try {
      tokens = await tokenRequest(env, c.tokenEndpoint, {
        grant_type: "refresh_token",
        refresh_token: c.refresh,
        client_id: c.clientId,
        resource: c.resource,
      });
    } catch {
      // Not reached, or not itself just now: the connection stands.
      throw new SaveError("failed", `Couldn't reach ${c.server}.`);
    }
    if (tokens === null) {
      await env.store(null);
      return null;
    }
    const next = { ...c, ...tokens, refresh: tokens.refresh ?? c.refresh };
    // Disconnected, or connected afresh, while the server answered (on the options page):
    // that stands, and this renewal is nobody's.
    const now = await env.load();
    if (now === null || now.refresh !== c.refresh) return now;
    await env.store(next);
    return next;
  })().finally(() => {
    renewing = null;
  });
  return renewing;
}

export interface Saving {
  /** The file's name, with its extension. */
  name: string;
  /** Its media type. */
  type: string;
  body: Blob | string;
  /** The address it was saved from. */
  url?: string;
}

export interface Saved {
  object: string;
  title: string;
  /** False when OpenHoard had this file already. */
  created: boolean;
  /** True when it had the file and this is new content for it (a page saved again). */
  newVersion: boolean;
}

/** Uploads one file as the connected person. */
export async function save(env: Env, file: Saving): Promise<Saved> {
  const again = () => new SaveError("connect", "Connect to your OpenHoard server first.");
  let c = await env.load();
  if (c === null) throw again();
  if (c.expiresAt - env.now() < FRESH_MS) {
    c = await renew(env, c);
    if (c === null) throw again();
  }
  const from = sourceHeader(file.url);
  const send = (connection: Connection) => {
    const to = new URL("/api/uploads", connection.server);
    to.searchParams.set("name", file.name);
    return env
      .fetch(to.href, {
        method: "POST",
        // The token is the whole credential: no cookie rides along.
        credentials: "omit",
        headers: {
          authorization: `Bearer ${connection.access}`,
          "content-type": file.type,
          // In a header, not the address: where a page is from can hold secrets.
          ...(from === null ? {} : { "x-openhoard-source-url": from }),
        },
        body: file.body,
      })
      .catch(() => {
        throw new SaveError("failed", `Couldn't reach ${connection.server}.`);
      });
  };
  let res = await send(c);
  if (res.status === 401) {
    // Run out, or taken away: one renewal says which.
    c = await renew(env, c);
    if (c === null) throw again();
    res = await send(c);
    if (res.status === 401) {
      await env.store(null);
      throw again();
    }
  }
  if (res.status === 413) throw new SaveError("too-large", "Too large for this server.");
  const body = await json(res);
  if (!res.ok) {
    const why = text(body.error) ?? `refused (${res.status})`;
    throw new SaveError("failed", `The server didn't take it: ${why.slice(0, 200)}.`);
  }
  return {
    object: text(body.object) ?? "",
    title: text(body.title) ?? file.name,
    created: body.created === true,
    newVersion: body.newVersion === true,
  };
}

/**
 * Where a file is from, as the server takes it: an http(s) address without credentials or its
 * fragment, of a length it keeps. Anything else (a file on this machine, an extension's page)
 * is no reason to refuse the save: the file goes without one.
 */
export function sourceHeader(address: string | undefined): string | null {
  if (address === undefined) return null;
  try {
    const u = new URL(address);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) {
      return null;
    }
    u.hash = "";
    return u.href.length <= 4096 ? u.href : null;
  } catch {
    return null;
  }
}

/** A file name from a page's title: what a title can't hold in a name is spaced out. */
export function fileName(title: string, extension: string): string {
  const clean = title
    // eslint-disable-next-line no-control-regex -- control characters are what is replaced
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const base = [...(clean || "Saved page")].slice(0, 120).join("").trim();
  return `${base}.${extension}`;
}

/** A PDF's name from its address: the last part of the path, else the host. */
export function pdfName(address: string): string {
  let last = "";
  let host = "document";
  try {
    const u = new URL(address);
    host = u.hostname || host;
    last = decodeURIComponent(u.pathname.split("/").pop() ?? "");
  } catch {
    // Not an address, or not decodable: the fallback name.
  }
  const base = last.replace(/\.pdf$/i, "");
  return fileName(base || host, "pdf");
}
