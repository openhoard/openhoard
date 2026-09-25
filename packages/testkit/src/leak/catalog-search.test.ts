import {
  blobs,
  facets,
  facetValues,
  grants,
  newId,
  objects,
  objectTags,
  tenants,
  versions,
  zones,
  type Database,
  type Tx,
} from "@openhoard/core-db";
import { openTestDatabase } from "@openhoard/core-db/testing";
import {
  searchObjects,
  suggestTitles,
  VIEW_TRANSACTION,
  type ViewRequest,
} from "@openhoard/core-catalog";
import {
  addMember,
  createGroup,
  createUser,
  lockUser,
  resolvePrincipal,
} from "@openhoard/core-identity";
import { Authorizer, createCedarEngine } from "@openhoard/core-policy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateTenant } from "../tenant/generate.js";
import type { FakeTenant } from "../tenant/types.js";
import { assertNoLeaks, runLeakHarness } from "./harness.js";
import type { SearchUnderTest } from "./types.js";

/*
 * T-504 against the real thing: a fake tenant imported into the database the way a correct
 * permission import would (source ACLs as object grants, sites' groups as groups, guests as
 * guest users, sharing links as nothing), then core/catalog searchObjects() probed by the
 * leak harness as each user, whose principal core/identity resolves from the database.
 *
 * Files are owned by a local account the harness never probes, so the owner permit can't hide
 * a leak, and the tenant's default level is hidden: what a member may find is exactly what the
 * ACLs let them read, which is the harness's ground truth.
 */

let db: Database;
let tenant: FakeTenant;
let tenantId: string;
const userIds = new Map<string, string>(); // fake user id → database user id
const itemIds = new Map<string, string>(); // database object id → fake item id

const chunks = <T>(list: readonly T[], size = 500): T[][] =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, n) =>
    list.slice(n * size, (n + 1) * size),
  );

beforeAll(async () => {
  tenant = generateTenant({ items: 600, seed: "catalog-search" });
  db = await openTestDatabase();
  tenantId = newId("tenant");
  const zoneId = newId("zone");
  await db.withTenant(tenantId, async (tx) => {
    await tx.insert(tenants).values({ id: tenantId, name: "Fake", defaultVisibility: "hidden" });
    await tx.insert(zones).values({ tenantId, id: zoneId, kind: "indexed", name: "SharePoint" });

    for (const u of tenant.users) {
      const user = await createUser(tx, tenantId, {
        email: u.upn,
        displayName: u.displayName,
        kind: u.guest ? "guest" : "member",
        source: "local",
      });
      userIds.set(u.id, user.id);
    }
    const owner = await createUser(tx, tenantId, {
      email: "import@hoard.test",
      displayName: "Import",
      source: "local",
    });
    const groupIds = new Map<string, string>();
    for (const g of tenant.groups) {
      const group = await createGroup(tx, tenantId, { name: g.displayName, source: "local" });
      groupIds.set(g.id, group.id);
      for (const m of g.members) {
        await addMember(tx, tenantId, group.id, userIds.get(m) as string, "local");
      }
    }
    const guestByUpn = new Map(
      tenant.users.filter((u) => u.guest).map((u) => [u.upn, userIds.get(u.id) as string]),
    );
    const principalOf = (p: string): string | undefined => {
      if (p.startsWith("user:")) return `user:${userIds.get(p.slice(5)) as string}`;
      if (p.startsWith("group:")) return `group:${groupIds.get(p.slice(6)) as string}`;
      if (p.startsWith("guest:")) {
        const id = guestByUpn.get(p.slice(6));
        return id === undefined ? undefined : `user:${id}`;
      }
      return undefined; // anyone-with-link: a link is not a principal
    };

    const labels = new Map<string, Set<string>>();
    const files = tenant.items.filter((i) => i.kind === "file");
    const objectRows = [];
    const versionRows = [];
    const blobRows = [];
    const tagRows = [];
    const grantRows = [];
    for (const [n, item] of files.entries()) {
      const objectId = newId("object");
      itemIds.set(objectId, item.id);
      const blobId = `b3t:${n.toString(16).padStart(64, "0")}`;
      blobRows.push({ tenantId, id: blobId, size: item.size });
      objectRows.push({
        tenantId,
        id: objectId,
        zoneId,
        title: item.name,
        ownerId: `user:${owner.id}`,
      });
      versionRows.push({
        tenantId,
        id: newId("version"),
        objectId,
        seq: 1,
        blobId,
        mime: item.mime,
        processedAt: new Date(),
      });
      for (const label of new Set(item.labels)) {
        const [facet, value] = label.split(":") as [string, string];
        if (!value) continue;
        (labels.get(facet) ?? labels.set(facet, new Set()).get(facet))?.add(value);
        tagRows.push({
          tenantId,
          objectId,
          facet,
          value,
          source: "rule" as const,
          appliedBy: "rule:import",
          confidence: 1,
        });
      }
      for (const principal of new Set(item.acl.map((a) => principalOf(a.principal)))) {
        if (principal === undefined) continue;
        grantRows.push({
          tenantId,
          id: newId("grant"),
          principal,
          role: "read" as const,
          objectId,
          grantedBy: "system:import",
          expiresAt: null,
        });
      }
    }
    await tx
      .insert(facets)
      .values(
        [...labels.keys()].map((key) => ({ tenantId, key, label: key, public: key === "type" })),
      );
    await tx
      .insert(facetValues)
      .values(
        [...labels].flatMap(([facet, values]) =>
          [...values].map((value) => ({ tenantId, facet, value, label: value, approved: true })),
        ),
      );
    for (const rows of chunks(blobRows)) await tx.insert(blobs).values(rows);
    for (const rows of chunks(objectRows)) await tx.insert(objects).values(rows);
    for (const rows of chunks(versionRows)) await tx.insert(versions).values(rows);
    for (const rows of chunks(tagRows)) await tx.insert(objectTags).values(rows);
    for (const rows of chunks(grantRows)) await tx.insert(grants).values(rows);

    // People who have left keep their grants on record but can't sign in.
    for (const u of tenant.users.filter((u) => !u.active)) {
      await lockUser(tx, tenantId, userIds.get(u.id) as string, "system:import");
    }
  });
}, 120_000);
afterAll(() => db?.close());

