import {
  addGrant,
  auditEvents,
  grants,
  liveObjectGrantsBy,
  objects,
  sourceRefs,
  sourceShares,
  type Database,
} from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import {
  addMember,
  createGroup,
  createServiceAccount,
  createUser,
  resolvePrincipal,
  retireUser,
} from "@openhoard/core-identity";
import {
  ConnectorError,
  type AclEntry,
  type AclPrincipal,
  type Connector,
  type ItemAcl,
} from "@openhoard/sdk";
import { memorySource, type MemorySource } from "@openhoard/sdk/testing";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sourceGranter } from "./acl.js";
import { runSync, type SyncOptions } from "./sync.js";

/*
 * T-305: a source's permissions as grants, through the sync runner on the database (PGlite, and
 * PostgreSQL with OPENHOARD_TEST_POSTGRES_URL), with the SDK's in-memory source saying who may
 * see what.
 */

const KEY = new Uint8Array(32).fill(7);
const SOURCE = "mem";
const BY = sourceGranter(SOURCE);
const enc = new TextEncoder();

let db: Database;
let t: SeededTenant;
let mem: MemorySource;
/** People and groups as the tenant knows them. */
let ana: string; // provisioned (SCIM), the source's id for her is `aad-ana`
let bo: string; // a local user, known by email only
let guest: string; // a local guest
let robot: string; // a service account
let finance: string; // a provisioned group, the source's id for it is `aad-finance`

beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  mem = memorySource({ checkpointEvery: 2 });
  await db.withTenant(t.tenantId, async (tx) => {
    const make = (email: string, more: Partial<Parameters<typeof createUser>[2]> = {}) =>
      createUser(tx, t.tenantId, { email, displayName: email, source: "local", ...more });
    ana = (await make("ana@corp.test", { source: "scim", externalId: "aad-ana" })).id;
    bo = (await make("bo@corp.test")).id;
    guest = (await make("pat@client.test", { kind: "guest" })).id;
    robot = (await createServiceAccount(tx, t.tenantId, { displayName: "CI", by: "system:test" }))
      .id;
    finance = (
      await createGroup(tx, t.tenantId, {
        name: "Finance",
        source: "scim",
        externalId: "aad-finance",
      })
    ).id;
    await addMember(tx, t.tenantId, finance, ana, "scim");
  });
});
afterEach(async () => {
  await db?.close();
});

function sync(connector: Connector = mem.connector, more: Partial<SyncOptions> = {}) {
  return runSync(db, {
    tenantId: t.tenantId,
    source: SOURCE,
    zoneId: t.zoneId,
    connector,
    ownerId: `user:${t.userId}`,
    tenantKey: () => KEY,
    enqueue: async () => {},
    sleep: async () => {},
    ...more,
  });
}

const entry = (principal: AclPrincipal, more: Partial<AclEntry> = {}): AclEntry => ({
  principal,
  role: "read",
  inherited: false,
  ...more,
});
const user = (id: string, email?: string): AclPrincipal => ({
  kind: "user",
  id,
  ...(email === undefined ? {} : { email }),
});
const group = (id: string): AclPrincipal => ({ kind: "group", id });

async function put(name: string, acl: readonly AclEntry[], text = name) {
  await mem.write([name], enc.encode(text));
  mem.setAcl([name], acl);
}

/** The object a file became. */
async function objectOf(name: string): Promise<string> {
  const [row] = await db.withTenant(t.tenantId, (tx) =>
    tx
      .select({ id: objects.id })
      .from(sourceRefs)
      .innerJoin(
        objects,
        and(eq(objects.tenantId, sourceRefs.tenantId), eq(objects.id, sourceRefs.objectId)),
      )
      .where(and(eq(sourceRefs.source, SOURCE), eq(objects.title, name))),
  );
  if (!row) throw new Error(`no object for ${name}`);
  return row.id;
}
/** The source's live grants on a file, as `role principal`, sorted. */
async function granted(name: string): Promise<string[]> {
  const objectId = await objectOf(name);
  const rows = await db.withTenant(t.tenantId, (tx) =>
    liveObjectGrantsBy(tx, t.tenantId, objectId, BY),
  );
  return rows.map((g) => `${g.role} ${g.principal}`).sort();
}
const imports = () =>
  db.withTenant(t.tenantId, (tx) =>
    tx.select().from(auditEvents).where(eq(auditEvents.action, "grant.import")),
  );
