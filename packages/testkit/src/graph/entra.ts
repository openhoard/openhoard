import { randomBytes, randomUUID, timingSafeEqual, X509Certificate } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { decodeProtectedHeader, errors, jwtVerify, SignJWT } from "jose";
import type { FakeTenant } from "../tenant/types.js";

/*
 * A fake of Microsoft Entra ID's token endpoint (T-302), limited to what a SharePoint connector
 * uses: the client credentials grant (app-only tokens) and the on-behalf-of grant (a user's
 * token exchanged for a Graph token), each with a client secret or a certificate assertion.
 *
 * It checks requests the way Entra does and refuses with Entra's error shapes and AADSTS codes,
 * so a connector's error handling can be tested offline. The tokens it issues are JWTs only it
 * can verify ({@link FakeEntra.verify}); pass the FakeEntra to a FakeGraph (`entra`) and the
 * Graph accepts them, applying `Sites.Selected` site by site.
 */

/** Graph application permissions (and delegated scopes) that reach every site. */
export const ALL_SITES_PERMISSIONS = [
  "Sites.Read.All",
  "Sites.ReadWrite.All",
  "Sites.Manage.All",
  "Sites.FullControl.All",
  "Files.Read.All",
  "Files.ReadWrite.All",
] as const;

export type SiteRole = "read" | "write" | "owner" | "fullcontrol";

export interface FakeApp {
  clientId: string;
  /** A client secret's value. */
  secret?: string;
  /** A certificate (PEM) registered for the app: assertions signed by its key are accepted. */
  certificate?: string;
  /** Application permissions consented by an admin (`Sites.Selected`, `Sites.Read.All`). */
  appRoles?: readonly string[];
  /** Delegated permissions consented (`Sites.Selected`, `Files.Read.All`, `User.Read`). */
  delegatedScopes?: readonly string[];
}

/** What a token the fake issued says, once verified. */
export interface GraphCaller {
  /** The app the token was issued to. */
  appId: string;
  /** App-only tokens: the application permissions. */
  roles: readonly string[];
  /** Delegated tokens: the scopes. */
  scopes: readonly string[];
  /** Delegated tokens: the user's id. Undefined for app-only tokens. */
  userId?: string;
}

export interface FakeEntraOptions {
  /** Where Graph is, as tokens' audience and scopes name it. Default `https://graph.microsoft.com`. */
  graph?: string;
  /** Access token lifetime in seconds. Default 3600. */
  lifetimeSeconds?: number;
  /** Clock, in milliseconds. Default `Date.now`. */
  now?: () => number;
  /**
   * Other names the token endpoint answers to besides the tenant's id and domain: a real tenant
   * id is a GUID, the fake tenant's isn't.
   */
  aliases?: readonly string[];
}

export interface TokenRequestLog {
  grant: string;
  clientId: string;
  /** How the client proved itself. */
  auth: "secret" | "certificate" | "none";
  status: number;
  error?: string;
}

const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
/** Entra's own limit on a client assertion's lifetime is longer; its guidance is ten minutes. */
const MAX_ASSERTION_SECONDS = 600;

export class FakeEntra {
  readonly app = new Hono();
  readonly requests: TokenRequestLog[] = [];
  readonly graph: string;

  private readonly apps = new Map<string, FakeApp>();
  private readonly grants = new Map<string, SiteRole>();
  private readonly seenJti = new Set<string>();
  private readonly interaction = new Set<string>();
  private readonly faults: { status: number; retryAfter?: number }[] = [];
  private readonly key = randomBytes(32);
  private readonly lifetime: number;
  private readonly now: () => number;
  private readonly names: ReadonlySet<string>;

  constructor(
    readonly tenant: FakeTenant,
    options: FakeEntraOptions = {},
  ) {
    this.names = new Set([tenant.id, tenant.domain, ...(options.aliases ?? [])]);
    this.graph = options.graph ?? "https://graph.microsoft.com";
    this.lifetime = options.lifetimeSeconds ?? 3600;
    this.now = options.now ?? Date.now;
    this.app.post("/:tenant/oauth2/v2.0/token", (c) => this.token(c));
    this.app.notFound((c) =>
      c.json(
        { error: "invalid_request", error_description: "AADSTS900561: no such endpoint" },
        404,
      ),
    );
  }

  /** Registers an app (or replaces one with the same client id). */
  registerApp(app: FakeApp): void {
    this.apps.set(app.clientId, { ...app });
  }

