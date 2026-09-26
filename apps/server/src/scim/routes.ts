import { randomUUID } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import { appendAudit, type AuditRecord } from "@openhoard/core-audit";
import { getTenant, lockPrincipals, type Database, type Tx } from "@openhoard/core-db";
import {
  checkScimToken,
  membersOf,
  parseScimToken,
  scimActor,
  touchScimToken,
  type ScimTokenCheck,
} from "@openhoard/core-identity";
import { Hono, type Context, type Env } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "pino";
import {
  LIST_SCHEMA,
  pageOf,
  PATCH_SCHEMA,
  resourceTypes,
  schemas,
  serviceProviderConfig,
} from "./discovery.js";
import { invalidSyntax, invalidValue, notFound, ScimError } from "./errors.js";
import { parseFilter, parsePath, type AttrPath } from "./filter.js";
import {
  createScimGroup,
  deleteScimGroup,
  groupResource,
  listScimGroups,
  loadMembers,
  MAX_MEMBERS_RETURNED,
  patchScimGroup,
  replaceScimGroup,
  scimGroup,
} from "./groups.js";
import { retrying } from "../retry.js";
import { field, isObject, parseBody, requireSchema, type Json } from "./json.js";
import { addressKey, clientAddress, trustedSet } from "./address.js";
import { FailureLimiter, RecentTokens, RefusalSummary } from "./limiter.js";
import {
  createScimUser,
  deleteScimUser,
  listScimUsers,
  patchUser,
  saveUser,
  scimUser,
  stateFromBody,
  stateOf,
  userResource,
  type PatchOpName,
} from "./users.js";

/*
 * The SCIM 2.0 endpoint (T-103, RFC 7643 and 7644): the tenant's identity provider (Entra ID's
 * provisioning service, Okta, …) keeps OpenHoard's users and groups in step with its own.
 *
 *   <publicUrl>/scim/v2/Users, /Groups, /ServiceProviderConfig, /ResourceTypes, /Schemas
 *
 * - One URL for every tenant: the bearer token (`ohscim.<tenant>.<token id>.<secret>`, issued by
 *   `openhoard admin scim-token issue`) names its tenant, and is checked in that tenant's
 *   transaction on every request (core/identity checkScimToken()), so a revoked or expired token
 *   fails on the next one. Changes are recorded as `scim:<token id>`.
 * - The token is checked before the body is read. A refused token on a real token id is audited
 *   as `scim.auth` with why (wrong secret, revoked, expired). Token ids a tenant doesn't have
 *   (guesses: tenant ids aren't secret) are counted in memory and summed up in one `scim.auth`
 *   record per tenant per window, written after the response, so guessing can't grow the log,
 *   queue on its lock, or tell a tenant that exists from one that doesn't. The caller only ever
 *   hears 401.
 * - Failed authentications are counted per client address (IPv6 by /64; behind trusted
 *   proxies, from X-Forwarded-For), per token id (not while the token is in use, so knowing its
 *   id can't lock it out), and, for unknown token ids, per tenant (limiter.ts). A block never
 *   refuses a valid token on its own: blocked requests get a quiet check (one lookup, nothing
 *   written or counted), and only an invalid token gets 429.
 * - Each request's work is one transaction, which checks the token again, audits the request,
 *   allowed or refused, last (core/audit: its lock is the last taken). A write takes the tenant's
 *   principal lock first (core/db lockPrincipals(), lock order step 0), so SCIM writes to one
 *   tenant run one at a time and its uniqueness checks hold; the directory's triggers invalidate
 *   the principal cache.
 * - A transaction that fails as a deadlock or a serialization failure runs again, whole, a few
 *   times (retry.ts): a disable or delete ends sessions and grants, and may meet an OAuth
 *   request or an admin's decision locking the same rows.
 * - A change to the members of the tenant's admin group (config `auth.adminGroups`, T-106) adds
 *   an `admin.group.join` or `admin.group.leave` record per person to the request's audit.
 * - A request's work runs in a savepoint: a refusal (4xx) undoes whatever it had done, and the
 *   refusal is still audited. Nothing internal reaches the caller: an unexpected error is a
 *   plain 500 with a request id, logged here and audited in a transaction of its own.
 */

