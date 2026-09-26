import { appendAudit, verifyAudit } from "@openhoard/core-audit";
import { newId, scimTokens, type Database, type Tx } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdentityError } from "./directory.js";
import {
  checkScimToken,
  issueScimToken,
  listScimTokens,
  parseScimToken,
  pruneScimTokens,
  revokeScimToken,
  SCIM_TOKEN_MAX_DAYS,
  scimActor,
  touchScimToken,
  type ScimTokenInput,
} from "./scim-tokens.js";

/* T-103: the tenant's SCIM bearer tokens: hashed, shown once, expiring, revocable. */

let db: Database;
let t: SeededTenant;
let other: SeededTenant;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  other = await seedTenant(db, 2);
});
afterEach(() => db?.close());

const write = <T>(work: (tx: Tx) => Promise<T>, tenantId = t.tenantId) =>
  db.withTenant(tenantId, work);
const days = (n: number) => new Date(Date.now() + n * 24 * 3600 * 1000);
const issue = (
  more: { [K in keyof ScimTokenInput]?: ScimTokenInput[K] | undefined } = {},
  tenantId = t.tenantId,
) =>
  write(
    (tx) =>
      issueScimToken(tx, tenantId, {
        name: "Entra provisioning",
        expiresAt: days(90),
        by: "system:admin-cli",
        ...more,
      } as ScimTokenInput),
    tenantId,
  );
const check = (token: string, tenantId = t.tenantId) =>
  write((tx) => checkScimToken(tx, tenantId, token), tenantId);
const identityCode = async (p: Promise<unknown>) =>
  p.then(
    () => "no error",
    (e: unknown) => (e instanceof IdentityError ? e.code : String(e)),
  );

