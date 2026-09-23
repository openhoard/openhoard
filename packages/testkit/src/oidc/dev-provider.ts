import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair } from "jose";
import Provider, { type Configuration, type KoaContextWithOIDC } from "oidc-provider";
import type { FakeTenant, FakeUser } from "../tenant/types.js";

export interface DevClient {
  clientId: string;
  redirectUris: string[];
  /** Omit for a public client (PKCE, no secret), such as the web app or a CLI. */
  clientSecret?: string;
}

export interface DevOidcOptions {
  tenant: FakeTenant;
  /** Port on 127.0.0.1. Default 0 (any free port). */
  port?: number;
  /** Registered clients. Default: one public client, `openhoard-dev`, redirecting to localhost:7420. */
  clients?: DevClient[];
}

export interface DevOidc {
  /** The issuer URL, e.g. `http://127.0.0.1:53211`. Discovery is at `/.well-known/openid-configuration`. */
  issuer: string;
  provider: Provider;
  close(): Promise<void>;
}

export const DEV_CLIENT: DevClient = {
  clientId: "openhoard-dev",
  redirectUris: ["http://127.0.0.1:7420/auth/callback", "http://localhost:7420/auth/callback"],
};

/**
 * A local OpenID Connect provider for development and tests (T-016), so sign-in works with no
 * cloud identity provider. It is `oidc-provider` (the certified implementation) seeded with the
 * fake tenant's people:
 *
 * - the login page lists the tenant's active users; pick one, no password (DEV ONLY);
 * - people who have left cannot sign in, like a disabled account;
 * - ID tokens and userinfo carry `email`, `name`, `groups` (group ids, as Entra ID does) and
 *   `guest`;
 * - registered clients are treated as first-party, so there is no consent screen.
 *
 * It binds to 127.0.0.1 only and uses fresh signing and cookie keys on every start. Never
 * expose it beyond the local machine.
 */
export async function startDevOidc(options: DevOidcOptions): Promise<DevOidc> {
  const { tenant } = options;
  const users = new Map(tenant.users.map((u) => [u.id, u]));
  const groupsOf = (userId: string) =>
    tenant.groups.filter((g) => g.members.includes(userId)).map((g) => g.id);
  const clients = options.clients ?? [DEV_CLIENT];

  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = {
    ...(await exportJWK(privateKey)),
    alg: "RS256",
    use: "sig",
    kid: randomBytes(8).toString("hex"),
  };

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const configuration: Configuration = {
    clients: clients.map((c) => ({
      client_id: c.clientId,
      redirect_uris: c.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(c.clientSecret
        ? {
            client_secret: c.clientSecret,
            token_endpoint_auth_method: "client_secret_basic" as const,
          }
        : { token_endpoint_auth_method: "none" as const }),
    })),
    jwks: { keys: [jwk] },
    cookies: { keys: [randomBytes(32).toString("hex")] },
    pkce: { required: () => true },
    scopes: ["openid", "email", "profile", "groups", "offline_access"],
    claims: {
      openid: ["sub"],
      email: ["email", "email_verified"],
      profile: ["name", "given_name", "family_name"],
      groups: ["groups", "guest"],
    },
    features: { devInteractions: { enabled: false } },
    // Put the scope claims (email, name, groups) in the ID token too, as Entra ID and Google do,
    // so a client can sign someone in without a separate userinfo call.
    conformIdTokenClaims: false,
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    findAccount: (_ctx, id) => {
      const user = users.get(id);
      if (!user?.active) return undefined;
      return {
        accountId: user.id,
        claims: () => {
          const [given = user.displayName, ...family] = user.displayName.split(" ");
          return {
            sub: user.id,
            email: user.upn,
            email_verified: true,
            name: user.displayName,
            given_name: given,
            family_name: family.join(" "),
            groups: groupsOf(user.id),
            guest: user.guest,
          };
        },
      };
    },
    // Registered dev clients are first-party: grant the requested OIDC scopes without a consent page.
    loadExistingGrant: async (ctx: KoaContextWithOIDC) => {
      const client = ctx.oidc.client;
      const session = ctx.oidc.session;
      if (!client || !session?.accountId) return undefined;
      const existing = session.grantIdFor(client.clientId);
      if (existing) return ctx.oidc.provider.Grant.find(existing);
      const grant = new ctx.oidc.provider.Grant({
        clientId: client.clientId,
        accountId: session.accountId,
      });
      grant.addOIDCScope("openid email profile groups offline_access");
      await grant.save();
      return grant;
    },
    ttl: { AccessToken: 3600, IdToken: 3600, Session: 8 * 3600, Grant: 8 * 3600, Interaction: 600 },
  };

  const provider = new Provider(issuer, configuration);
  const callback = provider.callback();
  server.on("request", (req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const m = /^\/interaction\/([\w-]+)(\/login)?$/.exec(path);
    if (!m) {
      void callback(req, res);
      return;
    }
    handleInteraction(provider, req, res, Boolean(m[2]), tenant.users).catch((error: unknown) => {
      res.statusCode = 400;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(`sign-in failed: ${(error as Error).message}`);
    });
  });

  return {
    issuer,
    provider,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}

/** The login step: a page listing active users, and the form post that signs one in. */
async function handleInteraction(
  provider: Provider,
  req: IncomingMessage,
  res: ServerResponse,
  submit: boolean,
  people: readonly FakeUser[],
): Promise<void> {
  const details = await provider.interactionDetails(req, res);
  if (details.prompt.name !== "login") throw new Error(`unexpected prompt ${details.prompt.name}`);
  if (!submit) {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    );
    res.end(
      loginPage(
        details.uid,
        people.filter((u) => u.active),
      ),
    );
    return;
  }
  if (req.method !== "POST") throw new Error("use POST to sign in");
  const form = new URLSearchParams(await readBody(req, 8 * 1024));
  const login = form.get("login") ?? "";
  const user = people.find((u) => (u.id === login || u.upn === login.toLowerCase()) && u.active);
  if (!user) throw new Error("unknown or disabled user");
  await provider.interactionFinished(
    req,
    res,
    { login: { accountId: user.id } },
    { mergeWithLastSubmission: false },
  );
}

function loginPage(uid: string, people: readonly FakeUser[]): string {
  const options = people
    .map((u) => `<option value="${esc(u.id)}">${esc(u.displayName)} &lt;${esc(u.upn)}&gt;</option>`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>OpenHoard dev sign-in</title>
<style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}select,button{font:inherit;width:100%;margin:.5rem 0;padding:.5rem}</style></head>
<body><h1>OpenHoard dev sign-in</h1><p>Development identity provider. Pick a seeded user; there is no password.</p>
<form method="post" action="/interaction/${esc(uid)}/login"><label for="login">User</label>
<select id="login" name="login">${options}</select><button type="submit">Sign in</button></form></body></html>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