export interface ScimOptions {
  /** Failed authentications a client address, or a token id, may make per window (10). */
  maxFailures?: number;
  /** The window, in milliseconds (60 s). */
  failureWindowMs?: number;
  /** Largest request body, in bytes (1 MiB). */
  maxBodyBytes?: number;
  /**
   * Proxies (exact addresses) whose X-Forwarded-For names the client (config
   * `scim.trustedProxies`); none by default.
   */
  trustedProxies?: readonly string[];
}

export interface ScimDeps {
  db: Database;
  log?: Logger;
  /** Where clients reach this server (the Tenant URL is `<publicUrl>/scim/v2`). */
  publicUrl?: string;
  options?: ScimOptions;
  /**
   * Each tenant's admin group id (config `auth.adminGroups`, T-106): a change to its members
   * makes or unmakes admins, which the request's audit records person by person
   * (`admin.group.join`, `admin.group.leave`).
   */
  adminGroup?: (tenantId: string) => string | undefined;
}

const CONTENT_TYPE = "application/scim+json";
const REALM = 'Bearer realm="OpenHoard SCIM"';
const MAX_OPERATIONS = 1000;

type ScimEnv = {
  Variables: {
    scim: { tenantId: string; token: string; tokenId: string; actor: string; keys: string[] };
  };
};

/** The resource a path names, for the audit record: an id, never arbitrary input. */
const targetOf = (id: string | undefined) =>
  id !== undefined && /^(usr|grp)_[0-9a-hjkmnp-tv-z]{26}$/.test(id) ? { target: id } : {};

/** What a request's work produced: a response, and what the audit record says of it. */
interface Done {
  status: 200 | 201 | 204;
  body?: Json;
  location?: string;
  detail?: Record<string, string | number | boolean>;
  /** More audit records, appended after the request's own (admins made or unmade). */
  audits?: AuditRecord[];
}

/** What the server calls at shutdown, before closing the database. */
export interface ScimHandle {
  /** Writes pending unknown-token summaries and stops their timers; nothing is written after. */
  close(): Promise<void>;
}

