import { sessions, signInLinks, type Database, type Tx } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createServiceAccount,
  createUser,
  IdentityError,
  lockUser,
  retireUser,
  type User,
} from "./directory.js";
import { checkSession } from "./sessions.js";
import {
  issueSignInLink,
  parseSignInLink,
  redeemSignInLink,
  SIGN_IN_LINK_ISSUER,
  SIGN_IN_LINK_PROVIDER,
} from "./sign-in-links.js";

/* One-time sign-in links: a server without an identity provider (dogfood, loopback only). */

let db: Database;
let t: SeededTenant;
let other: SeededTenant;
let bo: User;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  other = await seedTenant(db, 2);
  bo = await write((tx) =>
    createUser(tx, t.tenantId, { email: "bo@example.com", displayName: "Bo", source: "local" }),
  );
});
afterEach(() => db?.close());

const write = <T>(work: (tx: Tx) => Promise<T>, tenantId = t.tenantId) =>
  db.withTenant(tenantId, work);
const issue = (userId = bo.id, minutes?: number) =>
  write((tx) =>
    issueSignInLink(tx, t.tenantId, {
      userId,
      by: "system:admin-cli",
      ...(minutes === undefined ? {} : { minutes }),
    }),
  );
const redeem = (token: string, tenantId = t.tenantId) =>
  write((tx) => redeemSignInLink(tx, tenantId, token), tenantId);

describe("sign-in links", () => {
  it("start one session, once; a replay ends it", async () => {
    const link = await issue();
    expect(parseSignInLink(link.token)).toEqual({ tenantId: t.tenantId, linkId: link.id });
    const [stored] = await write((tx) =>
      tx.select().from(signInLinks).where(eq(signInLinks.id, link.id)),
    );
    // Only a hash of the secret is kept.
    expect(stored?.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(link.token.split(".")[3]);

    const used = await redeem(link.token);
    if (!used.ok) throw new Error(`refused: ${used.refused}`);
    expect(used.userId).toBe(bo.id);
    const check = await write((tx) => checkSession(tx, t.tenantId, used.session.token));
    expect(check.ok).toBe(true);
    const [row] = await write((tx) =>
      tx.select().from(sessions).where(eq(sessions.id, used.session.id)),
    );
    expect(row).toMatchObject({
      provider: SIGN_IN_LINK_PROVIDER,
      issuer: SIGN_IN_LINK_ISSUER,
      subject: link.id,
    });

    expect(await redeem(link.token)).toEqual({
      ok: false,
      refused: "used",
      linkId: link.id,
      userId: bo.id,
      endedSession: used.session.id,
    });
    expect((await write((tx) => checkSession(tx, t.tenantId, used.session.token))).ok).toBe(false);
  });

  it("refuses what isn't a live link of this tenant's", async () => {
    const link = await issue();
    expect(await redeem("not a token")).toEqual({ ok: false, refused: "unknown" });
    // Another tenant's token names its tenant: not this one's link.
    expect(await redeem(link.token, other.tenantId)).toEqual({ ok: false, refused: "unknown" });
    const forged = `${link.token.slice(0, link.token.lastIndexOf(".") + 1)}${"A".repeat(43)}`;
    expect(await redeem(forged)).toMatchObject({ ok: false, refused: "wrong-secret" });
    // Expired.
    await write((tx) =>
      tx
        .update(signInLinks)
        .set({
          createdAt: sql`now() - interval '2 hours'`,
          expiresAt: sql`now() - interval '1 hour'`,
        })
        .where(eq(signInLinks.id, link.id)),
    );
    expect(await redeem(link.token)).toMatchObject({ ok: false, refused: "expired" });
  });

  it("only for a current person, and never for long", async () => {
    await expect(issue(bo.id, 61)).rejects.toBeInstanceOf(IdentityError);
    await expect(issue(bo.id, 0)).rejects.toBeInstanceOf(IdentityError);
    await expect(
      write((tx) => issueSignInLink(tx, t.tenantId, { userId: bo.id, by: "someone" })),
    ).rejects.toBeInstanceOf(IdentityError);
    const robot = await write((tx) =>
      createServiceAccount(tx, t.tenantId, { displayName: "CI", by: "system:test" }),
    );
    await expect(issue(robot.id)).rejects.toThrow(/service account/);
    await expect(issue("usr_nobody")).rejects.toThrow(/no such person/);
    // Locked after the link was issued: refused when it is used.
    const link = await issue(bo.id, 60);
    await write((tx) => lockUser(tx, t.tenantId, bo.id, "system:test"));
    expect(await redeem(link.token)).toMatchObject({ ok: false, refused: "inactive" });
    await expect(issue()).rejects.toThrow(/locked/);
    await write((tx) => retireUser(tx, t.tenantId, bo.id, "system:test"));
    await expect(issue()).rejects.toThrow(/no such person/);
  });
});