/** What a person holds on a file: "write", "read" or nothing. */
async function holds(userId: string, name: string): Promise<"write" | "read" | undefined> {
  const objectId = await objectOf(name);
  const principal = await db.withTenant(t.tenantId, (tx) =>
    resolvePrincipal(tx, t.tenantId, userId),
  );
  if (principal?.objectWriteGrants.includes(objectId)) return "write";
  return principal?.objectGrants.includes(objectId) ? "read" : undefined;
}

describe("a source's permissions", () => {
  it("become grants to the people and groups they can be matched to, and to nobody else", async () => {
    const soon = new Date(Date.now() + 86_400_000).toISOString();
    await put("plan.txt", [
      entry(user("aad-ana")),
      entry(user("aad-bo", "Bo@Corp.test"), { role: "write" }),
      entry(group("aad-finance"), { inherited: true }),
      entry({ kind: "guest", email: "pat@client.test" }, { expiresAt: soon }),
      // Nobody here: an unknown person, an unknown group, a link, everyone.
      entry(user("aad-nobody", "nobody@corp.test")),
      entry(group("aad-unknown")),
      entry({ kind: "link", id: "l1", scope: "anyone" }, { role: "write" }),
      entry({ kind: "organization" }),
      // Lapsed already: not a grant.
      entry(user("aad-ana-old"), { expiresAt: "2020-01-01T00:00:00Z" }),
    ]);
    await put("open.txt", []);

    const report = await sync();
    expect(report).toMatchObject({ status: "done", skipped: [] });
    expect(report.counts).toMatchObject({
      grantsAdded: 4,
      grantsRevoked: 0,
      unmappedUsers: 1,
      unmappedGroups: 1,
    });
    expect(await granted("plan.txt")).toEqual(
      [
        `read user:${ana}`,
        `write user:${bo}`,
        `read group:${finance}`,
        `read user:${guest}`,
      ].sort(),
    );
    expect(await granted("open.txt")).toEqual([]);
    // They are grants like any other: what a person holds is what the policy engine is given.
    expect(await holds(ana, "plan.txt")).toBe("read");
    expect(await holds(bo, "plan.txt")).toBe("write");
    expect(await holds(guest, "plan.txt")).toBe("read");
    expect(await holds(ana, "open.txt")).toBeUndefined();
    // The guest's lapses when the source says, the others when the source takes them away.
    const rows = await db.withTenant(t.tenantId, (tx) =>
      tx.select().from(grants).where(eq(grants.grantedBy, BY)),
    );
    expect(rows.find((g) => g.principal === `user:${guest}`)?.expiresAt?.toISOString()).toBe(soon);
    expect(rows.filter((g) => g.expiresAt === null)).toHaveLength(3);
    // Audited once for the file, by the source, with who.
    const events = await imports();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: BY, object: await objectOf("plan.txt") });
    const { detail } = JSON.parse(events[0]?.event ?? "{}") as { detail: Record<string, unknown> };
    expect(detail).toMatchObject({ source: SOURCE, basis: "source", added: 4, revoked: 0 });
    expect(detail.granted).toContain(`write user:${bo}`);
  });

  it("are followed: what the source takes away is revoked, and a person's own grant is left alone", async () => {
    await put("plan.txt", [entry(user("aad-ana")), entry(group("aad-finance"))]);
    await sync();
    const objectId = await objectOf("plan.txt");
    // Someone shares the file here, with the same person the source names.
    await db.withTenant(t.tenantId, (tx) =>
      addGrant(tx, t.tenantId, {
        principal: `user:${ana}`,
        role: "write",
        target: { objectId },
        grantedBy: `user:${t.userId}`,
      }),
    );

    // The source: Ana out, Bo in, the group may now write. And the file changed.
    await put(
      "plan.txt",
      [entry(user("x", "bo@corp.test")), entry(group("aad-finance"), { role: "owner" })],
      "second draft",
    );
    const second = await sync();
    expect(second.counts).toMatchObject({ grantsAdded: 2, grantsRevoked: 2 });
    expect(await granted("plan.txt")).toEqual([`read user:${bo}`, `write group:${finance}`]);
    // Ana keeps what a person gave her, and only that.
    expect(await holds(ana, "plan.txt")).toBe("write");
    const kept = await db.withTenant(t.tenantId, (tx) =>
      tx
        .select()
        .from(grants)
        .where(and(eq(grants.objectId, objectId), eq(grants.grantedBy, `user:${t.userId}`))),
    );
    expect(kept).toMatchObject([{ revokedAt: null }]);
    // Revoked grants stay on record, revoked by the source.
    const revoked = await db.withTenant(t.tenantId, (tx) =>
      tx
        .select()
        .from(grants)
        .where(and(eq(grants.objectId, objectId), eq(grants.revokedBy, BY))),
    );
    expect(revoked).toHaveLength(2);

    // Nothing changed at the source: nothing is written, nothing audited.
    const events = (await imports()).length;
    await mem.write(["plan.txt"], enc.encode("third draft"));
    expect((await sync()).counts).toMatchObject({ ingested: 1, grantsAdded: 0, grantsRevoked: 0 });
    expect(await imports()).toHaveLength(events);

    // The source takes everything away.
    mem.setAcl(["plan.txt"], []);
    await mem.write(["plan.txt"], enc.encode("fourth draft"));
    expect((await sync()).counts).toMatchObject({ grantsRevoked: 2 });
    expect(await granted("plan.txt")).toEqual([]);
    expect(await holds(bo, "plan.txt")).toBeUndefined();
  });

  it("never match a provisioned user by email, or a service account at all", async () => {
    await put("plan.txt", [
      // The source's id is unknown here; the email is a provisioned user's.
      entry(user("aad-someone-else", "ana@corp.test")),
      entry({ kind: "guest", email: "ana@corp.test" }),
    ]);
    const report = await sync();
    expect(report.counts).toMatchObject({ grantsAdded: 0, unmappedUsers: 2 });
    expect(await holds(ana, "plan.txt")).toBeUndefined();
    expect(await holds(robot, "plan.txt")).toBeUndefined();
  });

  it("are asked for again whenever the source mentions the item, changed or not", async () => {
    await put("plan.txt", [entry(user("aad-ana"))]);
    await put("other.txt", []);
    await sync();
    // A delta that mentions every item again, though none changed.
    const mentioning: Connector = {
      ...mem.connector,
      delta: (cursor, signal) =>
        (async function* () {
          for await (const e of mem.connector.crawl(null, signal)) if (e.type === "item") yield e;
          yield* (mem.connector.delta as NonNullable<Connector["delta"]>)(cursor, signal);
        })(),
    };
    mem.setAcl(["plan.txt"], [entry(group("aad-finance"))]);
    const before = mem.calls.read;
    const report = await sync(mentioning);
    expect(report).toMatchObject({ status: "done", phase: "delta" });
    expect(report.counts).toMatchObject({
      unchanged: 2,
      ingested: 0,
      grantsAdded: 1,
      grantsRevoked: 1,
    });
    expect(mem.calls.read).toBe(before);
    expect(await granted("plan.txt")).toEqual([`read group:${finance}`]);
    // Ana is in the group: she reads it still, another way.
    expect(await holds(ana, "plan.txt")).toBe("read");
  });

  it("that can't be read keep the item from being recorded: it waits, as for any failure", async () => {
    await put("plan.txt", [entry(user("aad-ana"))]);
    const answering = (answer: (acl: ItemAcl) => unknown): Connector => ({
      ...mem.connector,
      aclImport: async (ref, signal) =>
        answer(
          await (mem.connector.aclImport as NonNullable<Connector["aclImport"]>)(ref, signal),
        ) as ItemAcl,
    });
    // An answer that isn't an ACL: skipped, nothing recorded on its word.
    const nonsense = await sync(
      answering(() => ({ basis: "source", entries: [{ principal: "everyone", role: "admin" }] })),
    );
    expect(nonsense.skipped).toEqual([
      { externalId: expect.any(String) as string, reason: "invalid-acl" },
    ]);
    expect(nonsense.counts).toMatchObject({ ingested: 0, grantsAdded: 0 });
    await expect(objectOf("plan.txt")).rejects.toThrow();

    // The source won't say (throttled): the run stops and comes back.
    await mem.write(["plan.txt"], enc.encode("again"));
    const throttled = await sync(
      answering(() => {
        throw new ConnectorError("throttled", "slow down", { retryAfterMs: 120_000 });
      }),
    );
    expect(throttled).toMatchObject({ status: "retry", error: "throttled" });
    await expect(objectOf("plan.txt")).rejects.toThrow();

    // Then it does.
    expect((await sync()).counts).toMatchObject({ ingested: 1, grantsAdded: 1 });
  });

  it("stop granting to someone who has left, and a source with none of its own grants nothing", async () => {
    await put("plan.txt", [entry(user("aad-ana")), entry(user("b", "bo@corp.test"))]);
    await sync();
    await db.withTenant(t.tenantId, (tx) => retireUser(tx, t.tenantId, ana, "scim:test"));
    await mem.write(["plan.txt"], enc.encode("after she left"));
    const after = await sync();
    // Her grant went with her (core/identity); the source's word doesn't bring it back.
    expect(after.counts).toMatchObject({ grantsAdded: 0, unmappedUsers: 1 });
    expect(await granted("plan.txt")).toEqual([`read user:${bo}`]);

    // The connector now says the source has no permissions of its own: owner only.
    const ownerOnly: Connector = {
      ...mem.connector,
      aclImport: async () => ({ basis: "owner-only", entries: [] }),
    };
    await mem.write(["plan.txt"], enc.encode("owner only"));
    expect((await sync(ownerOnly)).counts).toMatchObject({ grantsRevoked: 1 });
    expect(await granted("plan.txt")).toEqual([]);

    // And one that imports none is never asked: only the owner, as items are recorded again.
    await put("plan.txt", [entry(user("b", "bo@corp.test"))], "back");
    await sync();
    expect(await granted("plan.txt")).toEqual([`read user:${bo}`]);
    const d = mem.connector.describe();
    const { aclImport: _dropped, ...rest } = mem.connector;
    const without = {
      ...rest,
      describe: () => ({ ...d, capabilities: { ...d.capabilities, aclImport: false } }),
    } as Connector;
    // Nothing changed at the source, and nothing need be recorded: taken back all the same,
    // when the run starts, and said once.
    const events = (await imports()).length;
    const calls = mem.calls.aclImport;
    const off = await sync(without);
    expect(off.counts).toMatchObject({ ingested: 0, grantsRevoked: 1 });
    expect(mem.calls.aclImport).toBe(calls);
    expect(await imports()).toHaveLength(events + 1);
    expect((await sync(without)).counts).toMatchObject({ grantsRevoked: 0 });
    expect(await imports()).toHaveLength(events + 1);
    expect(await granted("plan.txt")).toEqual([]);
  });

  it("are applied to what a file already is here when it can't be recorded, and withdrawn when they can't be read", async () => {
    await put("plan.txt", [entry(user("aad-ana")), entry(user("b", "bo@corp.test"))]);
    await sync();
    const real = {
      read: mem.connector.read,
      aclImport: mem.connector.aclImport as NonNullable<Connector["aclImport"]>,
    };

    // The source takes Ana away and changes the file, whose new bytes can't be read.
    mem.setAcl(["plan.txt"], [entry(user("b", "bo@corp.test"))]);
    await mem.write(["plan.txt"], enc.encode("second"));
    const unreadable: Connector = {
      ...mem.connector,
      read: async () => {
        throw new ConnectorError("permanent", "refused");
      },
    };
    const first = await sync(unreadable);
    expect(first.skipped).toEqual([
      { externalId: expect.any(String) as string, reason: "permanent" },
    ]);
    expect(first.counts).toMatchObject({ ingested: 0, grantsRevoked: 1 });
    expect(await granted("plan.txt")).toEqual([`read user:${bo}`]);

    // Its permissions can't be read at all (refused, or an answer that isn't one): what the
    // source had granted on it is withdrawn, not left as it was.
    for (const answer of [
      async () => {
        throw new ConnectorError("permanent", "refused");
      },
      async () => ({ basis: "source", entries: "everyone" }) as unknown as ItemAcl,
    ]) {
      await put("plan.txt", [entry(user("b", "bo@corp.test"))], `again ${Math.random()}`);
      await sync();
      expect(await granted("plan.txt")).toEqual([`read user:${bo}`]);
      await mem.write(["plan.txt"], enc.encode(`unknown ${Math.random()}`));
      const report = await sync({ ...mem.connector, aclImport: answer });
      expect(report.counts).toMatchObject({ ingested: 0, skipped: 1, grantsRevoked: 1 });
      expect(await granted("plan.txt")).toEqual([]);
    }

    // The source only slow to say: nothing is withdrawn, the run comes back.
    await put("plan.txt", [entry(user("b", "bo@corp.test"))], "restored");
    await sync();
    await mem.write(["plan.txt"], enc.encode("throttled"));
    const slow = await sync({
      ...mem.connector,
      aclImport: async () => {
        throw new ConnectorError("throttled", "slow down", { retryAfterMs: 120_000 });
      },
    });
    expect(slow).toMatchObject({ status: "retry", error: "throttled" });
    expect(await granted("plan.txt")).toEqual([`read user:${bo}`]);

    // Asked once for an item, however many tries reading it takes.
    let reads = 0;
    const asked = mem.calls.aclImport;
    const flaky: Connector = {
      ...mem.connector,
      aclImport: real.aclImport,
      read: async (ref, signal) => {
        if (++reads < 3) throw new ConnectorError("retryable", "try again");
        return real.read(ref, signal);
      },
    };
    expect((await sync(flaky)).counts).toMatchObject({ ingested: 1 });
    expect(reads).toBe(3);
    expect(mem.calls.aclImport - asked).toBe(1);
  });

  it("give one grant to one person however the source names them, and keep to its expiries", async () => {
    const day = 86_400_000;
    const from = Date.now();
    const at = (days: number) => new Date(from + days * day).toISOString();
    const expiryOf = async (principal: string) => {
      const objectId = await objectOf("plan.txt");
      const rows = await db.withTenant(t.tenantId, (tx) =>
        liveObjectGrantsBy(tx, t.tenantId, objectId, BY),
      );
      return rows.find((g) => g.principal === principal)?.expiresAt?.toISOString() ?? null;
    };
    // Bo three ways: by an unknown id with his email, as a guest by email, and to write.
    await put("plan.txt", [
      entry(user("x1", "bo@corp.test"), { expiresAt: at(2) }),
      entry({ kind: "guest", email: "bo@corp.test" }, { role: "write", expiresAt: at(5) }),
      entry(user("x2", "BO@corp.test"), { expiresAt: at(3) }),
      entry(user("aad-ana"), { expiresAt: at(2) }),
    ]);
    expect((await sync()).counts).toMatchObject({ grantsAdded: 2 });
    expect(await granted("plan.txt")).toEqual([`read user:${ana}`, `write user:${bo}`]);
    expect(await expiryOf(`user:${bo}`)).toBe(at(5));

    // Extended for Ana, made permanent for Bo (one of his entries has no expiry now).
    await put(
      "plan.txt",
      [
        entry(user("x1", "bo@corp.test"), { role: "write" }),
        entry({ kind: "guest", email: "bo@corp.test" }, { role: "write", expiresAt: at(5) }),
        entry(user("aad-ana"), { expiresAt: at(9) }),
      ],
      "v2",
    );
    expect((await sync()).counts).toMatchObject({ grantsAdded: 2, grantsRevoked: 2 });
    expect(await expiryOf(`user:${bo}`)).toBeNull();
    expect(await expiryOf(`user:${ana}`)).toBe(at(9));

    // A read that stays and a write lent for a while, to one person two ways: the read that
    // stays, never a write that stays.
    await put(
      "plan.txt",
      [
        entry(user("x1", "bo@corp.test")),
        entry(
          { kind: "guest", email: "bo@corp.test", id: "x9" },
          { role: "write", expiresAt: at(4) },
        ),
        entry(user("aad-ana"), { expiresAt: at(9) }),
      ],
      "v2b",
    );
    await sync();
    expect(await granted("plan.txt")).toEqual([`read user:${ana}`, `read user:${bo}`]);
    expect(await expiryOf(`user:${bo}`)).toBeNull();
    await put(
      "plan.txt",
      [
        entry(user("x1", "bo@corp.test"), { role: "write" }),
        entry({ kind: "guest", email: "bo@corp.test" }, { role: "write", expiresAt: at(5) }),
        entry(user("aad-ana"), { expiresAt: at(9) }),
      ],
      "v2c",
    );
    await sync();

    // An entry about to lapse is not made a grant; a role taken down is.
    await put(
      "plan.txt",
      [
        entry(user("x1", "bo@corp.test")),
        entry(user("aad-ana"), { expiresAt: new Date(Date.now() + 5_000).toISOString() }),
      ],
      "v3",
    );
    expect((await sync()).counts).toMatchObject({ grantsAdded: 1, grantsRevoked: 2 });
    expect(await granted("plan.txt")).toEqual([`read user:${bo}`]);
  });

  /** What is kept of the source's sharing of a file beyond grants, as text, sorted. */
  async function shared(name: string): Promise<string[]> {
    const objectId = await objectOf(name);
    const rows = await db.withTenant(t.tenantId, (tx) =>
      tx.select().from(sourceShares).where(eq(sourceShares.objectId, objectId)),
    );
    return rows
      .map(
        (r) =>
          `${r.kind} ${r.key} ${r.role}${r.inherited ? " inherited" : ""}${r.matched ? " matched" : ""}${r.expiresAt ? ` until ${r.expiresAt.toISOString().slice(0, 10)}` : ""}`,
      )
      .sort();
  }

  it("keep what the source shares beyond grants: links, the organization, guests, the unmatched (T-1001)", async () => {
    await put("deck.txt", [
      entry(user("aad-ana")),
      entry(group("aad-finance"), { role: "write" }),
      entry({ kind: "link", id: "L1", scope: "anyone" }, { expiresAt: "2999-01-01T00:00:00Z" }),
      entry({ kind: "link", id: "L2", scope: "organization" }, { role: "write", inherited: true }),
      // A link that has lapsed shares nothing.
      entry({ kind: "link", id: "L3", scope: "anyone" }, { expiresAt: "2001-01-01T00:00:00Z" }),
      entry({ kind: "organization" }),
      entry({ kind: "guest", email: "pat@client.test" }),
      entry({ kind: "guest", email: "stranger@else.test" }),
      entry(user("aad-nobody")),
      entry(group("aad-unknown")),
    ]);
    await put("plain.txt", [entry(user("aad-ana"))]);
    await sync();
    // Those matched are grants, and only grants; the rest is kept as said, giving nobody anything.
    expect(await granted("deck.txt")).toEqual(
      [`read user:${ana}`, `read user:${guest}`, `write group:${finance}`].sort(),
    );
    expect(await shared("deck.txt")).toEqual([
      "group aad-unknown read",
      "guest pat@client.test read matched",
      "guest stranger@else.test read",
      "link-anyone L1 read until 2999-01-01",
      "link-organization L2 write inherited",
      "organization  read",
      "user aad-nobody read",
    ]);
    expect(await shared("plain.txt")).toEqual([]);

    // Followed like grants, with no grant changing: nothing is audited for it.
    const audited = (await imports()).length;
    mem.setAcl(
      ["deck.txt"],
      [
        entry(user("aad-ana")),
        entry(group("aad-finance"), { role: "write" }),
        entry({ kind: "guest", email: "pat@client.test" }),
        entry({ kind: "link", id: "L4", scope: "specific" }),
      ],
    );
    // (A delta that mentions every item again, as a source reporting a sharing change does.)
    const mentioning: Connector = {
      ...mem.connector,
      delta: (cursor, signal) =>
        (async function* () {
          for await (const e of mem.connector.crawl(null, signal)) if (e.type === "item") yield e;
          yield* (mem.connector.delta as NonNullable<Connector["delta"]>)(cursor, signal);
        })(),
    };
    const again = await sync(mentioning);
    expect(again.counts).toMatchObject({ grantsAdded: 0, grantsRevoked: 0 });
    expect(await shared("deck.txt")).toEqual([
      "guest pat@client.test read matched",
      "link-specific L4 read",
    ]);
    expect((await imports()).length).toBe(audited);

    // Gone with the object's permissions being no longer imported, and with the object.
    await sync({ ...mem.connector, aclImport: undefined } as unknown as Connector);
    expect(await shared("deck.txt")).toEqual([]);
  });

  it("keep who made and last changed a file, and when, for items already recorded too (T-1001)", async () => {
    await put("plan.txt", []);
    await sync();
    const facts = async () => {
      const [row] = await db.withTenant(t.tenantId, (tx) =>
        tx
          .select({
            at: sourceRefs.sourceModifiedAt,
            by: sourceRefs.sourceModifiedBy,
            made: sourceRefs.sourceCreatedBy,
          })
          .from(sourceRefs)
          .where(eq(sourceRefs.source, SOURCE)),
      );
      return row;
    };
    const recorded = await facts();
    expect(recorded).toMatchObject({ by: null, made: null });
    // The source says more of the same, unchanged item: kept without recording it again.
    const saying: Connector = {
      ...mem.connector,
      delta: (cursor, signal) =>
        (async function* () {
          for await (const e of mem.connector.crawl(null, signal)) {
            if (e.type === "item") {
              yield {
                ...e,
                item: {
                  ...e.item,
                  modifiedAt: e.item.modifiedAt ?? "2020-02-02T02:02:02Z",
                  modifiedBy: { id: "aad-ana" },
                  createdBy: { id: "aad-gone", name: "Gone" },
                },
              };
            }
          }
          yield* (mem.connector.delta as NonNullable<Connector["delta"]>)(cursor, signal);
        })(),
    };
    const before = mem.calls.read;
    const report = await sync(saying);
    expect(report.counts).toMatchObject({ unchanged: 1, ingested: 0 });
    expect(mem.calls.read).toBe(before);
    expect(await facts()).toMatchObject({ by: "aad-ana", made: "aad-gone" });
    expect((await facts())?.at).toBeInstanceOf(Date);
  });
});
