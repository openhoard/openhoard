import { facets, facetValues, type Database, type Tx } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { createUser, grantAdmin } from "@openhoard/core-identity";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { proposeTag } from "./tagging.js";
import { markProcessed, VIEW_TRANSACTION } from "./visibility.js";
import { tenantVocabulary, VocabularyError } from "./vocabulary.js";

/* T-903: the vocabulary as a tenant's admins see it. */

let db: Database;
let t: SeededTenant;
let admin: string;
const inTenant = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work);
const view = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work, VIEW_TRANSACTION);

beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  admin = (
    await inTenant((tx) =>
      createUser(tx, t.tenantId, {
        email: "ada@example.com",
        displayName: "Ada",
        source: "local",
        kind: "member",
      }),
    )
  ).id;
  await inTenant(async (tx) => {
    await grantAdmin(tx, t.tenantId, admin, "system:admin-cli");
    await markProcessed(tx, t.tenantId, { versionId: t.versionId, title: "Report 1.docx" });
    await tx
      .insert(facets)
      .values({ tenantId: t.tenantId, key: "sensitivity", label: "Sensitivity", single: true });
    await tx.insert(facetValues).values([
      { tenantId: t.tenantId, facet: "client", value: "globex", label: "Globex", approved: true },
      {
        tenantId: t.tenantId,
        facet: "sensitivity",
        value: "restricted",
        label: "Restricted",
        approved: true,
        visibility: "hidden",
        exposure: "local-only",
      },
    ]);
  });
});
afterEach(() => db?.close());

describe("the tenant's vocabulary (T-903)", () => {
  it("is every facet and value, with what a value does and how many items propose it", async () => {
    // A model proposes a value the vocabulary doesn't have, and one it has.
    for (const tag of ["client:umbrella", "client:globex"]) {
      await inTenant((tx) =>
        proposeTag(
          tx,
          t.tenantId,
          { objectId: t.objectId, tag, source: "model", appliedBy: "model:x", confidence: 0.4 },
          { review: "agent" },
        ),
      );
    }
    const v = await view((tx) => tenantVocabulary(tx, t.tenantId, { userId: admin }));
    expect(v.cut).toBe(false);
    const keys = v.facets.map((f) => f.key);
    expect(keys).toEqual([...keys].sort());
    const client = v.facets.find((f) => f.key === "client");
    expect(client?.values.map((x) => [x.tag, x.approved, x.waiting])).toEqual([
      // The seeded tenant's own value: nothing proposes it.
      ["client:acme-1", true, 0],
      ["client:globex", true, 1],
      ["client:umbrella", false, 1],
    ]);
    const sensitivity = v.facets.find((f) => f.key === "sensitivity");
    expect(sensitivity).toMatchObject({ label: "Sensitivity", single: true });
    expect(sensitivity?.values).toEqual([
      {
        value: "restricted",
        tag: "sensitivity:restricted",
        label: "Restricted",
        approved: true,
        visibility: "hidden",
        exposure: "local-only",
        waiting: 0,
      },
    ]);
    // Nothing of any file is in it.
    expect(JSON.stringify(v)).not.toContain(t.objectId);
    expect(JSON.stringify(v)).not.toContain("Report 1");
  });

  it("is for tenant admins only", async () => {
    for (const userId of [t.userId, "usr_nobody", ""]) {
      await expect(
        view((tx) => tenantVocabulary(tx, t.tenantId, { userId })),
      ).rejects.toBeInstanceOf(VocabularyError);
    }
    // Another tenant's admin is not this one's, and sees only their own.
    const other = await seedTenant(db, 2);
    await expect(
      db.withTenant(
        other.tenantId,
        (tx) => tenantVocabulary(tx, other.tenantId, { userId: admin }),
        VIEW_TRANSACTION,
      ),
    ).rejects.toBeInstanceOf(VocabularyError);
  });

  it("reads one snapshot", async () => {
    await expect(
      inTenant((tx) => tenantVocabulary(tx, t.tenantId, { userId: admin })),
    ).rejects.toThrow(/repeatable read/i);
  });
});
