import {
  appendAudit,
  auditedExport,
  AuditFilterError,
  ExportFailed,
  listAudit,
  MAX_AUDIT_PAGE,
  parseAuditFilter,
  verifyAudit,
  type AuditFilterText,
  type AuditRecord,
} from "@openhoard/core-audit";
import { AI_CLIENT_TRUSTS, isId, lockPrincipals, type Database, type Tx } from "@openhoard/core-db";
import {
  approvedTrust,
  clientPeople,
  decideClient,
  findUserByEmail,
  findUserByUserName,
  getClient,
  getGroup,
  getUser,
  grantAdmin,
  IdentityError,
  isAdmin,
  listAdmins,
  listClients,
  revokeAdmin,
  userPrincipal,
  type ClientStatus,
  type OAuthClient,
  type User,
} from "@openhoard/core-identity";
import {
  HEALTH_SECTIONS,
  healthCsv,
  healthCsvCut,
  HealthError,
  healthPage,
  healthReport,
  tenantVocabulary,
  VIEW_TRANSACTION,
  VocabularyError,
  type HealthOptions,
  type HealthReport,
} from "@openhoard/core-catalog";
import {
  listSourceSkips,
  listSourceSyncs,
  MAX_SKIP_PAGE,
  syncStanding,
  type SourceSyncState,
  type SyncStanding,
} from "@openhoard/core-jobs";
import { mayAdminister, type AuthzClient, type ClientTrust } from "@openhoard/core-policy";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "pino";
import type { AuthEnv, SignedIn } from "./auth.js";
import { adminGroupOf, type AuthConfig, type SourceConfig } from "./config.js";
import type { UnavailableSource } from "./sources.js";
import { configuredTrust, listedIn } from "./oauth/allowlist.js";
import { retrying } from "./retry.js";

/*
 * The admin API (T-106): a tenant's admins decide which AI clients its people may connect, and
 * who else is an admin. JSON over HTTP, for the admin UI to come (T-9xx) and for scripts.
 *
 *   GET    /api/admin/clients                 every client the tenant's people tried, and its use
 *   POST   /api/admin/clients/:key/approve    {"trust": "local" | "commercial" | "consumer"}
 *   POST   /api/admin/clients/:key/refuse     a pending client
 *   POST   /api/admin/clients/:key/revoke     an approved client: its grants and tokens end
 *   GET    /api/admin/admins                  the tenant's admins
 *   POST   /api/admin/admins                  {"userId": "usr_…"} or {"email": …} or {"userName": …}
 *   DELETE /api/admin/admins/:userId
 *   GET    /api/admin/sources                 each connector sync and its last scheduled run
 *   GET    /api/admin/sources/:source/skips   what a source's syncs left out, and why
 *   GET    /api/admin/audit                   the audit log, newest first, filtered, a page
 *   POST   /api/admin/audit/export            the same filter as NDJSON or CSV (recent sign-in)
 *   POST   /api/admin/audit/verify            checks the tenant's whole chain
 *   POST   /api/admin/health                  the File Health Report as a page says it
 *   POST   /api/admin/health/export           the same as CSV, every file listed (recent sign-in)
 *   GET    /api/admin/vocabulary              every facet and value, and what waits in review
 *
 * - Signed in with the session cookie (T-102), as an admin (core/policy mayAdminister(): an
 *   active member with the admin role or in the tenant's admin group, through OpenHoard's own
 *   app). Admin is for this API only: it never widens what someone may read.
 * - Changes carry the session cookie, so the server's CSRF check applies: their Origin must be
 *   publicUrl's (auth.ts). They also take JSON only, which a cross-site form can't send.
 * - Approving a client (or relabelling it) and changing who is an admin take a recent sign-in
 *   (auth.adminSignInMinutes, 15 by default): a session left open, or stolen, can't let a client
 *   in, make itself admins, or remove the ones who would stop it. Refusing and revoking a client
 *   never wait on it, so an emergency cut-off is never a sign-in away.
 * - Each change is checked again in its own transaction (isAdmin(), not the snapshot the session
 *   was read in), and every decision, allowed or refused, is audited: `admin.access` for a
 *   request refused before it reached anything, `oauth-client.approve|refuse|revoke` and
 *   `admin.grant|revoke` for the rest.
 * - A client is shown by what identifies it: its metadata document URL (client_id), or the
 *   redirect URIs a dynamically registered client's codes go to. The name it gives itself is
 *   `claimedName`, never the identity (anyone can call themselves "Claude").
 */