  /** Grants an app a role on one site, as `POST /sites/{id}/permissions` does (Sites.Selected). */
  grantSite(clientId: string, siteId: string, role: SiteRole = "read"): void {
    this.grants.set(`${clientId} ${siteId}`, role);
  }

  revokeSite(clientId: string, siteId: string): void {
    this.grants.delete(`${clientId} ${siteId}`);
  }

  /** The role an app holds on a site through Sites.Selected, if any. */
  siteRole(clientId: string, siteId: string): SiteRole | undefined {
    return this.grants.get(`${clientId} ${siteId}`);
  }

  /** On-behalf-of exchanges for this user answer `interaction_required` (MFA), until undone. */
  requireInteraction(userId: string, required = true): void {
    if (required) this.interaction.add(userId);
    else this.interaction.delete(userId);
  }

  /** The next `count` token requests fail with `status` (429, 503), optionally Retry-After. */
  failNext(status: number, count = 1, retryAfterSeconds?: number): void {
    for (let i = 0; i < count; i++) {
      this.faults.push({
        status,
        ...(retryAfterSeconds === undefined ? {} : { retryAfter: retryAfterSeconds }),
      });
    }
  }

  /**
   * A token a signed-in user's client would send to the app `audience` (the middle tier): what
   * the on-behalf-of grant takes as its `assertion`. `expiresInSeconds` may be negative.
   */
  userToken(
    userId: string,
    audience: string,
    { expiresInSeconds = 3600 }: { expiresInSeconds?: number } = {},
  ): Promise<string> {
    const seconds = Math.floor(this.now() / 1000);
    return new SignJWT({ oid: userId, tid: this.tenant.id, scp: "access_as_user", ver: "2.0" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setAudience(audience)
      .setIssuedAt(seconds)
      .setExpirationTime(seconds + expiresInSeconds)
      .sign(this.key);
  }

  /** What a bearer token says, when this fake issued it for Graph and it hasn't expired. */
  async verify(bearer: string): Promise<GraphCaller | undefined> {
    try {
      const { payload } = await jwtVerify(bearer, this.key, {
        audience: this.graph,
        algorithms: ["HS256"],
        currentDate: new Date(this.now()),
        clockTolerance: 0,
      });
      const appId = typeof payload.appid === "string" ? payload.appid : "";
      if (appId === "" || payload.tid !== this.tenant.id) return undefined;
      const roles = Array.isArray(payload.roles) ? (payload.roles as string[]) : [];
      const scopes = typeof payload.scp === "string" ? payload.scp.split(" ") : [];
      return {
        appId,
        roles,
        scopes: scopes.filter((s) => s !== ""),
        ...(typeof payload.oid === "string" ? { userId: payload.oid } : {}),
      };
    } catch {
      return undefined;
    }
  }

  /** Sends a request to the fake without a network hop. Relative URLs resolve against it. */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const request =
      typeof input === "string" && input.startsWith("/") ? `http://entra.test${input}` : input;
    return Promise.resolve(this.app.request(request, init));
  }

  /** Serves the fake on 127.0.0.1. `port` 0 picks a free port. */
  listen(port = 0): Promise<{ url: string; close: () => Promise<void> }> {
    return new Promise((resolve, reject) => {
      const server = serve(
        { fetch: this.app.fetch, hostname: "127.0.0.1", port },
        (info: AddressInfo) => {
          resolve({
            url: `http://127.0.0.1:${info.port}`,
            close: () =>
              new Promise<void>((done, fail) => server.close((e) => (e ? fail(e) : done()))),
          });
        },
      );
      server.once("error", reject);
    });
  }

  // ── The token endpoint ───────────────────────────────────────────────────────────────

  private async token(c: Context): Promise<Response> {
    const log: TokenRequestLog = { grant: "", clientId: "", auth: "none", status: 200 };
    this.requests.push(log);
    const refuse = (status: number, error: string, code: number, text: string, extra = {}) => {
      log.status = status;
      log.error = error;
      return entraError(c, status, error, code, text, extra, this.now());
    };

    const fault = this.faults.shift();
    if (fault) {
      if (fault.retryAfter !== undefined) c.header("Retry-After", String(fault.retryAfter));
      return refuse(
        fault.status,
        fault.status === 429 ? "throttled" : "temporarily_unavailable",
        90033,
        "A transient error has occurred. Please try again.",
      );
    }

    const type = c.req.header("content-type") ?? "";
    if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      return refuse(400, "invalid_request", 900144, "The request body must be form encoded.");
    }
    const form = new URLSearchParams(await c.req.text());
    const one = (name: string) =>
      form.getAll(name).length === 1 ? (form.get(name) as string) : "";
    log.grant = one("grant_type");
    log.clientId = one("client_id");

    if (!this.names.has(c.req.param("tenant") ?? "")) {
      return refuse(400, "invalid_request", 90002, `Tenant '${c.req.param("tenant")}' not found.`);
    }
    const app = this.apps.get(log.clientId);
    if (!app) {
      return refuse(
        400,
        "unauthorized_client",
        700016,
        `Application with identifier '${log.clientId}' was not found in the directory.`,
      );
    }

    // Who is asking: a secret, or an assertion signed by a registered certificate.
    const endpoint = new URL(c.req.url);
    const secret = one("client_secret");
    const assertion = one("client_assertion");
    if (assertion !== "" && secret !== "") {
      return refuse(
        400,
        "invalid_request",
        7000219,
        "Send a client_assertion or a client_secret, not both.",
      );
    }
    if (assertion !== "") {
      log.auth = "certificate";
      if (one("client_assertion_type") !== ASSERTION_TYPE) {
        return refuse(400, "invalid_request", 900144, "client_assertion_type is missing or wrong.");
      }
      const problem = await this.checkAssertion(assertion, app, endpoint);
      if (problem) return refuse(401, "invalid_client", problem.code, problem.text);
    } else if (secret !== "") {
      log.auth = "secret";
      if (app.secret === undefined || !safeEqual(secret, app.secret)) {
        return refuse(
          401,
          "invalid_client",
          7000215,
          "Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID.",
        );
      }
    } else {
      return refuse(
        401,
        "invalid_client",
        7000218,
        "The request body must contain the following parameter: 'client_assertion' or 'client_secret'.",
      );
    }

    const scope = one("scope")
      .split(" ")
      .filter((s) => s !== "");
    if (scope.length === 0) {
      return refuse(400, "invalid_request", 900144, "The request body must contain 'scope'.");
    }
    if (scope.some((s) => s !== "offline_access" && !s.startsWith(`${this.graph}/`))) {
      return refuse(
        400,
        "invalid_resource",
        500011,
        "The resource principal named in the scope was not found in the tenant.",
      );
    }
    const seconds = Math.floor(this.now() / 1000);
    const issue = async (claims: Record<string, unknown>, granted: string | undefined) => {
      const token = await new SignJWT({ appid: app.clientId, tid: this.tenant.id, ...claims })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setAudience(this.graph)
        .setIssuedAt(seconds)
        .setExpirationTime(seconds + this.lifetime)
        .sign(this.key);
      c.header("Cache-Control", "no-store");
      return c.json({
        token_type: "Bearer",
        expires_in: this.lifetime,
        ext_expires_in: this.lifetime,
        ...(granted === undefined ? {} : { scope: granted }),
        access_token: token,
      });
    };

    if (log.grant === "client_credentials") {
      if (scope.length !== 1 || scope[0] !== `${this.graph}/.default`) {
        return refuse(
          400,
          "invalid_scope",
          1002012,
          "The provided value for scope is not valid. Client credential flows must have a scope value with /.default suffixed to the resource identifier.",
        );
      }
      return issue({ roles: [...(app.appRoles ?? [])], idtyp: "app" }, undefined);
    }

    if (log.grant === JWT_BEARER) {
      if (one("requested_token_use") !== "on_behalf_of") {
        return refuse(400, "invalid_request", 900144, "requested_token_use must be on_behalf_of.");
      }
      let userId: string;
      try {
        const { payload } = await jwtVerify(one("assertion"), this.key, {
          audience: app.clientId,
          algorithms: ["HS256"],
          currentDate: new Date(this.now()),
          clockTolerance: 0,
        });
        // An app-only token names no user: there is nobody to act on behalf of.
        if (typeof payload.oid !== "string" || payload.idtyp === "app") throw new Error("no user");
        userId = payload.oid;
      } catch (e) {
        // Entra tells these apart: out of its time range, for another app, anything else.
        if (e instanceof errors.JWTExpired) {
          return refuse(
            400,
            "invalid_grant",
            500133,
            "Assertion is not within its valid time range. Ensure that the access token is not expired before using it for user assertion.",
          );
        }
        if (e instanceof errors.JWTClaimValidationFailed && e.claim === "aud") {
          return refuse(
            400,
            "invalid_grant",
            500131,
            "Assertion audience does not match the Client app presenting the assertion.",
          );
        }
        return refuse(400, "invalid_grant", 50013, "Assertion failed signature validation.");
      }
      const user = this.tenant.users.find((u) => u.id === userId);
      if (!user?.active) {
        return refuse(400, "invalid_grant", 50057, "The user account is disabled.");
      }
      if (this.interaction.has(userId)) {
        return refuse(
          400,
          "interaction_required",
          50079,
          "Due to a configuration change made by your administrator, you must enroll in multifactor authentication.",
          {
            claims: JSON.stringify({ access_token: { polids: { essential: true } } }),
            suberror: "basic_action",
          },
        );
      }
      const consented = app.delegatedScopes ?? [];
      const asked = scope.filter((s) => s !== "offline_access");
      if (asked.length > 1 && asked.includes(`${this.graph}/.default`)) {
        return refuse(
          400,
          "invalid_scope",
          70011,
          "The provided value for scope is not valid: .default can't be combined with other scopes.",
        );
      }
      const wanted = asked.includes(`${this.graph}/.default`)
        ? [...consented]
        : asked.map((s) => s.slice(this.graph.length + 1));
      if (wanted.length === 0 || wanted.some((s) => !consented.includes(s))) {
        return refuse(
          400,
          "invalid_grant",
          65001,
          "The user or administrator has not consented to use the application.",
          { suberror: "consent_required" },
        );
      }
      return issue(
        { scp: wanted.join(" "), oid: userId, upn: user.upn },
        wanted.map((s) => `${this.graph}/${s}`).join(" "),
      );
    }

    return refuse(
      400,
      "unsupported_grant_type",
      70003,
      `The grant type '${log.grant}' is not supported.`,
    );
  }

