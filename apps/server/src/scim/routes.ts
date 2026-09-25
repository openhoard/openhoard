import { getConnInfo } from "@hono/node-server/conninfo";
import { appendAudit } from "@openhoard/core-audit";
import { getTenant, lockPrincipals, type Database, type Tx } from "@openhoard/core-db";
import {
  checkScimToken,
  parseScimToken,
  scimActor,
  touchScimToken,
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
import { field, isObject, parseBody, requireSchema, type Json } from "./json.js";
import { FailureLimiter } from "./limiter.js";
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
 * - Every request is audited, allowed or refused, in the transaction that serves it and last
 *   (core/audit: its lock is the last taken). A refused token on a real token id is audited as
 *   `scim.auth` with why; the caller only ever hears 401.
 * - Failed authentications are limited per client address and per token id (limiter.ts).
 * - Each request is one transaction. A write takes the tenant's principal lock first (core/db
 *   lockPrincipals(), lock order step 0), so SCIM writes to one tenant run one at a time and its
 *   uniqueness checks hold; the directory's triggers invalidate the principal cache.
 * - A request's work runs in a savepoint: a refusal (4xx) undoes whatever it had done, and the
 *   refusal is still audited. Nothing internal reaches the caller: an unexpected error is a
 *   plain 500, logged here.
 */

export interface ScimOptions {
  /** Failed authentications a client address, or a token id, may make per window (10). */
  maxFailures?: number;
  /** The window, in milliseconds (60 s). */
  failureWindowMs?: number;
  /** Largest request body, in bytes (1 MiB). */
  maxBodyBytes?: number;
}

export interface ScimDeps {
  db: Database;
  log?: Logger;
  /** Where clients reach this server (the Tenant URL is `<publicUrl>/scim/v2`). */
  publicUrl?: string;
  options?: ScimOptions;
}

const CONTENT_TYPE = "application/scim+json";
const REALM = 'Bearer realm="OpenHoard SCIM"';
const MAX_OPERATIONS = 1000;

type ScimEnv = { Variables: { scim: { tenantId: string; token: string; keys: string[] } } };

/** What a request's work produced: a response, and what the audit record says of it. */
interface Done {
  status: 200 | 201 | 204;
  body?: Json;
  location?: string;
  detail?: Record<string, string | number | boolean>;
}

export function mountScim<E extends Env>(app: Hono<E>, deps: ScimDeps): void {
  const { db, log } = deps;
  const opts = deps.options ?? {};
  const limiter = new FailureLimiter(opts.maxFailures ?? 10, opts.failureWindowMs ?? 60_000);
  const maxBody = opts.maxBodyBytes ?? 1024 * 1024;
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

  scim.use(
    "*",
    bodyLimit({
      maxSize: maxBody,
      onError: () => fail(new ScimError(413, `the body is over ${maxBody} bytes`)),
    }),
  );

  // Who is asking, before anything is read: a client that failed too often is turned away.
  scim.use("*", async (c, next) => {
    const address = clientAddress(c);
    const header = c.req.header("authorization") ?? "";
    const m = /^Bearer +(\S+) *$/i.exec(header);
    const named = m ? parseScimToken(m[1]) : null;
    const keys = [`address:${address}`, ...(named ? [`token:${named.tokenId}`] : [])];
    const wait = Math.max(...keys.map((k) => limiter.blockedFor(k)));
    if (wait > 0) {
      return fail(new ScimError(429, "too many failed authentications; try again later"), {
        "retry-after": String(Math.ceil(wait / 1000)),
      });
    }
    if (!m || !named) {
      // Refused without touching the database or the log, so not counted: counting them would
      // let anyone lock out a proxy's address (every client behind it shares one) for free.
      return unauthorized(m !== null);
    }
    c.set("scim", { tenantId: named.tenantId, token: m[1] as string, keys });
    await next();
  });

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
    const { tenantId, token, keys } = c.var.scim;
    const target = c.req.param("id");
    let outcome: { refused: true } | { done: Done } | { error: ScimError };
    try {
      outcome = await db.withTenant(tenantId, async (tx) => {
        const check = await checkScimToken(tx, tenantId, token);
        if (!check.ok) {
          // A tenant that doesn't exist has no log to write to (and nothing to protect).
          if (await getTenant(tx, tenantId)) {
            await appendAudit(tx, tenantId, {
              actor: check.refused ? scimActor(check.refused.tokenId) : "scim:unknown-token",
              action: "scim.auth",
              decision: "deny",
              detail: { reason: check.refused?.reason ?? "unknown-token", request: action },
            });
          }
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
          detail: {
            ...detail,
            // The resource asked for, when the path names one (never arbitrary input).
            ...(target !== undefined && /^(usr|grp)_[0-9a-hjkmnp-tv-z]{26}$/.test(target)
              ? { target }
              : {}),
          },
        });
        return result;
      });
    } catch (err) {
      log?.error({ err, action }, "scim: request failed");
      return fail(new ScimError(500, "internal error"));
    }
    if ("refused" in outcome) {
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
      // A PUT without `active` leaves it as it is: it never re-enables a user by omission.
      const next = stateFromBody(body(), current.providerDisabled === null);
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

  scim.put("/Groups/:id", async (c) => {
    const body = await bodyOf(c);
    return run(c, "scim.group.replace", "write", async (tx) => {
      const g = await replaceScimGroup(tx, tenantOf(c), c.req.param("id"), body());
      const members = await loadMembers(tx, tenantOf(c), g.id, { left: MAX_MEMBERS_RETURNED });
      return { status: 200, body: groupResource(g, base(c), members) };
    });
  });

  scim.patch("/Groups/:id", async (c) => {
    const body = await bodyOf(c);
    return run(c, "scim.group.patch", "write", async (tx) => {
      const ops = patchOps(body());
      await patchScimGroup(tx, tenantOf(c), c.req.param("id"), ops);
      // Entra expects no body back; the members of a large group would be a large one.
      return { status: 204 };
    });
  });

  scim.delete("/Groups/:id", (c) =>
    run(c, "scim.group.delete", "write", async (tx, actor) => {
      await deleteScimGroup(tx, tenantOf(c), c.req.param("id"), actor);
      return { status: 204 };
    }),
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

/** The client's address, for counting failures; "unknown" when the server can't tell. */
function clientAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}