export interface AdminApiDeps {
  auth: AuthConfig;
  db: Database;
  log?: Logger;
  /** The configured sources: each one's staleness limit. */
  sources?: readonly Pick<SourceConfig, "tenantId" | "id" | "staleAfterHours">[];
  /** Configured sources this server couldn't start (sources.ts prepareSources()). */
  unavailable?: readonly UnavailableSource[];
}

/** The request's client: the admin API is OpenHoard's own. */
const FIRST_PARTY: AuthzClient = { id: "openhoard", trust: "first-party" };
const NO_STORE = { "cache-control": "no-store" } as const;
const CLIENT_KEY = /^[0-9a-f]{64}$/;
/** A source's id, as the config takes it. */
const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** A skip's reason (core/db source_skips). */
const REASON_CODE = /^[a-z0-9][a-z0-9:-]{0,63}$/;

type Action = "approve" | "refuse" | "revoke";
/** The statuses each action starts from: a refusal of an approved client is a revocation. */
const FROM: Record<Action, readonly ClientStatus[]> = {
  approve: ["pending", "refused", "approved"],
  refuse: ["pending"],
  revoke: ["approved"],
};

/** A failure the handler answers with, after auditing it. */
class Refusal extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

export function mountAdminApi(app: Hono<AuthEnv>, deps: AdminApiDeps): void {
  const { auth, db, log } = deps;
  const adminGroup = adminGroupOf(auth);
  const groupOf = (tenantId: string) => {
    const g = adminGroup(tenantId);
    return g === undefined ? {} : { adminGroupId: g };
  };
  const audit = (tx: Tx, tenantId: string, record: AuditRecord) =>
    appendAudit(tx, tenantId, record);
  /** A refusal's audit record, in a transaction of its own (the action's rolled back). */
  const auditDenial = (signedIn: SignedIn, record: Omit<AuditRecord, "actor" | "decision">) =>
    db.withTenant(signedIn.tenantId, (tx) =>
      audit(tx, signedIn.tenantId, {
        ...record,
        actor: userPrincipal(signedIn.principal.userId),
        decision: "deny",
      }),
    );

  app.use(
    "/api/admin/*",
    bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "body too large" }, 413) }),
  );

  // Who may be here at all: a signed-in admin, as the session's snapshot says.
  app.use("/api/admin/*", async (c, next) => {
    c.header("cache-control", "no-store");
    const signedIn = c.get("auth");
    if (!signedIn) return c.json({ error: "not signed in" }, 401);
    const decision = mayAdminister(signedIn.principal, FIRST_PARTY);
    if (!decision.allow) {
      await auditDenial(signedIn, {
        action: "admin.access",
        detail: { method: c.req.method, path: c.req.path.slice(0, 256), reason: "not-admin" },
      });
      return c.json({ error: "forbidden" }, 403);
    }
    if (c.req.method === "POST") {
      const type = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
      if (type !== "application/json") return c.json({ error: "the body is JSON" }, 415);
    }
    await next();
  });

  /** Whether the session started recently enough for a change that asks for it. */
  const recent = (signedIn: SignedIn): boolean =>
    Date.now() - signedIn.signedInAt.getTime() <= auth.adminSignInMinutes * 60_000;

  /**
   * Runs a change as the signed-in admin: checks they still are one, in the change's own
   * transaction, then `work`, which audits what it did. A Refusal (or an IdentityError it maps)
   * rolls the change back and is audited on its own.
   */
  async function change<T>(
    c: Context<AuthEnv>,
    what: { action: string; client?: string; detail: Record<string, string> },
    work: (tx: Tx, signedIn: SignedIn) => Promise<T>,
    options: { recentSignIn: boolean; identityErrors?: (e: IdentityError) => Refusal },
  ): Promise<Response | T> {
    const signedIn = c.get("auth") as SignedIn;
    const { tenantId } = signedIn;
    const refuse = async (r: Refusal) => {
      await auditDenial(signedIn, {
        action: what.action,
        ...(what.client ? { client: what.client } : {}),
        detail: { ...what.detail, reason: r.reason },
      });
      return c.json(
        r.reason === "sign-in-again"
          ? { error: r.message, signIn: "/auth/sign-in" }
          : { error: r.message },
        r.status,
        NO_STORE,
      );
    };
    if (options.recentSignIn && !recent(signedIn)) {
      return refuse(new Refusal(403, "sign-in-again", "sign in again to do this"));
    }
    try {
      // Run again after a deadlock or serialization failure: the database rolled it back.
      return await retrying(() =>
        db.withTenant(tenantId, async (tx) => {
          // The principal lock first: admin changes take it, and a removal of this admin that
          // commits first is seen here.
          await lockPrincipals(tx, tenantId);
          if (!(await isAdmin(tx, tenantId, signedIn.principal.userId, groupOf(tenantId)))) {
            throw new Refusal(403, "not-admin", "forbidden");
          }
          return work(tx, signedIn);
        }),
      );
    } catch (e) {
      if (e instanceof Refusal) return refuse(e);
      if (e instanceof IdentityError && options.identityErrors) {
        return refuse(options.identityErrors(e));
      }
      throw e;
    }
  }

  // --- Clients ---------------------------------------------------------------------------------

  app.get("/api/admin/clients", async (c) => {
    const { tenantId } = c.get("auth") as SignedIn;
    const [clients, people] = await db.withTenant(
      tenantId,
      async (tx) => [await listClients(tx, tenantId), await clientPeople(tx, tenantId)] as const,
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    return c.json({
      clients: clients.map((client) => {
        const shown = showClient(auth, tenantId, client);
        return {
          ...shown,
          // Its use (T-904). How many people it acts for now: a count, never who; none for a
          // client that gets nothing now (taken out of the config since), whatever it holds.
          people: shown.approved ? (people.get(client.clientKey) ?? 0) : 0,
          // The last request made with a token of it, to within a minute.
          lastUsedAt: client.lastUsedAt?.toISOString() ?? null,
        };
      }),
    });
  });

  for (const action of ["approve", "refuse", "revoke"] as const) {
    app.post(`/api/admin/clients/:key/${action}`, async (c) => {
      const key = c.req.param("key");
      if (!CLIENT_KEY.test(key)) return c.json({ error: "no such client" }, 404);
      let trust: ClientTrust | undefined;
      if (action === "approve") {
        const body = (await c.req.json().catch(() => null)) as { trust?: unknown } | null;
        const asked = body?.trust;
        if (typeof asked !== "string" || !(AI_CLIENT_TRUSTS as readonly string[]).includes(asked)) {
          return c.json({ error: `trust is one of ${AI_CLIENT_TRUSTS.join(", ")}` }, 400);
        }
        trust = asked as ClientTrust;
      }
      const result = await change(
        c,
        {
          action: `oauth-client.${action}`,
          detail: { clientKey: key, ...(trust ? { trust } : {}) },
        },
        async (tx, signedIn) => {
          const { tenantId } = signedIn;
          const client = await getClient(tx, tenantId, key);
          if (!client) throw new Refusal(404, "unknown-client", "no such client");
          const listed = listedIn(auth, tenantId, client);
          // The config decides for what it lists; only a refusal made here before it was listed
          // can be lifted here, and with the config's label.
          if (listed && !(action === "approve" && client.status === "refused")) {
            throw new Refusal(
              409,
              "config-managed",
              "approved in the server's config (auth.clients)",
            );
          }
          if (listed && trust !== listed.trust) {
            throw new Refusal(409, "config-managed", `the config gives it trust ${listed.trust}`);
          }
          const by = userPrincipal(signedIn.principal.userId);
          const decided = await decideClient(
            tx,
            tenantId,
            key,
            trust ? { approve: true, trust } : { approve: false },
            by,
            { expect: FROM[action] },
          );
          await audit(tx, tenantId, {
            actor: by,
            action: `oauth-client.${action}`,
            decision: "allow",
            client: client.clientRef,
            detail: {
              clientKey: key,
              was: decided.was,
              ...(trust ? { trust } : {}),
              ...(client.status === "approved" && client.trust !== null
                ? { previousTrust: client.trust }
                : {}),
            },
          });
          return showClient(auth, tenantId, decided);
        },
        {
          // Approving lets a client in (or relabels it); refusing and revoking only cut off.
          recentSignIn: action === "approve",
          identityErrors: (e) =>
            e.code === "conflict"
              ? new Refusal(409, "status-changed", `can't ${action}: ${e.message}`)
              : new Refusal(404, "unknown-client", "no such client"),
        },
      );
      return result instanceof Response ? result : c.json({ client: result }, 200, NO_STORE);
    });
  }

  // --- Admins ----------------------------------------------------------------------------------

  app.get("/api/admin/admins", async (c) => {
    const { tenantId } = c.get("auth") as SignedIn;
    const groupId = adminGroup(tenantId);
    const { admins, group } = await db.withTenant(
      tenantId,
      async (tx) => ({
        admins: await listAdmins(tx, tenantId, groupOf(tenantId)),
        group: groupId === undefined ? null : await getGroup(tx, tenantId, groupId),
      }),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    return c.json({
      admins: admins.map((a) => ({
        ...showUser(a.user),
        via: a.via,
        effective: a.effective,
        grantedBy: a.user.adminRole?.by ?? null,
        grantedAt: a.user.adminRole?.at.toISOString() ?? null,
      })),
      // The config's admin group, and whether it makes anyone an admin: a group that is gone, or
      // isn't a SCIM group, makes nobody one.
      adminGroup:
        groupId === undefined
          ? null
          : {
              groupId,
              name: group?.name ?? null,
              usable: group?.source === "scim",
            },
    });
  });

  app.post("/api/admin/admins", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const named = whoIsNamed(body);
    if (!named) return c.json({ error: "name one person: userId, email or userName" }, 400);
    const result = await change(
      c,
      { action: "admin.grant", detail: named.detail },
      async (tx, signedIn) => {
        const { tenantId } = signedIn;
        const user = await named.find(tx, tenantId);
        if (!user) throw new Refusal(404, "unknown-user", "no such person");
        const by = userPrincipal(signedIn.principal.userId);
        const granted = await grantAdmin(tx, tenantId, user.id, by);
        await audit(tx, tenantId, {
          actor: by,
          action: "admin.grant",
          decision: "allow",
          detail: { user: user.id, ...(granted ? {} : { unchanged: true }) },
        });
        return { user: showUser(user), granted };
      },
      {
        recentSignIn: true,
        identityErrors: (e) =>
          e.code === "invalid"
            ? new Refusal(
                400,
                "not-a-member",
                "only a member is made admin, never a guest or a service account",
              )
            : e.code === "inactive"
              ? new Refusal(409, "inactive", "unlock them first")
              : new Refusal(404, "unknown-user", "no such person"),
      },
    );
    return result instanceof Response ? result : c.json(result, 200, NO_STORE);
  });

  app.delete("/api/admin/admins/:userId", async (c) => {
    const userId = c.req.param("userId");
    const detail = { user: isId("user", userId) ? userId : "not-a-user-id" };
    const result = await change(
      c,
      { action: "admin.revoke", detail },
      async (tx, signedIn) => {
        const { tenantId } = signedIn;
        const by = userPrincipal(signedIn.principal.userId);
        const done = await revokeAdmin(tx, tenantId, userId, by, groupOf(tenantId));
        await audit(tx, tenantId, {
          actor: by,
          action: "admin.revoke",
          decision: "allow",
          detail: {
            user: userId,
            ...(done.revoked ? {} : { unchanged: true }),
            ...(done.stillAdminByGroup ? { stillAdminByGroup: true } : {}),
          },
        });
        return done;
      },
      {
        // A stolen session removing the admins who would stop it.
        recentSignIn: true,
        identityErrors: (e) =>
          e.code === "wrong-source"
            ? new Refusal(
                409,
                "admin-group",
                "an admin through the identity provider's admin group: remove them there",
              )
            : e.code === "conflict"
              ? new Refusal(
                  409,
                  "last-admin",
                  "the tenant's last admin: make someone else admin first",
                )
              : new Refusal(404, "unknown-user", "no such person"),
      },
    );
    return result instanceof Response ? result : c.json(result, 200, NO_STORE);
  });

  // --- Sources (T-303) -------------------------------------------------------------------------

  // Where each connector sync stands and how its last scheduled run ended: read-only (the admin
  // CLI confirms, discards, resumes and runs them).
  app.get("/api/admin/sources", async (c) => {
    const { tenantId } = c.get("auth") as SignedIn;
    const syncs = await db.withTenant(tenantId, (tx) => listSourceSyncs(tx, tenantId), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
    const now = new Date();
    const configured = new Map(
      (deps.sources ?? []).filter((s) => s.tenantId === tenantId).map((s) => [s.id, s]),
    );
    const unavailable = new Map(
      (deps.unavailable ?? []).filter((u) => u.tenantId === tenantId).map((u) => [u.source, u]),
    );
    const standingOf = (source: string, s: SourceSyncState) => {
      const hours = configured.get(source)?.staleAfterHours;
      const down = unavailable.get(source)?.code;
      return syncStanding(s, {
        now,
        ...(hours === undefined ? {} : { staleAfterMs: hours * 3_600_000 }),
        ...(down === undefined ? {} : { unavailable: down }),
      });
    };
    // A source the server couldn't start that never ran has no sync yet: listed all the same,
    // so it isn't missing from the page.
    const unstarted = [...unavailable.values()]
      .filter((u) => !syncs.some((s) => s.source === u.source))
      .map((u) => ({
        source: u.source,
        connector: u.connector,
        zoneId: null,
        phase: null,
        standing: { is: "unavailable", code: u.code } satisfies SyncStanding,
        scheduled: false,
        stoppedAt: null,
        stoppedError: null,
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        lastCounts: null,
        lastCurrentAt: null,
        reconciling: false,
        reconcileHeld: null,
        reconcileConfirmed: null,
        reconcileDeferred: false,
        updatedAt: null,
      }));
    return c.json({
      sources: [
        ...syncs.map((s) => ({
          source: s.source,
          connector: s.connector,
          zoneId: s.zoneId,
          phase: s.phase,
          // The one thing to tell an admin: what waits on them, else how it is going (core/jobs).
          standing: standingOf(s.source, s),
          scheduled: s.stoppedAt === null && !unavailable.has(s.source),
          stoppedAt: s.stoppedAt?.toISOString() ?? null,
          stoppedError: s.stoppedError,
          lastRunAt: s.lastRunAt?.toISOString() ?? null,
          lastStatus: s.lastStatus,
          lastError: s.lastError,
          lastCounts: s.lastCounts,
          lastCurrentAt: s.lastCurrentAt?.toISOString() ?? null,
          reconciling: s.reconciling,
          reconcileHeld: s.reconcileHeld,
          reconcileConfirmed: s.reconcileConfirmed,
          reconcileDeferred: s.reconcileDeferred,
          updatedAt: s.updatedAt.toISOString(),
        })),
        ...unstarted,
      ],
    });
  });

  // What a source's syncs left out, and why (core/jobs skips.ts): counts by reason and the
  // items, most recently met first. Paths are the source's text: the page shows them as text.
  app.get("/api/admin/sources/:source/skips", async (c) => {
    const { tenantId } = c.get("auth") as SignedIn;
    const source = c.req.param("source");
    const reason = c.req.query("reason");
    const limitArg = c.req.query("limit");
    const limit = limitArg === undefined ? 100 : Number(limitArg);
    if (
      !SOURCE_ID.test(source) ||
      (reason !== undefined && !REASON_CODE.test(reason)) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_SKIP_PAGE
    ) {
      return c.json({ error: "invalid" }, 400);
    }
    const found = await db.withTenant(
      tenantId,
      async (tx) =>
        (await listSourceSyncs(tx, tenantId)).some((s) => s.source === source)
          ? listSourceSkips(tx, tenantId, source, {
              limit,
              ...(reason === undefined ? {} : { reason }),
            })
          : null,
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    if (found === null) return c.json({ error: "not found" }, 404);
    return c.json(
      {
        total: found.total,
        byReason: found.byReason,
        skips: found.items.map((i) => ({
          externalId: i.externalId,
          reason: i.reason,
          path: i.path,
          firstSeenAt: i.firstSeenAt.toISOString(),
          lastSeenAt: i.lastSeenAt.toISOString(),
        })),
      },
      200,
      NO_STORE,
    );
  });

  // --- The audit log (T-905) ------------------------------------------------------------------

  const FILTER_FIELDS = [
    "actor",
    "action",
    "actionPrefix",
    "decision",
    "client",
    "object",
    "from",
    "to",
  ] as const;
  /** A filter, checked as the CLI checks its flags (core/audit): from the query, or a body. */
  const auditFilterOf = (read: (field: (typeof FILTER_FIELDS)[number]) => unknown) => {
    const text: AuditFilterText = {};
    for (const field of FILTER_FIELDS) {
      const value = read(field);
      if (value === undefined) continue;
      if (typeof value !== "string") throw new AuditFilterError(field, `${field} is text`);
      text[field] = value;
    }
    return parseAuditFilter(text);
  };
  const filterRefused = (c: Context<AuthEnv>, e: unknown) => {
    if (e instanceof AuditFilterError) return c.json({ error: e.message, field: e.field }, 400);
    throw e;
  };
  /** The admin, checked again in the database: the session's word is as old as the sign-in. */
  const stillAdmin = (signedIn: SignedIn) =>
    db.withTenant(signedIn.tenantId, (tx) =>
      isAdmin(tx, signedIn.tenantId, signedIn.principal.userId, groupOf(signedIn.tenantId)),
    );

  // A page of events, newest first; `before` (a seq) for the next, older page. Read-only, and
  // not itself audited: an admin reading the log is what the log is for. Paging shows what an
  // export does, a page at a time; the export is the door for taking it away whole.
  app.get("/api/admin/audit", async (c) => {
    const signedIn = c.get("auth") as SignedIn;
    const limitArg = c.req.query("limit");
    const beforeArg = c.req.query("before");
    const whole = (v: string | undefined, max: number) =>
      v === undefined
        ? undefined
        : /^\d{1,15}$/.test(v) && Number(v) >= 1 && Number(v) <= max
          ? Number(v)
          : null;
    const limit = whole(limitArg, MAX_AUDIT_PAGE);
    const before = whole(beforeArg, Number.MAX_SAFE_INTEGER);
    if (limit === null || before === null) {
      return c.json({ error: `limit is 1 to ${MAX_AUDIT_PAGE}, before a sequence number` }, 400);
    }
    let filter;
    try {
      ({ filter } = auditFilterOf((field) => c.req.query(field)));
    } catch (e) {
      return filterRefused(c, e);
    }
    if (!(await stillAdmin(signedIn))) return c.json({ error: "forbidden" }, 403, NO_STORE);
    const page = await listAudit(db, signedIn.tenantId, filter, {
      ...(limit === undefined ? {} : { limit }),
      ...(before === undefined ? {} : { before }),
    });
    return c.json(page, 200, NO_STORE);
  });

  // The filtered log as a file, recorded (`audit.export`) after it, with who took it and what
  // they asked: the whole tenant's history, so it takes a recent sign-in, and the admin is
  // checked again in the database first. A POST with a JSON body (`format` and the filter), so
  // another site can't make an admin's browser take one (the Origin check) and put it in the log.
  app.post("/api/admin/audit/export", async (c) => {
    const signedIn = c.get("auth") as SignedIn;
    const { tenantId } = signedIn;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({ error: "a JSON object" }, 400);
    }
    const format = body.format ?? "ndjson";
    if (format !== "ndjson" && format !== "csv") {
      return c.json({ error: "format is ndjson or csv", field: "format" }, 400);
    }
    let parsed;
    try {
      parsed = auditFilterOf((field) => body[field]);
    } catch (e) {
      return filterRefused(c, e);
    }
    // Refused as a change is (`change()`), and audited so: who tried to take the log.
    const refused = async (reason: "sign-in-again" | "not-admin") => {
      await auditDenial(signedIn, {
        action: "audit.export",
        client: FIRST_PARTY.id,
        detail: { format, reason, ...parsed.asked },
      });
      return c.json(
        reason === "sign-in-again"
          ? { error: "sign in again to do this", signIn: "/auth/sign-in" }
          : { error: "forbidden" },
        403,
        NO_STORE,
      );
    };
    if (!recent(signedIn)) return refused("sign-in-again");
    if (!(await stillAdmin(signedIn))) return refused("not-admin");

    // Written through a pipe the reader pulls from (so a slow reader slows the export). Any
    // failure errors the body rather than ending it, so a cut file never looks whole: the
    // response ends without its last chunk and the reader's download fails. The last bytes go
    // out only after the export is recorded, so a file that can't be recorded isn't handed over
    // whole either.
    const pipe = new TransformStream<Uint8Array, Uint8Array>();
    const writer = pipe.writable.getWriter();
    const bytes = new TextEncoder();
    let pending = "";
    const run = async () => {
      try {
        await auditedExport(
          db,
          tenantId,
          {
            actor: userPrincipal(signedIn.principal.userId),
            client: FIRST_PARTY.id,
            asked: parsed.asked,
          },
          parsed.filter,
          format,
          async (chunk) => {
            pending += chunk;
            if (pending.length < 64 * 1024) return;
            const text = pending;
            pending = "";
            await writer.ready;
            await writer.write(bytes.encode(text));
          },
          // Before the record: a reader gone already is an incomplete export.
          () => writer.ready,
        );
        if (pending !== "") await writer.write(bytes.encode(pending));
        await writer.close();
      } catch (e) {
        await writer.abort(e).catch(() => undefined);
        log?.warn(
          {
            tenantId,
            events: e instanceof ExportFailed ? e.events : undefined,
            recorded: e instanceof ExportFailed ? e.recorded : undefined,
            err: e instanceof Error ? e.message : String(e),
          },
          "audit export ended early",
        );
      }
    };
    void run();
    const day = new Date().toISOString().slice(0, 10);
    return new Response(pipe.readable, {
      headers: {
        "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson",
        "content-disposition": `attachment; filename="audit-${day}.${format}"`,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  });

  // Checks the tenant's whole chain (core/audit verifyAudit()): every hash, link and sequence
  // number. Read-only; a POST, as it is work on demand, not a page to prefetch.
  app.post("/api/admin/audit/verify", async (c) => {
    const { tenantId } = c.get("auth") as SignedIn;
    const result = await verifyAudit(db, tenantId);
    return c.json(result, 200, NO_STORE);
  });

  // --- The File Health Report (T-1002) -------------------------------------------------------

  /** `staleDays` and `largeMb`, from the query or a body, checked as the CLI's flags are. */
  const healthOptionsOf = (
    read: (field: "staleDays" | "largeMb") => unknown,
  ): Omit<HealthOptions, "limit"> | { invalid: string } => {
    const whole = (field: "staleDays" | "largeMb", max: number) => {
      const v = read(field);
      if (v === undefined) return undefined;
      const n =
        typeof v === "number" ? v : typeof v === "string" && /^\d{1,9}$/.test(v) ? Number(v) : NaN;
      return Number.isSafeInteger(n) && n >= 1 && n <= max ? n : null;
    };
    const staleAfterDays = whole("staleDays", 36_500);
    const largeMb = whole("largeMb", 1_000_000);
    if (staleAfterDays === null) return { invalid: "staleDays is a whole number, 1 to 36500" };
    if (largeMb === null) return { invalid: "largeMb is a whole number, 1 to 1000000" };
    return {
      ...(staleAfterDays === undefined ? {} : { staleAfterDays }),
      ...(largeMb === undefined ? {} : { largeBytes: largeMb * 1024 * 1024 }),
    };
  };

  /**
   * The report for the signed-in admin (core checks again that they are one), recorded as the
   * CLI records it (`health.report`): it names every file by its title. Refusals are recorded
   * too. Returns the report, or the response that refuses it.
   */
  async function healthFor(
    c: Context<AuthEnv>,
    format: "page" | "csv",
    options: HealthOptions,
  ): Promise<HealthReport | Response> {
    const signedIn = c.get("auth") as SignedIn;
    const { tenantId } = signedIn;
    const actor = userPrincipal(signedIn.principal.userId);
    let report: HealthReport;
    try {
      report = await db.withTenant(
        tenantId,
        (tx) =>
          healthReport(
            tx,
            tenantId,
            { userId: signedIn.principal.userId, ...groupOf(tenantId) },
            options,
          ),
        VIEW_TRANSACTION,
      );
    } catch (e) {
      if (!(e instanceof HealthError)) throw e;
      if (e.code === "invalid") return c.json({ error: e.message }, 400, NO_STORE);
      await auditDenial(signedIn, {
        action: "health.report",
        client: FIRST_PARTY.id,
        detail: { format, reader: actor, refusal: e.code },
      });
      return c.json({ error: "forbidden" }, 403, NO_STORE);
    }
    // Recorded before it is handed over, as the CLI does.
    const counts = Object.fromEntries(HEALTH_SECTIONS.map((s) => [s, report.sections[s].count]));
    await db.withTenant(tenantId, (tx) =>
      audit(tx, tenantId, {
        actor,
        action: "health.report",
        decision: "allow",
        client: FIRST_PARTY.id,
        // `reader` as the CLI records it (whose report it was): here, the actor's own.
        detail: { format, reader: actor, files: report.files, ...counts },
      }),
    );
    return report;
  }

  // The report as a page says it (core/catalog healthPage()): every word from core, so the web
  // app and `admin health report` say the same. `show` files a finding (1 to 100, default 10).
  // A POST with a JSON body, though it changes nothing but the log: reading it is recorded, so
  // another site mustn't be able to make an admin's browser read it (the Origin check).
  app.post("/api/admin/health", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({ error: "a JSON object" }, 400);
    }
    const show = body.show ?? 10;
    if (typeof show !== "number" || !Number.isInteger(show) || show < 1 || show > 100) {
      return c.json({ error: "show is 1 to 100" }, 400);
    }
    const options = healthOptionsOf((field) => body[field]);
    if ("invalid" in options) return c.json({ error: options.invalid }, 400);
    const report = await healthFor(c, "page", { ...options, limit: show });
    if (report instanceof Response) return report;
    return c.json(
      {
        generatedAt: report.generatedAt.toISOString(),
        files: report.files,
        thresholds: report.thresholds,
        ...healthPage(report, show),
      },
      200,
      NO_STORE,
    );
  });

  // The report as CSV, every file listed (up to 10,000 a finding), as `admin health report
  // --format csv` writes it. A POST, so another site can't make an admin's browser take one; a
  // recent sign-in, as the audit log's export: it is the tenant's files and who can open them.
  app.post("/api/admin/health/export", async (c) => {
    const signedIn = c.get("auth") as SignedIn;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({ error: "a JSON object" }, 400);
    }
    const options = healthOptionsOf((field) => body[field]);
    if ("invalid" in options) return c.json({ error: options.invalid }, 400);
    if (!recent(signedIn)) {
      await auditDenial(signedIn, {
        action: "health.report",
        client: FIRST_PARTY.id,
        detail: {
          format: "csv",
          reader: userPrincipal(signedIn.principal.userId),
          refusal: "sign-in-again",
        },
      });
      return c.json({ error: "sign in again to do this", signIn: "/auth/sign-in" }, 403, NO_STORE);
    }
    const report = await healthFor(c, "csv", { ...options, limit: 10_000 });
    if (report instanceof Response) return report;
    const cut = healthCsvCut(report).reduce((n, s) => n + s.missing, 0);
    const day = report.generatedAt.toISOString().slice(0, 10);
    // (A sheet opened by a double click is read as UTF-8 only when it says so.)
    return c.body(`\ufeff${healthCsv(report)}`, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="file-health-${day}.csv"`,
      "x-content-type-options": "nosniff",
      // Files the sheet leaves out, past 10,000 in a finding.
      "x-report-cut": String(cut),
      ...NO_STORE,
    });
  });

  // The tag vocabulary (T-903): every facet and value, the proposed too, with how many open
  // review items propose each. Read-only; core checks again that the asker is an admin.
  app.get("/api/admin/vocabulary", async (c) => {
    const signedIn = c.get("auth") as SignedIn;
    const { tenantId } = signedIn;
    try {
      const vocabulary = await db.withTenant(
        tenantId,
        (tx) =>
          tenantVocabulary(tx, tenantId, {
            userId: signedIn.principal.userId,
            ...groupOf(tenantId),
          }),
        VIEW_TRANSACTION,
      );
      return c.json(vocabulary);
    } catch (e) {
      if (!(e instanceof VocabularyError)) throw e;
      // An admin when the session was read, not now.
      return c.json({ error: "forbidden" }, 403);
    }
  });

  log?.debug("admin API mounted at /api/admin");
}

/** A client as an admin sees it: what identifies it first, its self-description last. */
function showClient(auth: AuthConfig, tenantId: string, client: OAuthClient) {
  const listed = listedIn(auth, tenantId, client);
  const trust = approvedTrust(client, configuredTrust(auth, tenantId));
  return {
    clientKey: client.clientKey,
    kind: client.kind,
    // A metadata document's URL is the client's identity; a registered client has none.
    clientId: client.kind === "cimd" ? client.clientRef : null,
    redirectUris: client.redirectUris,
    /** Whether it gets tokens now, and with which trust label (the config's, if it lists it). */
    approved: trust !== null,
    trust,
    status: client.status,
    managedBy: listed ? "config" : "app",
    /** The label the config gives it, when it lists it: the only one an approval here may use. */
    configTrust: listed?.trust ?? null,
    requestedBy: client.requestedBy,
    requestedAt: client.requestedAt.toISOString(),
    decidedBy: client.decidedBy,
    decidedAt: client.decidedAt?.toISOString() ?? null,
    /** What the client calls itself: shown, never trusted. */
    claimedName: client.name,
  };
}

function showUser(user: User) {
  return {
    userId: user.id,
    displayName: user.displayName,
    email: user.email,
    userName: user.userName,
    kind: user.kind,
    active: user.active,
  };
}

/** The person a request names, by exactly one of userId, email or userName. */
function whoIsNamed(body: Record<string, unknown> | null): {
  detail: Record<string, string>;
  find: (tx: Tx, tenantId: string) => Promise<User | null>;
} | null {
  if (typeof body !== "object" || body === null) return null;
  const given = (["userId", "email", "userName"] as const).filter((k) => body[k] !== undefined);
  if (given.length !== 1) return null;
  const key = given[0] as "userId" | "email" | "userName";
  const value = body[key];
  if (typeof value !== "string" || value === "" || value.length > 512) return null;
  if (key === "userId") {
    if (!isId("user", value)) return null;
    return {
      detail: { user: value },
      find: (tx, tenantId) => getUser(tx, tenantId, value),
    };
  }
  return {
    detail: { by: key },
    find: (tx, tenantId) =>
      key === "email"
        ? findUserByEmail(tx, tenantId, value)
        : findUserByUserName(tx, tenantId, value),
  };
}
