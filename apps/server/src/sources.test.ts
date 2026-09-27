import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAudit } from "@openhoard/core-audit";
import { readExtract } from "@openhoard/core-catalog";
import { newId, objects, sourceRefs, versions, zones, type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { createUser, lockUser, retireUser, type User } from "@openhoard/core-identity";
import { listSourceSyncs, startJobs, type Jobs } from "@openhoard/core-jobs";
import { and, eq, isNotNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, loadConfig } from "./config.js";
import { ownerOf, prepareSources } from "./sources.js";
import { blobsIn, tenantKeyStore } from "./tenant-keys.js";

/*
 * T-303 in the server: configured folders become zones, bindings and scheduled syncs; the
 * owner reads what they sync; content is read only where a source opts in. And the tenant
 * blob keys kept in the data directory.
 */

let db: Database;
let t: SeededTenant;
let steve: User;
let base: string;
let dataDir: string;
let root: string;
const started: Jobs[] = [];
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  steve = await db.withTenant(t.tenantId, (tx) =>
    createUser(tx, t.tenantId, {
      email: "steve@example.com",
      displayName: "Steve",
      source: "local",
    }),
  );
  base = mkdtempSync(join(tmpdir(), "oh-sources-"));
  dataDir = join(base, "data");
  root = join(base, "Documents");
  mkdirSync(dataDir);
  mkdirSync(root);
});
afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop({ timeoutMs: 1_000 });
  await db?.close();
  rmSync(base, { recursive: true, force: true, maxRetries: 5 });
});

const source = (more: Record<string, unknown> = {}) => ({
  id: "fs-docs",
  connector: "fs",
  tenantId: t.tenantId,
  root,
  zone: "Steve's documents",
  owner: "steve@example.com",
  ...more,
});
const configOf = (...sources: Record<string, unknown>[]) =>
  ConfigSchema.parse({ dataDir, sources });
const prepare = (...sources: Record<string, unknown>[]) =>
  prepareSources(db, configOf(...sources), { tenantKey: keys() });
/** A key store for the tests' tenant, which starts with no key file (its blob is the seed's). */
const keys = (hasContent = false) =>
  tenantKeyStore(dataDir, { hasContent: async () => hasContent });
const zoneRows = () =>
  db.withTenant(t.tenantId, (tx) =>
    tx.select().from(zones).where(eq(zones.name, "Steve's documents")),
  );

