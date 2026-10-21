import { appendAudit } from "@openhoard/core-audit";
import { newId, objects, sourceRefs, zones, type Tx } from "@openhoard/core-db";
import type { Authorizer } from "@openhoard/core-policy";
import { blobPath } from "@openhoard/core-storage";
import { and, desc, eq, isNull } from "drizzle-orm";
import { ingest, type IngestInput, type IngestResult } from "./ingest.js";
import { MAX_OBJECT_IDS, requireSnapshot, viewObjects, type ViewRequest } from "./visibility.js";

/*
 * Zones the server makes for itself, and what goes into the managed ones (T-1405): one way to
 * find or make a zone by name (a source's indexed zone, the uploads' and a mailbox's managed
 * zone), and one way to record bytes OpenHoard was handed and keeps (an upload, a mail's files).
 */

/** The zone's name is taken by a zone of another kind. */
export class ZoneKindError extends Error {
  constructor(
    readonly zone: string,
    readonly kind: string,
    readonly wanted: string,
  ) {
    super(`zone "${zone}" is a ${kind} zone, not a ${wanted} one`);
    this.name = "ZoneKindError";
  }
}

export interface ZoneRequest {
  name: string;
  kind: "managed" | "indexed";
  /** Make it when the tenant has none of that name (audited as `zone.create` by `actor`). */
  create: boolean;
  actor: string;
  /** More for the audit record of its making (the source it is for, say). */
  detail?: Record<string, string>;
}

/**
 * The tenant's zone of that name and kind: its id, or null when there is none and `create` is
 * off. Two first arrivals at once make it once. Throws ZoneKindError when the name belongs to a
 * zone of another kind.
 *
 * (The audit comes before ingest's locks, once in a zone's life; a deadlock from that order is
 * a retryable error, and callers retry their transaction.)
 */
export async function ensureZone(
  tx: Tx,
  tenantId: string,
  want: ZoneRequest,
): Promise<string | null> {
  const find = () =>
    tx
      .select({ id: zones.id, kind: zones.kind })
      .from(zones)
      .where(and(eq(zones.tenantId, tenantId), eq(zones.name, want.name)));
  let [zone] = await find();
  if (!zone && !want.create) return null;
  if (!zone) {
    const id = newId("zone");
    const made = await tx
      .insert(zones)
      .values({ tenantId, id, kind: want.kind, name: want.name })
      .onConflictDoNothing()
      .returning({ id: zones.id });
    if (made.length > 0) {
      await appendAudit(tx, tenantId, {
        actor: want.actor,
        action: "zone.create",
        decision: "allow",
        detail: { zone: id, kind: want.kind, name: want.name, ...want.detail },
      });
      return id;
    }
    [zone] = await find();
  }
  if (!zone) throw new Error(`zone "${want.name}" vanished`);
  if (zone.kind !== want.kind) throw new ZoneKindError(want.name, zone.kind, want.kind);
  return zone.id;
}

export interface ManagedIngest extends Omit<IngestInput, "zoneId" | "content"> {
  /** The managed zone's name: made on its first file. */
  zone: string;
  /** Who makes the zone, in the audit log (`system:uploads`…). */
  zoneActor: string;
  /** The bytes, as BlobStore.put() kept them. */
  blob: { blobId: string; size: number };
}

/**
 * Records bytes OpenHoard keeps (an upload, a mail's files) in a managed zone, made when it is
 * the first: core/catalog ingest() with the blob's location. An item of that external id that
 * has since become someone else's isn't touched: the bytes become a new file (each time: after
 * a hand-over, the same file sent twice is two files). Throws ZoneKindError when the zone's
 * name is taken by an indexed zone.
 */
export async function ingestManaged(
  tx: Tx,
  tenantId: string,
  input: ManagedIngest,
): Promise<IngestResult & { zoneId: string }> {
  const { zone, zoneActor, blob, ...item } = input;
  const zoneId = (await ensureZone(tx, tenantId, {
    name: zone,
    kind: "managed",
    create: true,
    actor: zoneActor,
  })) as string;
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
        eq(sourceRefs.source, item.source),
        eq(sourceRefs.externalId, item.externalId),
      ),
    );
  const done = await ingest(tx, tenantId, {
    ...item,
    externalId:
      known && known.owner !== item.ownerId
        ? `${item.externalId}/${newId("object")}`
        : item.externalId,
    zoneId,
    content: { ...blob, location: blobPath(tenantId, blob.blobId) },
  });
  return { ...done, zoneId };
}

/** One of a person's own files in a managed zone (their uploads). */
export interface OwnFile {
  object: string;
  title: string;
  updatedAt: Date;
  /** Where it was saved from (a page the browser extension saved), or null. */
  url: string | null;
}

/**
 * The caller's own files in the managed zone of that name, newest first, at most `limit` (50 by
 * default, {@link MAX_OBJECT_IDS} at most): each through the gate, so a file they may no
 * longer read (a policy forbids it) isn't listed. None when there is no such managed zone.
 */
export async function listOwnManaged(
  tx: Tx,
  tenantId: string,
  authz: Authorizer,
  request: ViewRequest,
  query: { zone: string; source: string; limit?: number },
): Promise<OwnFile[]> {
  await requireSnapshot(tx, "listOwnManaged");
  const limit = query.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_OBJECT_IDS) {
    throw new RangeError(`limit must be 1 to ${MAX_OBJECT_IDS}`);
  }
  const zoneId = await ensureZone(tx, tenantId, {
    name: query.zone,
    kind: "managed",
    create: false,
    actor: "",
  }).catch((e: unknown) => {
    if (e instanceof ZoneKindError) return null;
    throw e;
  });
  if (zoneId === null) return [];
  const rows = await tx
    .select({ object: objects.id, url: sourceRefs.url })
    .from(objects)
    .leftJoin(
      sourceRefs,
      and(
        eq(sourceRefs.tenantId, objects.tenantId),
        eq(sourceRefs.objectId, objects.id),
        eq(sourceRefs.source, query.source),
      ),
    )
    .where(
      and(
        eq(objects.tenantId, tenantId),
        eq(objects.zoneId, zoneId),
        eq(objects.ownerId, `user:${request.principal.userId}`),
        isNull(objects.deletedAt),
      ),
    )
    .orderBy(desc(objects.updatedAt), desc(objects.id))
    .limit(limit);
  const urls = new Map(rows.map((r) => [r.object, r.url]));
  const views = await viewObjects(
    tx,
    tenantId,
    authz,
    request,
    rows.map((r) => r.object),
  );
  return views.flatMap((v) =>
    v.shape === "card" && v.readable
      ? [{ object: v.id, title: v.title, updatedAt: v.updatedAt, url: urls.get(v.id) ?? null }]
      : [],
  );
}
