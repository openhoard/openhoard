import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
 * A tenant's admin group (T-106): the SCIM group whose members are the tenant's admins, named by
 * its OpenHoard id (`grp_…`: `admin group list` shows them), never by the identity provider's
 * externalId, which whoever holds the SCIM token chooses. The identity provider decides who is
 * in it, so its admins can't be removed in the app: the SCIM token and the group's owners
 * upstream are admin-grade. A group that is missing, deleted or not provisioned over SCIM makes
 * nobody an admin. Optional: admins are also made with the admin CLI and the admin API.
 */
export const AdminGroupSchema = z
  .object({
    tenantId: z.string().regex(/^ten_[0-9a-hjkmnp-tv-z]{26}$/, "a tenant id (ten_…)"),
    groupId: z.string().regex(/^grp_[0-9a-hjkmnp-tv-z]{26}$/, "a group id (grp_…)"),
  })
  .strict();

export type AdminGroup = z.infer<typeof AdminGroupSchema>;

/** A cloudflared tunnel's name (or its id), and a public host name: no address, no port. */
export const TUNNEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const TUNNEL_HOST =
  /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

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
    /**
     * One-time sign-in links (`openhoard admin user sign-in-link`): a person signs in without an
     * identity provider, with a link an operator issued on this machine. Off by default, and
     * refused unless the server listens on this machine only (`host` a loopback address): for
     * a single person trying OpenHoard out, never for a team.
     */
    signInLinks: z.boolean().default(false),
    /**
     * Passkeys for built-in accounts (T-108): local people, on a server without an identity
     * provider, sign in with a passkey made from an invite (`openhoard admin user invite`). Off
     * by default. A passkey belongs to publicUrl's host (its WebAuthn relying party id), so that
     * must be a name, not an address, and passkeys stop working when it changes.
     */
    passkeys: z.boolean().default(false),
  })
  .strict()
  .superRefine((a, ctx) => {
    const url = new URL(a.publicUrl);
    if (a.passkeys && !isDomain(url.hostname)) {
      ctx.addIssue({
        code: "custom",
        path: ["passkeys"],
        message:
          "passkeys belong to a host name: publicUrl can't be an IP address (use http://localhost:… on this machine)",
      });
    }
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

/** Each tenant's admin group id (`grp_…`), as the config names it (T-106). */
export function adminGroupOf(
  auth: Pick<AuthConfig, "adminGroups"> | undefined,
): (tenantId: string) => string | undefined {
  const groups = new Map((auth?.adminGroups ?? []).map((g) => [g.tenantId, g.groupId]));
  return (tenantId) => groups.get(tenantId);
}

/**
 * A model provider (T-404). Its API key never comes from this file: the server reads
 * OPENHOARD_MODEL_<ID>_API_KEY (id upper-cased, `-` as `_`) from the environment, and the
 * schema has no field for it, so a key pasted into config.json fails loudly.
 */
export const ModelProviderSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "a lower-case slug"),
    /** Where it runs, which decides which files' content it may have (core/policy mayProcess). */
    kind: z.enum(["local", "commercial", "consumer"]),
    /** stub (tests, CI, trials), openai (OpenAI, Azure OpenAI, LM Studio, vLLM), anthropic, ollama. */
    adapter: z.enum(["stub", "openai", "anthropic", "ollama"]),
    /** Defaults: anthropic https://api.anthropic.com, ollama http://localhost:11434. */
    baseUrl: z.url().optional(),
    /** Default for anthropic: claude-haiku-4-5 (Haiku class); required for openai and ollama. */
    chatModel: z.string().min(1).max(200).optional(),
    embedModel: z.string().min(1).max(200).optional(),
    /** stub only: the size of its hashed-word embeddings (tests, CI, trials). */
    embedDimensions: z.number().int().min(2).max(4_096).optional(),
    timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
    maxRetries: z.number().int().min(0).max(10).optional(),
    maxRetryAfterMs: z.number().int().min(0).max(600_000).optional(),
    maxInputChars: z.number().int().min(1_000).max(2_000_000).optional(),
    maxOutputTokens: z.number().int().min(64).max(32_000).optional(),
    maxResponseBytes: z
      .number()
      .int()
      .min(4_096)
      .max(64 * 1024 * 1024)
      .optional(),
    concurrency: z.number().int().min(1).max(64).optional(),
    /** openai only: `api-key` for Azure OpenAI. */
    auth: z.enum(["bearer", "api-key"]).optional(),
    /** openai only: `max_completion_tokens` for OpenAI's reasoning models. */
    maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
    /** openai only: send `response_format: json_object` (default true). */
    jsonMode: z.boolean().optional(),
  })
  .strict();

