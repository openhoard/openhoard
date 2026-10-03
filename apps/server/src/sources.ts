import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendAudit } from "@openhoard/core-audit";
import type { ContentSource } from "@openhoard/core-catalog";
import { getTenant, isId, newId, zones, type Database } from "@openhoard/core-db";
import { findUserByEmail, getUser, type User } from "@openhoard/core-identity";
import {
  connectorContentSource,
  ensureSourceSync,
  firstOf,
  pinSourceOwner,
  type ScheduledSource,
} from "@openhoard/core-jobs";
import { fsConnector } from "@openhoard/connector-fs";
import { graphAuth, sharepointConnector, sitePath } from "@openhoard/connector-sharepoint";
import type { Connector } from "@openhoard/sdk";
import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import {
  sourceSecretEnv,
  type Config,
  type FsSourceConfig,
  type SharePointSourceConfig,
  type SourceConfig,
} from "./config.js";
import { retrying } from "./retry.js";

/*
 * The configured sources (T-303): local folders and SharePoint sites synced on a schedule. At
 * start the server, for each one:
 *
 * - checks its tenant exists, and finds its zone by name, making it (an indexed zone, audited
 *   as `zone.create` by `system:config`) when the tenant has none of that name; a zone of that
 *   name that isn't indexed is refused;
 * - binds the source to that zone and to its connector (core/jobs ensureSourceSync()): a
 *   configuration that later points it at another zone is refused, never applied to the items
 *   it already has;
 * - builds its connector: the fs connector over `root` (its state in
 *   `<dataDir>/connectors/<tenant>/<source>`), or the SharePoint connector over `site`, signed
 *   in as the configured Entra app (its secret from the environment, or a certificate from the
 *   files named). Either way with owner-only permissions: nothing but the owner's OpenHoard
 *   access reaches its files. A SharePoint source whose secret isn't set is left out with a
 *   warning (as a model without its key is), and the rest start;
 * - resolves its owner (an email or a user id) to an active member on its first run, and pins
 *   that person (ownerOf()): until they exist (`admin user create`, SCIM) runs wait, and a later
 *   configuration naming someone else is refused.
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
    tenantKey: (tenantId: string) => Promise<Uint8Array>;
    blobs?: ContentSource;
    log?: Logger;
    /** Builds a source's connector; by its `connector` by default (tests pass their own). */
    connectorOf?: (source: SourceConfig, stateDir: string) => Connector;
    /** Where a source's secret is read from. Default `process.env`. */
    env?: NodeJS.ProcessEnv;
    /** What the SharePoint connector reaches Entra and Graph with. Default the global `fetch`. */
    fetch?: typeof fetch;
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
    /** How a SharePoint source signs in, for the log: never the credential. */
    let credential: "certificate" | "secret" | undefined;
    try {
      if (options.connectorOf) connector = options.connectorOf(s, stateDir);
      else if (s.connector === "fs") connector = fsSource(s, stateDir);
      else {
        const env = options.env ?? process.env;
        const built = sharepointSource(s, env, options.fetch);
        if (built === null) {
          // As a mailbox without its password: said loudly, and the rest start. What it
          // indexed before stays as it is, and goes stale until the secret is back.
          options.log?.error(
            { source: s.id, tenantId: s.tenantId, variable: sourceSecretEnv(s.id) },
            `source ${s.id} has no client secret (${sourceSecretEnv(s.id)} isn't set) and no certificate: it isn't synced until one is given and the server restarted`,
          );
          continue;
        }
        ({ connector, credential } = built);
        if (built.secretIgnored) {
          options.log?.warn(
            { source: s.id, tenantId: s.tenantId, variable: sourceSecretEnv(s.id) },
            `source ${s.id} signs in with its certificate: ${sourceSecretEnv(s.id)} is set and not used`,
          );
        }
      }
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
            `zone "${s.zone}" is a ${zone.kind} zone: a source syncs into an indexed one`,
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
        // The owner is pinned on the first run: a configuration naming another person now must
        // be a new source, never a takeover of this one's files.
        const pinned = await pinSourceOwner(tx, s.tenantId, s.id, null);
        if (pinned !== null) {
          const named = isId("user", s.owner)
            ? `user:${s.owner}`
            : await findUserByEmail(tx, s.tenantId, s.owner).then((u) =>
                u ? `user:${u.id}` : null,
              );
          if (named !== null && named !== pinned) {
            return fail(
              `its owner is ${pinned.slice("user:".length)} since its first run, and "${s.owner}" names someone else: give it another id to start afresh`,
            );
          }
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
      owner: () => ownerOf(db, { ...s, source: s.id }),
      ...(s.reconcileGuard === undefined
        ? {}
        : { reconcileGuard: stripUndefined(s.reconcileGuard) }),
    });
    if (s.extract) reading.set(`${s.tenantId}/${s.id}`, connector);
    options.log?.info(
      {
        source: s.id,
        tenantId: s.tenantId,
        zoneId,
        schedule: s.schedule,
        extract: s.extract,
        ...(credential === undefined ? {} : { credential }),
      },
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
function fsSource(s: FsSourceConfig, stateDir: string): Connector {
  return fsConnector({ root: s.root, stateDir });
}

/** A PEM file is a few kilobytes: one far larger isn't one, and isn't read. */
const MAX_PEM_BYTES = 256 * 1024;

/**
 * The SharePoint connector over a configured site, signed in as the configured Entra app: with
 * its certificate when one is named, else with the client secret in the environment. Null
 * when there is neither (after checking what can be checked without one, so a mistake in the
 * site isn't found only once the secret is set). The credential goes to the connector and
 * nowhere else: it is not logged, and what is thrown here names files and variables, never
 * their contents.
 */
export function sharepointSource(
  s: SharePointSourceConfig,
  env: NodeJS.ProcessEnv,
  send?: typeof fetch,
): { connector: Connector; credential: "certificate" | "secret"; secretIgnored: boolean } | null {
  const pem = (what: string, file: string): string => {
    let reason: string;
    let fd: number | undefined;
    try {
      // Opened once, and checked and read through that: what is read is what was checked.
      fd = openSync(file, "r");
      const found = fstatSync(fd);
      if (!found.isFile()) reason = "not a file";
      else if (found.size > MAX_PEM_BYTES) reason = "too large to be one";
      else return readFileSync(fd, "utf8");
    } catch (e) {
      // The reason by its code: not the error's own text, and nothing of the file.
      const code = (e as NodeJS.ErrnoException).code ?? "unreadable";
      reason = code === "EISDIR" ? "not a file" : code;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    throw new Error(`its ${what} file can't be read (${reason}): ${file}`);
  };
  const secret = env[sourceSecretEnv(s.id)] ?? "";
  if (s.certificate === undefined && secret === "") {
    sitePath(s.site);
    return null;
  }
  const credential = s.certificate
    ? ({
        kind: "certificate",
        certificate: pem("certificate", s.certificate.certificateFile),
        privateKey: pem("private key", s.certificate.privateKeyFile),
      } as const)
    : ({ kind: "secret", secret } as const);
  const connector = sharepointConnector({
    auth: graphAuth({
      tenant: s.directory,
      clientId: s.clientId,
      credential,
      ...(s.authority === undefined ? {} : { authority: s.authority }),
      ...(s.graph === undefined ? {} : { graph: s.graph }),
      ...(send === undefined ? {} : { fetch: send }),
    }),
    site: s.site,
    ...(s.downloadHosts === undefined ? {} : { downloadHosts: s.downloadHosts }),
    ...(send === undefined ? {} : { fetch: send }),
  });
  return {
    connector,
    credential: credential.kind,
    secretIgnored: s.certificate !== undefined && secret !== "",
  };
}

/**
 * The source's owner as a principal (`user:usr_…`), or null while there is none to own it.
 *
 * On the first run the configured owner (an email, or an id) is resolved to a current member and
 * pinned in source_syncs (core/jobs pinSourceOwner()); from then on only that person owns the
 * source: never someone the email names later (an address reused after its owner left). While
 * the pinned person isn't an active member (locked, disabled, retired), runs wait.
 */
export async function ownerOf(
  db: Database,
  s: Pick<SourceConfig, "tenantId" | "owner"> & { source: string },
): Promise<string | null> {
  return db.withTenant(s.tenantId, async (tx) => {
    let pinned = await pinSourceOwner(tx, s.tenantId, s.source, null);
    if (pinned === null) {
      const found = isId("user", s.owner)
        ? await getUser(tx, s.tenantId, s.owner)
        : await findUserByEmail(tx, s.tenantId, s.owner);
      if (!usable(found)) return null;
      pinned = await pinSourceOwner(tx, s.tenantId, s.source, `user:${found.id}`);
      if (pinned === null) return null;
    }
    const user = await getUser(tx, s.tenantId, pinned.slice("user:".length));
    return usable(user) ? pinned : null;
  });
}

/** An active member: never a guest, a service account, or someone locked or retired. */
function usable(user: User | null): user is User {
  return user !== null && user.kind === "member" && user.active && user.retired === null;
}

function stripUndefined<T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
