import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { clientKeyOf, redirectIdentity, type ClientKind } from "@openhoard/core-identity";

/*
 * Who an MCP client is (T-105). Two ways, per the MCP authorization spec:
 *
 * - Client ID Metadata Documents (preferred): the client_id is an https URL serving a JSON
 *   document whose `client_id` is that URL, with its name and redirect URIs. OpenHoard fetches
 *   it, guarded against server-side request forgery: https only, public addresses only (checked
 *   on the address actually connected to), no redirects, 5 s, 64 KB. Cached for minutes.
 * - Dynamic client registration (older clients): registering returns a client_id that *is* the
 *   registration, `ohdcr.<base64url JSON>`: redirect URIs and a name. Registration is open to
 *   anyone, so a server-side record would add nothing but a table anyone can fill; the admin's
 *   approval, keyed by the redirect URIs, is what matters.
 *
 * Either way a client's name is only for display; what identifies it is its URL, or where its
 * codes can go.
 */

export interface ResolvedClient {
  kind: ClientKind;
  clientId: string;
  clientKey: string;
  /** Shown to people: the metadata URL, or `dcr:<key prefix>`. */
  clientRef: string;
  name: string;
  redirectUris: string[];
}

export class ClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientError";
  }
}

const MAX_REDIRECTS = 10;
const MAX_NAME = 200;

/** A redirect URI a client may register: https, or http on this machine; no fragment. */
export function checkRedirectUri(uri: unknown): string {
  if (typeof uri !== "string" || uri.length > 2048) throw new ClientError("invalid redirect_uri");
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    throw new ClientError("invalid redirect_uri");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    throw new ClientError("a redirect_uri is https, or http on the loopback address");
  }
  if (u.hash !== "" || uri.includes("#") || u.username !== "" || u.password !== "") {
    throw new ClientError("a redirect_uri has no fragment or credentials");
  }
  return uri;
}

function checkName(name: unknown, fallback: string): string {
  if (name === undefined) return fallback;
  if (typeof name !== "string") throw new ClientError("invalid client_name");
  // Control characters and direction overrides out: it is shown on the consent page.
  // eslint-disable-next-line no-control-regex
  const clean = name
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim();
  return [...clean].slice(0, MAX_NAME).join("") || fallback;
}

function checkRedirects(list: unknown): string[] {
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_REDIRECTS) {
    throw new ClientError(`redirect_uris is 1 to ${MAX_REDIRECTS} URIs`);
  }
  return [...new Set(list.map(checkRedirectUri))];
}

// ---------------------------------------------------------------------------------------------
// Dynamic client registration (RFC 7591), stateless

const DCR_PREFIX = "ohdcr.";

export interface Registration {
  redirect_uris?: unknown;
  client_name?: unknown;
  token_endpoint_auth_method?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
}

/** Registers a public client: returns its client_id and what was registered (RFC 7591). */
export function register(body: Registration): Record<string, unknown> {
  if (typeof body !== "object" || body === null) throw new ClientError("invalid registration");
  if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
    throw new ClientError("only public clients (token_endpoint_auth_method none) register");
  }
  const grants = body.grant_types ?? ["authorization_code", "refresh_token"];
  if (
    !Array.isArray(grants) ||
    !grants.every((g) => g === "authorization_code" || g === "refresh_token")
  ) {
    throw new ClientError("grant_types are authorization_code and refresh_token");
  }
  const responses = body.response_types ?? ["code"];
  if (!Array.isArray(responses) || !responses.every((r) => r === "code")) {
    throw new ClientError("response_types is code");
  }
  const redirectUris = checkRedirects(body.redirect_uris);
  const name = checkName(body.client_name, new URL(redirectUris[0] as string).host);
  const clientId =
    DCR_PREFIX + Buffer.from(JSON.stringify({ n: name, r: redirectUris })).toString("base64url");
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: grants,
    response_types: ["code"],
  };
}

function fromRegistration(clientId: string): ResolvedClient {
  if (clientId.length > 8192) throw new ClientError("invalid client_id");
  let v: { n?: unknown; r?: unknown };
  try {
    v = JSON.parse(
      Buffer.from(clientId.slice(DCR_PREFIX.length), "base64url").toString("utf8"),
    ) as {
      n?: unknown;
      r?: unknown;
    };
  } catch {
    throw new ClientError("invalid client_id");
  }
  const redirectUris = checkRedirects(v.r);
  const clientKey = clientKeyOf("dcr", redirectUris);
  return {
    kind: "dcr",
    clientId,
    clientKey,
    clientRef: `dcr:${clientKey.slice(0, 16)}`,
    name: checkName(v.n, new URL(redirectUris[0] as string).host),
    redirectUris,
  };
}

// ---------------------------------------------------------------------------------------------
// Client ID Metadata Documents

/** Fetches a client's metadata document: its body text, and for how long it may be cached. */
export type MetadataFetcher = (url: URL) => Promise<{ body: string; maxAgeSeconds?: number }>;

const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 64 * 1024;
const CACHE_DEFAULT_S = 300;
const CACHE_MAX_S = 3600;
const CACHE_ENTRIES = 1000;

/** Whether an address is one a public client can't be at: private, loopback, link-local… */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return (
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe8") ||
    v6.startsWith("fe9") ||
    v6.startsWith("fea") ||
    v6.startsWith("feb") ||
    v6.startsWith("ff") ||
    v6.startsWith("64:ff9b:") ||
    v6.startsWith("2001:db8")
  );
}