  /** Checks a certificate assertion as Entra's documentation describes it. */
  private async checkAssertion(
    assertion: string,
    app: FakeApp,
    endpoint: URL,
  ): Promise<{ code: number; text: string } | undefined> {
    const bad = (text: string) => ({
      code: 700027,
      text: `Client assertion failed validation: ${text}`,
    });
    if (app.certificate === undefined) {
      return {
        code: 700027,
        text: "The certificate used to sign the client assertion is not registered on the application.",
      };
    }
    try {
      const cert = new X509Certificate(app.certificate);
      const header = decodeProtectedHeader(assertion);
      const thumbprint = Buffer.from(cert.fingerprint256.replaceAll(":", ""), "hex").toString(
        "base64url",
      );
      if (header["x5t#S256"] !== thumbprint) {
        return {
          code: 700027,
          text: "The certificate with the given thumbprint is not registered on the application.",
        };
      }
      if (header.alg !== "PS256") return bad("the algorithm must be PS256");
      const { payload } = await jwtVerify(assertion, cert.publicKey, {
        algorithms: ["PS256"],
        audience: `${endpoint.origin}${endpoint.pathname}`,
        issuer: app.clientId,
        subject: app.clientId,
        currentDate: new Date(this.now()),
        clockTolerance: 300,
      });
      if (typeof payload.exp !== "number" || typeof payload.nbf !== "number")
        return bad("exp and nbf are required");
      if (payload.exp - payload.nbf > MAX_ASSERTION_SECONDS) return bad("its lifetime is too long");
      if (typeof payload.jti !== "string" || payload.jti === "") return bad("jti is required");
      if (this.seenJti.has(payload.jti))
        return { code: 700025, text: "The client assertion was already used." };
      this.seenJti.add(payload.jti);
      return undefined;
    } catch (e) {
      return bad((e as Error).message);
    }
  }
}

function entraError(
  c: Context,
  status: number,
  error: string,
  code: number,
  text: string,
  extra: Record<string, unknown> = {},
  nowMs: number = Date.now(),
): Response {
  const trace = randomUUID();
  const correlation = randomUUID();
  const timestamp = new Date(nowMs)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "Z");
  return c.json(
    {
      error,
      error_description: `AADSTS${code}: ${text}\r\nTrace ID: ${trace}\r\nCorrelation ID: ${correlation}\r\nTimestamp: ${timestamp}`,
      error_codes: [code],
      timestamp,
      trace_id: trace,
      correlation_id: correlation,
      error_uri: `https://login.microsoftonline.com/error?code=${code}`,
      ...extra,
    },
    status as 400,
  );
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