describe("issuing", () => {
  it("returns the token once, names its tenant, and keeps only a hash", async () => {
    const issued = await issue();
    expect(issued.token).toMatch(
      new RegExp(`^ohscim\\.${t.tenantId}\\.${issued.id}\\.[A-Za-z0-9_-]{43}$`),
    );
    expect(issued).toMatchObject({
      name: "Entra provisioning",
      createdBy: "system:admin-cli",
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(parseScimToken(issued.token)).toEqual({ tenantId: t.tenantId, tokenId: issued.id });
    const [row] = await write((tx) => tx.select().from(scimTokens));
    const secret = issued.token.split(".").pop() as string;
    expect(row?.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(secret);
    const listed = await write((tx) => listScimTokens(tx, t.tenantId));
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("token");
    expect(JSON.stringify(listed)).not.toContain(secret);
  });

  it("refuses a bad name, admin or expiry", async () => {
    for (const name of ["", "  ", "x".repeat(201), "a\nb", 7 as unknown as string]) {
      expect(await identityCode(issue({ name }))).toBe("invalid");
    }
    for (const by of ["scim:sct_x", "admin", "", 1 as unknown as string]) {
      expect(await identityCode(issue({ by }))).toBe("invalid");
    }
    for (const expiresAt of [
      days(-1),
      days(SCIM_TOKEN_MAX_DAYS + 2),
      new Date(Number.NaN),
      "tomorrow" as unknown as Date,
    ]) {
      expect(await identityCode(issue({ expiresAt }))).toBe("invalid");
    }
    expect(await identityCode(issue({ expiresAt: days(SCIM_TOKEN_MAX_DAYS - 1) }))).toBe(
      "no error",
    );
    // Or a number of days, by the database's clock: a full year is fine.
    for (const n of [0, 366, 1.5, Number.NaN]) {
      expect(await identityCode(issue({ expiresAt: undefined, days: n }))).toBe("invalid");
    }
    expect(await identityCode(issue({ days: 30 }))).toBe("invalid");
    const year = await issue({ expiresAt: undefined, days: SCIM_TOKEN_MAX_DAYS });
    expect(year.expiresAt.getTime() - year.createdAt.getTime()).toBe(
      SCIM_TOKEN_MAX_DAYS * 24 * 3600 * 1000,
    );
  });

  it("lists newest first", async () => {
    const first = await issue({ name: "one" });
    const second = await issue({ name: "two" });
    const listed = await write((tx) => listScimTokens(tx, t.tenantId));
    expect(listed.map((k) => k.id)).toEqual([second.id, first.id]);
    expect(await write((tx) => listScimTokens(tx, other.tenantId), other.tenantId)).toEqual([]);
  });

  it("is held by the database too: a year at most, admins only", async () => {
    const raw = (values: Partial<Record<keyof typeof scimTokens.$inferInsert, unknown>>) =>
      write((tx) =>
        tx.insert(scimTokens).values({
          tenantId: t.tenantId,
          id: newId("scimToken"),
          name: "x",
          secretHash: "0".repeat(64),
          createdBy: "system:test",
          expiresAt: sql`now() + interval '1 day'`,
          ...values,
        } as typeof scimTokens.$inferInsert),
      );
    await expect(raw({ expiresAt: sql`now() + interval '367 days'` })).rejects.toThrow();
    await expect(raw({ createdBy: "scim:sct_x" })).rejects.toThrow();
    await expect(raw({ secretHash: "secret" })).rejects.toThrow();
    await expect(raw({ id: newId("apiKey") })).rejects.toThrow();
    await expect(raw({ revokedAt: sql`now()` })).rejects.toThrow();
    await expect(raw({})).resolves.toBeDefined();
  });
});

describe("checking", () => {
  it("accepts the token as scim:<token id>, and records its use at most once a minute", async () => {
    const issued = await issue();
    const ok = await check(issued.token);
    expect(ok).toEqual({
      ok: true,
      tokenId: issued.id,
      actor: scimActor(issued.id),
      stale: true,
    });
    expect(await write((tx) => touchScimToken(tx, t.tenantId, issued.id))).toBe(true);
    expect(await check(issued.token)).toMatchObject({ ok: true, stale: false });
    expect(await write((tx) => touchScimToken(tx, t.tenantId, issued.id))).toBe(false);
    const [listed] = await write((tx) => listScimTokens(tx, t.tenantId));
    expect(listed?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("says why a real token id was refused, and refuses anything else alike", async () => {
    const issued = await issue();
    const [, tenant, id, secret] = issued.token.split(".") as [string, string, string, string];
    const wrongSecret = `ohscim.${tenant}.${id}.${"A".repeat(43)}`;
    expect(await check(wrongSecret)).toEqual({
      ok: false,
      refused: { tokenId: issued.id, reason: "wrong-secret" },
    });
    // Another tenant's name on this token: it isn't a token there.
    const swapped = `ohscim.${other.tenantId}.${id}.${secret}`;
    expect(await check(swapped, other.tenantId)).toEqual({ ok: false, refused: null });
    // Checked against the wrong tenant, even the real token is nothing.
    expect(await check(issued.token, other.tenantId)).toEqual({ ok: false, refused: null });
    for (const junk of [
      "",
      "ohscim",
      `ohscim.${tenant}.${newId("scimToken")}.${secret}`,
      `ohs.${tenant}.${id}.${secret}`,
      `${issued.token}x`,
      42 as unknown as string,
    ]) {
      expect(await check(junk)).toEqual({ ok: false, refused: null });
    }
    expect(parseScimToken("ohscim.ten_x.sct_y.z")).toBeNull();
  });

  it("fails a revoked token on the next request, and an expired one", async () => {
    const issued = await issue();
    expect(await write((tx) => revokeScimToken(tx, t.tenantId, issued.id, "user:admin"))).toBe(
      true,
    );
    expect(await write((tx) => revokeScimToken(tx, t.tenantId, issued.id, "user:admin"))).toBe(
      false,
    );
    expect(await write((tx) => revokeScimToken(tx, t.tenantId, "sct_nope", "user:admin"))).toBe(
      false,
    );
    expect(
      await identityCode(write((tx) => revokeScimToken(tx, t.tenantId, issued.id, "scim:x"))),
    ).toBe("invalid");
    expect(await check(issued.token)).toEqual({
      ok: false,
      refused: { tokenId: issued.id, reason: "revoked" },
    });
    expect(await write((tx) => touchScimToken(tx, t.tenantId, issued.id))).toBe(false);
    const [revoked] = await write((tx) => listScimTokens(tx, t.tenantId));
    expect(revoked).toMatchObject({ revokedBy: "user:admin" });

    const old = await issue();
    await write((tx) =>
      tx
        .update(scimTokens)
        .set({
          createdAt: sql`now() - interval '2 days'`,
          expiresAt: sql`now() - interval '1 day'`,
        })
        .where(eq(scimTokens.id, old.id)),
    );
    expect(await check(old.token)).toEqual({
      ok: false,
      refused: { tokenId: old.id, reason: "expired" },
    });
  });

  it("prunes tokens revoked or expired before a time, in bounded batches, in their tenant only", async () => {
    const live = await issue();
    const revoked = await issue();
    const expired = await issue();
    const otherRevoked = await issue({}, other.tenantId);
    await write((tx) => revokeScimToken(tx, t.tenantId, revoked.id, "user:admin"));
    await write(
      (tx) => revokeScimToken(tx, other.tenantId, otherRevoked.id, "user:admin"),
      other.tenantId,
    );
    await write((tx) =>
      tx
        .update(scimTokens)
        .set({
          createdAt: sql`now() - interval '2 days'`,
          expiresAt: sql`now() - interval '1 day'`,
        })
        .where(eq(scimTokens.id, expired.id)),
    );
    const prune = (before: Date, limit?: number) =>
      write((tx) => pruneScimTokens(tx, t.tenantId, before, limit));
    // Before anything ended, nothing goes.
    expect(await prune(days(-3))).toBe(0);
    const later = days(1);
    expect(await prune(later, 1)).toBe(1);
    expect(await prune(later)).toBe(1);
    expect(await prune(later)).toBe(0);
    expect((await write((tx) => listScimTokens(tx, t.tenantId))).map((x) => x.id)).toEqual([
      live.id,
    ]);
    expect(await write((tx) => listScimTokens(tx, other.tenantId), other.tenantId)).toHaveLength(1);
    for (const bad of [0, 100_001, 1.5]) {
      expect(await identityCode(prune(later, bad))).toBe("invalid");
    }
    expect(await identityCode(prune(new Date(Number.NaN)))).toBe("invalid");
  });

  it("gives the audit what it needs: the actor is a principal core/audit accepts", async () => {
    const issued = await issue();
    await write((tx) =>
      appendAudit(tx, t.tenantId, {
        actor: scimActor(issued.id),
        action: "scim.user.list",
        decision: "allow",
      }),
    );
    expect(await verifyAudit(db, t.tenantId)).toMatchObject({ ok: true, count: 1 });
  });
});
