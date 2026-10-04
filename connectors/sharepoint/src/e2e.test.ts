import { grants, objects, sourceRefs, sourceSyncs, type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addMember,
  createGroup,
  createUser,
  lockUser,
  resolvePrincipal,
} from "@openhoard/core-identity";
import { runSync, type SyncReport } from "@openhoard/core-jobs";
import type { SyncEvent } from "@openhoard/sdk";
import { and, count, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { graphAuth } from "./auth.js";
import { sharepointConnector, type SharePointConnectorOptions } from "./connector.js";
import { AccessModel } from "@openhoard/testkit";
import { AUTHORITY, CLIENT_ID, fakes, GRAPH, SECRET, type Fakes } from "./testing/fakes.js";

/*
 * T-303's done-when, through the real sync runner into the catalog (PGlite, or PostgreSQL with
 * OPENHOARD_TEST_POSTGRES_URL): a fake tenant's sites are fully indexed, and a sync that is
 * killed goes on from its last checkpoint. And T-304's: after a crawl, syncs follow the site's
 * changes, and the catalog holds what a fresh crawl of the site as it is now would give it.
 * And T-305's: who can read each file here is exactly who SharePoint lets read it.
 *
 * The 10,000-item tenant takes minutes, so it runs as a slow test:
 * `pnpm --filter @openhoard/connector-sharepoint test:slow` (or OPENHOARD_TEST_SLOW=1). The
 * same test runs on 600 items every time.
 */

const KEY = new Uint8Array(32).fill(7);
const slow =
  process.env.OPENHOARD_TEST_SLOW === "1" || process.env.npm_lifecycle_event === "test:slow";

let db: Database;
let t: SeededTenant;
let f: Fakes;

function setUp(items: number, more: { contentHashes?: boolean } = {}) {
  f = fakes({ items, maxFileBytes: 512, ...more });
  f.entra.registerApp({ clientId: CLIENT_ID, secret: SECRET, appRoles: ["Sites.Selected"] });
  for (const site of f.tenant.sites) f.entra.grantSite(CLIENT_ID, site.id);
}

beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
});
afterEach(async () => {
  await db?.close();
});