export function mountScim<E extends Env>(app: Hono<E>, deps: ScimDeps): ScimHandle {
  const { db, log } = deps;
  const opts = deps.options ?? {};
  const windowMs = opts.failureWindowMs ?? 60_000;
  const limiter = new FailureLimiter(opts.maxFailures ?? 10, windowMs);
  // A token that authenticated within the last 10 windows isn't turned away by others' failures.
  const recent = new RecentTokens(windowMs * 10);
  const trusted = trustedSet(opts.trustedProxies ?? []);
  const maxBody = opts.maxBodyBytes ?? 1024 * 1024;
  const unknownTokens = new RefusalSummary(windowMs, async (tenantId, count) => {
    try {
      await db.withTenant(tenantId, async (tx) => {
        // Written only for a tenant that exists (it has a log), after the responses went out.
        if (!(await getTenant(tx, tenantId))) return;
        await appendAudit(tx, tenantId, {
          actor: "scim:unknown-token",
          action: "scim.auth",
          decision: "deny",
          detail: { reason: "unknown-token", count, windowSeconds: Math.ceil(windowMs / 1000) },
        });
      });
    } catch (err) {
      log?.error({ err }, "scim: writing the unknown-token summary failed");
    }
  });
  const scim = new Hono<ScimEnv>();

  const send = (status: number, body?: Json, headers: Record<string, string> = {}) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { ...(body === undefined ? {} : { "content-type": CONTENT_TYPE }), ...headers },
    });
  const fail = (e: ScimError, headers: Record<string, string> = {}) =>
    send(e.status, e.body(), headers);
  const base = (c: Context) =>
    new URL("/scim/v2", deps.publicUrl ?? new URL(c.req.url).origin).href;

  /** A refused token on a real token id, audited with why, in the transaction that checked it. */
  const auditRefusal = async (
    tx: Tx,
    tenantId: string,
    refused: { tokenId: string; reason: string },
    method: string,
  ) =>
    appendAudit(tx, tenantId, {
      actor: scimActor(refused.tokenId),
      action: "scim.auth",
      decision: "deny",
      detail: { reason: refused.reason, method },
    });

  // Who is asking, before the body is read: the token must be good, and a client that failed too
  // often is turned away first.
  scim.use("*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const m = /^Bearer +(\S+) *$/i.exec(header);
    const named = m ? parseScimToken(m[1]) : null;
    if (!m || !named) {
      // Refused without touching the database or the log, so not counted: counting them would
      // let anyone lock out a proxy's address (every client behind it shares one) for free.
      return unauthorized(m !== null);
    }
    const token = m[1] as string;
    const { tenantId, tokenId } = named;
    const address = `address:${addressKey(clientAddress(peerOf(c), c.req.header("x-forwarded-for"), trusted))}`;
    const tokenKey = `token:${tokenId}`;
    const tenantKey = `tenant:${tenantId}`;
    const wait = Math.max(...[address, tokenKey, tenantKey].map((k) => limiter.blockedFor(k)));
    if (wait > 0) {
      // A block never refuses a valid token on its own: anyone who knows a tenant id, or shares
      // the identity provider's address, could otherwise halt provisioning. Blocked requests
      // get a quiet check instead (one lookup; nothing written, nothing counted): a valid token
      // goes on, anything else is turned away.
      let quiet: ScimTokenCheck;
      try {
        quiet = await db.withTenant(tenantId, (tx) => checkScimToken(tx, tenantId, token), {
          accessMode: "read only",
        });
      } catch (err) {
        log?.error({ err }, "scim: checking a token failed");
        return fail(new ScimError(500, "internal error"));
      }
      if (!quiet.ok) {
        return fail(new ScimError(429, "too many failed authentications; try again later"), {
          "retry-after": String(Math.ceil(wait / 1000)),
        });
      }
      recent.add(tokenId);
      c.set("scim", { tenantId, token, tokenId, actor: quiet.actor, keys: [address, tokenKey] });
      return next();
    }
    let check: ScimTokenCheck;
    try {
      // The same work for a tenant that doesn't exist as for one that does: one lookup.
      check = await db.withTenant(tenantId, async (tx) => {
        const checked = await checkScimToken(tx, tenantId, token);
        if (!checked.ok && checked.refused) {
          await auditRefusal(tx, tenantId, checked.refused, c.req.method);
        }
        return checked;
      });
    } catch (err) {
      log?.error({ err }, "scim: checking a token failed");
      return fail(new ScimError(500, "internal error"));
    }
    if (!check.ok) {
      if (check.refused) {
        // Audited above either way; but while its token id is in use, a wrong secret doesn't
        // count toward blocking it, so knowing a token id isn't enough to lock it out.
        limiter.fail(address, ...(recent.has(tokenId) ? [] : [tokenKey]));
      } else {
        limiter.fail(address, tenantKey);
        if (!unknownTokens.note(tenantId)) log?.warn({ tenantId }, "scim: refusals not summed");
      }
      return unauthorized(true);
    }
    recent.add(tokenId);
    c.set("scim", { tenantId, token, tokenId, actor: check.actor, keys: [address, tokenKey] });
    await next();
  });

  // Only then is the body read, and only so much of it.
  scim.use(
    "*",
    bodyLimit({
      maxSize: maxBody,
      onError: () => fail(new ScimError(413, `the body is over ${maxBody} bytes`)),
    }),
  );

  const unauthorized = (presented: boolean) =>
    fail(new ScimError(401, "authentication failed"), {
      "www-authenticate": presented ? `${REALM}, error="invalid_token"` : REALM,
    });

  /**
   * Runs one request: the token check, the work in a savepoint, the audit record last, all in
   * one transaction of the token's tenant.
   */
  const run = async (
    c: Context<ScimEnv>,
    action: string,
    access: "read" | "write",
    work: (tx: Tx, actor: string) => Promise<Done>,
  ): Promise<Response> => {
    const { tenantId, token, actor, keys } = c.var.scim;
    const target = targetOf(c.req.param("id"));
    let outcome: { refused: true } | { done: Done } | { error: ScimError };
    try {
      // A deadlock or serialization failure rolls it all back, audit record included: run it
      // again (a disable or delete meeting a transaction that locks in another order).
      outcome = await retrying(() =>
        db.withTenant(tenantId, async (tx) => {
          // Again, in the transaction that acts: a token revoked a moment ago acts no more.
          const check = await checkScimToken(tx, tenantId, token);
          if (!check.ok) {
            if (check.refused) await auditRefusal(tx, tenantId, check.refused, c.req.method);
            return { refused: true as const };
          }
          if (access === "write") await lockPrincipals(tx, tenantId);
          if (check.stale) await touchScimToken(tx, tenantId, check.tokenId);
          let result: { done: Done } | { error: ScimError };
          try {
            result = { done: await tx.transaction((sp) => work(sp as Tx, check.actor)) };
          } catch (e) {
            if (!(e instanceof ScimError)) throw e;
            result = { error: e };
          }
          const said =
            "done" in result
              ? { decision: "allow" as const, status: result.done.status, ...result.done.detail }
              : {
                  decision: "deny" as const,
                  status: result.error.status,
                  reason: result.error.scimType ?? "refused",
                };
          const { decision, ...detail } = said;
          await appendAudit(tx, tenantId, {
            actor: check.actor,
            action,
            decision,
            detail: { ...detail, ...target },
          });
          if ("done" in result) {
            for (const record of result.done.audits ?? []) await appendAudit(tx, tenantId, record);
          }
          return result;
        }),
      );
    } catch (err) {
      // The transaction rolled back, audit record and all: record the failure in one of its own,
      // as well as it can, under an id the log and the caller share.
      const requestId = randomUUID();
      log?.error({ err, action, requestId }, "scim: request failed");
      try {
        await db.withTenant(tenantId, (tx) =>
          appendAudit(tx, tenantId, {
            actor,
            action,
            decision: "deny",
            detail: { status: 500, reason: "internal-error", request: requestId, ...target },
          }),
        );
      } catch (auditErr) {
        log?.error({ err: auditErr, action, requestId }, "scim: auditing the failure failed");
      }
      return fail(new ScimError(500, `internal error (request ${requestId})`));
    }
    if ("refused" in outcome) {
      // Revoked or expired since the middleware's check: counted like any refusal.
      limiter.fail(...keys);
      return unauthorized(true);
    }
    if ("error" in outcome) return fail(outcome.error);
    const { status, body, location } = outcome.done;
    return send(status, body, location === undefined ? {} : { location });
  };

  /** The body of a POST, PUT or PATCH, read before the transaction and checked inside it. */
  const bodyOf = async (c: Context) => {
    const type = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    const raw = await c.req.text();
    return (): Json => {
      if (type !== CONTENT_TYPE && type !== "application/json") {
        throw new ScimError(415, `send the body as ${CONTENT_TYPE} or application/json`);
      }
      return parseBody(raw);
    };
  };

  // --- Discovery ------------------------------------------------------------------------------

  scim.get("/ServiceProviderConfig", (c) =>
    run(c, "scim.discovery.read", "read", async () => ({
      status: 200,
      body: serviceProviderConfig(base(c)),
    })),
  );
  for (const [path, doc] of [
    ["/ResourceTypes", resourceTypes],
    ["/Schemas", schemas],
  ] as const) {
    scim.get(path, (c) =>
      run(c, "scim.discovery.read", "read", async () => ({
        status: 200,
        body: doc(base(c)) as Json,
      })),
    );
    scim.get(`${path}/:id`, (c) =>
      run(c, "scim.discovery.read", "read", async () => {
        const found = doc(base(c), c.req.param("id"));
        if (!found) throw notFound("resource");
        return { status: 200, body: found };
      }),
    );
  }

  // --- Users ----------------------------------------------------------------------------------

  scim.get("/Users", (c) =>
    run(c, "scim.user.list", "read", async (tx) => {
      const filterText = c.req.query("filter");
      const filter = filterText === undefined ? undefined : parseFilter(filterText);
      const page = pageOf(c.req.query("startIndex"), c.req.query("count"));
      const { total, users } = await listScimUsers(tx, tenantOf(c), filter, page);
      const shape = projection(c);
      return {
        status: 200,
        body: listResponse(
          total,
          page.startIndex,
          users.map((u) => shape(userResource(u, base(c)))),
        ),
        detail: { results: users.length, total, filtered: filter !== undefined },
      };
    }),
  );

  scim.get("/Users/:id", (c) =>
    run(c, "scim.user.read", "read", async (tx) => {
      const u = await scimUser(tx, tenantOf(c), c.req.param("id"));
      return { status: 200, body: projection(c)(userResource(u, base(c))) };
    }),
  );

  scim.post("/Users", async (c) => {
    const body = await bodyOf(c);
    return run(c, "scim.user.create", "write", async (tx, actor) => {
      const u = await createScimUser(tx, tenantOf(c), body(), actor);
      const resource = userResource(u, base(c));
      return {
        status: 201,
        body: resource,
        location: (resource.meta as { location: string }).location,
        detail: { user: u.id },
      };
    });
  });

  scim.put("/Users/:id", async (c) => {
    const body = await bodyOf(c);
    return run(c, "scim.user.replace", "write", async (tx, actor) => {
      const current = await scimUser(tx, tenantOf(c), c.req.param("id"));
      // A PUT without `active` or `userType` leaves them as they are: it never re-enables a user,
      // or makes a guest a member, by omission.
      const next = stateFromBody(body(), {
        active: current.providerDisabled === null,
        guest: current.kind === "guest",
      });
      const u = await saveUser(tx, tenantOf(c), current, next, actor);
      return { status: 200, body: userResource(u, base(c)) };
    });
  });

  scim.patch("/Users/:id", async (c) => {
    const body = await bodyOf(c);
    return run(c, "scim.user.patch", "write", async (tx, actor) => {
      const current = await scimUser(tx, tenantOf(c), c.req.param("id"));
      const state = stateOf(current);
      for (const { op, path, value } of patchOps(body())) patchUser(state, op, path, value);
      const u = await saveUser(tx, tenantOf(c), current, state, actor);
      return { status: 200, body: userResource(u, base(c)) };
    });
  });

  scim.delete("/Users/:id", (c) =>
    run(c, "scim.user.delete", "write", async (tx, actor) => {
      await deleteScimUser(tx, tenantOf(c), c.req.param("id"), actor);
      return { status: 204 };
    }),
  );

  // --- Groups ---------------------------------------------------------------------------------

  scim.get("/Groups", (c) =>
    run(c, "scim.group.list", "read", async (tx) => {
      const filterText = c.req.query("filter");
      const filter = filterText === undefined ? undefined : parseFilter(filterText);
      const page = pageOf(c.req.query("startIndex"), c.req.query("count"));
      const { total, groups } = await listScimGroups(tx, tenantOf(c), filter, page);
      const shape = projection(c);
      const budget = { left: MAX_MEMBERS_RETURNED };
      const resources: Json[] = [];
      for (const g of groups) {
        const members = wantsMembers(c)
          ? await loadMembers(tx, tenantOf(c), g.id, budget)
          : undefined;
        resources.push(shape(groupResource(g, base(c), members)));
      }
      return {
        status: 200,
        body: listResponse(total, page.startIndex, resources),
        detail: { results: groups.length, total, filtered: filter !== undefined },
      };
    }),
  );

  scim.get("/Groups/:id", (c) =>
    run(c, "scim.group.read", "read", async (tx) => {
      const g = await scimGroup(tx, tenantOf(c), c.req.param("id"));
      const members = wantsMembers(c)
        ? await loadMembers(tx, tenantOf(c), g.id, { left: MAX_MEMBERS_RETURNED })
        : undefined;
      return { status: 200, body: projection(c)(groupResource(g, base(c), members)) };
    }),
  );

  scim.post("/Groups", async (c) => {
    const body = await bodyOf(c);
    return run(c, "scim.group.create", "write", async (tx) => {
      const g = await createScimGroup(tx, tenantOf(c), body());
      const members = await loadMembers(tx, tenantOf(c), g.id, { left: MAX_MEMBERS_RETURNED });
      const resource = groupResource(g, base(c), members);
      return {
        status: 201,
        body: resource,
        location: (resource.meta as { location: string }).location,
        detail: { group: g.id },
      };
    });
  });

  /** The ids of a group's members. */
  const memberIds = async (tx: Tx, tenantId: string, groupId: string) => {
    const ids = new Set<string>();
    let after: string | undefined;
    for (;;) {
      const page = await membersOf(tx, tenantId, groupId, {
        limit: 5000,
        ...(after === undefined ? {} : { after }),
      });
      for (const u of page) ids.add(u.id);
      if (page.length < 5000) return ids;
      after = page[page.length - 1]?.id;
    }
  };

  /**
   * Runs a change to a group; when it is the tenant's admin group (T-106), the request's audit
   * gets a record for each person who joined or left it, and so became or stopped being an
   * admin through it (while an active member). A new group is never the admin group: the config
   * names it by an id the group already has.
   */
  const watchingAdmins = async (
    tx: Tx,
    tenantId: string,
    groupId: string,
    actor: string,
    work: () => Promise<Done>,
  ): Promise<Done> => {
    if (deps.adminGroup?.(tenantId) !== groupId) return work();
    const before = await memberIds(tx, tenantId, groupId);
    const done = await work();
    const after = await memberIds(tx, tenantId, groupId);
    const record = (action: string, user: string): AuditRecord => ({
      actor,
      action,
      decision: "allow",
      detail: { user, group: groupId },
    });
    return {
      ...done,
      audits: [
        ...[...after].filter((u) => !before.has(u)).map((u) => record("admin.group.join", u)),
        ...[...before].filter((u) => !after.has(u)).map((u) => record("admin.group.leave", u)),
      ],
    };
  };

  scim.put("/Groups/:id", async (c) => {
    const body = await bodyOf(c);
    return run(c, "scim.group.replace", "write", (tx, actor) =>
      watchingAdmins(tx, tenantOf(c), c.req.param("id"), actor, async () => {
        const g = await replaceScimGroup(tx, tenantOf(c), c.req.param("id"), body());
        const members = await loadMembers(tx, tenantOf(c), g.id, { left: MAX_MEMBERS_RETURNED });
        return { status: 200, body: groupResource(g, base(c), members) };
      }),
    );
  });

  scim.patch("/Groups/:id", async (c) => {
    const body = await bodyOf(c);
    return run(c, "scim.group.patch", "write", (tx, actor) =>
      watchingAdmins(tx, tenantOf(c), c.req.param("id"), actor, async () => {
        const ops = patchOps(body());
        await patchScimGroup(tx, tenantOf(c), c.req.param("id"), ops);
        // Entra expects no body back; the members of a large group would be a large one.
        return { status: 204 };
      }),
    );
  });

  scim.delete("/Groups/:id", (c) =>
    run(c, "scim.group.delete", "write", (tx, actor) =>
      watchingAdmins(tx, tenantOf(c), c.req.param("id"), actor, async () => {
        await deleteScimGroup(tx, tenantOf(c), c.req.param("id"), actor);
        return { status: 204 };
      }),
    ),
  );

  // Anything else under /scim/v2, for an authenticated caller: a SCIM 404 (or 501 for Bulk,
  // /Me and the search endpoint, which aren't supported).
  scim.all("*", (c) =>
    run(c, "scim.unknown", "read", async () => {
      if (/\/(Bulk|Me|\.search)$/i.test(c.req.path)) {
        throw new ScimError(501, "not supported");
      }
      throw notFound("resource");
    }),
  );

  app.route("/scim/v2", scim);
  return { close: () => unknownTokens.close() };
}

