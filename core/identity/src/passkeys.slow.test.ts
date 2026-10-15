import {
  invites,
  passkeyChallenges,
  passkeys,
  queryRows,
  sessions,
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
import {
  createServiceAccount,
  createUser,
  IdentityError,
  lockUser,
  retireUser,
  unlockUser,
  type EndedAccess,
  type User,
} from "./directory.js";
import {
  acceptInvite,
  addPasskey,
  authenticationOptions,
  CHALLENGE_MEMORY_SECONDS,
  checkInvite,
  issueInvite,
  listPasskeys,
  newChallenge,
  parseInvite,
  parseUserHandle,
  PASSKEY_ISSUER,
  PASSKEY_MAX_PER_USER,
  PASSKEY_PROVIDER,
  registerPasskey,
  registrationOptions,
  removePasskey,
  removeStrandedPasskeys,
  signInWithPasskey,
  spendChallenge,
  userHandle,
} from "./passkeys.js";
import { checkSession } from "./sessions.js";
import { SoftAuthenticator, type Bend } from "./testing.js";

/* Built-in accounts (T-108): invites, the passkeys they make, and signing in with one. */

const ORIGIN = "https://files.example.com";
const RP = { id: "files.example.com", name: "OpenHoard" };
const BY = "system:admin-cli";
const postgres = process.env[TEST_POSTGRES_ENV] !== undefined;

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
const invite = (userId = bo.id, hours?: number) =>
  write((tx) =>
    issueInvite(tx, t.tenantId, { userId, by: BY, ...(hours === undefined ? {} : { hours }) }),
  );
const expectedFor = (challenge: string) => ({ challenge, origin: ORIGIN, rpId: RP.id });

/** The whole ceremony an invite's page runs: options, the authenticator, the registration. */
async function accept(token: string, device = new SoftAuthenticator(), bend: Bend = {}) {
  const challenge = newChallenge();
  const named = parseInvite(token);
  const options = registrationOptions({
    rp: RP,
    tenantId: t.tenantId,
    user: bo,
    challenge,
    exclude: [],
  });
  return write((tx) =>
    acceptInvite(tx, t.tenantId, {
      token,
      challengeFor: named?.inviteId ?? "",
      response: device.create(options, ORIGIN, bend),
      expected: expectedFor(challenge),
      name: "Phone",
    }),
  );
}

async function signIn(device: SoftAuthenticator, bend: Bend = {}, tenantId = t.tenantId) {
  const challenge = newChallenge();
  const response = device.get(authenticationOptions({ rpId: RP.id, challenge }), ORIGIN, bend);
  return write(
    (tx) => signInWithPasskey(tx, tenantId, { response, expected: expectedFor(challenge) }),
    tenantId,
  );
}

async function enrolled() {
  const device = new SoftAuthenticator();
  const done = await accept((await invite()).token, device);
  if (!done.ok) throw new Error(`invite refused: ${done.refused}`);
  return { device, ...done };
}

describe("invites", () => {
  it("make one passkey and sign the person in, once", async () => {
    const issued = await invite();
    expect(parseInvite(issued.token)).toEqual({ tenantId: t.tenantId, inviteId: issued.id });
    expect(issued.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 3600_000);
    expect(issued.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(7 * 24 * 3600_000 + 5000);
    const [stored] = await write((tx) =>
      tx.select().from(invites).where(eq(invites.id, issued.id)),
    );
    // Only a hash of the secret is kept.
    expect(stored?.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(issued.token.split(".")[3]);
    expect(await write((tx) => checkInvite(tx, t.tenantId, issued.token))).toMatchObject({
      ok: true,
      inviteId: issued.id,
      user: { id: bo.id },
    });

    const done = await accept(issued.token);
    if (!done.ok) throw new Error("refused");
    expect(done.passkey).toMatchObject({ userId: bo.id, name: "Phone", backupEligible: true });
    expect((await write((tx) => checkSession(tx, t.tenantId, done.session.token))).ok).toBe(true);
    const [session] = await write((tx) =>
      tx.select().from(sessions).where(eq(sessions.id, done.session.id)),
    );
    expect(session).toMatchObject({
      provider: PASSKEY_PROVIDER,
      issuer: PASSKEY_ISSUER,
      subject: done.passkey.id,
    });
    const [kept] = await write((tx) => tx.select().from(passkeys));
    expect(kept).toMatchObject({ inviteId: issued.id, algorithm: -7, signCount: 0 });

    // Used: a second passkey from the same link is refused, and nothing more is stored.
    expect(await accept(issued.token)).toEqual({
      ok: false,
      refused: "used",
      inviteId: issued.id,
      userId: bo.id,
    });
    expect(await write((tx) => listPasskeys(tx, t.tenantId, bo.id))).toHaveLength(1);
  });

  it("refuse a wrong secret, another tenant, an expired one, and a challenge for another", async () => {
    const issued = await invite(bo.id, 1);
    const [head] = issued.token.split(/\.(?=[^.]+$)/) as [string];
    expect(await accept(`${head}.${"A".repeat(43)}`)).toMatchObject({ refused: "wrong-secret" });
    expect(await accept("ohi.nonsense")).toEqual({ ok: false, refused: "unknown" });
    expect(await accept(issued.token.replace(t.tenantId, other.tenantId))).toEqual({
      ok: false,
      refused: "unknown",
    });
    // A challenge issued for another invite isn't this one's: nothing is read, locked or spent.
    const challenge = newChallenge();
    const response = new SoftAuthenticator().create(
      registrationOptions({ rp: RP, tenantId: t.tenantId, user: bo, challenge, exclude: [] }),
      ORIGIN,
    );
    expect(
      await write((tx) =>
        acceptInvite(tx, t.tenantId, {
          token: issued.token,
          challengeFor: "inv_00000000000000000000000000",
          response,
          expected: expectedFor(challenge),
        }),
      ),
    ).toEqual({ ok: false, refused: "unknown" });

    await write((tx) =>
      tx
        .update(invites)
        .set({
          createdAt: sql`now() - interval '2 hours'`,
          expiresAt: sql`now() - interval '1 hour'`,
        })
        .where(eq(invites.id, issued.id)),
    );
    expect(await accept(issued.token)).toMatchObject({ refused: "expired" });
    expect(await write((tx) => listPasskeys(tx, t.tenantId, bo.id))).toEqual([]);
  });

  it("stay usable after a passkey that doesn't check out", async () => {
    const issued = await invite();
    expect(await accept(issued.token, new SoftAuthenticator(), { userVerified: false })).toEqual({
      ok: false,
      refused: "invalid-passkey",
      reason: "user-verification",
      inviteId: issued.id,
      userId: bo.id,
    });
    expect(
      await accept(issued.token, new SoftAuthenticator(), { origin: "https://evil.test" }),
    ).toMatchObject({ reason: "origin" });
    expect((await accept(issued.token)).ok).toBe(true);
  });

  it("live 1 hour to 7 days, for current local people only", async () => {
    for (const hours of [0, 169, 1.5]) {
      await expect(invite(bo.id, hours)).rejects.toMatchObject({ code: "invalid" });
    }
    await expect(
      write((tx) => issueInvite(tx, t.tenantId, { userId: bo.id, by: "scim:sct_x" })),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(invite("usr_00000000000000000000000000")).rejects.toMatchObject({
      code: "not-found",
    });
    await expect(invite("nobody")).rejects.toMatchObject({ code: "not-found" });
    // A SCIM person signs in through their identity provider, whatever an admin would like.
    const scim = await write((tx) =>
      createUser(tx, t.tenantId, {
        email: "ana@example.com",
        displayName: "Ana",
        source: "scim",
        externalId: "ext-1",
      }),
    );
    await expect(invite(scim.id)).rejects.toMatchObject({ code: "wrong-source" });
    const robot = await write((tx) =>
      createServiceAccount(tx, t.tenantId, { displayName: "CI", by: "user:admin" }),
    );
    await expect(invite(robot.id)).rejects.toMatchObject({ code: "invalid" });
    await write((tx) => lockUser(tx, t.tenantId, bo.id, "user:admin"));
    await expect(invite()).rejects.toMatchObject({ code: "inactive" });
    await write((tx) => unlockUser(tx, t.tenantId, bo.id, "user:admin"));
    await write((tx) => retireUser(tx, t.tenantId, bo.id, "user:admin"));
    await expect(invite()).rejects.toBeInstanceOf(IdentityError);
  });

  it("are replaced by a newer one, and revoked for good by a lock", async () => {
    const first = await invite();
    const second = await invite();
    expect(second.revoked).toBe(1);
    expect(await accept(first.token)).toMatchObject({ refused: "revoked" });

    const ended: EndedAccess[] = [];
    await write((tx) =>
      lockUser(tx, t.tenantId, bo.id, "user:admin", { onEnded: (e) => ended.push(e) }),
    );
    expect(ended).toEqual([{ sessions: 0, oauthCodes: 0, oauthGrants: 0, apiKeys: 0, invites: 1 }]);
    expect(await accept(second.token)).toMatchObject({ refused: "revoked" });
    // Unlocking brings nothing back: whoever held the link needs a new invite.
    await write((tx) => unlockUser(tx, t.tenantId, bo.id, "user:admin"));
    expect(await accept(second.token)).toMatchObject({ refused: "revoked" });
    const [row] = await write((tx) => tx.select().from(invites).where(eq(invites.id, second.id)));
    expect(row?.revokedBy).toBe("user:admin");
  });
});

describe("passkeys", () => {
  it("sign their person in, and record each use", async () => {
    const { device, passkey } = await enrolled();
    const done = await signIn(device);
    if (!done.ok) throw new Error("refused");
    expect(done).toMatchObject({ userId: bo.id, passkeyId: passkey.id });
    expect(await write((tx) => checkSession(tx, t.tenantId, done.session.token))).toMatchObject({
      ok: true,
      session: { provider: PASSKEY_PROVIDER },
    });
    const [listed] = await write((tx) => listPasskeys(tx, t.tenantId, bo.id));
    expect(listed?.lastUsedAt).toBeInstanceOf(Date);
    // What is listed is what a person may see of it: no key, no counter.
    expect(Object.keys(listed ?? {}).sort()).toEqual(
      [
        "backedUp",
        "backupEligible",
        "createdAt",
        "credentialId",
        "id",
        "lastUsedAt",
        "name",
        "rpId",
        "transports",
        "userId",
      ].sort(),
    );
  });

  it("refuse an assertion that doesn't check out, another tenant, and someone else's handle", async () => {
    const { device, passkey } = await enrolled();
    const who = { passkeyId: passkey.id, userId: bo.id };
    expect(await signIn(device, { wrongKey: true })).toEqual({
      ok: false,
      refused: "invalid",
      reason: "signature",
      ...who,
    });
    expect(await signIn(device, { userVerified: false })).toMatchObject({
      reason: "user-verification",
    });
    expect(await signIn(device, { origin: "https://evil.test" })).toMatchObject({
      reason: "origin",
    });
    // The handle names the tenant: looked up anywhere else, the passkey isn't there.
    expect(await signIn(device, {}, other.tenantId)).toEqual({ ok: false, refused: "unknown" });
    expect(await signIn(device, { userHandle: userHandle(other.tenantId, bo.id) })).toEqual({
      ok: false,
      refused: "unknown",
    });
    const cy = await write((tx) =>
      createUser(tx, t.tenantId, { email: "cy@example.com", displayName: "Cy", source: "local" }),
    );
    expect(await signIn(device, { userHandle: userHandle(t.tenantId, cy.id) })).toEqual({
      ok: false,
      refused: "unknown",
    });
    expect(await signIn(device, { userHandle: null })).toEqual({ ok: false, refused: "unknown" });
    // Nothing above counted as a use.
    expect((await write((tx) => listPasskeys(tx, t.tenantId, bo.id)))[0]?.lastUsedAt).toBeNull();
  });

  it("keep the counter of an authenticator that has one", async () => {
    const device = new SoftAuthenticator({ counter: true, backupEligible: false });
    const done = await accept((await invite()).token, device);
    if (!done.ok) throw new Error("refused");
    expect(done.passkey).toMatchObject({ backupEligible: false, backedUp: false });
    expect((await signIn(device)).ok).toBe(true);
    const count = async () =>
      (await write((tx) => tx.select({ n: passkeys.signCount }).from(passkeys)))[0]?.n;
    expect(await count()).toBe(2);
    // A copy that is behind: refused, and the stored count stays.
    expect(await signIn(device, { signCount: 2 })).toMatchObject({ reason: "counter" });
    expect(await count()).toBe(2);
  });

  it("stop with their person, and are gone when the person is retired", async () => {
    const { device, session } = await enrolled();
    await write((tx) => lockUser(tx, t.tenantId, bo.id, "user:admin"));
    expect((await write((tx) => checkSession(tx, t.tenantId, session.token))).ok).toBe(false);
    expect(await signIn(device)).toMatchObject({ ok: false, refused: "inactive" });
    await write((tx) => unlockUser(tx, t.tenantId, bo.id, "user:admin"));
    // The passkey is the person's own: unlocked, it signs in again (the old session doesn't).
    expect((await signIn(device)).ok).toBe(true);
    expect((await write((tx) => checkSession(tx, t.tenantId, session.token))).ok).toBe(false);

    await write((tx) => retireUser(tx, t.tenantId, bo.id, "user:admin"));
    expect(await write((tx) => tx.select().from(passkeys))).toEqual([]);
    expect(await signIn(device)).toEqual({ ok: false, refused: "unknown" });
  });

  it("are added by their person, up to a limit, one per credential", async () => {
    const { device } = await enrolled();
    const add = async (authenticator: SoftAuthenticator, name?: string) => {
      const challenge = newChallenge();
      const held = await write((tx) => listPasskeys(tx, t.tenantId, bo.id));
      const options = registrationOptions({
        rp: RP,
        tenantId: t.tenantId,
        user: bo,
        challenge,
        exclude: held,
      });
      const response = authenticator.create(options, ORIGIN);
      return write((tx) =>
        registerPasskey(tx, t.tenantId, {
          userId: bo.id,
          response,
          expected: expectedFor(challenge),
          ...(name === undefined ? {} : { name }),
        }),
      );
    };
    // The options name the passkeys they have, so the same authenticator declines.
    await expect(add(device)).rejects.toThrow(/holds a passkey already/);
    const key = await add(new SoftAuthenticator({ algorithm: -8 }), "  YubiKey ");
    expect(key).toMatchObject({ name: "YubiKey" });
    expect((await add(new SoftAuthenticator({ algorithm: -257 }))).name).toBe("Passkey");
    await expect(add(new SoftAuthenticator(), "")).rejects.toMatchObject({ code: "invalid" });
    await expect(add(new SoftAuthenticator(), "x".repeat(101))).rejects.toMatchObject({
      code: "invalid",
    });

    // The same credential offered again (a replayed registration): refused.
    const challenge = newChallenge();
    const response = new SoftAuthenticator().create(
      registrationOptions({ rp: RP, tenantId: t.tenantId, user: bo, challenge, exclude: [] }),
      ORIGIN,
    );
    const once = () =>
      write((tx) =>
        registerPasskey(tx, t.tenantId, {
          userId: bo.id,
          response,
          expected: expectedFor(challenge),
        }),
      );
    await once();
    await expect(once()).rejects.toMatchObject({ code: "conflict" });

    for (let n = 4; n < PASSKEY_MAX_PER_USER; n++) await add(new SoftAuthenticator());
    await expect(add(new SoftAuthenticator())).rejects.toMatchObject({ code: "invalid" });
  });

  it("end the sessions they signed in when removed, and only those", async () => {
    const first = await enrolled();
    const second = new SoftAuthenticator();
    const challenge = newChallenge();
    const added = await write((tx) =>
      registerPasskey(tx, t.tenantId, {
        userId: bo.id,
        response: second.create(
          registrationOptions({ rp: RP, tenantId: t.tenantId, user: bo, challenge, exclude: [] }),
          ORIGIN,
        ),
        expected: expectedFor(challenge),
      }),
    );
    const viaSecond = await signIn(second);
    if (!viaSecond.ok) throw new Error("refused");
    const live = async (token: string) =>
      (await write((tx) => checkSession(tx, t.tenantId, token))).ok;

    expect(
      await write((tx) => removePasskey(tx, t.tenantId, bo.id, added.id, "user:admin")),
    ).toMatchObject({ sessions: 1 });
    expect(await live(viaSecond.session.token)).toBe(false);
    expect(await live(first.session.token)).toBe(true);
    expect(await signIn(second)).toEqual({ ok: false, refused: "unknown" });
    // Not theirs, not there, not a passkey id: nothing.
    const cy = await write((tx) =>
      createUser(tx, t.tenantId, { email: "cy@example.com", displayName: "Cy", source: "local" }),
    );
    for (const [userId, id] of [
      [cy.id, first.passkey.id],
      [bo.id, added.id],
      [bo.id, "nonsense"],
    ] as const) {
      expect(
        await write((tx) => removePasskey(tx, t.tenantId, userId, id, "user:admin")),
      ).toBeNull();
    }
    expect(await live(first.session.token)).toBe(true);
  });

  it("are one tenant's: another tenant sees none", async () => {
    await enrolled();
    expect(await write((tx) => tx.select().from(passkeys), other.tenantId)).toEqual([]);
    expect(await write((tx) => tx.select().from(invites), other.tenantId)).toEqual([]);
    expect(
      await write((tx) =>
        tx
          .select()
          .from(passkeys)
          .where(and(eq(passkeys.userId, bo.id))),
      ),
    ).toHaveLength(1);
  });
});

describe("hosts", () => {
  /** Adds a passkey made at `host` (the server reached at another address). */
  async function addAt(host: string, device = new SoftAuthenticator()) {
    const challenge = newChallenge();
    const origin = `https://${host}`;
    const response = device.create(
      registrationOptions({
        rp: { id: host, name: "OpenHoard" },
        tenantId: t.tenantId,
        user: bo,
        challenge,
        exclude: [],
      }),
      origin,
    );
    return write((tx) =>
      registerPasskey(tx, t.tenantId, {
        userId: bo.id,
        response,
        expected: { challenge, origin, rpId: host },
      }),
    );
  }

  it("are recorded, and a passkey left at another host doesn't count against this one", async () => {
    const here = await enrolled();
    expect(here.passkey.rpId).toBe(RP.id);
    for (let n = 0; n < PASSKEY_MAX_PER_USER; n++) await addAt("old.example.net");
    // Twenty at the old host, one here: here still has room.
    const challenge = newChallenge();
    const more = await write((tx) =>
      registerPasskey(tx, t.tenantId, {
        userId: bo.id,
        response: new SoftAuthenticator().create(
          registrationOptions({ rp: RP, tenantId: t.tenantId, user: bo, challenge, exclude: [] }),
          ORIGIN,
        ),
        expected: expectedFor(challenge),
      }),
    );
    expect(more.rpId).toBe(RP.id);
    await expect(addAt("old.example.net")).rejects.toMatchObject({ code: "invalid" });
  });

  it("that are gone for good take their passkeys and those passkeys' sessions with them", async () => {
    const here = await enrolled();
    const gone = new SoftAuthenticator();
    const stranded = await addAt("quiet-river.trycloudflare.com", gone);
    await addAt("loud-lake.trycloudflare.com");
    const current = await addAt("new-hill.trycloudflare.com");
    const other = await addAt("files.example.org");
    // A session the stranded passkey started (while its host lived).
    const challenge = newChallenge();
    const signed = await write((tx) =>
      signInWithPasskey(tx, t.tenantId, {
        response: gone.get(
          authenticationOptions({ rpId: "quiet-river.trycloudflare.com", challenge }),
          "https://quiet-river.trycloudflare.com",
        ),
        expected: {
          challenge,
          origin: "https://quiet-river.trycloudflare.com",
          rpId: "quiet-river.trycloudflare.com",
        },
      }),
    );
    if (!signed.ok) throw new Error("refused");
    const remove = (suffix = ".trycloudflare.com") =>
      write((tx) =>
        removeStrandedPasskeys(
          tx,
          t.tenantId,
          bo.id,
          { suffix, keep: "new-hill.trycloudflare.com" },
          BY,
        ),
      );
    expect(await remove()).toBe(2);
    expect(await remove()).toBe(0);
    const left = await write((tx) => listPasskeys(tx, t.tenantId, bo.id));
    expect(left.map((p) => p.id).sort()).toEqual([here.passkey.id, current.id, other.id].sort());
    expect(left.some((p) => p.id === stranded.id)).toBe(false);
    const live = async (token: string) =>
      (await write((tx) => checkSession(tx, t.tenantId, token))).ok;
    expect(await live(signed.session.token)).toBe(false);
    expect(await live(here.session.token)).toBe(true);
    // A suffix is a dot and a domain: never a pattern, never everything.
    for (const bad of ["trycloudflare.com", ".com", "%", "._.com", ""]) {
      await expect(remove(bad)).rejects.toMatchObject({ code: "invalid" });
    }
    expect(
      await write((tx) =>
        removeStrandedPasskeys(tx, t.tenantId, "nobody", { suffix: ".a.b", keep: "x" }, BY),
      ),
    ).toBe(0);
  });
});

describe("challenges", () => {
  it("are answered once: a copied sign-in or registration does nothing more", async () => {
    const { device, passkey } = await enrolled();
    const challenge = newChallenge();
    const response = device.get(authenticationOptions({ rpId: RP.id, challenge }), ORIGIN);
    const send = () =>
      write((tx) =>
        signInWithPasskey(tx, t.tenantId, { response, expected: expectedFor(challenge) }),
      );
    expect((await send()).ok).toBe(true);
    // The same request again, as whoever copied it would send it.
    expect(await send()).toEqual({ ok: false, refused: "replay" });
    expect(await write((tx) => tx.select().from(sessions))).toHaveLength(2);
    // A refused answer spends its challenge too: it can't be retried into the audit log.
    const second = newChallenge();
    const bad = device.get(authenticationOptions({ rpId: RP.id, challenge: second }), ORIGIN, {
      wrongKey: true,
    });
    const sendBad = () =>
      write((tx) =>
        signInWithPasskey(tx, t.tenantId, { response: bad, expected: expectedFor(second) }),
      );
    expect(await sendBad()).toMatchObject({ refused: "invalid", passkeyId: passkey.id });
    expect(await sendBad()).toEqual({ ok: false, refused: "replay" });

    // A registration: the invite stays good after a bad answer, but that answer's challenge is spent.
    const issued = await invite();
    const third = newChallenge();
    const made = new SoftAuthenticator().create(
      registrationOptions({
        rp: RP,
        tenantId: t.tenantId,
        user: bo,
        challenge: third,
        exclude: [],
      }),
      ORIGIN,
      { userVerified: false },
    );
    const register = () =>
      write((tx) =>
        acceptInvite(tx, t.tenantId, {
          token: issued.token,
          challengeFor: issued.id,
          response: made,
          expected: expectedFor(third),
        }),
      );
    expect(await register()).toMatchObject({ refused: "invalid-passkey" });
    expect(await register()).toEqual({ ok: false, refused: "replay" });
    expect((await accept(issued.token)).ok).toBe(true);

    // Any refusal that names a real invite is that challenge's one answer: a wrong secret, and
    // an invite used already.
    for (const token of [`${issued.token.slice(0, -43)}${"A".repeat(43)}`, issued.token]) {
      const fourth = newChallenge();
      const again = () =>
        write((tx) =>
          acceptInvite(tx, t.tenantId, {
            token,
            challengeFor: issued.id,
            response: made,
            expected: expectedFor(fourth),
          }),
        );
      expect(await again()).toMatchObject({ ok: false, inviteId: issued.id });
      expect(await again()).toEqual({ ok: false, refused: "replay" });
    }
    // An invite nobody issued names nothing, and spends nothing.
    const before = await write((tx) => tx.select().from(passkeyChallenges));
    expect(
      await write((tx) =>
        acceptInvite(tx, t.tenantId, {
          token: `ohi.${t.tenantId}.inv_00000000000000000000000000.${"A".repeat(43)}`,
          challengeFor: issued.id,
          response: made,
          expected: expectedFor(newChallenge()),
        }),
      ),
    ).toEqual({ ok: false, refused: "unknown" });
    expect(await write((tx) => tx.select().from(passkeyChallenges))).toHaveLength(before.length);
  });

  it("are answered once when a signed-in person adds a passkey, too", async () => {
    await enrolled();
    const challenge = newChallenge();
    const options = registrationOptions({
      rp: RP,
      tenantId: t.tenantId,
      user: bo,
      challenge,
      exclude: [],
    });
    const add = (bend: Bend = {}) =>
      write((tx) =>
        addPasskey(tx, t.tenantId, {
          userId: bo.id,
          response: new SoftAuthenticator().create(options, ORIGIN, bend),
          expected: expectedFor(challenge),
        }),
      );
    expect(await add({ userVerified: false })).toEqual({
      ok: false,
      refused: "invalid-passkey",
      reason: "user-verification",
    });
    // The challenge went with that answer, good or not.
    expect(await add()).toEqual({ ok: false, refused: "replay" });
    expect(await write((tx) => listPasskeys(tx, t.tenantId, bo.id))).toHaveLength(1);
  });

  it("are one tenant's, and forgotten once no cookie could still hold them", async () => {
    const challenge = newChallenge();
    const spend = (tenantId = t.tenantId) =>
      write((tx) => spendChallenge(tx, tenantId, challenge), tenantId);
    expect(await spend()).toBe(true);
    expect(await spend()).toBe(false);
    expect(await spend(other.tenantId)).toBe(true);
    const [row] = await write((tx) => tx.select().from(passkeyChallenges));
    // Only a hash is kept, for longer than a ceremony lasts.
    expect(row?.challengeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(challenge);
    expect((row?.expiresAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(
      (CHALLENGE_MEMORY_SECONDS - 60) * 1000,
    );
    await write((tx) =>
      tx.update(passkeyChallenges).set({ expiresAt: sql`now() - interval '1 second'` }),
    );
    expect(await write((tx) => spendChallenge(tx, t.tenantId, newChallenge()))).toBe(true);
    expect(await write((tx) => tx.select().from(passkeyChallenges))).toHaveLength(1);
  });
});

describe.runIf(postgres)("lock order (PostgreSQL)", () => {
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
  /** A transaction holding the person's row until released. */
  function holdingPerson() {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let held = () => {};
    const started = new Promise<void>((r) => (held = r));
    const done = write(async (tx) => {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.tenantId, t.tenantId), eq(users.id, bo.id)))
        .for("update");
      held();
      await gate;
    });
    return { started, release, done };
  }

  it("lets one invite make one passkey when two browsers use it at once", async () => {
    const issued = await invite();
    const results = await Promise.all([accept(issued.token), accept(issued.token)]);
    expect(results.map((r) => r.ok).sort()).toEqual([false, true]);
    expect(results.find((r) => !r.ok)).toMatchObject({ refused: "used" });
    expect(await write((tx) => listPasskeys(tx, t.tenantId, bo.id))).toHaveLength(1);
    expect(await write((tx) => tx.select().from(sessions))).toHaveLength(1);
  });

  it("lets a sign-in and a retirement of its person both finish, whichever queued first", async () => {
    const { device } = await enrolled();
    const hold = holdingPerson();
    await hold.started;
    // The retirement queues on the person first, the sign-in behind it.
    const retiring = write((tx) => retireUser(tx, t.tenantId, bo.id, "user:admin"));
    await waiters(1);
    const signing = signIn(device);
    await waiters(2);
    hold.release();
    const [retired, signed] = await Promise.all([retiring, signing, hold.done]);
    expect(retired).toBe(true);
    expect(signed).toEqual({ ok: false, refused: "unknown" });
    expect(await write((tx) => tx.select().from(passkeys))).toEqual([]);
  });

  it("lets an invite's use and a lock of its person both finish", async () => {
    const issued = await invite();
    const hold = holdingPerson();
    await hold.started;
    const locking = write((tx) => lockUser(tx, t.tenantId, bo.id, "user:admin"));
    await waiters(1);
    const accepting = accept(issued.token);
    await waiters(2);
    hold.release();
    const [locked, accepted] = await Promise.all([locking, accepting, hold.done]);
    expect(locked).toBe(true);
    // The lock revoked the invite before it could be used.
    expect(accepted).toMatchObject({ ok: false, refused: "revoked" });
    expect(await write((tx) => tx.select().from(passkeys))).toEqual([]);
    expect(await write((tx) => tx.select().from(sessions))).toEqual([]);
  });

  it("lets a sign-in and the same person adding a passkey both finish", async () => {
    const { device } = await enrolled();
    // An old challenge to clear away: what both would otherwise reach for.
    await write((tx) => spendChallenge(tx, t.tenantId, newChallenge()));
    await write((tx) =>
      tx.update(passkeyChallenges).set({ expiresAt: sql`now() - interval '1 second'` }),
    );
    const challenge = newChallenge();
    const response = new SoftAuthenticator().create(
      registrationOptions({ rp: RP, tenantId: t.tenantId, user: bo, challenge, exclude: [] }),
      ORIGIN,
    );
    const hold = holdingPerson();
    await hold.started;
    const adding = write((tx) =>
      addPasskey(tx, t.tenantId, { userId: bo.id, response, expected: expectedFor(challenge) }),
    );
    await waiters(1);
    const signing = signIn(device);
    await waiters(2);
    hold.release();
    const [added, signed] = await Promise.all([adding, signing, hold.done]);
    expect(added.ok).toBe(true);
    expect(signed.ok).toBe(true);
    // And many at once, for different challenges, with stale ones to clear: nobody waits on
    // anybody's cleanup.
    await write((tx) =>
      tx.update(passkeyChallenges).set({ expiresAt: sql`now() - interval '1 second'` }),
    );
    const many = await Promise.all(Array.from({ length: 6 }, () => signIn(device)));
    expect(many.every((r) => r.ok)).toBe(true);
    expect(await write((tx) => tx.select().from(passkeyChallenges))).toHaveLength(6);
  });

  it("lets a sign-in and the removal of its passkey both finish", async () => {
    const { device, passkey } = await enrolled();
    const hold = holdingPerson();
    await hold.started;
    const removing = write((tx) => removePasskey(tx, t.tenantId, bo.id, passkey.id, "user:admin"));
    await waiters(1);
    const signing = signIn(device);
    await waiters(2);
    hold.release();
    const [removed, signed] = await Promise.all([removing, signing, hold.done]);
    expect(removed).toMatchObject({ sessions: 1 });
    expect(signed).toEqual({ ok: false, refused: "unknown" });
  });
});

describe("user handles", () => {
  it("name a tenant and a person, and nothing else", () => {
    const handle = userHandle(t.tenantId, bo.id);
    // WebAuthn allows 64 bytes.
    expect(Buffer.from(handle, "base64url").length).toBeLessThanOrEqual(64);
    expect(parseUserHandle(handle)).toEqual({ tenantId: t.tenantId, userId: bo.id });
    for (const bad of [
      null,
      undefined,
      7,
      "",
      "!!",
      Buffer.from("ten_x.usr_y").toString("base64url"),
    ]) {
      expect(parseUserHandle(bad)).toBeNull();
    }
    expect(parseUserHandle("A".repeat(200))).toBeNull();
  });
});
