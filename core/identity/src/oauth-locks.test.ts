import { createHash, randomBytes } from "node:crypto";
import {
  oauthCodes,
  oauthGrants,
  queryRows,
  users,
  type Database,
  type Tx,
} from "@openhoard/core-db";
import {
  openTestDatabase,
  seedTenant,
  TEST_POSTGRES_ENV,
  type SeededTenant,
} from "@openhoard/core-db/testing";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUser, lockUser, type User } from "./directory.js";
import { decideClient, issueCode, noteClient, redeemCode, type OAuthClient } from "./oauth.js";

/*
 * The lock order of oauth.ts's header, on PostgreSQL (PGlite runs one transaction at a time).
 * Each test holds a row in a third transaction so the other two queue in the interleaving that
 * once deadlocked (40P01), then lets them go: both must finish.
 */

const RESOURCE = "https://hoard.example/mcp";
const CLIENT = "https://claude.ai/oauth/mcp-client.json";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const postgres = process.env[TEST_POSTGRES_ENV] !== undefined;

let db: Database;
let t: SeededTenant;
let ana: User;
let client: OAuthClient;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  ana = await write((tx) =>
    createUser(tx, t.tenantId, { email: "ana@example.com", displayName: "Ana", source: "local" }),
  );
  client = (await write(async (tx) => {
    const c = await noteClient(
      tx,
      t.tenantId,
      { kind: "cimd", clientRef: CLIENT, name: "Claude", redirectUris: [REDIRECT] },
      `user:${ana.id}`,
    );
    return decideClient(
      tx,
      t.tenantId,
      (c as OAuthClient).clientKey,
      { approve: true, trust: "commercial" },
      "user:admin",
    );
  })) as OAuthClient;
});
afterEach(() => db?.close());

const write = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work);

async function code() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const c = await write((tx) =>
    issueCode(tx, t.tenantId, {
      userId: ana.id,
      clientKey: client.clientKey,
      redirectUri: REDIRECT,
      codeChallenge: challenge,
      scopes: ["files:read"],
      resource: RESOURCE,
    }),
  );
  return { code: c, verifier };
}
const redeem = (c: { code: string; verifier: string }) =>
  write((tx) =>
    redeemCode(tx, t.tenantId, c.code, {
      clientKey: client.clientKey,
      redirectUri: REDIRECT,
      codeVerifier: c.verifier,
      resource: RESOURCE,
    }),
  );

/** Waits until `n` sessions of this database wait on a lock. */
async function waiters(n: number) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [row] = await write((tx) =>
      queryRows<{ n: number }>(
        tx,
        sql`select count(*)::int as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`,
      ),
    );
    if ((row?.n ?? 0) >= n) return;
    if (Date.now() > deadline) throw new Error(`fewer than ${n} sessions waiting on a lock`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A third transaction holding `lock` until released. */
function holding(lock: (tx: Tx) => Promise<unknown>) {
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let held = () => {};
  const started = new Promise<void>((r) => (held = r));
  const done = write(async (tx) => {
    await lock(tx);
    held();
    await gate;
  });
  return { started, release, done };
}

describe.runIf(postgres)("lock order (PostgreSQL)", () => {
  it("lets a code redemption and a lock of its person both finish", async () => {
    const pending = await code();
    // Holds the person, so the lock queues first and the redemption behind it.
    const c = holding((tx) =>
      tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.tenantId, t.tenantId), eq(users.id, ana.id)))
        .for("update"),
    );
    await c.started;
    const locking = write((tx) => lockUser(tx, t.tenantId, ana.id, "user:admin"));
    await waiters(1);
    const redeeming = redeem(pending);
    await waiters(2);
    c.release();
    const [locked, redeemed] = await Promise.all([locking, redeeming, c.done]);
    expect(locked).toBe(true);
    // The lock used the code up before the redemption could.
    expect(redeemed).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(await write((tx) => tx.select().from(oauthGrants))).toEqual([]);
  });

  it("lets a client's refusal and a lock of a person holding its grant both finish", async () => {
    const granted = await redeem(await code());
    if (!granted.ok) throw new Error(granted.reason);
    const waiting = await code();
    // Holds the grant, so the refusal queues first and the lock behind it.
    const c = holding((tx) =>
      tx
        .select({ id: oauthGrants.id })
        .from(oauthGrants)
        .where(and(eq(oauthGrants.tenantId, t.tenantId), eq(oauthGrants.id, granted.grantId)))
        .for("update"),
    );
    await c.started;
    const refusing = write((tx) =>
      decideClient(tx, t.tenantId, client.clientKey, { approve: false }, "user:admin"),
    );
    await waiters(1);
    const locking = write((tx) => lockUser(tx, t.tenantId, ana.id, "user:other"));
    await waiters(2);
    c.release();
    const [refused, locked] = await Promise.all([refusing, locking, c.done]);
    expect(refused).toMatchObject({ status: "refused" });
    expect(locked).toBe(true);
    const [grant] = await write((tx) => tx.select().from(oauthGrants));
    expect(grant?.revokedBy).toBe("user:admin");
    expect(await redeem(waiting)).toMatchObject({ ok: false });
    const codes = await write((tx) => tx.select({ usedAt: oauthCodes.usedAt }).from(oauthCodes));
    expect(codes.every((row) => row.usedAt !== null)).toBe(true);
  });
});
