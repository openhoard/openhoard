import { fromDriver, prepareDriver, type Database, type Driver } from "./database.js";
import { newId } from "./ids.js";
import { openPglite } from "./pglite.js";
import {
  blobs,
  facets,
  facetValues,
  objects,
  objectTags,
  sourceRefs,
  tenants,
  versions,
  zones,
} from "./schema.js";

/*
 * Test databases for this package and the packages built on it:
 *
 *   import { openTestDatabase } from "@openhoard/core-db/testing";
 *   const db = await openTestDatabase(); // migrated, empty
 *   afterEach(() => db.close());
 *
 * By default each one is a fresh in-memory PGlite. Set OPENHOARD_TEST_POSTGRES_URL to a native
 * PostgreSQL 17+ server (an ordinary user with CREATEDB, not a superuser) to run the same tests
 * there: each database is then created with the required locale and dropped on close.
 */

export const TEST_POSTGRES_ENV = "OPENHOARD_TEST_POSTGRES_URL";

/** A migrated, empty database for one test. */
export async function openTestDatabase(): Promise<Database> {
  return fromDriver(await openTestDriver());
}

/**
 * Like {@link openTestDatabase}, but returns the driver itself, for this package's own tests,
 * which look at the database from outside withTenant().
 */
export async function openTestDriver(): Promise<Driver> {
  const server = process.env[TEST_POSTGRES_ENV];
  if (server) {
    const { createPostgresDatabase } = await import("./testing-postgres.js");
    const driver = await createPostgresDatabase(server);
    await prepareDriver(driver, { migrate: true });
    return driver;
  }
  // Starting PGlite and migrating takes seconds; loading a migrated snapshot takes a fraction
  // of that. One snapshot per test worker, taken on first use.
  snapshot ??= (async () => {
    const template = await openPglite({});
    try {
      await prepareDriver(template, { migrate: true });
      return await template.dump();
    } finally {
      await template.close();
    }
  })();
  const driver = await openPglite({ snapshot: await snapshot });
  await prepareDriver(driver, { migrate: false });
  return driver;
}

let snapshot: Promise<Blob> | undefined;

export interface SeededTenant {
  tenantId: string;
  zoneId: string;
  blobId: string;
  objectId: string;
  versionId: string;
  externalId: string;
  /** The object's one tag, `client:acme-<n>`, an approved value. */
  tag: string;
}

/**
 * Creates a tenant with one row in every table: a zone, a blob, an object with one version, the
 * object's source reference, and one tag on it from a one-value vocabulary. `n` makes names and hashes distinct between seeded tenants.
 */
export async function seedTenant(db: Database, n = 0): Promise<SeededTenant> {
  const s: SeededTenant = {
    tenantId: newId("tenant"),
    zoneId: newId("zone"),
    blobId: `b3t:${n.toString(16).padStart(64, "0")}`,
    objectId: newId("object"),
    versionId: newId("version"),
    externalId: `item-${n}`,
    tag: `client:acme-${n}`,
  };
  await db.withTenant(s.tenantId, async (tx) => {
    await tx.insert(tenants).values({ id: s.tenantId, name: `Tenant ${n}` });
    await tx
      .insert(zones)
      .values({ tenantId: s.tenantId, id: s.zoneId, kind: "indexed", name: "SharePoint" });
    await tx.insert(blobs).values({ tenantId: s.tenantId, id: s.blobId, size: 1234 });
    await tx.insert(objects).values({
      tenantId: s.tenantId,
      id: s.objectId,
      zoneId: s.zoneId,
      title: `Report ${n}.docx`,
      ownerId: `user:owner-${n}`,
    });
    await tx.insert(versions).values({
      tenantId: s.tenantId,
      id: s.versionId,
      objectId: s.objectId,
      seq: 1,
      blobId: s.blobId,
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      authorId: `user:owner-${n}`,
    });
    await tx.insert(sourceRefs).values({
      tenantId: s.tenantId,
      source: "sharepoint",
      externalId: s.externalId,
      objectId: s.objectId,
    });
    await tx.insert(facets).values({ tenantId: s.tenantId, key: "client", label: "Client" });
    await tx.insert(facetValues).values({
      tenantId: s.tenantId,
      facet: "client",
      value: `acme-${n}`,
      label: `Acme ${n}`,
      approved: true,
    });
    await tx.insert(objectTags).values({
      tenantId: s.tenantId,
      objectId: s.objectId,
      facet: "client",
      value: `acme-${n}`,
      source: "rule",
      appliedBy: "rule:client-dictionary",
      confidence: 1,
    });
  });
  return s;
}
