import { appendAudit } from "@openhoard/core-audit";
import { ingest, INGEST_LIMITS, IngestError, type IngestResult } from "@openhoard/core-catalog";
import { newId, objects, sourceRefs, zones, type Database, type Tx } from "@openhoard/core-db";
import { getUser, userPrincipal } from "@openhoard/core-identity";
import {
  blobPath,
  BlobTooLargeError,
  type BlobStore,
  type PutResult,
} from "@openhoard/core-storage";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import type { Logger } from "pino";
import type { AuthEnv, SignedIn } from "./auth.js";
import type { UploadsConfig } from "./config.js";
import { retrying } from "./retry.js";

/*
 * Uploads (T-1206): a signed-in member hands OpenHoard a file, and OpenHoard keeps it. The first
 * content the server holds itself: it goes to a managed zone (`uploads.zone`, "Uploads" by
 * default, made in the tenant on its first upload and audited as `zone.create`).
 *
 *   POST /api/uploads?name=<file name>   the request's body is the file, its Content-Type the type
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
  log?: Logger;
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
  const zoneOf = async (tx: Tx, tenantId: string, create: boolean): Promise<string | null> => {
    const find = () =>
      tx
        .select({ id: zones.id, kind: zones.kind })
        .from(zones)
        .where(and(eq(zones.tenantId, tenantId), eq(zones.name, uploads.zone)));
    let [zone] = await find();
    if (!zone && !create) return null;
    if (!zone) {
      const id = newId("zone");
      // Two first uploads at once: one makes it, the other finds it. (Its audit comes before
      // ingest's locks, once in a tenant's life; a deadlock from that order is retried.)
      const made = await tx
        .insert(zones)
        .values({ tenantId, id, kind: "managed", name: uploads.zone })
        .onConflictDoNothing()
        .returning({ id: zones.id });
      if (made.length > 0) {
        await appendAudit(tx, tenantId, {
          actor: ZONE_ACTOR,
          action: "zone.create",
          decision: "allow",
          detail: { zone: id, kind: "managed", name: uploads.zone },
        });
        return id;
      }
      [zone] = await find();
    }
    if (!zone || zone.kind !== "managed") {
      throw new Refusal(
        409,
        "zone-kind",
        `zone "${uploads.zone}" is not a managed zone: name another in uploads.zone`,
      );
    }
    return zone.id;
  };

  const deny = (signedIn: SignedIn, reason: string) =>
    db.withTenant(signedIn.tenantId, (tx) =>
      appendAudit(tx, signedIn.tenantId, {
        actor: userPrincipal(signedIn.principal.userId),
        action: "object.upload",
        decision: "deny",
        detail: { reason },
      }),
    );

  /** A person's own session: a member, with no narrower credential. */
  const mayUpload = (signedIn: SignedIn): boolean => {
    const p = signedIn.principal;
    return p.active && !p.guest && p.service !== true && p.scope === undefined;
  };

  app.use("/api/uploads", async (c, next) => {
    c.header("cache-control", "no-store");
    const signedIn = c.get("auth");
    if (!signedIn) return c.json({ error: "not signed in" }, 401);
    if (!mayUpload(signedIn)) {
      if (c.req.method !== "GET") await deny(signedIn, "not-member");
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  });

  app.post("/api/uploads", async (c) => {
    const signedIn = c.get("auth") as SignedIn;
    const { tenantId } = signedIn;
    const userId = signedIn.principal.userId;
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
        await deny(signedIn, e.reason);
        return c.json({ error: e.message }, e.status);
      }
      if (e instanceof IngestError) {
        await deny(signedIn, `ingest-${e.code}`);
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
    const sameFile = `${userId}/${stored.blobId.slice("b3t:".length)}/${title}`;
    let result: IngestResult;
    try {
      result = await retrying(() =>
        db.withTenant(tenantId, async (tx) => {
          const zoneId = (await check(tx, true)) as string;
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
      },
      result.created.object ? 201 : 200,
    );
  });

  app.get("/api/uploads", async (c) => {
    const signedIn = c.get("auth") as SignedIn;
    const { tenantId } = signedIn;
    const owner = userPrincipal(signedIn.principal.userId);
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
          .select({ object: objects.id, title: objects.title, updatedAt: objects.updatedAt })
          .from(objects)
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
