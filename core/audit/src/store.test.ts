import { createHash } from "node:crypto";
import {
  auditEvents,
  isRetryable,
  objects,
  queryRows,
  sqlState,
  type Database,
  type Tx,
} from "@openhoard/core-db";
import { openTestDatabase, seedTenant, TEST_POSTGRES_ENV } from "@openhoard/core-db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvent, GENESIS_HASH, hashedText, type AuditEvent } from "./chain.js";
import { appendAudit, verifyAudit, type AuditRecord } from "./store.js";

/* The audit store (T-701) on a real database: PGlite here, PostgreSQL in the postgres CI job. */

let db: Database;
let tenant: string;
beforeEach(async () => {
  db = await openTestDatabase();
  tenant = (await seedTenant(db, 1)).tenantId;
});
afterEach(() => db?.close());

const record = (n: number): AuditRecord => ({
  actor: "user:u1",
  action: n % 2 ? "open" : "search",
  decision: "allow",
  client: "claude",
  object: `obj-${n}`,
  detail: { n, query: `q${n}`, exact: n % 3 === 0 },
});
const append = (n: number, t = tenant) => db.withTenant(t, (tx) => appendAudit(tx, t, record(n)));

/** Runs `work` as the tables' owner with the append-only guards off, as a hostile admin would. */
async function tamper(work: (tx: Tx) => Promise<unknown>) {
  await db.withTenant(tenant, async (tx) => {
    await tx.execute(sql`alter table audit.events disable trigger events_append_only`);
    await tx.execute(sql`alter table audit.events no force row level security`);
    await work(tx);
    await tx.execute(sql`alter table audit.events force row level security`);
    await tx.execute(sql`alter table audit.events enable trigger events_append_only`);
  });
}

