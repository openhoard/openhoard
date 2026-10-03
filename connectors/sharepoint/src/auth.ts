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
 * Signing in to Microsoft Graph (T-302). Two kinds of token, both from Entra ID's v2 token
 * endpoint:
 *
 * - **App-only** (the client credentials grant): the connector as itself, for crawling. With
 *   the application permission `Sites.Selected` it reaches only the sites an admin granted it,
 *   one by one; it holds nothing tenant-wide.
 * - **On behalf of a user** (the on-behalf-of grant): a token a signed-in person's client sent
 *   to OpenHoard, exchanged for a Graph token that can do no more than that person can.
 *
 * The app proves itself with a certificate (an assertion signed with its private key, which
 * never leaves this process) or a client secret. Tokens are kept in memory only, until shortly
 * before they lapse; nothing here writes one anywhere, and no message holds one.
 *
 * Failures are ConnectorErrors: `auth` when Entra refuses (a {@link GraphAuthError}, which says
 * whether the app or the person was refused), `throttled` or `retryable` when it is busy.
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
  /**
   * The scopes asked for on behalf of a user. Default `<graph>/.default`: every delegated
   * permission consented for the app.
   */
  delegatedScopes?: readonly string[];
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
  /** An app-only token for Graph. */
  appToken(signal: AbortSignal): Promise<string>;
  /**
   * A Graph token for the person `assertion` was issued to: an access token (a JWT) their
   * client got for this app (its audience is this app). It is kept no longer than the
   * assertion lasts.
   */
  onBehalfOf(assertion: string, signal: AbortSignal): Promise<string>;
  /** Drops a token Graph refused, so the next call asks Entra for a new one. */
  forget(token: string): void;
}

/** Who Entra refused: the app (its registration, credentials, consent) or the person. */
export type GraphAuthSubject = "app" | "user";

/** An `auth` ConnectorError from Entra, with what it said. */
export class GraphAuthError extends ConnectorError {
  /**
   * `app`: nothing works until an admin fixes the registration, the credential or consent.
   * `user`: this person must sign in again (or can't be acted for); others are unaffected.
   */
  readonly subject: GraphAuthSubject;
  /** Entra's `error` (`invalid_client`, `interaction_required`). */
  readonly entraError: string;
  /** Its AADSTS codes. */
  readonly entraCodes: readonly number[];
  /** A claims challenge to pass back to the person's client, when Entra sent one. */
  readonly claims: string | undefined;