/** Models for enrichment (T-404, T-405). Off unless providers are listed. */
export const ModelsSchema = z
  .object({
    providers: z.array(ModelProviderSchema).max(32).default([]),
    /**
     * Providers per task, in preference order, by id. Default: every provider, local first,
     * then commercial, then consumer. A file only ever reaches a provider its exposure allows.
     */
    tasks: z
      .object({
        summarize: z.array(z.string()).max(32).optional(),
        embed: z.array(z.string()).max(32).optional(),
      })
      .strict()
      .prefault({}),
    /** Tokens a tenant may spend on models per UTC day, all providers together. */
    dailyTokenBudget: z.number().int().min(0).default(5_000_000),
    /** Budgets for particular tenants, by tenant id, over dailyTokenBudget. */
    tenantBudgets: z
      .record(
        z.string().regex(/^ten_[0-9a-hjkmnp-tv-z]{26}$/, "a tenant id (ten_…)"),
        z.number().int().min(0),
      )
      .default({}),
    summarize: z
      .object({
        /** The summarize step's time for its model calls, in ms (under the job's lease). */
        budgetMs: z
          .number()
          .int()
          .min(10_000)
          .max(15 * 60_000)
          .optional(),
        /** Vocabulary entries offered to the model at most. */
        vocabularyLimit: z.number().int().min(0).max(5_000).optional(),
      })
      .strict()
      .prefault({}),
  })
  .strict();

/** Standard cron (five fields): minutes, hours, day of month, month, day of week. */
const CRON = /^(\S+\s+){4}\S+$/;

/** What every source has, whatever its connector. */
const schedule = (byDefault: string) =>
  z.string().max(100).regex(CRON, "a cron expression with five fields").default(byDefault);

const sourceBase = {
  /** The connection's name: the `source` of its items, and how admin commands name it. */
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "a lower-case slug"),
  tenantId: z.string().regex(/^ten_[0-9a-hjkmnp-tv-z]{26}$/, "a tenant id (ten_…)"),
  /**
   * The zone its items go to, by name: an indexed zone, made at start if the tenant has none
   * of that name. A source stays in the zone it was first synced into.
   */
  zone: z.string().min(1).max(200),
  /** Who owns (and so reads) its files: a person's email, or their id (`usr_…`). */
  owner: z.string().min(3).max(320),
  /**
   * Read its files' content on this server for text extraction, summaries and embeddings (as
   * far as each file's exposure lets content reach a model). Default false: names and
   * metadata only.
   */
  extract: z.boolean().default(false),
  /** When a reconcile is held for an admin (core/jobs runSync()); the defaults suit most. */
  reconcileGuard: z
    .object({
      maxFraction: z.number().min(0).max(1).optional(),
      minItems: z.number().int().min(0).max(1_000_000).optional(),
    })
    .strict()
    .optional(),
};

/**
 * A local folder synced on a schedule (T-303, the fs connector): indexed in place, its files
 * owned (and so read) by `owner`. Each source's content is read by the server only when it opts
 * in (`extract`), for text extraction, summaries and embeddings.
 */