const sourceOf = (siteId: string) => `sp-${siteId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

/** A connector that remembers nothing itself: what it keeps between runs is in `stateDir`. */
function connectorOf(siteId: string, more: Partial<SharePointConnectorOptions> = {}) {
  const send = more.fetch ?? f.fetch;
  return sharepointConnector({
    auth: graphAuth({
      tenant: f.tenant.domain,
      clientId: CLIENT_ID,
      credential: { kind: "secret", secret: SECRET },
      authority: AUTHORITY,
      graph: GRAPH,
      fetch: send,
      now: () => f.clock.now,
    }),
    site: siteId,
    fetch: send,
    now: () => f.clock.now,
    pageSize: 50,
    ...more,
  });
}

/** One run of the runner over one site, with a new connector each time. */
function sync(
  siteId: string,
  more: { signal?: AbortSignal; maxItems?: number; fetch?: typeof fetch; stateDir?: string } = {},
): Promise<SyncReport> {
  return runSync(db, {
    tenantId: t.tenantId,
    source: sourceOf(siteId),
    zoneId: t.zoneId,
    connector: connectorOf(siteId, {
      ...(more.fetch === undefined ? {} : { fetch: more.fetch }),
      ...(more.stateDir === undefined ? {} : { stateDir: more.stateDir }),
    }),
    ownerId: `user:${t.userId}`,
    tenantKey: () => KEY,
    enqueue: async () => {},
    sleep: async () => {},
    ...(more.signal === undefined ? {} : { signal: more.signal }),
    ...(more.maxItems === undefined ? {} : { maxItems: more.maxItems }),
  });
}

/** How many live objects the catalog holds for a site's source. */
async function recorded(siteId: string): Promise<number> {
  const [row] = await db.withTenant(t.tenantId, (tx) =>
    tx
      .select({ n: count() })
      .from(sourceRefs)
      .innerJoin(
        objects,
        and(eq(objects.tenantId, sourceRefs.tenantId), eq(objects.id, sourceRefs.objectId)),
      )
      .where(and(eq(sourceRefs.source, sourceOf(siteId)), isNull(objects.deletedAt))),
  );
  return Number(row?.n ?? 0);
}

const filesOf = (siteId: string) =>
  f.tenant.items.filter((i) => i.siteId === siteId && i.kind === "file").length;

async function indexEverySite(): Promise<void> {
  let total = 0;
  for (const site of f.tenant.sites) {
    const report = await sync(site.id);
    expect(report, site.id).toMatchObject({ status: "done", phase: "crawl", skipped: [] });
    expect(report.warnings).toEqual([]);
    expect(report.counts.files).toBe(filesOf(site.id));
    expect(report.counts.ingested).toBe(filesOf(site.id));
    expect(await recorded(site.id)).toBe(filesOf(site.id));
    total += report.counts.files + report.counts.folders - 1; // the library's top is a folder too
  }
  expect(total).toBe(f.tenant.items.length);
}

describe("a fake tenant through the sync runner", () => {
  it("is fully indexed, site by site", async () => {
    setUp(600);
    await indexEverySite();
    // Again: nothing is read a second time, and nothing is taken for gone.
    const site = f.tenant.sites[0] as { id: string };
    const downloads = () => f.sent.filter((s) => s.url.includes("/_download/")).length;
    const before = downloads();
    const again = await sync(site.id);
    expect(again.status).toBe("done");
    expect(again.counts).toMatchObject({ files: filesOf(site.id), deleted: 0, reconciled: 0 });
    expect(downloads()).toBe(before);
    expect(await recorded(site.id)).toBe(filesOf(site.id));
  }, 240_000);

  it.runIf(slow)(
    "of 10,000 items is fully indexed",
    async () => {
      setUp(10_000);
      await indexEverySite();
    },
    1_800_000,
  );

  it("killed midway goes on from its last checkpoint, and ends complete", async () => {
    setUp(2500);
    const site = f.tenant.sites[0] as { id: string };
    const files = filesOf(site.id);
    expect(files).toBeGreaterThan(150);

    // Killed: the signal aborts once a third of the files have been asked for.
    const kill = new AbortController();
    let reads = 0;
    const counting: typeof fetch = (input, init) => {
      if (String(input).endsWith("/content") && ++reads === Math.floor(files / 3)) {
        kill.abort(new Error("killed"));
      }
      return f.fetch(input, init);
    };
    const first = await sync(site.id, { signal: kill.signal, fetch: counting });
    expect(first.status).toBe("cancelled");
    const partly = await recorded(site.id);
    expect(partly).toBeGreaterThan(0);
    expect(partly).toBeLessThan(files);
    const [state] = await db.withTenant(t.tenantId, (tx) =>
      tx
        .select()
        .from(sourceSyncs)
        .where(eq(sourceSyncs.source, sourceOf(site.id))),
    );
    expect(state?.token, "a checkpoint was saved before the kill").toEqual(expect.any(String));

    // Stopped at checkpoints to fit a budget, as a job does: each run goes on from the last.
    let report = await sync(site.id, { maxItems: 60 });
    expect(report.status).toBe("partial");
    let runs = 1;
    while (report.status === "partial") {
      report = await sync(site.id, { maxItems: 60 });
      expect(++runs).toBeLessThan(50);
    }
    expect(report).toMatchObject({ status: "done", skipped: [] });
    expect(runs).toBeGreaterThan(2);
    expect(await recorded(site.id)).toBe(files);

    // What the killed run recorded wasn't read again: fewer downloads than two whole crawls.
    const downloads = f.sent.filter((s) => s.url.includes("/_download/")).length;
    expect(downloads).toBeLessThan(files + 60);
  }, 240_000);

  it("indexes a tenant whose files have no content hash", async () => {
    setUp(300, { contentHashes: false });
    const site = f.tenant.sites[0] as { id: string };
    expect(await sync(site.id)).toMatchObject({ status: "done", skipped: [] });
    expect(await recorded(site.id)).toBe(filesOf(site.id));
  }, 120_000);

  it("keeps a file Graph says nonsense of, and still removes what is gone", async () => {
    setUp(300);
    const site = f.tenant.sites[0] as { id: string };
    expect((await sync(site.id)).status).toBe("done");
    const files = filesOf(site.id);
    const mine = f.tenant.items.filter((i) => i.siteId === site.id && i.kind === "file");
    const victim = mine[0] as { id: string };
    const gone = mine[1] as { id: string };
    // The next crawl's feed is wrong about one file, and another file has been deleted.
    f.graph.store.delete(gone.id);
    const wrong: typeof fetch = async (input, init) => {
      const response = await f.fetch(input, init);
      if (!String(input).includes("/root/delta") || !response.ok) return response;
      const page = (await response.json()) as { value: Record<string, unknown>[] };
      for (const raw of page.value) if (raw.id === victim.id) raw.size = "many";
      return new Response(JSON.stringify(page));
    };
    const second = await sync(site.id, { fetch: wrong });
    // The one it couldn't serve is warned of and kept; the deleted one is removed.
    expect(second).toMatchObject({ status: "done", counts: { deleted: 0, reconciled: 1 } });
    expect(second.warnings).toEqual([
      { code: "invalid-item", externalId: expect.stringContaining(victim.id) as string },
    ]);
    expect(await recorded(site.id)).toBe(files - 1);

    // An entry that can't even be named: unknown, not gone. Nothing is removed that time.
    const third = f.tenant.items.filter((i) => i.siteId === site.id && i.kind === "file")[2] as {
      id: string;
    };
    f.graph.store.delete(third.id);
    const nameless: typeof fetch = async (input, init) => {
      const response = await f.fetch(input, init);
      if (!String(input).includes("/root/delta") || !response.ok) return response;
      const page = (await response.json()) as { value: unknown[] };
      page.value.push({ name: "no id" });
      return new Response(JSON.stringify(page));
    };
    const unsure = await sync(site.id, { fetch: nameless });
    expect(unsure.counts.reconciled).toBe(0);
    expect(unsure.warnings.map((w) => w.code)).toEqual(["unreadable", "reconcile-deferred"]);
    expect(await recorded(site.id)).toBe(files - 1);
    // The next clean crawl removes it.
    expect((await sync(site.id)).counts.reconciled).toBe(1);
    expect(await recorded(site.id)).toBe(files - 2);
  }, 120_000);

  it("stops for an admin when the site isn't granted, and goes on once it is", async () => {
    setUp(300);
    const site = f.tenant.sites[1] as { id: string };
    f.entra.revokeSite(CLIENT_ID, site.id);
    expect(await sync(site.id)).toMatchObject({ status: "failed", error: "auth" });
    expect(await recorded(site.id)).toBe(0);
    f.entra.grantSite(CLIENT_ID, site.id);
    expect((await sync(site.id)).status).toBe("done");
    expect(await recorded(site.id)).toBe(filesOf(site.id));
  }, 120_000);

  it("waits when Graph asks it to, and loses nothing", async () => {
    setUp(300);
    const site = f.tenant.sites[2] as { id: string };
    let pages = 0;
    const throttling: typeof fetch = (input, init) => {
      if (String(input).includes("/root/delta") && ++pages === 1) {
        return Promise.resolve(
          new Response("{}", { status: 429, headers: { "retry-after": "120" } }),
        );
      }
      return f.fetch(input, init);
    };
    const first = await sync(site.id, { fetch: throttling });
    expect(first).toMatchObject({ status: "retry", error: "throttled", retryAfterMs: 120_000 });
    expect(await recorded(site.id)).toBe(0);
    expect((await sync(site.id)).status).toBe("done");
    expect(await recorded(site.id)).toBe(filesOf(site.id));
  }, 120_000);
});

/** The catalog's live files for a site's source: each one's id and etag (which holds its path). */
async function cataloged(siteId: string): Promise<string[]> {
  const rows = await db.withTenant(t.tenantId, (tx) =>
    tx
      .select({ externalId: sourceRefs.externalId, etag: sourceRefs.etag })
      .from(sourceRefs)
      .innerJoin(
        objects,
        and(eq(objects.tenantId, sourceRefs.tenantId), eq(objects.id, sourceRefs.objectId)),
      )
      .where(and(eq(sourceRefs.source, sourceOf(siteId)), isNull(objects.deletedAt))),
  );
  return rows.map((r) => `${r.externalId} ${r.etag}`).sort();
}

/** The same of the site as it is now, from a crawl that knows nothing of what came before. */
async function crawled(siteId: string): Promise<string[]> {
  const out: string[] = [];
  const events: AsyncIterable<SyncEvent> = connectorOf(siteId).crawl(
    null,
    new AbortController().signal,
  );
  for await (const e of events) {
    if (e.type === "item" && e.item.kind === "file") {
      out.push(`${e.item.externalId} ${e.item.etag}`);
    }
  }
  return out.sort();
}

describe("a site's changes through the sync runner (T-304)", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "oh-sp-e2e-"));
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 5 });
  });
  const downloads = () => f.sent.filter((s) => s.url.includes("/_download/")).length;
  const deltas = () => f.sent.filter((s) => s.url.includes("/root/delta")).length;

  it("are followed: the catalog is what a fresh crawl of the site as it is now would give", async () => {
    setUp(600);
    const site = f.tenant.sites[0] as { id: string; driveId: string };
    const store = f.graph.store;
    const mine = () => store.inDrive(site.driveId);
    // Three folders of its own, each with files and a folder of files in it.
    const made = ["Plans", "Drafts", "Old"].map((name) => {
      const folder = store.addFolder(site.driveId, undefined, name);
      const inner = store.addFolder(site.driveId, folder.id, "Inner");
      for (const n of [1, 2, 3]) {
        store.addFile(site.driveId, folder.id, `${name} ${n}.txt`, 40 + n);
        store.addFile(site.driveId, inner.id, `${name} inner ${n}.txt`, 60 + n);
      }
      return folder;
    });
    const renamedFolder = made[0] as { id: string };
    const movedFolder = made[1] as { id: string };
    const doomedFolder = made[2] as { id: string };
    expect(await sync(site.id, { stateDir })).toMatchObject({ status: "done", phase: "crawl" });
    expect(await cataloged(site.id)).toEqual(await crawled(site.id));

    // Nothing changed: one request to the library, nothing recorded, nothing read.
    let asked = deltas();
    let read = downloads();
    const idle = await sync(site.id, { stateDir });
    expect(idle).toMatchObject({ status: "done", phase: "delta", skipped: [], warnings: [] });
    expect(idle.counts).toMatchObject({ files: 0, deleted: 0, reconciled: 0 });
    expect(deltas() - asked).toBe(1);
    expect(downloads()).toBe(read);

    // A day's work on the site.
    const files = mine().filter((i) => i.kind === "file");
    const below = (id: string): string[] =>
      mine()
        .filter((i) => i.parentId === id)
        .flatMap((i) => [i.id, ...below(i.id)]);
    const touched = new Set(
      [renamedFolder, movedFolder, doomedFolder].flatMap((d) => [d.id, ...below(d.id)]),
    );
    const free = files.filter((i) => !touched.has(i.id));
    const [edited, renamed, deleted] = free as [
      (typeof files)[0],
      (typeof files)[0],
      (typeof files)[0],
    ];
    store.addFile(site.driveId, undefined, "new at the top.txt", 120);
    store.addFile(site.driveId, renamedFolder.id, "new in a folder.txt", 80);
    store.update(edited.id, { size: edited.size + 11 });
    store.update(renamed.id, { name: "renamed in place.txt" });
    store.delete(deleted.id);
    store.update(renamedFolder.id, { name: "Renamed folder" });
    const gone = below(doomedFolder.id).filter((id) => store.get(id)?.kind === "file").length;
    store.delete(doomedFolder.id);
    store.move(movedFolder.id, renamedFolder.id);

    asked = deltas();
    read = downloads();
    const followed = await sync(site.id, { stateDir });
    const [askedNow, readNow] = [deltas() - asked, downloads() - read];
    expect(followed).toMatchObject({ status: "done", phase: "delta", skipped: [], warnings: [] });
    expect(followed.counts.deleted).toBe(1 + gone);
    expect(await cataloged(site.id)).toEqual(await crawled(site.id));
    // Asked what changed, not crawled; and only the bytes that are new were read: the two new
    // files and the edited one, not what was renamed or is under a renamed or moved folder.
    expect(askedNow).toBe(1);
    expect(readNow).toBe(3);

    // And from there again.
    store.update(renamed.id, { name: "renamed again.txt" });
    expect(await sync(site.id, { stateDir })).toMatchObject({ status: "done", phase: "delta" });
    expect(await cataloged(site.id)).toEqual(await crawled(site.id));
  }, 240_000);

  it("are held when they would delete most of the source, as a reconcile is", async () => {
    setUp(300);
    const site = f.tenant.sites[0] as { id: string; driveId: string };
    expect((await sync(site.id, { stateDir })).status).toBe("done");
    const before = await recorded(site.id);
    for (const top of f.graph.store.inDrive(site.driveId).filter((i) => i.parentId === undefined)) {
      f.graph.store.delete(top.id);
    }
    expect(await sync(site.id, { stateDir })).toMatchObject({
      status: "failed",
      phase: "delta",
      error: "delete-guard",
    });
    expect(await recorded(site.id)).toBe(before);
  }, 120_000);

  it("are found by a crawl when what the connector kept is lost, or Graph can't say", async () => {
    setUp(300);
    const site = f.tenant.sites[0] as { id: string; driveId: string };
    const store = f.graph.store;
    expect((await sync(site.id, { stateDir })).status).toBe("done");
    const file = store.inDrive(site.driveId).find((i) => i.kind === "file") as { id: string };

    // The state directory lost (a restore without it): crawled again, in the same run.
    rmSync(stateDir, { recursive: true, force: true });
    store.update(file.id, { name: "while the state was lost.txt" });
    expect(await sync(site.id, { stateDir })).toMatchObject({ status: "done", phase: "crawl" });
    expect(await cataloged(site.id)).toEqual(await crawled(site.id));
    expect((await sync(site.id, { stateDir })).phase).toBe("delta");

    // Graph no longer takes the link (410).
    store.update(file.id, { name: "while the link lapsed.txt" });
    f.graph.requireResync();
    expect(await sync(site.id, { stateDir })).toMatchObject({ status: "done", phase: "crawl" });
    expect(await cataloged(site.id)).toEqual(await crawled(site.id));

    // A week on, the site is crawled again whatever changed.
    expect((await sync(site.id, { stateDir })).phase).toBe("delta");
    f.clock.now += 8 * 86_400_000;
    expect(await sync(site.id, { stateDir })).toMatchObject({ status: "done", phase: "crawl" });
  }, 240_000);

  it("are followed from a crawl that was killed and resumed", async () => {
    setUp(600);
    const site = f.tenant.sites[0] as { id: string; driveId: string };
    const store = f.graph.store;
    let report = await sync(site.id, { stateDir, maxItems: 40 });
    expect(report.status).toBe("partial");
    for (let runs = 1; report.status === "partial"; runs++) {
      report = await sync(site.id, { stateDir, maxItems: 40 });
      expect(runs).toBeLessThan(60);
    }
    expect(report).toMatchObject({ status: "done", phase: "crawl" });
    const folder = store
      .inDrive(site.driveId)
      .find(
        (i) => i.kind === "folder" && store.inDrive(site.driveId).some((c) => c.parentId === i.id),
      ) as { id: string };
    store.update(folder.id, { name: "Renamed after the crawl" });
    expect(await sync(site.id, { stateDir })).toMatchObject({ status: "done", phase: "delta" });
    expect(await cataloged(site.id)).toEqual(await crawled(site.id));
  }, 240_000);
});

describe("a site's permissions through the sync runner (T-305)", () => {
  let stateDir: string;
  /** The tenant's people here, by their id there. */
  let people: Map<string, string>;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "oh-sp-acl-"));
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 5 });
  });

  /**
   * The fake tenant's directory as an identity provider would provision it: members and groups
   * by their Entra ids (SCIM), guests as guest accounts, and those who left locked.
   */
  async function provision(): Promise<void> {
    people = new Map();
    await db.withTenant(t.tenantId, async (tx) => {
      for (const u of f.tenant.users) {
        const created = await createUser(tx, t.tenantId, {
          email: u.upn,
          displayName: u.displayName,
          source: "scim",
          externalId: u.id,
          ...(u.guest ? { kind: "guest" as const } : {}),
        });
        people.set(u.id, created.id);
        if (!u.active) await lockUser(tx, t.tenantId, created.id, "system:test");
      }
      for (const g of f.tenant.groups) {
        const group = await createGroup(tx, t.tenantId, {
          name: g.displayName,
          source: "scim",
          externalId: g.id,
        });
        for (const member of g.members) {
          await addMember(tx, t.tenantId, group.id, people.get(member) as string, "scim");
        }
      }
    });
  }

  /** For every person, the site's files they can read here: by the grants the policy engine is given. */
  async function readableHere(siteId: string): Promise<Map<string, string[]>> {
    const rows = await db.withTenant(t.tenantId, (tx) =>
      tx
        .select({ externalId: sourceRefs.externalId, objectId: sourceRefs.objectId })
        .from(sourceRefs)
        .innerJoin(
          objects,
          and(eq(objects.tenantId, sourceRefs.tenantId), eq(objects.id, sourceRefs.objectId)),
        )
        .where(and(eq(sourceRefs.source, sourceOf(siteId)), isNull(objects.deletedAt))),
    );
    const itemOf = new Map(rows.map((r) => [r.objectId, r.externalId.split(":")[1] as string]));
    const out = new Map<string, string[]>();
    for (const [there, here] of people) {
      const principal = await db.withTenant(t.tenantId, (tx) =>
        resolvePrincipal(tx, t.tenantId, here),
      );
      const held =
        principal?.active === true
          ? [...principal.objectGrants, ...principal.objectWriteGrants]
          : [];
      out.set(there, [...new Set(held.flatMap((id) => itemOf.get(id) ?? []))].sort());
    }
    return out;
  }

  /** The same, as SharePoint has it. */
  function readableThere(driveId: string): Map<string, string[]> {
    const access = new AccessModel(f.tenant);
    const files = f.graph.store.inDrive(driveId).filter((i) => i.kind === "file");
    return new Map(
      f.tenant.users.map((u) => [
        u.id,
        files
          .filter((i) => access.canRead(u.id, i))
          .map((i) => i.id)
          .sort(),
      ]),
    );
  }

  it("are who can read each file here: the matrix matches SharePoint's exactly, and follows it", async () => {
    setUp(600);
    await provision();
    // A site with unique permissions, sharing links and guests among its files.
    const site = f.tenant.sites.find((s) =>
      f.tenant.items.some(
        (i) => i.siteId === s.id && i.acl.some((a) => a.principal.startsWith("guest:")),
      ),
    ) as { id: string; driveId: string };
    const store = f.graph.store;
    const files = () => store.inDrive(site.driveId).filter((i) => i.kind === "file");
    const kinds = new Set(files().flatMap((i) => i.acl.map((a) => a.principal.split(":")[0])));
    expect([...kinds].sort()).toEqual(
      expect.arrayContaining(["anyone-with-link", "group", "guest", "user"]),
    );

    const crawl = await sync(site.id, { stateDir });
    expect(crawl).toMatchObject({ status: "done", phase: "crawl", skipped: [] });
    expect(crawl.counts.grantsAdded).toBeGreaterThan(files().length);
    expect(crawl.counts).toMatchObject({ unmappedUsers: 0, unmappedGroups: 0 });
    const there = readableThere(site.driveId);
    expect(await readableHere(site.id)).toEqual(there);
    // Not vacuously: some people read some files, some read none, nobody reads through a link.
    const counts = [...there.values()].map((list) => list.length);
    expect(Math.max(...counts)).toBeGreaterThan(0);
    expect(Math.min(...counts)).toBe(0);

    // Again, nothing changed: no grant is touched.
    const idle = await sync(site.id, { stateDir });
    expect(idle).toMatchObject({ status: "done", phase: "delta" });
    expect(idle.counts).toMatchObject({ grantsAdded: 0, grantsRevoked: 0 });

    // Permissions change at SharePoint: a file shared with one person only, a folder's
    // permissions replaced (and with them what everything inheriting from it allows), a file
    // whose sharing is taken away.
    const outsider = f.tenant.users.find(
      (u) => u.active && !u.guest && (there.get(u.id) as string[]).length === 0,
    ) as { id: string };
    const first = files()[0] as { id: string };
    const second = files()[1] as { id: string };
    store.setAcl(first.id, [{ principal: `user:${outsider.id}`, role: "write" }]);
    store.setAcl(second.id, []);
    const folder = store
      .inDrive(site.driveId)
      .find(
        (i) =>
          i.kind === "folder" &&
          store.inDrive(site.driveId).some((c) => c.parentId === i.id && c.kind === "file"),
      ) as { id: string };
    store.setAcl(folder.id, [{ principal: `user:${outsider.id}`, role: "read" }]);

    const read = f.sent.filter((r) => r.url.includes("/_download/")).length;
    const followed = await sync(site.id, { stateDir });
    expect(followed).toMatchObject({ status: "done", phase: "delta", skipped: [] });
    expect(followed.counts.grantsRevoked).toBeGreaterThan(0);
    expect(followed.counts.grantsAdded).toBeGreaterThan(0);
    // No file's bytes were read for a change of permissions.
    expect(f.sent.filter((r) => r.url.includes("/_download/")).length).toBe(read);
    const now = readableThere(site.driveId);
    expect(now).not.toEqual(there);
    expect((now.get(outsider.id) as string[]).length).toBeGreaterThan(0);
    expect(await readableHere(site.id)).toEqual(now);
  }, 600_000);

  it("grant nothing to people and groups nobody provisioned, and say how many", async () => {
    setUp(300);
    people = new Map();
    const site = f.tenant.sites[0] as { id: string; driveId: string };
    const report = await sync(site.id, { stateDir });
    expect(report).toMatchObject({ status: "done", skipped: [] });
    expect(report.counts.grantsAdded).toBe(0);
    expect(report.counts.unmappedGroups).toBeGreaterThan(0);
    const [row] = await db.withTenant(t.tenantId, (tx) => tx.select({ n: count() }).from(grants));
    // (The seeded tenant's own fixture grant aside.)
    expect(Number(row?.n)).toBeLessThanOrEqual(1);
  }, 240_000);
});
