import { join } from "node:path";
import { appendAudit } from "@openhoard/core-audit";
import type { ContentSource } from "@openhoard/core-catalog";
import { getTenant, isId, newId, zones, type Database } from "@openhoard/core-db";
import { findUserByEmail, getUser, type User } from "@openhoard/core-identity";
import {
  connectorContentSource,
  ensureSourceSync,
  firstOf,
  type ScheduledSource,
} from "@openhoard/core-jobs";
import { fsConnector } from "@openhoard/connector-fs";
import type { Connector } from "@openhoard/sdk";
import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { Config, SourceConfig } from "./config.js";
import { retrying } from "./retry.js";

/*
 * The configured sources (T-303): local folders synced on a schedule. At start the server, for
 * each one:
 *
 * - checks its tenant exists, and finds its zone by name, making it (an indexed zone, audited
 *   as `zone.create` by `system:config`) when the tenant has none of that name; a zone of that
 *   name that isn't indexed is refused;
 * - binds the source to that zone and to its connector (core/jobs ensureSourceSync()): a
 *   configuration that later points it at another zone is refused, never applied to the items
 *   it already has;
 * - builds its connector (the fs connector over `root`, its state in
 *   `<dataDir>/connectors/<tenant>/<source>`, owner-only permissions: nothing but the owner's
 *   OpenHoard access reaches its files);
 * - resolves its owner (an email or a user id) to an active member when a run starts: until
 *   that person exists (their first sign-in, or `admin user create`) runs wait.
 *
 * Any of those failing stops the server with a message naming the source: a folder half set up
 * would sync into the wrong place or not at all, silently.
 */

export interface ServerSources {
  /** The sources as core/jobs schedules them. */
  scheduled: ScheduledSource[];
  /**
   * Where enrichment reads indexed zones' bytes: the connectors of the sources that opted in
   * (`extract`), after `blobs` when given. Null when none did.
   */
  content: ContentSource | null;
  /** Wires `onStale` to the job queue once it runs (a changed item syncs its source soon). */
  onStale(handler: (tenantId: string, source: string) => void): void;
}

/** Who configured it, in the audit log. */
export const CONFIG_ACTOR = "system:config";

export async function prepareSources(
  db: Database,
  config: Pick<Config, "sources" | "dataDir">,
  options: {
    tenantKey: (tenantId: string) => Uint8Array;
    blobs?: ContentSource;
    log?: Logger;
    /** Builds a source's connector; the fs connector by default (tests pass their own). */
    connectorOf?: (source: SourceConfig, stateDir: string) => Connector;
  },
): Promise<ServerSources> {
  const scheduled: ScheduledSource[] = [];
  const reading = new Map<string, Connector>();
  for (const s of config.sources) {
    const fail = (why: string): never => {
      throw new Error(`invalid OpenHoard config:\n  sources ${s.id}: ${why}`);
    };
    const stateDir = join(config.dataDir, "connectors", s.tenantId, s.id);
    let connector: Connector;
    try {
      connector = (options.connectorOf ?? fsSource)(s, stateDir);
    } catch (e) {
      return fail((e as Error).message);
    }
    const connectorId = connector.describe().id;
    const zoneId = await retrying(() =>
      db.withTenant(s.tenantId, async (tx) => {
        if (!(await getTenant(tx, s.tenantId))) return fail(`no tenant ${s.tenantId}`);
        const [zone] = await tx
          .select({ id: zones.id, kind: zones.kind })
          .from(zones)
          .where(and(eq(zones.tenantId, s.tenantId), eq(zones.name, s.zone)));
        let id = zone?.id;
        if (zone && zone.kind !== "indexed") {
          return fail(
            `zone "${s.zone}" is a ${zone.kind} zone: a folder syncs into an indexed one`,
          );
        }
        if (!zone) {
          id = newId("zone");
          await tx
            .insert(zones)
            .values({ tenantId: s.tenantId, id, kind: "indexed", name: s.zone });
          await appendAudit(tx, s.tenantId, {
            actor: CONFIG_ACTOR,
            action: "zone.create",
            decision: "allow",
            detail: { zone: id, kind: "indexed", source: s.id },
          });
        }
        const bound = await ensureSourceSync(tx, s.tenantId, {
          source: s.id,
          zoneId: id as string,
          connector: connectorId,
        });
        if (bound !== "ok") {
          return fail(
            bound === "zone-mismatch"
              ? `it was first synced into another zone, not "${s.zone}": give it another id to start afresh`
              : `it was first synced by another connector: give it another id to start afresh`,
          );
        }
        return id as string;
      }),
    );
    scheduled.push({
      tenantId: s.tenantId,
      source: s.id,
      zoneId,
      cron: s.schedule,
      connector,
      owner: () => ownerOf(db, s),
      ...(s.reconcileGuard === undefined
        ? {}
        : { reconcileGuard: stripUndefined(s.reconcileGuard) }),
    });
    if (s.extract) reading.set(`${s.tenantId}/${s.id}`, connector);
    options.log?.info(
      { source: s.id, tenantId: s.tenantId, zoneId, schedule: s.schedule, extract: s.extract },
      "source ready",
    );
  }
  let stale: ((tenantId: string, source: string) => void) | undefined;
  const connectors =
    reading.size === 0
      ? null
      : connectorContentSource({
          db,
          connectorFor: (tenantId, source) => reading.get(`${tenantId}/${source}`),
          tenantKey: options.tenantKey,
          onStale: (tenantId, source) => stale?.(tenantId, source),
        });
  return {
    scheduled,
    content:
      connectors === null
        ? null
        : options.blobs === undefined
          ? connectors
          : firstOf(options.blobs, connectors),
    onStale(handler) {
      stale = handler;
    },
  };
}

/** The fs connector over a configured folder: owner-only permissions. */
function fsSource(s: SourceConfig, stateDir: string): Connector {
  return fsConnector({ root: s.root, stateDir });
}

/**
 * The source's owner as a principal (`user:usr_…`), or null while there is no such active
 * member: an email nobody has yet, a guest, a service account, a locked or retired person.
 */
export async function ownerOf(
  db: Database,
  s: Pick<SourceConfig, "tenantId" | "owner">,
): Promise<string | null> {
  const user: User | null = await db.withTenant(
    s.tenantId,
    (tx) =>
      isId("user", s.owner)
        ? getUser(tx, s.tenantId, s.owner)
        : findUserByEmail(tx, s.tenantId, s.owner),
    { accessMode: "read only" },
  );
  return user && user.kind === "member" && user.active && user.retired === null
    ? `user:${user.id}`
    : null;
}

function stripUndefined<T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