export const FsSourceSchema = z
  .object({
    ...sourceBase,
    connector: z.literal("fs"),
    /** The folder, an absolute path on this machine (a local disk, or a mapped drive). */
    root: z
      .string()
      .min(1)
      .max(1024)
      .refine((r) => isAbsolute(r), "an absolute path on this machine")
      .refine(
        (r) => !/^[\\/]{2}/.test(r) && isAbsolute(r) && pathToFileURL(r).host === "",
        "a network share or a device path isn't supported: map the share to a drive letter",
      ),
    /** When it syncs, in UTC (standard cron). Default every 15 minutes. */
    schedule: schedule("*/15 * * * *"),
    /**
     * Also sync soon (seconds) after something in the folder changes, not only on `schedule`
     * (watch.ts, on a worker only). Default true. The schedule stays the safety net: changes on
     * network drives, or while nothing watched, are seen at its next run.
     */
    watch: z.boolean().default(true),
  })
  .strict();

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
/** An origin: https, a host, perhaps a port; no path, credentials or query. */
const ORIGIN = z
  .string()
  .max(255)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        DOMAIN.test(url.hostname) &&
        url.username === "" &&
        url.password === "" &&
        (url.pathname === "/" || url.pathname === "") &&
        url.search === "" &&
        url.hash === "" &&
        !value.includes("?") &&
        !value.includes("#")
      );
    } catch {
      return false;
    }
  }, "an https origin, as https://graph.microsoft.com");
/** A file the admin names, absolute so it doesn't depend on where the server was started. */
const KEY_FILE = z
  .string()
  .min(1)
  .max(1024)
  .refine((f) => isAbsolute(f), "an absolute path on this machine");

/**
 * A SharePoint site synced on a schedule (T-303, connectors/sharepoint): its document libraries
 * indexed in place through Microsoft Graph, as the Entra app `clientId` of the directory
 * `directory`, which an admin has granted the site (`Sites.Selected`).
 *
 * The app's credential is never here: a client secret is in the environment
 * ({@link sourceSecretEnv}); a certificate is two files this names.
 */
export const SharePointSourceSchema = z
  .object({
    ...sourceBase,
    connector: z.literal("sharepoint"),
    /** The site: `contoso.sharepoint.com:/sites/finance`, or its id as Graph gives it. */
    site: z.string().min(1).max(1024),
    /** The Entra directory (tenant): its id, or a domain it has verified. Not OpenHoard's tenant. */
    directory: z
      .string()
      .max(253)
      .refine((d) => GUID.test(d) || DOMAIN.test(d), "an Entra tenant id (a GUID) or domain"),
    /** The app registration's application (client) id. */
    clientId: z.string().regex(GUID, "the app's client id (a GUID)"),
    /** A certificate registered for the app, and its private key: PEM files. Else a secret. */
    certificate: z
      .object({ certificateFile: KEY_FILE, privateKeyFile: KEY_FILE })
      .strict()
      .refine(
        (c) => c.certificateFile !== c.privateKeyFile,
        "two files: the certificate, and its key",
      )
      .optional(),
    /**
     * When it syncs, in UTC (standard cron). Default every fifteen minutes: a sync asks Graph
     * what changed since the last one (T-304), and crawls the site only the first time and
     * every `recrawlAfterDays`.
     */
    schedule: schedule("*/15 * * * *"),
    /**
     * How old a crawl may be before the site is crawled again instead of followed, in days:
     * the crawl mends whatever following changes missed. Default 7; 0 never.
     */
    recrawlAfterDays: z.number().min(0).max(3650).optional(),
    /**
     * Whether SharePoint's permissions become grants here (T-305): to the users and groups
     * provisioned under their Entra ids, and to nobody otherwise. False: only `owner` reads the
     * files (grants an earlier import made are withdrawn as each file is next recorded).
     */
    importPermissions: z.boolean().default(true),
    /** A national cloud's addresses. Default: the global cloud's. */
    authority: ORIGIN.optional(),
    graph: ORIGIN.optional(),
    /** Hosts a file's bytes may be fetched from besides Graph (default `.sharepoint.com`). */
    downloadHosts: z
      .array(
        z
          .string()
          .max(253)
          .regex(
            /^\.?([a-z0-9-]+\.)+[a-z0-9-]+$/i,
            "a host name, or a suffix starting with a dot (.sharepoint.com)",
          ),
      )
      .min(1)
      .max(20)
      .optional(),
  })
  .strict();

export const SourceSchema = z.discriminatedUnion("connector", [
  FsSourceSchema,
  SharePointSourceSchema,
]);

