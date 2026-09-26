import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

/**
 * Server configuration. Precedence: environment (OPENHOARD_*) > <dataDir>/config.json > defaults.
 * No Docker, no external services required: defaults run a single node with embedded storage.
 *
 * The schema is STRICT (security review #12): unknown keys are errors, so a typo such as
 * `"prot": 9000` fails loudly instead of silently running with the default.
 */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const isLoopback = (u: URL) => LOOPBACK.has(u.hostname);
/** A tenant-specific Entra ID issuer (v2.0 endpoint). */
const ENTRA_ISSUER =
  /^https:\/\/login\.microsoftonline\.com\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/v2\.0$/;

/**
 * A sign-in provider (T-102): an OpenID Connect issuer people of one tenant sign in through.
 * `id` names it in URLs (/auth/login/<id>, /auth/callback/<id>, the redirect URI to register).
 */
export const ProviderSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "a lower-case slug"),
    /** Shown on the sign-in page. */
    label: z.string().min(1).max(100).optional(),
    /** entra: a tenant-specific Entra ID issuer; google; generic: any OIDC issuer. */
    kind: z.enum(["entra", "google", "generic"]),
    /** The OpenHoard tenant its people belong to. */
    tenantId: z.string().regex(/^ten_[0-9a-hjkmnp-tv-z]{26}$/, "a tenant id (ten_…)"),
    /** The exact issuer: discovery must return it, and ID tokens must carry it. */
    issuer: z.url(),
    clientId: z.string().min(1).max(256),
    /**
     * For a confidential client. Better from the environment:
     * OPENHOARD_AUTH_<ID>_CLIENT_SECRET (id upper-cased, `-` as `_`).
     */
    clientSecret: z.string().min(1).optional(),
    /**
     * Whether a first sign-in may be matched to a SCIM user by the provider's id for the person,
     * once, before the identity is linked: Entra's `oid` (default on; map SCIM externalId to
     * the user's objectId), or a generic provider's `sub` (default off). Never for Google, and
     * for at most one provider per tenant.
     */
    matchExternalId: z.boolean().optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    const url = new URL(p.issuer);
    const bad = (message: string) => ctx.addIssue({ code: "custom", path: ["issuer"], message });
    if (p.kind === "entra" && !ENTRA_ISSUER.test(p.issuer)) {
      bad(
        "an Entra issuer is https://login.microsoftonline.com/<tenant id>/v2.0 (not common or organizations)",
      );
    }
    if (p.kind === "google" && p.issuer !== "https://accounts.google.com") {
      bad("Google's issuer is https://accounts.google.com");
    }
    if (p.kind === "google" && p.matchExternalId === true) {
      ctx.addIssue({
        code: "custom",
        path: ["matchExternalId"],
        message: "Google sign-ins are matched through invitations, not external ids",
      });
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) {
      bad("an issuer must use https (http only on this machine, for development)");
    }
  });

export type ProviderConfig = z.infer<typeof ProviderSchema>;

/** The claim a provider matches first sign-ins on, if any: Entra's `oid`, a generic `sub`. */
export function externalIdClaim(p: ProviderConfig): "oid" | "sub" | undefined {
  if (p.kind === "entra") return p.matchExternalId === false ? undefined : "oid";
  if (p.kind === "generic") return p.matchExternalId === true ? "sub" : undefined;
  return undefined;
}

/**
 * An MCP client the operator approves for a tenant in the config (T-105): by its Client ID
 * Metadata Document URL, or, for a client that registers dynamically, by its exact redirect URIs
 * (every one of them must be listed). Since T-106 admins approve clients in the app (the admin
 * API); this list stays as a bootstrap and an override: a client listed here is approved with
 * this trust label whatever the app says (except a refusal made in the app before it was
 * listed, which stands), and the app can't refuse, revoke or relabel it. Taking it out of the
 * list ends the approval it gave.
 */
export const ApprovedClientSchema = z
  .object({
    tenantId: z.string().regex(/^ten_[0-9a-hjkmnp-tv-z]{26}$/, "a tenant id (ten_…)"),
    clientId: z.url().optional(),
    redirectUris: z.array(z.url()).min(1).max(20).optional(),
    trust: z.enum(["local", "commercial", "consumer"]),
    /** For the admin's own notes. */
    note: z.string().max(200).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if ((c.clientId === undefined) === (c.redirectUris === undefined)) {
      ctx.addIssue({ code: "custom", message: "name a client by clientId or by redirectUris" });
    }
    if (c.clientId !== undefined && !c.clientId.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["clientId"], message: "a client id URL is https" });
    }
  });