const tenantOf = (c: Context<ScimEnv>) => c.var.scim.tenantId;

/** The PATCH request's operations (RFC 7644 section 3.5.2), op names in any case. */
function patchOps(body: Json): { op: PatchOpName; path: AttrPath | undefined; value: unknown }[] {
  requireSchema(body, PATCH_SCHEMA);
  const ops = field(body, "Operations");
  if (!Array.isArray(ops) || ops.length === 0) throw invalidSyntax("Operations must be a list");
  if (ops.length > MAX_OPERATIONS) {
    throw invalidValue(`at most ${MAX_OPERATIONS} operations per request`);
  }
  return ops.map((o: unknown) => {
    if (!isObject(o)) throw invalidSyntax("each operation must be an object");
    const op = field(o, "op");
    const name = typeof op === "string" ? op.toLowerCase() : "";
    if (name !== "add" && name !== "replace" && name !== "remove") {
      throw invalidSyntax("op must be add, replace or remove");
    }
    const path = field(o, "path");
    if (path !== undefined && path !== null && typeof path !== "string") {
      throw invalidSyntax("path must be a string");
    }
    return {
      op: name,
      path: typeof path === "string" && path !== "" ? parsePath(path) : undefined,
      value: field(o, "value"),
    };
  });
}

function listResponse(total: number, startIndex: number, resources: Json[]): Json {
  return {
    schemas: [LIST_SCHEMA],
    totalResults: total,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

/** Top-level attribute names from a comma-separated list, lower-cased, URN prefixes dropped. */
function attributeNames(list: string | undefined): Set<string> | undefined {
  if (list === undefined || list.trim() === "") return undefined;
  return new Set(
    list.split(",").map((a) => {
      const name = a.trim().replace(/^urn:ietf:params:scim:schemas:core:2\.0:(user|group):/i, "");
      return (name.split(".")[0] ?? "").toLowerCase();
    }),
  );
}

/**
 * `attributes` and `excludedAttributes` (RFC 7644 section 3.9), on top-level attributes:
 * `schemas` and `id` are always returned.
 */
function projection(c: Context): (resource: Json) => Json {
  const only = attributeNames(c.req.query("attributes"));
  const without = attributeNames(c.req.query("excludedAttributes"));
  return (resource) =>
    Object.fromEntries(
      Object.entries(resource).filter(([key]) => {
        const k = key.toLowerCase();
        if (k === "schemas" || k === "id") return true;
        if (only !== undefined) return only.has(k);
        return !(without?.has(k) ?? false);
      }),
    );
}

/** Whether a group's members are to be returned (and so loaded). */
function wantsMembers(c: Context): boolean {
  const only = attributeNames(c.req.query("attributes"));
  if (only !== undefined) return only.has("members");
  return !(attributeNames(c.req.query("excludedAttributes"))?.has("members") ?? false);
}

/** The socket's peer address, or undefined when there is no socket (in-process requests). */
function peerOf(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}