describe("appendAudit", () => {
  it("chains events per tenant, stamped with the store's time", async () => {
    const now = new Date("2026-09-24T01:02:03.456Z");
    const first = await db.withTenant(tenant, (tx) => appendAudit(tx, tenant, record(1), now));
    const second = await append(2);
    expect(first).toMatchObject({
      tenantId: tenant,
      seq: 1,
      prevHash: GENESIS_HASH,
      at: now.toISOString(),
    });
    expect(second).toMatchObject({ seq: 2, prevHash: first.hash });
    expect(await verifyAudit(db, tenant)).toEqual({ ok: true, count: 2, head: second.hash });
  });

  it("keeps each tenant's chain separate", async () => {
    const other = (await seedTenant(db, 2)).tenantId;
    await append(1);
    await append(1, other);
    await append(2);
    expect(await verifyAudit(db, tenant)).toMatchObject({ ok: true, count: 2 });
    expect(await verifyAudit(db, other)).toMatchObject({ ok: true, count: 1 });
    // Appending to another tenant from this tenant's transaction is refused.
    await expect(
      db.withTenant(tenant, (tx) => appendAudit(tx, other, record(9))),
    ).rejects.toThrow();
  });

  it("never forks the chain under concurrent appends", async () => {
    const events = await Promise.all(Array.from({ length: 25 }, (_, i) => append(i)));
    expect(events.map((e) => e.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
    expect(await verifyAudit(db, tenant)).toMatchObject({ ok: true, count: 25 });
  });

  it("rolls back with the transaction it belongs to", async () => {
    await append(1);
    const failing = db.withTenant(tenant, async (tx) => {
      await appendAudit(tx, tenant, record(2));
      throw new Error("the action failed");
    });
    await expect(failing).rejects.toThrow("the action failed");
    expect(await append(3)).toMatchObject({ seq: 2 });
    expect(await verifyAudit(db, tenant)).toMatchObject({ ok: true, count: 2 });
  });
});

describe("appendAudit and isolation levels", () => {
  it("appends in a SERIALIZABLE transaction, with the action it records", async () => {
    await append(1);
    const event = await db.withTenant(
      tenant,
      async (tx) => {
        await tx.update(objects).set({ title: "Renamed.docx" });
        return appendAudit(tx, tenant, record(2));
      },
      { isolationLevel: "serializable" },
    );
    expect(event.seq).toBe(2);
    expect(await verifyAudit(db, tenant)).toMatchObject({ ok: true, count: 2 });
  });

  it("refuses REPEATABLE READ, whose snapshot predates the lock", async () => {
    const attempt = db.withTenant(tenant, (tx) => appendAudit(tx, tenant, record(1)), {
      isolationLevel: "repeatable read",
    });
    await expect(attempt).rejects.toThrow(
      "needs a READ COMMITTED or SERIALIZABLE transaction, not repeatable read",
    );
  });

  it("refuses a read-only transaction, before anything else", async () => {
    for (const isolationLevel of ["read committed", "repeatable read", "serializable"] as const) {
      const attempt = db.withTenant(tenant, (tx) => appendAudit(tx, tenant, record(1)), {
        isolationLevel,
        accessMode: "read only",
      });
      await expect(attempt).rejects.toThrow("can't write in a read-only transaction");
    }
  });

  it("records a read after its read-only snapshot, in a transaction of its own", async () => {
    const rows = await db.withTenant(tenant, (tx) => tx.select().from(objects), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
    const event = await db.withTenant(tenant, (tx) =>
      appendAudit(tx, tenant, { ...record(1), object: rows[0]?.id ?? "none" }),
    );
    expect(event).toMatchObject({ seq: 1, object: rows[0]?.id });
  });

  describe.runIf(process.env[TEST_POSTGRES_ENV])("racing appends (PostgreSQL)", () => {
    it.each(["serializable", "read committed"] as const)(
      "fail a SERIALIZABLE append that lost to a %s one with 40001, and never fork",
      async (winner) => {
        await append(1);
        let committed!: () => void;
        const aDone = new Promise<void>((resolve) => (committed = resolve));
        // B's snapshot is taken first (withTenant's first statement); it appends only after A
        // committed, so the head it reads is stale.
        const b = db.withTenant(
          tenant,
          async (tx) => {
            await aDone;
            return appendAudit(tx, tenant, record(3));
          },
          { isolationLevel: "serializable" },
        );
        const a = await db.withTenant(tenant, (tx) => appendAudit(tx, tenant, record(2)), {
          isolationLevel: winner,
        });
        committed();
        const failure: unknown = await b.then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(a.seq).toBe(2);
        // PostgreSQL reports 40001 itself between two SERIALIZABLE transactions, and a
        // duplicate key when the winner wasn't one; appendAudit reports that as 40001 too.
        expect(sqlState(failure)).toBe("40001");
        expect(isRetryable(failure)).toBe(true);
        expect(await verifyAudit(db, tenant)).toMatchObject({ ok: true, count: 2 });
        // Run again, it goes through.
        const retried = await db.withTenant(tenant, (tx) => appendAudit(tx, tenant, record(3)), {
          isolationLevel: "serializable",
        });
        expect(retried).toMatchObject({ seq: 3, prevHash: a.hash });
        expect(await verifyAudit(db, tenant)).toMatchObject({ ok: true, count: 3 });
      },
    );
  });

  it("never forks under concurrent SERIALIZABLE appends that retry", async () => {
    const appendRetrying = async (n: number): Promise<AuditEvent> => {
      for (;;) {
        try {
          return await db.withTenant(tenant, (tx) => appendAudit(tx, tenant, record(n)), {
            isolationLevel: "serializable",
          });
        } catch (e) {
          if (!isRetryable(e)) throw e;
        }
      }
    };
    const events = await Promise.all(Array.from({ length: 10 }, (_, i) => appendRetrying(i)));
    expect(events.map((e) => e.seq).sort((x, y) => x - y)).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 1),
    );
    expect(await verifyAudit(db, tenant)).toMatchObject({ ok: true, count: 10 });
  });
});

describe("appendAudit refuses", () => {
  it.each([
    ["a lone surrogate", { object: `file${String.fromCharCode(0xd800)}.txt` }],
    ["a NUL character", { actor: `user:u1${String.fromCharCode(0)}` }],
    ["a lone surrogate in the detail", { detail: { q: String.fromCharCode(0xdc00) } }],
  ])("text with %s, which the database would store differently", async (_, patch) => {
    const attempt = db.withTenant(tenant, (tx) =>
      appendAudit(tx, tenant, { ...record(1), ...patch }),
    );
    await expect(attempt).rejects.toThrow("is not well-formed text");
  });

  it("times the database would read back differently", async () => {
    for (const now of [new Date("0005-01-01T00:00:00Z"), new Date("x"), new Date(-1)]) {
      const attempt = db.withTenant(tenant, (tx) => appendAudit(tx, tenant, record(1), now));
      await expect(attempt).rejects.toThrow("audit time out of range");
    }
  });

  it("a top-level field that is bad, whatever the detail holds under the same key", async () => {
    // The detail used to be merged over the record before checking, hiding the real field.
    const shadowed = {
      ...record(1),
      object: `x${String.fromCharCode(0xd800)}`,
      detail: { object: "fine", actor: "user:fine" },
    };
    await expect(db.withTenant(tenant, (tx) => appendAudit(tx, tenant, shadowed))).rejects.toThrow(
      "audit field object is not well-formed text",
    );
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["an actor that isn't text", { actor: 42 }, "actor is not well-formed text"],
    ["an actor that isn't a principal", { actor: "nobody" }, "actor is not a principal"],
    ["an empty action", { action: "" }, "action is not well-formed text"],
    ["an action that isn't a name", { action: "Open File" }, "action is not an action name"],
    ["an unknown decision", { decision: "maybe" }, "decision is not allow or deny"],
    ["a client that isn't text", { client: 5 }, "client is not well-formed text"],
    ["an empty object", { object: "" }, "object is not well-formed text"],
    ["a version that is null", { version: null }, "version is not well-formed text"],
    ["a detail that is a list", { detail: ["a"] }, "detail is not an object"],
    ["a detail that is null", { detail: null }, "detail is not an object"],
    ["a detail number JSON can't hold", { detail: { n: Number.NaN } }, "detail.n is not finite"],
    ["a nested detail", { detail: { n: { deep: 1 } } }, "detail.n is not a string, number"],
    ["a chain field", { seq: 7 }, "audit field seq is not part of a record"],
    ["a hash", { hash: "0".repeat(64) }, "audit field hash is not part of a record"],
  ])("%s", async (_, patch, message) => {
    const bad = { ...record(1), ...patch } as unknown as AuditRecord;
    await expect(db.withTenant(tenant, (tx) => appendAudit(tx, tenant, bad))).rejects.toThrow(
      message,
    );
  });

  it("not a record at all", async () => {
    for (const bad of [null, "open", ["open"]]) {
      await expect(
        db.withTenant(tenant, (tx) => appendAudit(tx, tenant, bad as unknown as AuditRecord)),
      ).rejects.toThrow("an audit record is an object");
    }
  });
});

describe("the database", () => {
  const raw = (seq: number, prevHash: string, hash: string) =>
    db.withTenant(tenant, (tx) =>
      tx.insert(auditEvents).values({
        tenantId: tenant,
        seq,
        at: new Date(),
        actor: "user:x",
        action: "open",
        decision: "allow",
        event: "{}",
        prevHash,
        hash,
      }),
    );

  it("refuses inserts that do not extend the chain", async () => {
    const first = await append(1);
    const sqlState = (p: Promise<unknown>) =>
      p.then(
        () => "no error",
        (e: { code?: string; cause?: { code?: string } }) => e.cause?.code ?? e.code,
      );
    expect(await sqlState(raw(5, first.hash, "a".repeat(64)))).toBe("23514");
    expect(await sqlState(raw(2, "b".repeat(64), "a".repeat(64)))).toBe("23514");
    // Rewriting an existing position is not extending the chain either.
    expect(await sqlState(raw(1, GENESIS_HASH, "a".repeat(64)))).toBe("23514");
  });

  describe("refuses a row in the right place that doesn't check out", () => {
    const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
    /** The row appendAudit would insert next, after `head`. */
    const next = (head: AuditEvent | undefined) => {
      const e = appendEvent(head, {
        ...record(9),
        tenantId: tenant,
        at: "2026-09-24T01:02:03.456Z",
      });
      return {
        tenantId: tenant,
        seq: e.seq,
        at: new Date(e.at),
        actor: e.actor,
        action: e.action,
        decision: e.decision,
        client: e.client ?? null,
        object: e.object ?? null,
        version: e.version ?? null,
        event: hashedText(e),
        prevHash: e.prevHash,
        hash: e.hash,
      };
    };
    type Row = ReturnType<typeof next>;
    /** Rewrites the stored event, with a hash that matches the new text. */
    const withEvent = (row: Row, change: (e: Record<string, unknown>) => unknown): Row => {
      const text = JSON.stringify(change(JSON.parse(row.event) as Record<string, unknown>));
      return { ...row, event: text, hash: sha256(text) };
    };
    const reText = (row: Row, text: string): Row => ({ ...row, event: text, hash: sha256(text) });

    it.each<[string, (row: Row) => Row]>([
      ["a hash that isn't the event's", (r) => ({ ...r, hash: "a".repeat(64) })],
      ["an edited event under its old hash", (r) => ({ ...r, event: r.event.replace("q9", "qX") })],
      ["an event naming another actor", (r) => withEvent(r, (e) => ({ ...e, actor: "user:eve" }))],
      ["an event naming another tenant", (r) => withEvent(r, (e) => ({ ...e, tenantId: "ten_x" }))],
      ["an event with another seq", (r) => withEvent(r, (e) => ({ ...e, seq: 99 }))],
      [
        "an event with another link",
        (r) => withEvent(r, (e) => ({ ...e, prevHash: "c".repeat(64) })),
      ],
      ["an event without its object", (r) => withEvent(r, (e) => ({ ...e, object: undefined }))],
      ["an event with a client the row lacks", (r) => ({ ...r, client: null })],
      [
        "an event at another time",
        (r) => withEvent(r, (e) => ({ ...e, at: "2026-09-24T01:02:03Z" })),
      ],
      [
        "a time finer than milliseconds",
        // A Date can't hold microseconds; the database can.
        (r) => ({
          ...r,
          at: sql`${r.at.toISOString()}::timestamptz + interval '1 microsecond'` as unknown as Date,
        }),
      ],
      ["an event carrying a hash", (r) => withEvent(r, (e) => ({ ...e, hash: r.hash }))],
      ["an event with a field of its own", (r) => withEvent(r, (e) => ({ ...e, extra: 1 }))],
      ["a nested detail", (r) => withEvent(r, (e) => ({ ...e, detail: { n: { deep: 1 } } }))],
      ["an event that is a list", (r) => reText(r, "[]")],
      ["an event that isn't JSON", (r) => reText(r, "{")],
    ])("%s", async (_, spoil) => {
      const head = await append(1);
      const good = next(head);
      const bad = spoil(good);
      const insert = (row: Row) =>
        db.withTenant(tenant, (tx) => tx.insert(auditEvents).values(row));
      expect(
        await insert(bad).then(
          () => "no error",
          (e: unknown) => sqlState(e),
        ),
      ).toBe("23514");
      // The row as appendAudit makes it goes in, and the chain still verifies.
      await insert(good);
      expect(await verifyAudit(db, tenant)).toMatchObject({ ok: true, count: 2 });
    });
  });

  it("accepts a batch that extends the chain row by row", async () => {
    const events: AuditEvent[] = [];
    for (let i = 0; i < 3; i++) {
      events.push(
        appendEvent(events.at(-1), {
          ...record(i),
          tenantId: tenant,
          at: new Date(i).toISOString(),
        }),
      );
    }
    await db.withTenant(tenant, (tx) =>
      tx.insert(auditEvents).values(
        events.map((e) => ({
          tenantId: tenant,
          seq: e.seq,
          at: new Date(e.at),
          actor: e.actor,
          action: e.action,
          decision: e.decision,
          client: e.client ?? null,
          object: e.object ?? null,
          version: null,
          event: hashedText(e),
          prevHash: e.prevHash,
          hash: e.hash,
        })),
      ),
    );
    expect(await verifyAudit(db, tenant)).toMatchObject({ ok: true, count: 3 });
  });
});

describe("append-only", () => {
  it("changes and deletes match nothing, and truncation is refused", async () => {
    await append(1);
    await db.withTenant(tenant, async (tx) => {
      await tx.update(auditEvents).set({ actor: "user:someone-else" });
      await tx.delete(auditEvents);
    });
    expect(await verifyAudit(db, tenant)).toMatchObject({ ok: true, count: 1 });
    const truncate = db.withTenant(tenant, (tx) => tx.execute(sql`truncate audit.events`));
    await expect(truncate).rejects.toThrow();
  });

  it("refuses changes even where row-level security does not apply", async () => {
    await append(1);
    // Row-level security off (as for a superuser): the trigger still refuses.
    const update = db.withTenant(tenant, async (tx) => {
      await tx.execute(sql`alter table audit.events no force row level security`);
      await tx.update(auditEvents).set({ actor: "user:x" });
    });
    await expect(update).rejects.toThrow();
  });
});

describe("verifyAudit", () => {
  beforeEach(async () => {
    for (let i = 1; i <= 5; i++) await append(i);
  });

  it("accepts an intact chain across pages", async () => {
    expect(await verifyAudit(db, tenant, { pageSize: 2 })).toMatchObject({ ok: true, count: 5 });
  });

  it("accepts an empty chain", async () => {
    const empty = (await seedTenant(db, 3)).tenantId;
    expect(await verifyAudit(db, empty)).toEqual({ ok: true, count: 0, head: GENESIS_HASH });
  });

  it.each([
    [
      "an edited event",
      sql`update audit.events set event = replace(event, '"q3"', '"q-edited"') where seq = 3`,
      { seq: 3, problem: "content altered", count: 2 },
    ],
    ["a deleted event", sql`delete from audit.events where seq = 2`, { seq: 3, count: 1 }],
    [
      "an edited column",
      sql`update audit.events set object = 'obj-other' where seq = 4`,
      { seq: 4, problem: "column object disagrees with the event", count: 3 },
    ],
    [
      "an edited time",
      sql`update audit.events set at = at + interval '1 hour' where seq = 1`,
      { seq: 1, problem: "column at disagrees with the event", count: 0 },
    ],
    [
      "re-serialized event text",
      sql`update audit.events set event = event || ' ' where seq = 5`,
      { seq: 5, problem: "event text is not canonical", count: 4 },
    ],
    [
      "unparseable event text",
      sql`update audit.events set event = '{' where seq = 2`,
      { seq: 2, problem: "event is not valid JSON", count: 1 },
    ],
  ])("detects %s", async (_, change, expected) => {
    await tamper((tx) => tx.execute(change));
    expect(await verifyAudit(db, tenant, { pageSize: 2 })).toMatchObject({
      ok: false,
      ...expected,
    });
  });

  it("cannot see events removed from the end of the chain: that needs an anchor", async () => {
    const before = await verifyAudit(db, tenant);
    await tamper((tx) => tx.execute(sql`delete from audit.events where seq > 3`));
    const after = await verifyAudit(db, tenant);
    expect(after).toMatchObject({ ok: true, count: 3 });
    // The head moved: an anchored head from before would not match.
    expect(before.ok && after.ok && before.head !== after.head).toBe(true);
  });

  it("refuses page sizes that could never finish", async () => {
    for (const pageSize of [0, -1, 1.5, Number.NaN]) {
      await expect(verifyAudit(db, tenant, { pageSize })).rejects.toThrow("invalid pageSize");
    }
  });

  it("detects rows moved between tenants", async () => {
    const other = (await seedTenant(db, 2)).tenantId;
    await append(1, other);
    await tamper(async (tx) => {
      await tx.execute(sql`set local app.tenant_id = ''`);
      await tx.execute(
        sql`update audit.events set seq = seq + 100, tenant_id = ${tenant} where tenant_id = ${other}`,
      );
    });
    const result = await verifyAudit(db, tenant);
    expect(result).toMatchObject({
      ok: false,
      seq: 101,
      problem: "column tenant_id disagrees with the event",
      count: 5,
    });
  });

  it("stores exactly the text it hashed", async () => {
    const rows = await db.withTenant(tenant, (tx) =>
      queryRows<{ event: string }>(tx, sql`select event from audit.events where seq = 1`),
    );
    const parsed = JSON.parse(rows[0]?.event ?? "{}") as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
    expect(parsed).toMatchObject({
      seq: 1,
      tenantId: tenant,
      detail: { n: 1, query: "q1", exact: false },
    });
    expect(parsed).not.toHaveProperty("hash");
    const [row] = await db.withTenant(tenant, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.seq, 1)),
    );
    expect(row?.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