export type ApprovedClient = z.infer<typeof ApprovedClientSchema>;

/**
 * A tenant's admin group (T-106): the identity provider group whose members are the tenant's
 * admins, named by its SCIM externalId (Entra: the group's object id, as provisioned). The
 * identity provider decides who is in it, so its admins can't be removed in the app. Optional:
 * admins are also made with the admin CLI and the admin API.
 */
export const AdminGroupSchema = z
  .object({
    tenantId: z.string().regex(/^ten_[0-9a-hjkmnp-tv-z]{26}$/, "a tenant id (ten_…)"),
    externalId: z.string().min(1).max(512),
  })
  .strict();

export type AdminGroup = z.infer<typeof AdminGroupSchema>;

/** Signing in (T-102): off unless configured. */
export const AuthSchema = z
  .object({
    /**
     * Where people reach this server: redirect URIs are built on it, and cookies are Secure
     * when it is https (it must be, except on this machine).
     */
    publicUrl: z.url(),
    /** A session ends after this long unused (default 12 hours). */
    sessionIdleMinutes: z.coerce.number().int().min(5).max(43200).default(720),
    /** And at the latest after this long (default 7 days, at most 30). */
    sessionMaxHours: z.coerce.number().int().min(1).max(720).default(168),
    providers: z.array(ProviderSchema).default([]),
    /** MCP clients approved per tenant in the config (T-105); others wait for an admin. */
    clients: z.array(ApprovedClientSchema).default([]),
    /** At most one admin group per tenant (T-106). */
    adminGroups: z.array(AdminGroupSchema).max(1000).default([]),
    /**
     * How recently an admin must have signed in to approve a client or change who is an admin
     * (default 15 minutes); older sessions sign in again first. Refusing and revoking clients
     * never waits on it.
     */
    adminSignInMinutes: z.coerce.number().int().min(1).max(1440).default(15),
    /**
     * Browser origins, besides publicUrl's and this machine's, that may call /mcp (a web MCP
     * client). Hosted clients call from their servers and need none.
     */
    mcpOrigins: z
      .array(z.url().refine((u) => /^https?:$/.test(new URL(u).protocol), "an http(s) origin"))
      .max(50)
      .default([]),
    /** How long an MCP client's grant lasts before the person consents again (default 30). */
    grantDays: z.coerce.number().int().min(1).max(90).default(30),
    /**
     * Seals sign-ins under way in their cookie: 32 random bytes, base64url. Set it (or
     * OPENHOARD_AUTH_COOKIE_KEY) when several servers share one address; otherwise each process
     * makes its own, and a restart only fails sign-ins in progress.
     */
    cookieKey: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/, "32 bytes, base64url (43 characters)")
      .optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    const url = new URL(a.publicUrl);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) {
      ctx.addIssue({
        code: "custom",
        path: ["publicUrl"],
        message: "publicUrl must use https (http only on this machine, for development)",
      });
    }
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      ctx.addIssue({
        code: "custom",
        path: ["publicUrl"],
        message: "publicUrl is an origin, with no path",
      });
    }
    if (a.sessionIdleMinutes > a.sessionMaxHours * 60) {
      ctx.addIssue({
        code: "custom",
        path: ["sessionIdleMinutes"],
        message: "the idle limit can't be longer than the session",
      });
    }
    // Two providers matching into one tenant's SCIM users would let the second claim the
    // first's people (the same id, from another provider).
    const matching = new Set<string>();
    a.providers.forEach((p, i) => {
      if (externalIdClaim(p) === undefined) return;
      if (matching.has(p.tenantId)) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", i, "matchExternalId"],
          message: "only one provider per tenant may match external ids",
        });
      }
      matching.add(p.tenantId);
    });
    const adminTenants = a.adminGroups.map((g) => g.tenantId);
    adminTenants.forEach((id, i) => {
      if (adminTenants.indexOf(id) !== i) {
        ctx.addIssue({
          code: "custom",
          path: ["adminGroups", i, "tenantId"],
          message: "one admin group per tenant",
        });
      }
    });
    const ids = a.providers.map((p) => p.id);
    ids.forEach((id, i) => {
      if (ids.indexOf(id) !== i) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", i, "id"],
          message: `duplicate provider ${id}`,
        });
      }
    });
  });

export type AuthConfig = z.infer<typeof AuthSchema>;

