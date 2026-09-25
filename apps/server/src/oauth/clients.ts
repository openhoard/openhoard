import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { clientKeyOf, redirectIdentity, type ClientKind } from "@openhoard/core-identity";

/*
 * Who an MCP client is (T-105). Two ways, per the MCP authorization spec:
 *
 * - Client ID Metadata Documents (preferred): the client_id is an https URL serving a JSON
 *   document whose `client_id` is that URL, with its name and redirect URIs. OpenHoard fetches
 *   it, only for a signed-in person, guarded against server-side request forgery: https to a
 *   named host (no address in the URL), public addresses only (checked on the address actually
 *   connected to), no redirects, 5 s in all, 64 KB, a few at a time; results (and failures) are
 *   cached for minutes.
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
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// Control characters and direction overrides: never shown on a page.
// eslint-disable-next-line no-control-regex
const UNSHOWN = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

/** A redirect URI a client may register: https, or http on this machine; no fragment. */
export function checkRedirectUri(uri: unknown): string {
  if (typeof uri !== "string" || uri.length > 2048 || CONTROL.test(uri)) {
    throw new ClientError("invalid redirect_uri");
  }
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    throw new ClientError("invalid redirect_uri");
  }
  const loopback = LOOPBACK.includes(u.hostname);
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
  const clean = name.replace(UNSHOWN, "").trim();
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
  const encoded = Buffer.from(JSON.stringify({ n: name, r: redirectUris })).toString("base64url");
  return {
    client_id: DCR_PREFIX + encoded,
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
  const encoded = clientId.slice(DCR_PREFIX.length);
  const raw = Buffer.from(encoded, "base64url");
  // Only the exact encoding register() made: no junk characters decoding to the same client.
  if (raw.toString("base64url") !== encoded) throw new ClientError("invalid client_id");
  let v: { n?: unknown; r?: unknown };
  try {
    v = JSON.parse(raw.toString("utf8")) as { n?: unknown; r?: unknown };
  } catch {
    throw new ClientError("invalid client_id");
  }
  if (typeof v !== "object" || v === null) throw new ClientError("invalid client_id");
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
const MAX_IN_FLIGHT = 8;
const FAILURE_CACHE_MS = 60_000;

/** Addresses a public client can't be at: private, loopback, link-local, reserved, translated. */
const NON_PUBLIC_V4 = new BlockList();
// Separate lists: Node checks an IPv4 address against IPv6 rules too (as ::ffff:a.b.c.d), and
// the IPv6 list blocks every mapped address.
const NON_PUBLIC_V6 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC_V4.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  // Unspecified, loopback and every IPv4-embedding form (compatible, mapped, NAT64, 6to4,
  // Teredo), any of which could name a private IPv4 address.
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  NON_PUBLIC_V6.addSubnet(net, prefix, "ipv6");
}

/** Whether an address is one a public client can't be at (anything but a plain public one). */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return family === 4 ? NON_PUBLIC_V4.check(address, "ipv4") : NON_PUBLIC_V6.check(address, "ipv6");
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
        callback(new Error("the host resolves to a non-public address"), "", 4);
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

const unbracket = (host: string) => host.replace(/^\[|\]$/g, "");

/** The real fetcher: https to public addresses of a named host, no redirects, bounded. */
export const fetchMetadata: MetadataFetcher = (url) =>
  new Promise((resolve, reject) => {
    if (url.protocol !== "https:") {
      reject(new ClientError("a client metadata URL is https"));
      return;
    }
    // Clients are named by their domain: an address in the URL (which would skip the lookup)
    // isn't one.
    if (isIP(unbracket(url.hostname)) !== 0) {
      reject(new ClientError("a client metadata URL names a host, not an address"));
      return;
    }
    const req = request(
      url,
      { method: "GET", lookup: publicLookup, headers: { accept: "application/json" } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new ClientError("client metadata couldn't be fetched"));
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
    // The whole exchange, not each silence, gets FETCH_TIMEOUT_MS.
    const timer = setTimeout(
      () => req.destroy(new ClientError("client metadata timed out")),
      FETCH_TIMEOUT_MS,
    );
    req.on("close", () => clearTimeout(timer));
    // What failed stays here (no port-scan oracle): the caller learns only that it did.
    req.on("error", (err) =>
      reject(
        err instanceof ClientError ? err : new ClientError("client metadata couldn't be fetched"),
      ),
    );
    req.end();
  });

/**
 * Whether a client_id is a metadata document URL: https to a named host, with a path, written
 * exactly as a URL parser writes it (no credentials, dot segments or fragment that would make
 * one client look like another).
 */
export function isMetadataUrl(clientId: string): boolean {
  if (clientId.length > 2048 || CONTROL.test(clientId)) return false;
  try {
    const u = new URL(clientId);
    return (
      u.protocol === "https:" &&
      u.pathname !== "/" &&
      u.href === clientId &&
      u.username === "" &&
      u.password === "" &&
      u.hash === "" &&
      isIP(unbracket(u.hostname)) === 0
    );
  } catch {
    return false;
  }
}

export class ClientResolver {
  readonly #fetch: MetadataFetcher;
  readonly #cache = new Map<string, { client: ResolvedClient; until: number }>();
  readonly #failed = new Map<string, { error: ClientError; until: number }>();
  readonly #inFlight = new Map<string, Promise<ResolvedClient>>();

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
    const failed = this.#failed.get(clientId);
    if (failed && failed.until > Date.now()) throw failed.error;
    const running = this.#inFlight.get(clientId);
    if (running) return running;
    if (this.#inFlight.size >= MAX_IN_FLIGHT) {
      throw new ClientError("too many clients being checked; try again shortly");
    }
    const work = this.#fetchAndCheck(clientId).catch((err: unknown) => {
      const error =
        err instanceof ClientError ? err : new ClientError("client metadata couldn't be fetched");
      if (this.#failed.size >= CACHE_ENTRIES) this.#failed.clear();
      this.#failed.set(clientId, { error, until: Date.now() + FAILURE_CACHE_MS });
      throw error;
    });
    this.#inFlight.set(clientId, work);
    try {
      return await work;
    } finally {
      this.#inFlight.delete(clientId);
    }
  }

  async #fetchAndCheck(clientId: string): Promise<ResolvedClient> {
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

  /** A client_id's key and display ref, without fetching anything (the token endpoint). */
  keyOf(clientId: unknown): { clientKey: string; clientRef: string } | null {
    if (typeof clientId !== "string") return null;
    if (clientId.startsWith(DCR_PREFIX)) {
      try {
        const r = fromRegistration(clientId);
        return { clientKey: r.clientKey, clientRef: r.clientRef };
      } catch {
        return null;
      }
    }
    return isMetadataUrl(clientId)
      ? { clientKey: clientKeyOf("cimd", clientId), clientRef: clientId }
      : null;
  }
}

/**
 * The registered redirect URI a request names: exact, except a loopback one may use any port
 * (RFC 8252 §7.3). The request must name it (the token request names it again).
 */
export function matchRedirect(client: ResolvedClient, asked: unknown): string | null {
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