/**
 * Resolves only to public addresses; the connection uses the address checked (no second
 * lookup a DNS rebinding could change).
 */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true }).then(
    (addresses) => {
      const ok = addresses.filter((a) => !isPrivateAddress(a.address));
      if (ok.length === 0 || ok.length !== addresses.length) {
        callback(new Error(`${hostname} resolves to a non-public address`), "", 4);
        return;
      }
      const first = ok[0] as { address: string; family: number };
      if ((options as { all?: boolean }).all) {
        (callback as unknown as (e: null, a: typeof ok) => void)(null, ok);
      } else {
        callback(null, first.address, first.family);
      }
    },
    (err: Error) => callback(err as NodeJS.ErrnoException, "", 4),
  );
};

/** The real fetcher: https to public addresses, no redirects, bounded in time and size. */
export const fetchMetadata: MetadataFetcher = (url) =>
  new Promise((resolve, reject) => {
    if (url.protocol !== "https:") {
      reject(new ClientError("a client metadata URL is https"));
      return;
    }
    // An address in the URL skips the lookup, so it is checked here.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) !== 0 && isPrivateAddress(host)) {
      reject(new ClientError(`${url.hostname} is not a public address`));
      return;
    }
    const req = request(
      url,
      {
        method: "GET",
        lookup: publicLookup,
        headers: { accept: "application/json" },
        timeout: FETCH_TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new ClientError(`client metadata answered ${res.statusCode ?? "nothing"}`));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            req.destroy(new ClientError("client metadata is too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const maxAge = /max-age=(\d+)/.exec(String(res.headers["cache-control"] ?? ""))?.[1];
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            ...(maxAge !== undefined ? { maxAgeSeconds: Number(maxAge) } : {}),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new ClientError("client metadata timed out")));
    req.on("error", (err) =>
      reject(err instanceof ClientError ? err : new ClientError(`client metadata: ${err.message}`)),
    );
    req.end();
  });

/** Whether a client_id is a metadata document URL: https with a path (not just `/`). */
export function isMetadataUrl(clientId: string): boolean {
  try {
    const u = new URL(clientId);
    return (
      u.protocol === "https:" && u.pathname !== "/" && u.hash === "" && clientId.length <= 2048
    );
  } catch {
    return false;
  }
}

export class ClientResolver {
  readonly #fetch: MetadataFetcher;
  readonly #cache = new Map<string, { client: ResolvedClient; until: number }>();

  constructor(fetch: MetadataFetcher = fetchMetadata) {
    this.#fetch = fetch;
  }

  /** The client a client_id names, fetched and checked; throws ClientError when it isn't one. */
  async resolve(clientId: unknown): Promise<ResolvedClient> {
    if (typeof clientId !== "string" || clientId === "") throw new ClientError("missing client_id");
    if (clientId.startsWith(DCR_PREFIX)) return fromRegistration(clientId);
    if (!isMetadataUrl(clientId)) throw new ClientError("unknown client_id");
    const cached = this.#cache.get(clientId);
    if (cached && cached.until > Date.now()) return cached.client;
    const got = await this.#fetch(new URL(clientId));
    let doc: {
      client_id?: unknown;
      client_name?: unknown;
      redirect_uris?: unknown;
      token_endpoint_auth_method?: unknown;
    };
    try {
      doc = JSON.parse(got.body) as typeof doc;
    } catch {
      throw new ClientError("client metadata isn't JSON");
    }
    if (typeof doc !== "object" || doc === null || doc.client_id !== clientId) {
      throw new ClientError("client metadata names another client_id");
    }
    if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== "none") {
      throw new ClientError("only public clients (token_endpoint_auth_method none)");
    }
    const client: ResolvedClient = {
      kind: "cimd",
      clientId,
      clientKey: clientKeyOf("cimd", clientId),
      clientRef: clientId,
      name: checkName(doc.client_name, new URL(clientId).host),
      redirectUris: checkRedirects(doc.redirect_uris),
    };
    const ttl = Math.min(Math.max(got.maxAgeSeconds ?? CACHE_DEFAULT_S, 0), CACHE_MAX_S);
    if (this.#cache.size >= CACHE_ENTRIES) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    this.#cache.set(clientId, { client, until: Date.now() + ttl * 1000 });
    return client;
  }

  /** The key a client_id's client has, without fetching anything (the token endpoint). */
  keyOf(clientId: unknown): string | null {
    if (typeof clientId !== "string") return null;
    if (clientId.startsWith(DCR_PREFIX)) {
      try {
        return fromRegistration(clientId).clientKey;
      } catch {
        return null;
      }
    }
    return isMetadataUrl(clientId) ? clientKeyOf("cimd", clientId) : null;
  }
}

/**
 * The registered redirect URI a request names: exact, except a loopback one may use any port
 * (RFC 8252 §7.3); with none named, the client's only one.
 */
export function matchRedirect(client: ResolvedClient, asked: unknown): string | null {
  if (asked === undefined)
    return client.redirectUris.length === 1 ? (client.redirectUris[0] as string) : null;
  if (typeof asked !== "string") return null;
  if (client.redirectUris.includes(asked)) return asked;
  try {
    const u = new URL(asked);
    const loopback = u.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(u.hostname);
    if (
      loopback &&
      client.redirectUris.some((r) => redirectIdentity(r) === redirectIdentity(asked))
    ) {
      return asked;
    }
  } catch {
    return null;
  }
  return null;
}