export type FsSourceConfig = z.infer<typeof FsSourceSchema>;
export type SharePointSourceConfig = z.infer<typeof SharePointSourceSchema>;

/** The environment variable a source's client secret is read from. */
export function sourceSecretEnv(id: string): string {
  return `OPENHOARD_SOURCE_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_CLIENT_SECRET`;
}

export type SourceConfig = z.infer<typeof SourceSchema>;

const EMAIL = z
  .string()
  .max(320)
  .regex(/^[^\s@<>]+@[^\s@<>]+$/, "an email address")
  .transform((a) => a.toLowerCase());

/**
 * A mailbox read over IMAP (T-1208, mail-in.ts): what is sent to it becomes files in a managed
 * zone. Its password is OPENHOARD_MAIL_<ID>_PASSWORD in the environment, never here.
 */
export const MailboxSchema = z
  .object({
    /** The mailbox's name here: in the audit, the logs and its password's variable. */
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "a lower-case slug"),
    tenantId: z.string().regex(/^ten_[0-9a-hjkmnp-tv-z]{26}$/, "a tenant id (ten_…)"),
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535).default(993),
    /** TLS from the first byte (port 993). Off only for a server on this machine. */
    secure: z.boolean().default(true),
    user: z.string().min(1).max(320),
    folder: z.string().min(1).max(200).default("INBOX"),
    /** The managed zone its files go to, by name: made in the tenant on its first message. */
    zone: z.string().min(1).max(200).default("Mail"),
    everyMinutes: z.number().int().min(1).max(1440).default(5),
    /**
     * The name the mailbox's provider signs its Authentication-Results header with (e.g.
     * "mx.google.com"), or several (a provider with more than one receiving server): a message
     * is taken only when that header says DMARC passed. Look at the headers of a message in
     * the mailbox to find it.
     */
    authserv: z
      .union([z.string().min(1).max(253), z.array(z.string().min(1).max(253)).min(1).max(20)])
      .transform((a) => (typeof a === "string" ? [a] : a))
      .optional(),
    /** Believe the From line with no such check. Only for a mailbox nobody else can send to. */
    allowUnauthenticated: z.boolean().default(false),
    /** Senders taken besides the tenant's own members; their mail is `owner`'s. */
    allowFrom: z.array(EMAIL).max(200).default([]),
    /** Who owns mail from `allowFrom` senders: a member's email, or their id (`usr_…`). */
    owner: z.string().min(3).max(320).optional(),
    /** The largest message taken, and the largest attachment, in bytes. Default 25 MiB. */
    maxBytes: z
      .number()
      .int()
      .min(1024)
      // (A message is held in memory whole, more than once, while it is read.)
      .max(100 * 1024 ** 2)
      .default(25 * 1024 ** 2),
  })
  .strict();

/** The environment variable a mailbox's password is read from. */
export function mailPasswordEnv(id: string): string {
  return `OPENHOARD_MAIL_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PASSWORD`;
}

