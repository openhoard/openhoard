import {
  constants,
  createHash,
  createPrivateKey,
  randomUUID,
  sign,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import { ConnectorError, isAbortError } from "@openhoard/sdk";
import { nameOf, objectOf, retryAfterMs } from "./http.js";

/*
 * Signing in to Microsoft Graph (T-302): an app-only token (the client credentials grant) from
 * Entra ID's v2 token endpoint. With the application permission `Sites.Selected` the app
 * reaches only the sites an admin granted it, one by one; it holds nothing tenant-wide.
 *
 * The app proves itself with a certificate (an assertion signed with its private key, which
 * never leaves this process) or a client secret. The token is kept in memory only, until
 * shortly before it lapses; nothing here writes it anywhere, and no message holds it.
 *
 * Failures are ConnectorErrors: `auth` when Entra refuses (a {@link GraphAuthError}, with what
 * it said), `throttled` or `retryable` when it is busy.
 */

export type ClientCredential =
  | { kind: "secret"; secret: string }
  | {
      kind: "certificate";
      /** The certificate registered for the app in Entra, PEM. Only its thumbprint is sent. */
      certificate: string;
      /** Its private key: PEM (PKCS #8 or PKCS #1, not encrypted) or a KeyObject. RSA. */
      privateKey: string | KeyObject;
    };

export interface GraphAuthOptions {
  /** The Entra tenant: its id (a GUID) or a domain it has verified. Never `common`. */
  tenant: string;
  /** The app registration's application (client) id. */
  clientId: string;
  credential: ClientCredential;
  /** Where Entra is. Default `https://login.microsoftonline.com` (a national cloud has its own). */
  authority?: string;
  /** Where Graph is. Default `https://graph.microsoft.com`. */
  graph?: string;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Milliseconds. Default `Date.now`. */
  now?: () => number;
  /** How long one token request may take. Default 30 s. */
  timeoutMs?: number;
}

export interface GraphAuth {
  /** Where Graph is, without a slash at the end. */
  readonly graph: string;
  /**
   * The app in its tenant, as Graph limits it: every connector signed in as the same account
   * shares one budget of requests (pace.ts). Nothing secret: the tenant and the client id.
   */
  readonly account?: string;
  /** How the app proves itself: SharePoint's own API takes app-only tokens from a certificate only. */
  readonly credential?: ClientCredential["kind"];
  /**
   * An app-only token for Graph, or for `resource` (an origin: the tenant's SharePoint, whose
   * REST API says who is in a site's groups).
   */
  appToken(signal: AbortSignal, resource?: string): Promise<string>;
  /** Drops a token Graph refused, so the next call asks Entra for a new one. */
  forget(token: string): void;
}

/**
 * An `auth` ConnectorError from Entra, with what it said. Nothing works until an admin fixes
 * the registration, the credential or consent.
 */
export class GraphAuthError extends ConnectorError {
  /** Entra's `error` (`invalid_client`, `invalid_grant`). */
  readonly entraError: string;
  /** Its AADSTS codes. */
  readonly entraCodes: readonly number[];

  constructor(message: string, details: { error: string; codes?: readonly number[] }) {
    super("auth", message);
    this.entraError = details.error;
    this.entraCodes = details.codes ?? [];
  }
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
/** A client assertion is used once, at once: five minutes covers a slow request and no more. */
const ASSERTION_SECONDS = 300;
/** A token is replaced this long before it lapses (or halfway through a shorter life). */
const EARLY_MS = 300_000;
/** No token is kept longer than a day, whatever its answer says. */
const MAX_LIFE_MS = 86_400_000;
/** A token response is small; one that isn't is not read. */
const MAX_RESPONSE_BYTES = 64 * 1024;
/** When Entra says 429 without saying how long. */
const DEFAULT_THROTTLE_MS = 30_000;

/** What a few common refusals mean, in an admin's words. */
const HINTS: Record<number, string> = {
  7000215: "the client secret is wrong (use the secret's value, not its id)",
  7000222: "the client secret has expired",
  700016: "no app with this client id in this tenant",
  90002: "no such tenant",
  700027: "the certificate isn't registered for the app, or the key doesn't match it",
  65001: "an admin hasn't consented to the permissions the app asks for",
};

/**
 * An origin an admin configured: https, or http on this machine (tests). No credentials, path,
 * query or fragment, so nothing but the origin decides where a secret is sent.
 */
function originOf(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Not the value: one written with a password in it would be printed.
    throw new Error(`${name} isn't a URL (give an origin, as https://login.microsoftonline.com)`);
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error(`${name} must be https (or http on this machine): ${url.host}`);
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error(`${name} must be an origin, without credentials or a query: ${url.origin}`);
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(`${name} must be an origin, without a path: ${url.origin}`);
  }
  return url.origin;
}

interface Signer {
  /** A fresh assertion for `audience` (the token endpoint). */
  assertion(audience: string, nowMs: number): string;
}

const b64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

/** Checks a certificate credential once, and returns what signs assertions with it. */
function signerOf(
  clientId: string,
  credential: Extract<ClientCredential, { kind: "certificate" }>,
): Signer {
  let cert: X509Certificate;
  let key: KeyObject;
  try {
    cert = new X509Certificate(credential.certificate);
  } catch {
    throw new Error("the certificate isn't a PEM X.509 certificate");
  }
  try {
    key =
      typeof credential.privateKey === "string"
        ? createPrivateKey(credential.privateKey)
        : credential.privateKey;
  } catch {
    // Never the cause: its message can quote the key's text.
    throw new Error("the private key isn't a PEM private key (an encrypted one isn't supported)");
  }
  if (key.type !== "private" || key.asymmetricKeyType !== "rsa") {
    throw new Error("the private key must be an RSA private key (Entra takes PS256 assertions)");
  }
  if (!cert.checkPrivateKey(key)) {
    throw new Error("the private key isn't the certificate's");
  }
  const thumbprint = b64url(createHash("sha256").update(cert.raw).digest());
  const notAfter = Date.parse(cert.validTo);
  return {
    assertion(audience, nowMs) {
      if (Number.isFinite(notAfter) && nowMs > notAfter) {
        throw new GraphAuthError(`the certificate expired on ${cert.validTo}`, {
          error: "certificate_expired",
        });
      }
      const seconds = Math.floor(nowMs / 1000);
      const header = { alg: "PS256", typ: "JWT", "x5t#S256": thumbprint };
      const claims = {
        aud: audience,
        iss: clientId,
        sub: clientId,
        jti: randomUUID(),
        nbf: seconds,
        iat: seconds,
        exp: seconds + ASSERTION_SECONDS,
      };
      const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
      const signature = sign("sha256", Buffer.from(input), {
        key,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
      });
      return `${input}.${b64url(signature)}`;
    },
  };
}

interface Held {
  token: string;
  /** Not handed out from this time on (milliseconds). */
  until: number;
}

/** Rejects with the signal's reason once it aborts; otherwise settles as `work` does. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason as Error);
    signal.addEventListener("abort", stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

export function graphAuth(options: GraphAuthOptions): GraphAuth {
  const { tenant, clientId, credential } = options;
  if (!GUID.test(tenant) && !DOMAIN.test(tenant)) {
    throw new Error("tenant must be the Entra tenant's id (a GUID) or one of its domains");
  }
  if (!GUID.test(clientId)) throw new Error("clientId must be the app's client id (a GUID)");
  const authority = originOf("authority", options.authority ?? "https://login.microsoftonline.com");
  const graph = originOf("graph", options.graph ?? "https://graph.microsoft.com");
  const endpoint = `${authority}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
  if (credential.kind === "secret" && credential.secret === "") {
    throw new Error("the client secret is empty");
  }
  const signer = credential.kind === "certificate" ? signerOf(clientId, credential) : undefined;
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 30_000;

  /** One token request. Its own clock, so one caller leaving doesn't end it for the others. */
  async function request(grant: Record<string, string>): Promise<Held> {
    const body = new URLSearchParams({ client_id: clientId, ...grant });
    if (signer) {
      body.set("client_assertion_type", ASSERTION_TYPE);
      body.set("client_assertion", signer.assertion(endpoint, now()));
    } else {
      body.set("client_secret", (credential as { secret: string }).secret);
    }
    const asked = now();
    let response: Response;
    let json: Record<string, unknown>;
    try {
      response = await send(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: body.toString(),
        // The request holds the app's credential: it goes to the configured origin or nowhere.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      json = await objectOf(response, MAX_RESPONSE_BYTES);
    } catch (e) {
      // Never the cause's text alone: say what was being done. The cause holds no credential.
      throw new ConnectorError(
        "retryable",
        isAbortError(e) || nameOf(e) === "TimeoutError"
          ? `Entra didn't answer within ${timeoutMs} ms`
          : "Entra couldn't be reached",
        { cause: e },
      );
    }
    if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
      throw new ConnectorError(
        "permanent",
        `the authority answered with a redirect (${response.status}): it isn't Entra's token endpoint`,
      );
    }

    if (response.ok) {
      const token = json.access_token;
      const lifetime = Number(json.expires_in);
      const type = typeof json.token_type === "string" ? json.token_type.toLowerCase() : "";
      if (
        typeof token !== "string" ||
        token === "" ||
        type !== "bearer" ||
        !(Number.isFinite(lifetime) && lifetime > 0)
      ) {
        throw new ConnectorError("retryable", "Entra's answer held no usable token");
      }
      const life = Math.min(lifetime * 1000, MAX_LIFE_MS);
      return { token, until: asked + life - Math.min(EARLY_MS, life / 2) };
    }

    const codes = Array.isArray(json.error_codes)
      ? json.error_codes.filter((n): n is number => Number.isSafeInteger(n))
      : [];
    const wait = retryAfterMs(response.headers.get("retry-after"), now());
    if (response.status === 429) {
      throw new ConnectorError("throttled", "Entra asked to slow down", {
        retryAfterMs: wait ?? DEFAULT_THROTTLE_MS,
      });
    }
    // Entra says what it refuses in JSON. A refusal without that is something on the way (a
    // proxy, a gateway): nothing an admin of the app can fix, so not a reason to stop the sync.
    if (
      response.status >= 500 ||
      typeof json.error !== "string" ||
      json.error === "temporarily_unavailable"
    ) {
      if (wait !== undefined) {
        throw new ConnectorError("throttled", `Entra is busy (${response.status})`, {
          retryAfterMs: wait,
        });
      }
      throw new ConnectorError(
        "retryable",
        typeof json.error === "string" || response.status >= 500
          ? `Entra is busy (${response.status})`
          : `the token endpoint refused without saying why (${response.status})`,
      );
    }
    // Entra's word for it, kept to what such a word is made of: it goes into a message.
    const error = json.error.replace(/[^\w.-]/g, "?").slice(0, 64);

    const hint = codes.map((c) => HINTS[c]).find((h) => h !== undefined);
    const named = [error, ...codes.map((c) => `AADSTS${c}`)].join(", ");
    throw new GraphAuthError(
      `Entra refused the app (${named})` + (hint === undefined ? "" : `: ${hint}`),
      { error, codes },
    );
  }

  /** By resource: the token held, and the request under way. */
  const held = new Map<string, Held>();
  const asking = new Map<string, Promise<Held>>();

  return {
    graph,
    account: `${graph}|${options.tenant.toLowerCase()}|${options.clientId.toLowerCase()}`,
    credential: credential.kind,

    async appToken(signal, resource = graph) {
      signal.throwIfAborted();
      const kept = held.get(resource);
      if (kept && now() < kept.until) return kept.token;
      // Callers arriving together share one request.
      let pending = asking.get(resource);
      if (!pending) {
        pending = request({ grant_type: "client_credentials", scope: `${resource}/.default` })
          .then((h) => (held.set(resource, h), h))
          .finally(() => asking.delete(resource));
        asking.set(resource, pending);
        // A failure is each caller's to hear; one nobody waits for any more isn't unhandled.
        pending.catch(() => undefined);
      }
      return (await untilAborted(pending, signal)).token;
    },

    forget(token) {
      for (const [resource, h] of held) if (h.token === token) held.delete(resource);
    },
  };
}
