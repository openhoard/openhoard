import { appendAudit, type AuditRecord } from "@openhoard/core-audit";
import { AI_CLIENT_TRUSTS, isId, lockPrincipals, type Database, type Tx } from "@openhoard/core-db";
import {
  approvedTrust,
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
import { mayAdminister, type AuthzClient, type ClientTrust } from "@openhoard/core-policy";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "pino";
import type { AuthEnv, SignedIn } from "./auth.js";
import { adminGroupOf, type AuthConfig } from "./config.js";
import { configuredTrust, listedIn } from "./oauth/allowlist.js";
import { retrying } from "./retry.js";

/*
 * The admin API (T-106): a tenant's admins decide which AI clients its people may connect, and
 * who else is an admin. JSON over HTTP, for the admin UI to come (T-9xx) and for scripts.
 *
 *   GET    /api/admin/clients                 every client the tenant's people tried
 *   POST   /api/admin/clients/:key/approve    {"trust": "local" | "commercial" | "consumer"}
 *   POST   /api/admin/clients/:key/refuse     a pending client
 *   POST   /api/admin/clients/:key/revoke     an approved client: its grants and tokens end
 *   GET    /api/admin/admins                  the tenant's admins
 *   POST   /api/admin/admins                  {"userId": "usr_…"} or {"email": …} or {"userName": …}
 *   DELETE /api/admin/admins/:userId
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
}

/** The request's client: the admin API is OpenHoard's own. */
const FIRST_PARTY: AuthzClient = { id: "openhoard", trust: "first-party" };
const NO_STORE = { "cache-control": "no-store" } as const;
const CLIENT_KEY = /^[0-9a-f]{64}$/;

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
    const clients = await db.withTenant(tenantId, (tx) => listClients(tx, tenantId), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
    return c.json({ clients: clients.map((client) => showClient(auth, tenantId, client)) });
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
