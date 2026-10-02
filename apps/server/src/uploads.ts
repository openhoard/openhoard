import { appendAudit } from "@openhoard/core-audit";
import { ingest, INGEST_LIMITS, IngestError, type IngestResult } from "@openhoard/core-catalog";
import { newId, objects, sourceRefs, type Database, type Tx } from "@openhoard/core-db";
import { getUser, grantIsLive, userPrincipal, type OAuthScope } from "@openhoard/core-identity";
import {
  blobPath,
  BlobTooLargeError,
  type BlobStore,
  type PutResult,
} from "@openhoard/core-storage";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { Logger } from "pino";
import type { AuthEnv, BearerAuth, SignedIn } from "./auth.js";
import type { UploadsConfig } from "./config.js";
import { managedZone, ZoneKindError } from "./managed.js";
import { retrying } from "./retry.js";

/*
 * Uploads (T-1206): a signed-in member hands OpenHoard a file, and OpenHoard keeps it. The first
 * content the server holds itself: it goes to a managed zone (`uploads.zone`, "Uploads" by
 * default, made in the tenant on its first upload and audited as `zone.create`).
 *
 *   POST /api/uploads?name=<file name>   the request's body is the file, its Content-Type the type;
 *                                        X-OpenHoard-Source-URL: where it is from, if it says
 *   GET  /api/uploads                    the caller's own uploads, newest first
 *
 * - One file per request, as the raw body: it streams to the blob store (core/storage), hashed
 *   as it arrives, so memory stays flat whatever its size; `uploads.maxBytes` (100 MiB by
 *   default) stops it. Then one transaction records it (core/catalog ingest()) and audits it
 *   (`object.upload`), and enrichment is queued after it commits.
 * - Who: the session cookie's person (T-102), an active member. Not a guest, not a service
 *   account, checked again in the upload's transaction. The request carries the cookie, so the
 *   server's CSRF check applies (auth.ts: its Origin must be publicUrl's). A form's encodings
 *   are refused: a form is not a file (the share target's form is unpacked in the browser).
 * - Or an approved OAuth client's token with the `files:add` scope (T-1207: the browser
 *   extension), for the member who allowed it: POST only. Such a request carries no cookie, so
 *   nothing ambient: the token is the whole credential, checked as the MCP server checks it
 *   (the client still approved, the grant live, the person active). The audit names the client.
 * - `X-OpenHoard-Source-URL` says where the file is from (a saved web page's address, without
 *   its fragment): kept as the item's link, never fetched. A header, not the query: addresses
 *   can hold secrets, and queries are what proxies log. A page saved again from the same
 *   address (and name) is a new version of the same file, so a client that may add may also
 *   add versions to what it added.
 * - The uploader owns the file, and nobody else reads it until they share it: an upload has no
 *   grants.
 * - The same bytes under the same name from the same person are the same file: sending it
 *   again answers with the one there is (brought back, if it was removed). A share tapped
 *   twice, or retried after a lost answer, makes one file. Another name is another file (of the
 *   same blob), and a file that has since been handed to someone else isn't touched.
 * - What can refuse an upload (not a member, the zone's name taken by another kind of zone) is
 *   checked before its bytes are kept, and again in its transaction. Bytes whose transaction
 *   still fails, or that a crash left half-written (`.incoming`), stay in the store,
 *   unreferenced (nothing reads them: content is served by its catalog row). Removing them is
 *   maintenance's, to come.
 */

export interface UploadDeps {
  db: Database;
  uploads: UploadsConfig;
  store: BlobStore;
  /** Each tenant's blob key (tenant-keys.ts). */
  tenantKey: (tenantId: string) => Promise<Uint8Array>;
  /** Queues enrichment once an upload committed (core/jobs enqueueAfterIngest). */
  enqueue?: (tenantId: string, result: IngestResult) => Promise<unknown>;
  /**
   * The bearer check (oauth/routes.ts): lets an approved client its person allowed to add files
   * (`files:add`) upload for them (T-1207). Without it, only the session does.
   */
  requireBearer?: (scope: OAuthScope) => MiddlewareHandler<AuthEnv>;
  log?: Logger;
}

/** Who a request acts for: the session's person, or the person a client's token is for. */
interface Caller {
  tenantId: string;
  userId: string;
  /** The OAuth client, grant and token, when a token (not the session) said who. */
  via?: { client: string; grant: string; token: string };
}