const authz = new Authorizer(createCedarEngine());

/**
 * searchObjects() and suggestTitles() as the harness drives them: the caller's principal comes
 * from the database. `widen` adds grants the caller doesn't hold, to show the harness catches a
 * leak.
 */
const searchAs = (widen: readonly string[] = []): SearchUnderTest => {
  const as = <T>(userId: string, work: (tx: Tx, request: ViewRequest) => Promise<T>) =>
    db.withTenant(
      tenantId,
      async (tx) => {
        const principal = await resolvePrincipal(tx, tenantId, userIds.get(userId) as string);
        if (!principal) throw new Error(`no principal for ${userId}`);
        return work(tx, {
          principal: { ...principal, objectGrants: [...principal.objectGrants, ...widen] },
          client: { id: "openhoard-web", trust: "first-party" },
        });
      },
      VIEW_TRANSACTION,
    );
  return {
    search: (r) =>
      as(r.userId, async (tx, request) => {
        const result = await searchObjects(tx, tenantId, authz, request, {
          query: r.query,
          limit: Math.min(r.limit ?? 20, 100),
        });
        return {
          hits: result.hits.map((view) => ({
            id: itemIds.get(view.id) ?? view.id,
            title: view.title,
            card: { ...view },
          })),
          total: result.total,
          facets: result.facets,
        };
      }),
    autocomplete: (r) =>
      as(r.userId, (tx, request) =>
        suggestTitles(tx, tenantId, authz, request, {
          prefix: r.prefix,
          limit: Math.min(r.limit ?? 10, 50),
        }),
      ),
  };
};

describe("searchObjects and suggestTitles under the leak harness (T-504, T-505)", () => {
  it("leaks nothing through results, totals, facets, suggestions or card text, and finds what callers may read", async () => {
    const report = await runLeakHarness({ tenant, target: searchAs(), sampleUsers: 8 });
    assertNoLeaks(report);
    expect(report.canaries).toBeGreaterThan(0);
    expect(report.found).toBeGreaterThan(0);
    // Every canary a caller may read is found: no pack permits here, so option 1 misses none.
    expect(report.found).toBe(report.readableCanaryProbes);
  }, 240_000);

  it("catches a caller given grants they don't hold (the wiring can see a leak)", async () => {
    const report = await runLeakHarness({
      tenant,
      target: searchAs([...itemIds.keys()]),
      sampleUsers: 2,
    });
    const surfaces = new Set(report.leaks.map((l) => l.surface));
    for (const surface of ["results", "total", "facets", "autocomplete", "text"] as const)
      expect(surfaces).toContain(surface);
    expect(() => assertNoLeaks(report)).toThrow(/permission leak/);
  }, 240_000);
});