export type MailboxConfig = z.infer<typeof MailboxSchema>;

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
    /** Folders synced on a schedule (T-303). */
    sources: z.array(SourceSchema).max(100).default([]),
    models: ModelsSchema.prefault({}),
    /** Mailboxes read over IMAP (T-1208): what is sent to them becomes files. */
    mailIn: z.array(MailboxSchema).max(20).default([]),
    auth: AuthSchema.optional(),
    /**
     * Uploads (T-1206): signed-in members add files through `/api/uploads` and the installable
     * page at `/app/` (a share target on phones and desktops), and OpenHoard keeps the bytes,
     * in `<dataDir>/blobs`. Off unless this is here; `{}` turns it on with the defaults. Needs
     * `auth`.
     */
    uploads: z
      .object({
        /** The managed zone uploads go to, by name: made in a tenant on its first upload. */
        zone: z.string().min(1).max(200).default("Uploads"),
        /** The largest file taken, in bytes. Default 100 MiB. */
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(16 * 1024 ** 3)
          .default(100 * 1024 ** 2),
      })
      .strict()
      .optional(),
    /**
     * The named Cloudflare tunnel `openhoard tunnel` runs when no flag names one (T-1205): the
     * tunnel's name on the operator's own Cloudflare account, and the host name routed to it.
     * Without it (and without flags) `openhoard tunnel` opens a quick tunnel, to try.
     */
    tunnel: z
      .object({
        name: z.string().regex(TUNNEL_NAME, "a tunnel's name or id"),
        hostname: z.string().regex(TUNNEL_HOST, "a host name, as files.example.com"),
      })
      .strict()
      .optional(),
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
  .strict()
  .superRefine((c, ctx) => {
    if (c.auth?.signInLinks === true) {
      // Both where it listens and where people reach it: a tunnel or a proxy in front (a public
      // publicUrl) would put the links on the internet.
      if (!LOOPBACK_HOSTS.has(c.host) || !isLoopback(new URL(c.auth.publicUrl))) {
        ctx.addIssue({
          code: "custom",
          path: ["auth", "signInLinks"],
          message:
            "sign-in links need a server on this machine only: host and publicUrl on 127.0.0.1 (no tunnel or proxy)",
        });
      }
    }
    if (c.uploads !== undefined && c.auth === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["uploads"],
        message: "uploads need sign-in: configure auth",
      });
    }
    c.sources.forEach((source, i) => {
      // The crawl is what bounds how long a permission removed at SharePoint can still read
      // here: without one, a change the delta doesn't report would never be seen.
      if (
        source.connector === "sharepoint" &&
        source.importPermissions &&
        source.recrawlAfterDays === 0
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["sources", i, "recrawlAfterDays"],
          message:
            "can't be 0 while permissions are imported: the periodic crawl bounds how long a removed permission lasts here",
        });
      }
    });
    const mailboxes = new Set<string>();
    c.mailIn.forEach((m, i) => {
      const issue = (path: string, message: string) =>
        ctx.addIssue({ code: "custom", path: ["mailIn", i, path], message });
      // By the variable their passwords are read from: "a.b" and "a-b" would share one.
      if (mailboxes.has(mailPasswordEnv(m.id))) issue("id", `duplicate mailbox ${m.id}`);
      mailboxes.add(mailPasswordEnv(m.id));
      if (m.authserv !== undefined && m.allowUnauthenticated) {
        issue("allowUnauthenticated", "authserv checks the sender: this would switch that off");
      }
      if (m.authserv === undefined && !m.allowUnauthenticated) {
        issue(
          "authserv",
          "name the mailbox provider's authserv-id, so a sender is who its server says (or set allowUnauthenticated, to believe the From line)",
        );
      }
      if (m.allowFrom.length > 0 && m.owner === undefined) {
        issue("owner", "mail from allowFrom senders needs an owner");
      }
      if (!m.secure && !LOOPBACK_HOSTS.has(m.host)) {
        issue("secure", "a mailbox is read over TLS, unless its server is on this machine");
      }
      if (c.uploads !== undefined && m.zone === c.uploads.zone) {
        issue("zone", `zone "${m.zone}" is the uploads' (uploads.zone): mail goes to another`);
      }
      if (c.sources.some((s) => s.tenantId === m.tenantId && s.zone === m.zone)) {
        issue("zone", `zone "${m.zone}" is a folder's: mail goes to a zone of its own`);
      }
    });
    const ids = new Set<string>();
    const secrets = new Set<string>();
    c.sources.forEach((s, i) => {
      const key = `${s.tenantId}/${s.id}`;
      // Uploaded items' own source (uploads.ts UPLOAD_SOURCE): a folder's would mix with them.
      // Mail's own source (mail-in.ts MAIL_SOURCE), likewise.
      if (c.mailIn.length > 0 && s.id === "mail") {
        ctx.addIssue({
          code: "custom",
          path: ["sources", i, "id"],
          message: `"mail" is what mail's files are recorded under: give the source another id`,
        });
      }
      if (c.uploads !== undefined && s.id === "uploads") {
        ctx.addIssue({
          code: "custom",
          path: ["sources", i, "id"],
          message: `"uploads" is what uploaded files are recorded under: give the source another id`,
        });
      }
      if (c.uploads !== undefined && s.zone === c.uploads.zone) {
        ctx.addIssue({
          code: "custom",
          path: ["sources", i, "zone"],
          message: `zone "${s.zone}" is the uploads' (uploads.zone): a folder syncs into another`,
        });
      }
      if (ids.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["sources", i, "id"],
          message: `duplicate source ${s.id}`,
        });
      }
      ids.add(key);
      // Two sources' secrets are told apart by their ids as the environment spells them.
      if (s.connector === "sharepoint") {
        const name = sourceSecretEnv(s.id);
        if (secrets.has(name)) {
          ctx.addIssue({
            code: "custom",
            path: ["sources", i, "id"],
            message: `its secret's variable (${name}) is another source's too: give it another id`,
          });
        }
        secrets.add(name);
      }
      // The connector keeps its state under the data directory, which must be outside the root.
      if (s.connector === "fs" && isAbsolute(s.root) && overlap(s.root, c.dataDir)) {
        ctx.addIssue({
          code: "custom",
          path: ["sources", i, "root"],
          message:
            "a source's folder and the data directory can't be inside one another (links and junctions included)",
        });
      }
    });
  });