/** What the audit says of a token's request: its client and grant (never the token). */
const viaOf = (who: Caller) => (who.via ? { client: who.via.client, grant: who.via.grant } : {});

/** The longest address a saved page is recorded under (longer ones are kept, as content). */
const URL_KEY_MAX = 1500;

/**
 * Where an upload came from, when it says: an http(s) address without credentials, or null.
 * It is kept as the item's link (what "open the original" goes to), never fetched.
 */
/**
 * The header an upload names its address in. Not the query: addresses can hold secrets, and
 * queries are what proxies log.
 */
export const SOURCE_HEADER = "x-openhoard-source-url";

export function sourceUrl(given: string | undefined): string | null {
  if (given === undefined || given === "" || given.length > INGEST_LIMITS.url) return null;
  let u: URL;
  try {
    u = new URL(given);
  } catch {
    return null;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return null;
  // Without its fragment: a place in the page, and where single-page sign-ins leave tokens.
  u.hash = "";
  return u.href.length <= INGEST_LIMITS.url ? u.href : null;
}

/** The `source` of uploaded items. A configured folder can't take this id (config.ts). */
export const UPLOAD_SOURCE = "uploads";
/** Who made the zone, in the audit log. */
const ZONE_ACTOR = "system:uploads";
const TITLE_MAX = 255;
const LISTED = 50;
/** Controls (C0, C1) and line separators: a space each. */
// eslint-disable-next-line no-control-regex -- these are what is replaced
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
/**
 * What isn't seen but is read (by a model, too) or reorders what is: bidi controls, zero-width
 * and filler characters, tag characters, the selectors that smuggle bytes. As
 * scripts/check-unicode.mjs keeps out of the source, but for the two joiners (U+200C, U+200D)
 * that Persian, Indic scripts and emoji are written with.
 */
const HIDDEN =
  // eslint-disable-next-line no-misleading-character-class -- each invisible code point is matched on its own, on purpose
  /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2069\u3164\ufeff\uffa0\ufff9-\ufffb\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
/** What a browser's form sends: never a file. */
const FORM_TYPES = new Set(["application/x-www-form-urlencoded", "multipart/form-data"]);

class Refusal extends Error {
  constructor(
    readonly status: 400 | 403 | 409,
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A file's title from the name it was sent with: its last path segment, without control
 * characters or the invisible and direction-changing ones (a title is shown to people and to
 * models), at most 255 characters (the extension kept). "Untitled" when nothing is left.
 */
export function uploadTitle(name: string | undefined): string {
  const last = (name ?? "").normalize("NFC").split(/[\\/]/).pop() ?? "";
  const clean = last.replace(HIDDEN, "").replace(CONTROLS, " ").replace(/ {2,}/g, " ").trim();
  const chars = [...clean];
  if (chars.length === 0 || /^\.+$/.test(clean)) return "Untitled";
  if (chars.length <= TITLE_MAX) return clean;
  const dot = clean.lastIndexOf(".");
  const ext = dot > 0 ? [...clean.slice(dot)] : [];
  if (ext.length === 0 || ext.length > 16) return chars.slice(0, TITLE_MAX).join("");
  return chars.slice(0, TITLE_MAX - ext.length).join("") + ext.join("");
}

export function mountUploads(app: Hono<AuthEnv>, deps: UploadDeps): void {
  const { db, uploads, store, log } = deps;

  /** The tenant's uploads zone, made on its first upload. */
  const zoneOf = (tx: Tx, tenantId: string, create: boolean): Promise<string | null> =>
    managedZone(tx, tenantId, uploads.zone, { create, actor: ZONE_ACTOR }).catch((e: unknown) => {
      if (!(e instanceof ZoneKindError)) throw e;
      throw new Refusal(
        409,
        "zone-kind",
        `zone "${uploads.zone}" is not a managed zone: name another in uploads.zone`,
      );
    });

  const deny = (who: Caller, reason: string) =>
    db.withTenant(who.tenantId, (tx) =>
      appendAudit(tx, who.tenantId, {
        actor: userPrincipal(who.userId),
        action: "object.upload",
        decision: "deny",
        detail: { reason, ...viaOf(who) },
      }),
    );
  const callers = new WeakMap<Request, Caller>();
  const callerOf = (c: Context<AuthEnv>) => callers.get(c.req.raw) as Caller;

  /** A person's own session: a member, with no narrower credential. */
  const mayUpload = (signedIn: SignedIn): boolean => {
    const p = signedIn.principal;
    return p.active && !p.guest && p.service !== true && p.scope === undefined;
  };

  app.use("/api/uploads", async (c, next) => {
    c.header("cache-control", "no-store");
    const signedIn = c.get("auth");
    if (signedIn) {
      const who = { tenantId: signedIn.tenantId, userId: signedIn.principal.userId };
      if (!mayUpload(signedIn)) {
        if (c.req.method !== "GET") await deny(who, "not-member");
        return c.json({ error: "forbidden" }, 403);
      }
      callers.set(c.req.raw, who);
      return next();
    }
    // No session: a client's token, for adding only (the list is the person's own page's).
    if (
      deps.requireBearer === undefined ||
      c.req.method !== "POST" ||
      c.req.header("authorization") === undefined
    ) {
      return c.json({ error: "not signed in" }, 401);
    }
    return deps.requireBearer("files:add")(c, async () => {
      const bearer = c.get("bearer") as BearerAuth;
      const p = bearer.principal;
      const who = {
        tenantId: bearer.tenantId,
        userId: p.userId,
        via: { client: bearer.client.id, grant: bearer.grantId, token: bearer.tokenId },
      };
      if (!p.active || p.guest || p.service === true) {
        await deny(who, "not-member");
        c.res = c.json({ error: "forbidden" }, 403);
        return;
      }
      callers.set(c.req.raw, who);
      await next();
    });
  });

  app.post("/api/uploads", async (c) => {
    const who = callerOf(c);
    const { tenantId, userId } = who;
    const owner = userPrincipal(userId);
    const type = c.req.header("content-type");
    const bare = (type ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (bare === "" || FORM_TYPES.has(bare)) {
      return c.json({ error: "send the file as the body, with its type as Content-Type" }, 415);
    }
    const tooLarge = () =>
      c.json({ error: "too large", maxBytes: uploads.maxBytes }, 413, { connection: "close" });
    const declared = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > uploads.maxBytes) return tooLarge();
    const title = uploadTitle(c.req.query("name"));
    const named = c.req.header(SOURCE_HEADER);
    const from = sourceUrl(named);
    if (from === null && (named ?? "") !== "") {
      return c.json({ error: `${SOURCE_HEADER} is an http or https address` }, 400);
    }
    if ((type as string).length > INGEST_LIMITS.mime) {
      return c.json({ error: "Content-Type is too long" }, 400);
    }

    /** Still a member, and the zone is one uploads can go to (made here when `create`). */
    const check = async (tx: Tx, create: boolean): Promise<string | null> => {
      const user = await getUser(tx, tenantId, userId);
      if (!user || user.kind !== "member" || !user.active || user.retired !== null) {
        throw new Refusal(403, "not-member", "forbidden");
      }
      return zoneOf(tx, tenantId, create);
    };
    const refused = async (e: unknown) => {
      if (e instanceof Refusal) {
        await deny(who, e.reason);
        return c.json({ error: e.message }, e.status);
      }
      if (e instanceof IngestError) {
        await deny(who, `ingest-${e.code}`);
        return c.json({ error: e.message }, e.code === "invalid" ? 400 : 409);
      }
      throw e;
    };
    // Before a byte is kept: what would refuse the upload afterwards is refused now.
    try {
      await db.withTenant(tenantId, (tx) => check(tx, false), { accessMode: "read only" });
    } catch (e) {
      return refused(e);
    }

    let stored: PutResult;
    try {
      stored = await store.put(
        { id: tenantId, key: await deps.tenantKey(tenantId) },
        (c.req.raw.body as AsyncIterable<Uint8Array> | null) ?? new Uint8Array(0),
        { maxBytes: uploads.maxBytes },
      );
    } catch (e) {
      if (e instanceof BlobTooLargeError) return tooLarge();
      // The browser went away mid-upload: nothing was kept.
      if (c.req.raw.signal.aborted) return c.json({ error: "upload interrupted" }, 400);
      throw e;
    }

    // One file per person, content and name: the same file sent again (a share tapped twice,
    // a retry after a lost answer) is the file there is. Another name is another file.
    // A page saved from an address is one file per person, address and name: saved again, it
    // gets a new version, not a twin.
    const sameFile =
      from !== null && from.length <= URL_KEY_MAX
        ? `${userId}/url/${title}/${from}`
        : `${userId}/${stored.blobId.slice("b3t:".length)}/${title}`;
    let result: IngestResult;
    try {
      result = await retrying(() =>
        db.withTenant(tenantId, async (tx) => {
          const zoneId = (await check(tx, true)) as string;
          // A client's token: still allowed now, not only when the body began to arrive (the
          // grant or the client revoked meanwhile, as the MCP server checks before answering).
          if (
            who.via &&
            !(await grantIsLive(tx, tenantId, who.via.grant, { tokenId: who.via.token }))
          ) {
            throw new Refusal(403, "grant-ended", "forbidden");
          }
          // Unless that file has since become someone else's: then this is a new one (each
          // time: after a hand-over, the same file sent twice is two files).
          const [known] = await tx
            .select({ owner: objects.ownerId })
            .from(sourceRefs)
            .innerJoin(
              objects,
              and(eq(objects.tenantId, sourceRefs.tenantId), eq(objects.id, sourceRefs.objectId)),
            )
            .where(
              and(
                eq(sourceRefs.tenantId, tenantId),
                eq(sourceRefs.source, UPLOAD_SOURCE),
                eq(sourceRefs.externalId, sameFile),
              ),
            );
          const done = await ingest(tx, tenantId, {
            source: UPLOAD_SOURCE,
            externalId:
              known && known.owner !== owner ? `${sameFile}/${newId("object")}` : sameFile,
            zoneId,
            title,
            ownerId: owner,
            content: {
              blobId: stored.blobId,
              size: stored.size,
              location: blobPath(tenantId, stored.blobId),
            },
            mime: type as string,
            authorId: owner,
            modifiedAt: new Date(),
            ...(from === null ? {} : { url: from }),
          });
          await appendAudit(tx, tenantId, {
            actor: owner,
            action: "object.upload",
            decision: "allow",
            detail: {
              object: done.objectId,
              version: done.versionId,
              zone: zoneId,
              size: stored.size,
              created: done.created.object,
              ...(done.created.object ? {} : { newVersion: done.created.version }),
              ...(done.restored ? { restored: true } : {}),
              ...viaOf(who),
            },
          });
          return done;
        }),
      );
    } catch (e) {
      return refused(e);
    }
    // After the commit, never inside it. If it fails the file is there all the same, and
    // maintenance queues what was left unprocessed.
    await deps
      .enqueue?.(tenantId, result)
      .catch((err: unknown) =>
        log?.warn({ err, tenantId, object: result.objectId }, "upload: enqueueing failed"),
      );
    return c.json(
      {
        object: result.objectId,
        version: result.versionId,
        title,
        size: stored.size,
        created: result.created.object,
        newVersion: result.created.version,
      },
      result.created.object ? 201 : 200,
    );
  });

  app.get("/api/uploads", async (c) => {
    const { tenantId, userId } = callerOf(c);
    const owner = userPrincipal(userId);
    const rows = await db.withTenant(
      tenantId,
      async (tx) => {
        // A zone of that name that isn't the uploads': nothing of theirs to list.
        const zoneId = await zoneOf(tx, tenantId, false).catch((e: unknown) => {
          if (e instanceof Refusal) return null;
          throw e;
        });
        if (zoneId === null) return [];
        return tx
          .select({
            object: objects.id,
            title: objects.title,
            updatedAt: objects.updatedAt,
            // Where it was saved from, when it was (a page the extension saved).
            url: sourceRefs.url,
          })
          .from(objects)
          .leftJoin(
            sourceRefs,
            and(
              eq(sourceRefs.tenantId, objects.tenantId),
              eq(sourceRefs.objectId, objects.id),
              eq(sourceRefs.source, UPLOAD_SOURCE),
            ),
          )
          .where(
            and(
              eq(objects.tenantId, tenantId),
              eq(objects.zoneId, zoneId),
              eq(objects.ownerId, owner),
              isNull(objects.deletedAt),
            ),
          )
          .orderBy(desc(objects.updatedAt), desc(objects.id))
          .limit(LISTED);
      },
      { accessMode: "read only" },
    );
    return c.json({ uploads: rows });
  });
}