  constructor(
    subject: GraphAuthSubject,
    message: string,
    details: { error: string; codes?: readonly number[]; claims?: string },
  ) {
    super("auth", message);
    this.subject = subject;
    this.entraError = details.error;
    this.entraCodes = details.codes ?? [];
    this.claims = details.claims;
  }
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
/** A client assertion is used once, at once: five minutes covers a slow request and no more. */
const ASSERTION_SECONDS = 300;
/** A token is replaced this long before it lapses (or halfway through a shorter life). */
const EARLY_MS = 300_000;
/** No token is kept longer than a day, whatever its answer says. */
const MAX_LIFE_MS = 86_400_000;
/** A token response is small; one that isn't is not read. */
const MAX_RESPONSE_BYTES = 64 * 1024;
/** People acted for at once; the oldest entry goes first. */
const MAX_USER_TOKENS = 1000;
/** A person's token is a JWT of a few kilobytes; anything far longer isn't one. */
const MAX_ASSERTION_CHARS = 16 * 1024;
/** Exchanges under way at once; more wait their turn by being told to come back. */
const MAX_EXCHANGES = 64;
/** A person's token Entra refused is refused here too for this long, without asking again. */
const REFUSED_MS = 60_000;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
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
  50013: "the person's token was refused",
  500131: "the person's token is for another app: its audience must be this app",
  500133: "the person's token has expired",
  50057: "the person's account is disabled",
  50076: "the person must sign in again with multifactor authentication",
  50079: "the person must sign in again with multifactor authentication",
};
/** Entra errors that are about the person, in an on-behalf-of exchange. */
const USER_ERRORS = new Set(["invalid_grant", "interaction_required", "login_required"]);
/** ...except these, which are about the app though they arrive as `invalid_grant`. */
const APP_CODES = new Set([65001, 700016, 7000215, 7000222, 700027, 90002]);

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
        throw new GraphAuthError("app", `the certificate expired on ${cert.validTo}`, {
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

/** When a JWT says it lapses, in milliseconds, read without verifying it; else undefined. */
export function expiryOf(jwt: string): number | undefined {
  const parts = jwt.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1] as string, "base64url").toString());
    const exp = (claims as { exp?: unknown } | null)?.exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
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
  const delegated = options.delegatedScopes ?? [`${graph}/.default`];
  if (delegated.length === 0 || delegated.some((s) => s.trim() === "" || /\s/.test(s))) {
    throw new Error("delegatedScopes must name at least one scope, each without spaces");
  }
  if (credential.kind === "secret" && credential.secret === "") {
    throw new Error("the client secret is empty");
  }
  const signer = credential.kind === "certificate" ? signerOf(clientId, credential) : undefined;
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 30_000;

  /** One token request. Its own clock, so one caller leaving doesn't end it for the others. */
  async function request(subject: GraphAuthSubject, grant: Record<string, string>): Promise<Held> {
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

    const about: GraphAuthSubject =
      subject === "user" && USER_ERRORS.has(error) && !codes.some((c) => APP_CODES.has(c))
        ? "user"
        : "app";
    const hint = codes.map((c) => HINTS[c]).find((h) => h !== undefined);
    const named = [error, ...codes.map((c) => `AADSTS${c}`)].join(", ");
    throw new GraphAuthError(
      about,
      `Entra refused ${about === "user" ? "the person's token" : "the app"} (${named})` +
        (hint === undefined ? "" : `: ${hint}`),
      {
        error,
        codes,
        ...(typeof json.claims === "string" ? { claims: json.claims } : {}),
      },
    );
  }

  let app: Held | undefined;
  let appAsking: Promise<Held> | undefined;
  const users = new Map<string, Held>();
  const usersAsking = new Map<string, Promise<Held>>();
  const refused = new Map<string, { error: GraphAuthError; until: number }>();

  return {
    graph,

    async appToken(signal) {
      signal.throwIfAborted();
      if (app && now() < app.until) return app.token;
      // Callers arriving together share one request.
      appAsking ??= request("app", {
        grant_type: "client_credentials",
        scope: `${graph}/.default`,
      })
        .then((held) => (app = held))
        .finally(() => (appAsking = undefined));
      // A failure is each caller's to hear; one nobody waits for any more isn't unhandled.
      appAsking.catch(() => undefined);
      return (await untilAborted(appAsking, signal)).token;
    },

    async onBehalfOf(assertion, signal) {
      signal.throwIfAborted();
      // Checked here before Entra is asked: what isn't a token, or says it has lapsed, costs
      // no request (each one carries the app's credential) and holds no memory.
      const lapses =
        assertion.length <= MAX_ASSERTION_CHARS && JWT_SHAPE.test(assertion)
          ? expiryOf(assertion)
          : undefined;
      if (lapses === undefined) {
        throw new GraphAuthError("user", "there is no usable token to act on behalf of", {
          error: "invalid_grant",
        });
      }
      if (lapses <= now()) {
        throw new GraphAuthError("user", "the person's token has expired", {
          error: "invalid_grant",
        });
      }
      // Known by its hash: the maps never hold the person's own token.
      const id = createHash("sha256").update(assertion).digest("base64url");
      const held = users.get(id);
      if (held && now() < held.until) return held.token;
      users.delete(id);
      // (A clock set back doesn't make a refusal last: it is dropped when its end is too far.)
      const no = refused.get(id);
      if (no && now() < no.until && no.until - now() <= REFUSED_MS) throw no.error;
      refused.delete(id);
      let asking = usersAsking.get(id);
      if (!asking) {
        if (usersAsking.size >= MAX_EXCHANGES) {
          throw new ConnectorError("throttled", "too many sign-ins at once", {
            retryAfterMs: 1000,
          });
        }
        asking = request("user", {
          grant_type: JWT_BEARER,
          requested_token_use: "on_behalf_of",
          assertion,
          scope: delegated.join(" "),
        })
          .then(
            (got) => {
              // Kept no longer than the token it came from lasts: a person signed out of
              // OpenHoard is not acted for from a cache.
              if (users.size >= MAX_USER_TOKENS) users.delete(users.keys().next().value as string);
              users.set(id, { token: got.token, until: Math.min(got.until, lapses) });
              return got;
            },
            (e: unknown) => {
              // Refused for good (not "sign in again", which the person may do at once with
              // the same token): this token gets the same answer for a while.
              if (
                e instanceof GraphAuthError &&
                e.subject === "user" &&
                e.entraError === "invalid_grant"
              ) {
                if (refused.size >= MAX_USER_TOKENS) {
                  refused.delete(refused.keys().next().value as string);
                }
                refused.set(id, { error: e, until: now() + REFUSED_MS });
              }
              throw e;
            },
          )
          .finally(() => usersAsking.delete(id));
        asking.catch(() => undefined);
        usersAsking.set(id, asking);
      }
      return (await untilAborted(asking, signal)).token;
    },

    forget(token) {
      if (app?.token === token) app = undefined;
      for (const [id, held] of users) if (held.token === token) users.delete(id);
    },
  };
}
