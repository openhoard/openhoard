import { appendAudit } from "@openhoard/core-audit";
import { newId, zones, type Tx } from "@openhoard/core-db";
import { and, eq } from "drizzle-orm";

/*
 * Managed zones the server makes for itself: where it keeps the bytes it is handed (uploads,
 * T-1206; mail, T-1208), each named in the config and made in a tenant the first time something
 * goes into it.
 */

/** The zone's name is taken by a zone of another kind. */
export class ZoneKindError extends Error {
  constructor(
    readonly zone: string,
    readonly kind: string,
  ) {
    super(`zone "${zone}" is a ${kind} zone, not a managed one`);
    this.name = "ZoneKindError";
  }
}

/**
 * The tenant's managed zone of that name: its id, or null when there is none and `create` is
 * off. Made when `create` is on (audited as `zone.create` by `actor`); two first arrivals at
 * once make it once. Throws ZoneKindError when the name belongs to a zone that isn't managed.
 *
 * (The audit comes before ingest's locks, once in a zone's life; a deadlock from that order is
 * a retryable error, and callers retry their transaction.)
 */
export async function managedZone(
  tx: Tx,
  tenantId: string,
  name: string,
  options: { create: boolean; actor: string },
): Promise<string | null> {
  const find = () =>
    tx
      .select({ id: zones.id, kind: zones.kind })
      .from(zones)
      .where(and(eq(zones.tenantId, tenantId), eq(zones.name, name)));
  let [zone] = await find();
  if (!zone && !options.create) return null;
  if (!zone) {
    const id = newId("zone");
    const made = await tx
      .insert(zones)
      .values({ tenantId, id, kind: "managed", name })
      .onConflictDoNothing()
      .returning({ id: zones.id });
    if (made.length > 0) {
      await appendAudit(tx, tenantId, {
        actor: options.actor,
        action: "zone.create",
        decision: "allow",
        detail: { zone: id, kind: "managed", name },
      });
      return id;
    }
    [zone] = await find();
  }
  if (!zone) throw new Error(`zone "${name}" vanished`);
  if (zone.kind !== "managed") throw new ZoneKindError(name, zone.kind);
  return zone.id;
}
