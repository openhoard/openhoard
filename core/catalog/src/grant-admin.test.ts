import { auditEvents, grants, type Database, type Tx } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { giveTagGrant, listTagGrants, takeTagGrant } from "./grant-admin.js";

let db: Database;
let t: SeededTenant;
const BY = "system:admin-cli";
const inTenant = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work);
const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { code?: string }) => e.code ?? String(e),
  );
const audit = async () =>
  (
    await inTenant((tx) =>
      tx
        .select({ action: auditEvents.action, actor: auditEvents.actor, event: auditEvents.event })
        .from(auditEvents)
        .where(inArray(auditEvents.action, ["grant.add", "grant.revoke"]))
        .orderBy(auditEvents.seq),
    )
  ).map((r) => ({
    action: r.action,
    actor: r.actor,
    detail: (JSON.parse(r.event) as { detail: unknown }).detail,
  }));

beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
});
afterEach(() => db?.close());

describe("grants an admin makes on a tag", () => {
  it("gives a role on a tag, lists it, takes it back, each audited", async () => {
    const ana = `user:${t.userId}`;
    const seeded = (await inTenant((tx) => listTagGrants(tx, t.tenantId))).total;
    const made = await inTenant((tx) =>
      giveTagGrant(tx, t.tenantId, { principal: ana, role: "write", tag: t.tag, by: BY }),
    );
    expect(made).toMatchObject({ principal: ana, role: "write", tag: t.tag, grantedBy: BY });
    // The default expiry, about 90 days out.
    const days = ((made.expiresAt?.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);

    const mine = await inTenant((tx) => listTagGrants(tx, t.tenantId, { principal: ana }));
    expect(mine).toMatchObject({ total: 1, grants: [{ id: made.id, tag: t.tag }] });
    expect((await inTenant((tx) => listTagGrants(tx, t.tenantId))).total).toBe(seeded + 1);

    const taken = await inTenant((tx) =>
      takeTagGrant(tx, t.tenantId, { grantId: made.id, by: BY }),
    );
    expect(taken).toMatchObject({ id: made.id, principal: ana });
    expect((await inTenant((tx) => listTagGrants(tx, t.tenantId, { principal: ana }))).total).toBe(
      0,
    );
    // One that has ended is no live grant: not listed, not there to take back.
    const lapsed = await inTenant(async (tx) => {
      const g = await giveTagGrant(tx, t.tenantId, {
        principal: ana,
        role: "read",
        tag: t.tag,
        by: BY,
      });
      await tx
        .update(grants)
        .set({ createdAt: new Date(Date.now() - 2000), expiresAt: new Date(Date.now() - 1000) })
        .where(eq(grants.id, g.id));
      return g.id;
    });
    expect((await inTenant((tx) => listTagGrants(tx, t.tenantId, { principal: ana }))).total).toBe(
      0,
    );
    expect(
      await code(inTenant((tx) => takeTagGrant(tx, t.tenantId, { grantId: lapsed, by: BY }))),
    ).toBe("not-found");
    // Once: it is no live grant any more.
    expect(
      await code(inTenant((tx) => takeTagGrant(tx, t.tenantId, { grantId: made.id, by: BY }))),
    ).toBe("not-found");
    expect(await audit()).toMatchObject([
      {
        action: "grant.add",
        actor: BY,
        detail: { grant: made.id, principal: ana, role: "write", tag: t.tag },
      },
      { action: "grant.revoke", actor: BY, detail: { grant: made.id, principal: ana } },
      { action: "grant.add", actor: BY, detail: { grant: lapsed, role: "read" } },
    ]);
  });

  it("gives one that never ends only when told to, and none that ended already", async () => {
    const group = `group:${t.groupId}`;
    const forever = await inTenant((tx) =>
      giveTagGrant(tx, t.tenantId, {
        principal: group,
        role: "write",
        tag: t.tag,
        expiresAt: null,
        by: BY,
      }),
    );
    expect(forever.expiresAt).toBeNull();
    expect(
      await code(
        inTenant((tx) =>
          giveTagGrant(tx, t.tenantId, {
            principal: `user:${t.userId}`,
            role: "read",
            tag: t.tag,
            expiresAt: new Date(Date.now() - 1000),
            by: BY,
          }),
        ),
      ),
    ).toBe("invalid");
  });

  it("refuses what isn't one, a second of the same, and leaves nothing behind", async () => {
    const ana = `user:${t.userId}`;
    const give = (more: Record<string, unknown>) =>
      code(
        inTenant((tx) =>
          giveTagGrant(tx, t.tenantId, {
            principal: ana,
            role: "read",
            tag: t.tag,
            by: BY,
            ...more,
          } as never),
        ),
      );
    expect(await give({ role: "owner" })).toBe("invalid");
    expect(await give({ tag: "no-colon" })).toBe("invalid");
    expect(await give({ tag: "client:nobody" })).toBe("unapproved-tag");
    expect(await give({ principal: "user:usr_00000000000000000000000000" })).toBe(
      "unknown-principal",
    );
    expect(await give({ principal: "everyone" })).toBe("invalid");
    // The detector's flag is on files across every source: nobody is let in by it.
    expect(await give({ tag: "risk:injection" })).toBe("invalid");
    expect(await give({})).toBe("ok");
    // The same role on the same tag again: said, not doubled. Another role is another grant.
    expect(await give({})).toBe("exists");
    expect(await give({ role: "write" })).toBe("ok");
    const held = await inTenant((tx) => listTagGrants(tx, t.tenantId, { principal: ana }));
    expect(held.grants.map((g) => g.role).sort()).toEqual(["read", "write"]);
    expect(await audit()).toHaveLength(2);
  });

  it("leaves a source's grants to the source: not listed, not taken back", async () => {
    const ana = `user:${t.userId}`;
    const id = await inTenant(async (tx) => {
      const made = await giveTagGrant(tx, t.tenantId, {
        principal: ana,
        role: "read",
        tag: t.tag,
        by: BY,
      });
      await tx.update(grants).set({ grantedBy: "source:sharepoint" }).where(eq(grants.id, made.id));
      return made.id;
    });
    expect((await inTenant((tx) => listTagGrants(tx, t.tenantId, { principal: ana }))).total).toBe(
      0,
    );
    expect(
      await code(inTenant((tx) => takeTagGrant(tx, t.tenantId, { grantId: id, by: BY }))),
    ).toBe("imported");
    // A person may hold the same from a source and from an admin: the source's is no twin.
    expect(
      await code(
        inTenant((tx) =>
          giveTagGrant(tx, t.tenantId, { principal: ana, role: "read", tag: t.tag, by: BY }),
        ),
      ),
    ).toBe("ok");
    // Another tenant's grant is nobody's here.
    const other = await seedTenant(db, 2);
    expect(
      await code(
        db.withTenant(other.tenantId, (tx) =>
          takeTagGrant(tx, other.tenantId, { grantId: id, by: BY }),
        ),
      ),
    ).toBe("not-found");
  });
});