/** Each tenant's admin group, by SCIM externalId, as the config names it (T-106). */
export function adminGroupOf(
  auth: Pick<AuthConfig, "adminGroups"> | undefined,
): (tenantId: string) => string | undefined {
  const groups = new Map((auth?.adminGroups ?? []).map((g) => [g.tenantId, g.externalId]));
  return (tenantId) => groups.get(tenantId);
}

export const ConfigSchema = z
  .object({
    host: z.string().default("127.0.0.1"),
    port: z.coerce.number().int().min(0).max(65535).default(7420),
    dataDir: z.string().default(".openhoard"),
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
    database: z
      .object({
        /** "pglite" for dev and single-node trials, a postgres:// URL for production. */
        url: z.string().default("pglite"),
      })
      .strict()
      .prefault({}),
    /** Background jobs (core/jobs on pg-boss): enrichment and scheduled maintenance. */
    jobs: z
      .object({
        /**
         * Work the queues and keep the maintenance schedule in this process. On by default: a
         * single node does everything. Every node enqueues; turn it off where a node should only
         * serve requests. OPENHOARD_JOBS_WORKER=false does the same.
         */
        worker: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
    auth: AuthSchema.optional(),
    /**
     * The SCIM 2.0 endpoint (T-103) at /scim/v2, where each tenant's identity provider
     * provisions its users and groups with the tenant's SCIM token. On by default: without a
     * token nothing gets in.
     */
    scim: z
      .object({
        enabled: z.boolean().default(true),
        /**
         * Reverse proxies or tunnels in front of this server (exact IPv4 or IPv6 addresses,
         * e.g. "127.0.0.1"): for requests from them, the client's address, which failed
         * authentications are counted by, is read from X-Forwarded-For. None by default.
         */
        trustedProxies: z
          .array(z.union([z.ipv4(), z.ipv6()]))
          .max(100)
          .default([]),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const dataDir = resolve(cwd, env.OPENHOARD_DATA_DIR ?? ".openhoard");
  const file = join(dataDir, "config.json");
  let fromFile: unknown = {};
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`invalid OpenHoard config:\n  ${file}: ${(e as Error).message}`, {
        cause: e,
      });
    }
  }
  const fileObj = typeof fromFile === "object" && fromFile !== null ? fromFile : {};

  const fromEnv = stripUndefined({
    host: env.OPENHOARD_HOST,
    port: env.OPENHOARD_PORT,
    logLevel: env.OPENHOARD_LOG_LEVEL,
  });
  const dbUrl = env.OPENHOARD_DATABASE_URL;

  const merged: Record<string, unknown> = {
    ...fileObj,
    ...fromEnv,
    dataDir,
    ...(dbUrl ? { database: { url: dbUrl } } : {}),
  };
  const worker = env.OPENHOARD_JOBS_WORKER;
  if (worker !== undefined) {
    const jobs = typeof merged.jobs === "object" && merged.jobs !== null ? merged.jobs : {};
    // Anything but true or false stays a string, which the schema refuses.
    const flag = worker === "true" ? true : worker === "false" ? false : worker;
    merged.jobs = { ...jobs, worker: flag };
  }
  withProviderSecrets(merged, env);
  const cookieKey = env.OPENHOARD_AUTH_COOKIE_KEY;
  if (cookieKey && typeof merged.auth === "object" && merged.auth !== null) {
    merged.auth = { ...(merged.auth as object), cookieKey };
  }
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`invalid OpenHoard config:\n  ${issues.join("\n  ")}`);
  }
  return parsed.data;
}

/**
 * Creates the data directory readable only by the service user (security review #9): it holds
 * the database, blobs and keys. On POSIX we also tighten an existing directory to 0700.
 * On Windows, mode bits are ignored; the directory inherits the user profile's ACLs, and
 * `openhoard service install` (T-1102) sets an explicit ACL for the service account.
 */
export function ensureDataDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
}

/** Client secrets from OPENHOARD_AUTH_<ID>_CLIENT_SECRET, over the file's. */
function withProviderSecrets(merged: Record<string, unknown>, env: NodeJS.ProcessEnv): void {
  const auth = merged.auth as { providers?: unknown } | undefined;
  if (typeof auth !== "object" || auth === null || !Array.isArray(auth.providers)) return;
  auth.providers = auth.providers.map((p: unknown) => {
    if (typeof p !== "object" || p === null) return p;
    const id = (p as { id?: unknown }).id;
    if (typeof id !== "string") return p;
    const secret = env[`OPENHOARD_AUTH_${id.toUpperCase().replaceAll("-", "_")}_CLIENT_SECRET`];
    return secret ? { ...p, clientSecret: secret } : p;
  });
}

function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
