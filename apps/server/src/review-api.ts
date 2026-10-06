import { appendAudit } from "@openhoard/core-audit";
import {
  decideReview,
  REVIEW_INBOX_MAX,
  ReviewAccessError,
  reviewInbox,
  reviewItemFor,
  TagError,
  VIEW_TRANSACTION,
  type ReviewDecision,
  type ReviewItem,
} from "@openhoard/core-catalog";
import { isId, type Database } from "@openhoard/core-db";
import { userPrincipal } from "@openhoard/core-identity";
import type { Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "pino";
import type { AuthEnv, SignedIn } from "./auth.js";
import { adminGroupOf, type AuthConfig } from "./config.js";
import { retrying } from "./retry.js";
import { cachedTenantAuthorizer, type TenantAuthorizer } from "./tools/context.js";

/*
 * The tag review inbox over HTTP (T-903), for the web app: what the `admin review` commands do
 * (T-1403), for the person signed in. core/catalog review-inbox.ts decides who may see and
 * decide what; this wires it to the session and answers.
 *
 *   GET  /api/review?limit=100          the open items the person may decide, oldest first
 *   POST /api/review/:id/approve        {"replace": true}? (a single-value facet's other value)
 *   POST /api/review/:id/reject
 *   POST /api/review/:id/merge          {"into": "<an approved value of the facet>", "replace"?}
 *
 * - The person is the session's (T-102), not an admin as such: they see and decide items on
 *   files they may tag, and a decision that reaches past the file takes a tenant admin who may
 *   also tag it. Being an admin shows nothing more.
 * - Changes carry the session cookie, so the server's CSRF check applies, and take JSON only.
 * - Every decision is audited by core (`tag.review`, as the person); a refusal is audited here,
 *   as the CLI audits its own: who asked, for what, and why not. Not an id that names no open
 *   item, and not the question a `conflict` is.
 * - Answers: 404 for an item that isn't open or isn't the person's to see (alike), 403 with
 *   `code` `refused` or `not-admin`, 409 with the tagging code (`conflict`, with `replaces`,
 *   the tags that would come off: ask again with `replace`; `already-resolved`; `invalid`).
 */

export interface ReviewApiDeps {
  auth: AuthConfig;
  db: Database;
  authorizer?: TenantAuthorizer;
  log?: Logger;
}

const DECISIONS = ["approve", "reject", "merge"] as const;
/**
 * What `into` may be before core looks at it: text of a value's length, no more. Whether it is
 * a value, and an approved one of the item's facet, core says (mergeReview()).
 */
const INTO_MAX = 128;

export function mountReviewApi(app: Hono<AuthEnv>, deps: ReviewApiDeps): void {
  const { auth, db, log } = deps;
  const authz = deps.authorizer ?? cachedTenantAuthorizer();
  const adminGroup = adminGroupOf(auth);

  app.use(
    "/api/review/*",
    bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: "body too large" }, 413) }),
  );
  const gate: MiddlewareHandler<AuthEnv> = async (c, next) => {
    c.header("cache-control", "no-store");
    if (!c.get("auth")) return c.json({ error: "not signed in" }, 401);
    if (c.req.method === "POST") {
      const type = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
      if (type !== "application/json") return c.json({ error: "the body is JSON" }, 415);
    }
    await next();
  };
  app.use("/api/review", gate);
  app.use("/api/review/*", gate);

  app.get("/api/review", async (c) => {
    const { tenantId, principal } = c.get("auth") as SignedIn;
    const asked = c.req.query("limit");
    const limit = asked === undefined ? 100 : Number(asked);
    if (!Number.isInteger(limit) || limit < 1 || limit > REVIEW_INBOX_MAX) {
      return c.json({ error: `limit is 1 to ${REVIEW_INBOX_MAX}` }, 400);
    }
    const reviewer = { userId: principal.userId, adminGroupId: adminGroup(tenantId) };
    try {
      const inbox = await db.withTenant(
        tenantId,
        async (tx) => reviewInbox(tx, tenantId, await authz(tx, tenantId), reviewer, limit),
        VIEW_TRANSACTION,
      );
      return c.json({ items: inbox.items.map(showItem), more: inbox.more, capped: inbox.capped });
    } catch (e) {
      if (!(e instanceof ReviewAccessError)) throw e;
      // No longer a current user: the session's next check ends it.
      return c.json({ error: "not signed in" }, 401);
    }
  });

  for (const decision of DECISIONS) {
    app.post(`/api/review/:id/${decision}`, async (c) => {
      const { tenantId, principal } = c.get("auth") as SignedIn;
      const reviewId = c.req.param("id");
      if (!isId("review", reviewId)) return c.json({ error: "no such open review item" }, 404);
      const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown>;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return c.json({ error: "the body is a JSON object" }, 400);
      }
      const replace = body.replace === true;
      let how: ReviewDecision;
      if (decision === "merge") {
        if (
          typeof body.into !== "string" ||
          body.into === "" ||
          body.into.length > INTO_MAX ||
          !/^[\x21-\x7e]+$/.test(body.into)
        ) {
          return c.json({ error: "into is a value of the item's facet" }, 400);
        }
        how = { decision, into: body.into, replace };
      } else {
        how = decision === "approve" ? { decision, replace } : { decision };
      }

      const by = userPrincipal(principal.userId);
      const adminGroupId = adminGroup(tenantId);
      const refused = async (refusal: string, object?: string) =>
        db
          .withTenant(tenantId, (tx) =>
            appendAudit(tx, tenantId, {
              actor: by,
              action: "tag.review",
              decision: "deny",
              ...(object === undefined ? {} : { object }),
              detail: {
                review: reviewId,
                asked: decision,
                ...(how.decision === "merge" ? { into: how.into } : {}),
                refusal,
              },
            }),
          )
          .catch((err: unknown) => log?.error({ err }, "review: auditing a refusal failed"));
      const denied = async (e: ReviewAccessError) => {
        // An id that names no open item is nothing anyone was refused: not a record each.
        if (e.code !== "not-found" || e.objectId !== undefined) await refused(e.code, e.objectId);
        return e.code === "not-found" || e.code === "unknown-reviewer"
          ? c.json({ error: "no such open review item" }, 404)
          : c.json({ error: e.message, code: e.code }, 403);
      };

      let item: ReviewItem;
      try {
        item = await db.withTenant(
          tenantId,
          async (tx) =>
            reviewItemFor(
              tx,
              tenantId,
              await authz(tx, tenantId),
              { userId: principal.userId, adminGroupId },
              reviewId,
              how,
            ),
          VIEW_TRANSACTION,
        );
      } catch (e) {
        if (!(e instanceof ReviewAccessError)) throw e;
        return denied(e);
      }
      try {
        const done = await retrying(() =>
          db.withTenant(tenantId, (tx) =>
            decideReview(tx, tenantId, { reviewId, userId: principal.userId, adminGroupId }, how),
          ),
        );
        return c.json({
          decided: {
            id: reviewId,
            objectId: done.objectId,
            title: item.title,
            tag: done.tag,
            applied: done.applied,
            replaced: done.replaced,
            alsoClosed: done.alsoClosed,
          },
        });
      } catch (e) {
        if (e instanceof ReviewAccessError) return denied(e);
        if (!(e instanceof TagError)) throw e;
        // A question back, not a refusal: the person hasn't said yet whether to replace.
        if (e.code === "conflict") {
          return c.json({ error: e.message, code: e.code, replaces: [...e.replaces] }, 409);
        }
        await refused(e.code, item.objectId);
        return c.json({ error: e.message, code: e.code }, 409);
      }
    });
  }

  log?.debug("review API mounted at /api/review");
}

function showItem(i: ReviewItem & { admin: boolean }) {
  return {
    id: i.id,
    objectId: i.objectId,
    title: i.title,
    tag: i.tag,
    reason: i.reason,
    source: i.source,
    appliedBy: i.appliedBy,
    confidence: i.confidence,
    createdAt: i.createdAt.toISOString(),
    /** Some decision on it takes a tenant admin (core/catalog ListedReviewItem). */
    admin: i.admin,
  };
}