export type Config = z.infer<typeof ConfigSchema>;
export type UploadsConfig = NonNullable<Config["uploads"]>;

/** The addresses `host` may name for a server that listens on this machine only. */
/**
 * Whether a URL's host is a name a passkey can belong to (a WebAuthn relying party id): not an
 * IPv4 or IPv6 address. `localhost` is one.
 */
function isDomain(hostname: string): boolean {
  return !hostname.startsWith("[") && !/^[0-9.]+$/.test(hostname) && hostname !== "";
}

/** The WebAuthn relying party id of a server: its public URL's host. */
export function relyingPartyId(publicUrl: string): string {
  return new URL(publicUrl).hostname;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Whether the server, listening on `host`, is reachable from this machine only. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * Whether two folders are one, or one is inside the other: as written, and as the file system
 * resolves them (symbolic links, junctions, mapped drives), for the part of each that exists.
 */
function overlap(a: string, b: string): boolean {
  const pairs: [string, string][] = [[resolve(a), resolve(b)]];
  const ra = real(a);
  const rb = real(b);
  if (ra !== null && rb !== null) pairs.push([ra, rb]);
  return pairs.some(([x, y]) => within(x, y) || within(y, x));
}

/** The path as the file system resolves it: its longest existing part, then the rest. */
function real(p: string): string | null {
  let head = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(head), ...rest.reverse());
    } catch {
      const up = dirname(head);
      if (up === head) return null;
      rest.push(basename(head));
      head = up;
    }
  }
}

/** Whether `inner` is `outer` or inside it (case-insensitively on Windows and macOS). */
function within(outer: string, inner: string): boolean {
  const fold = process.platform === "linux" ? (x: string) => x : (x: string) => x.toLowerCase();
  const rel = relative(fold(outer), fold(inner));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The byte order mark Windows editors (Notepad, PowerShell 5's Out-File) put before JSON. */
const BOM = 0xfeff;

/** `text` without a leading byte order mark, which JSON.parse refuses. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === BOM ? text.slice(1) : text;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const dataDir = resolve(cwd, env.OPENHOARD_DATA_DIR ?? ".openhoard");
  const file = join(dataDir, "config.json");
  let fromFile: unknown = {};
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(stripBom(readFileSync(file, "utf8")));
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
  // Reached through a tunnel for this run (`openhoard tunnel` sets it for the server it starts):
  // people come in at that address, so links issued on this machine are off, and built-in
  // accounts sign in with passkeys. Nothing is written to the file.
  const tunnelUrl = env.OPENHOARD_TUNNEL_URL;
  if (tunnelUrl !== undefined && tunnelUrl !== "") {
    if (typeof merged.auth !== "object" || merged.auth === null) {
      throw new Error(
        "invalid OpenHoard config:\n  OPENHOARD_TUNNEL_URL needs sign-in configured (auth)",
      );
    }
    merged.auth = {
      ...(merged.auth as object),
      publicUrl: tunnelUrl,
      signInLinks: false,
      passkeys: true,
    };
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