async function waitFor<T>(probe: () => Promise<T | null | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + (process.platform === "win32" ? 150_000 : 40_000);
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

// Each test migrates a database, and one crawls folders and runs enrichment through pg-boss:
// minutes on the Windows runner.
describe("configured sources", { timeout: process.platform === "win32" ? 600_000 : 90_000 }, () => {
  it("make their zone once (audited) and bind the source to it", async () => {
    const first = await prepare(source());
    expect(first.scheduled).toHaveLength(1);
    expect(first.scheduled[0]).toMatchObject({ source: "fs-docs", cron: "*/15 * * * *" });
    expect(first.content).toBeNull();
    const [zone] = await zoneRows();
    expect(zone).toMatchObject({ kind: "indexed" });
    expect(first.scheduled[0]?.zoneId).toBe(zone?.id);
    const syncs = await db.withTenant(t.tenantId, (tx) => listSourceSyncs(tx, t.tenantId));
    expect(syncs).toMatchObject([
      { source: "fs-docs", zoneId: zone?.id, connector: "connector-fs" },
    ]);
    // Again (a restart): the same zone, nothing new.
    const again = await prepare(source({ schedule: "0 * * * *" }));
    expect(again.scheduled[0]).toMatchObject({ zoneId: zone?.id, cron: "0 * * * *" });
    expect(await zoneRows()).toHaveLength(1);
    const lines: string[] = [];
    await exportAudit(db, t.tenantId, {}, "ndjson", (s: string) => void lines.push(s));
    expect(lines.join("").match(/"zone\.create"/g)).toHaveLength(1);
  });

  it("refuse a source moved to another zone, a zone that isn't indexed, an unknown tenant", async () => {
    await prepare(source());
    await expect(prepare(source({ zone: "Elsewhere" }))).rejects.toThrow(/another zone/);
    await db.withTenant(t.tenantId, (tx) =>
      tx
        .insert(zones)
        .values({ tenantId: t.tenantId, id: newId("zone"), kind: "managed", name: "M" }),
    );
    await expect(prepare(source({ id: "fs-m", zone: "M" }))).rejects.toThrow(/managed zone/);
    await expect(prepare(source({ id: "fs-x", tenantId: newId("tenant") }))).rejects.toThrow(
      /no tenant/,
    );
    // A root the connector refuses (relative, here via a hand-made config) names the source.
    await expect(
      prepareSources(
        db,
        { dataDir, sources: [{ ...configOf(source()).sources[0], root: "relative" } as never] },
        { tenantKey: keys() },
      ),
    ).rejects.toThrow(/sources fs-docs: root must be an absolute path/);
  });

  it("resolve their owner to an active member only, and pin that person", async () => {
    // Each call names a source of its own: the first resolution pins it.
    let n = 0;
    const bind = async () => {
      const name = `fs-${++n}`;
      await prepare(source({ id: name, root: join(base, name), zone: "Owners" }));
      return name;
    };
    const owner = async (o: string, name?: string) =>
      ownerOf(db, { tenantId: t.tenantId, owner: o, source: name ?? (await bind()) });
    expect(await owner("steve@example.com")).toBe(`user:${steve.id}`);
    expect(await owner("STEVE@example.com")).toBe(`user:${steve.id}`);
    expect(await owner(steve.id)).toBe(`user:${steve.id}`);
    expect(await owner("nobody@example.com")).toBeNull();
    const guest = await db.withTenant(t.tenantId, (tx) =>
      createUser(tx, t.tenantId, {
        email: "g@example.com",
        displayName: "G",
        kind: "guest",
        source: "local",
      }),
    );
    expect(await owner(guest.id)).toBeNull();
    // Pinned: Steve leaves, and his address goes to someone new, who never owns the source.
    const pinned = await bind();
    expect(await owner("steve@example.com", pinned)).toBe(`user:${steve.id}`);
    await db.withTenant(t.tenantId, (tx) => retireUser(tx, t.tenantId, steve.id, "system:test"));
    const newcomer = await db.withTenant(t.tenantId, (tx) =>
      createUser(tx, t.tenantId, { email: "steve@example.com", displayName: "N", source: "local" }),
    );
    expect(await owner("steve@example.com", pinned)).toBeNull();
    // And a configuration naming the newcomer for that source is refused at start.
    await expect(
      prepare(source({ id: pinned, root: join(base, pinned), zone: "Owners" })),
    ).rejects.toThrow(/its owner is .* since its first run/);
    expect(await owner(newcomer.id)).toBe(`user:${newcomer.id}`);
    await db.withTenant(t.tenantId, (tx) => lockUser(tx, t.tenantId, newcomer.id, "system:test"));
    expect(await owner(newcomer.id)).toBeNull();
  });

  it("sync on schedule into the owner's files, and extract text only where opted in", async () => {
    writeFileSync(join(root, "plan.txt"), "The garden plan: tomatoes by the fence.");
    mkdirSync(join(base, "Other"));
    writeFileSync(join(base, "Other", "list.txt"), "Groceries: eggs.");
    const tenantKey = keys();
    const sources = await prepareSources(
      db,
      configOf(
        source({ extract: true }),
        source({ id: "fs-other", root: join(base, "Other"), zone: "Other" }),
      ),
      { tenantKey },
    );
    expect(sources.content).not.toBeNull();
    const stale: string[] = [];
    sources.onStale((_t, s) => stale.push(s));
    const jobs = await startJobs(db, {
      pollingIntervalSeconds: 0.5,
      maintenance: false,
      ...(sources.content ? { content: sources.content } : {}),
      extract: { indexedZones: true },
      sync: { sources: sources.scheduled, tenantKey },
    });
    started.push(jobs);
    const processed = await waitFor(async () => {
      const rows = await db.withTenant(t.tenantId, (tx) =>
        tx
          .select({ id: versions.id, objectId: versions.objectId, source: sourceRefs.source })
          .from(versions)
          .innerJoin(
            sourceRefs,
            and(
              eq(sourceRefs.tenantId, versions.tenantId),
              eq(sourceRefs.objectId, versions.objectId),
            ),
          )
          .where(and(eq(versions.tenantId, t.tenantId), isNotNull(versions.processedAt))),
      );
      const mine = rows.filter((r) => r.source !== "sharepoint");
      return mine.length >= 2 ? mine : null;
    }, "both files processed");
    const extractOf = (s: string) => {
      const v = processed.find((r) => r.source === s);
      return db.withTenant(t.tenantId, (tx) => readExtract(tx, t.tenantId, v?.id ?? ""));
    };
    expect(await extractOf("fs-docs")).toMatchObject({
      status: "extracted",
      text: expect.stringContaining("tomatoes by the fence") as unknown,
    });
    // Not opted in: no source reaches its bytes.
    expect(await extractOf("fs-other")).toMatchObject({ status: "unavailable", text: "" });
    // Owned by the configured owner, who reads them.
    const owners = await db.withTenant(t.tenantId, (tx) =>
      tx
        .select({ ownerId: objects.ownerId })
        .from(objects)
        .innerJoin(
          sourceRefs,
          and(eq(sourceRefs.tenantId, objects.tenantId), eq(sourceRefs.objectId, objects.id)),
        )
        .where(eq(sourceRefs.source, "fs-docs")),
    );
    expect(owners).toEqual([{ ownerId: `user:${steve.id}` }]);
    expect(stale).toEqual([]);
  });
});

describe("tenant blob keys", () => {
  it("are made once, kept, and never replaced by something that isn't a key", async () => {
    const one = await keys()(t.tenantId);
    expect(one.byteLength).toBe(32);
    // Another process (another store) reads the same key, content or not.
    expect(await keys(true)(t.tenantId)).toEqual(one);
    const file = join(dataDir, "keys", `${t.tenantId}.blob-key`);
    expect(readFileSync(file, "utf8").trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Nothing but the key is left behind (the file it was written to first).
    expect(readdirSync(join(dataDir, "keys"))).toEqual([`${t.tenantId}.blob-key`]);
    const other = newId("tenant");
    writeFileSync(join(dataDir, "keys", `${other}.blob-key`), "garbage");
    await expect(keys()(other)).rejects.toThrow(/is not a tenant key/);
    await expect(keys()("ten_bad")).rejects.toThrow(TypeError);
  });

  it("are never made anew for a tenant with content: the lost one must be restored", async () => {
    await expect(keys(true)(t.tenantId)).rejects.toThrow(/is missing.*restore the file/);
    expect(existsSync(join(dataDir, "keys", `${t.tenantId}.blob-key`))).toBe(false);
    // From the database: the seeded tenant has a blob, a new one has none.
    expect(await blobsIn(db)(t.tenantId)).toBe(true);
    expect(await blobsIn(db)(newId("tenant"))).toBe(false);
  });
});

describe("the sources config", () => {
  const parse = (s: Record<string, unknown>, more: Record<string, unknown> = {}) =>
    ConfigSchema.safeParse({ dataDir: join(base, "data"), sources: [s], ...more });
  const issues = (r: ReturnType<typeof parse>) => JSON.stringify(r.error?.issues ?? []);

  it("takes a folder, with defaults", () => {
    const r = parse(source());
    expect(r.success, issues(r)).toBe(true);
    expect(r.data?.sources[0]).toMatchObject({ schedule: "*/15 * * * *", extract: false });
  });

  it("refuses shares, relative paths, the data directory inside, bad schedules and typos", () => {
    const unc = parse(source({ root: "//server/share/docs" }));
    expect(unc.success).toBe(false);
    expect(issues(unc)).toContain("network share");
    expect(parse(source({ root: "docs" })).success).toBe(false);
    const inside = parse(source({ root: base }));
    expect(issues(inside)).toContain("can't be inside one another");
    // The other way round: a source inside the data directory (its keys, say).
    expect(issues(parse(source({ root: join(dataDir, "keys") })))).toContain(
      "can't be inside one another",
    );
    // Through a link (a junction on Windows) to the data directory.
    const link = join(base, "via-link");
    symlinkSync(dataDir, link, "junction");
    expect(issues(parse(source({ root: join(link, "keys") })))).toContain(
      "can't be inside one another",
    );
    expect(parse(source({ schedule: "every day" })).success).toBe(false);
    expect(parse(source({ connector: "sharepoint" })).success).toBe(false);
    expect(parse(source({ rooot: root })).success).toBe(false);
    expect(parse(source({ id: "Docs" })).success).toBe(false);
    const twice = ConfigSchema.safeParse({ dataDir, sources: [source(), source()] });
    expect(JSON.stringify(twice.error?.issues)).toContain("duplicate source fs-docs");
  });

  it("is read from config.json like the rest", () => {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ sources: [source()] }));
    const config = loadConfig({ OPENHOARD_DATA_DIR: dataDir }, base);
    expect(config.sources.map((s) => s.id)).toEqual(["fs-docs"]);
  });
});
