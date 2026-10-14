import { type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant } from "@openhoard/core-db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendAudit, verifyAudit, type AuditRecord } from "./store.js";
import {
  auditedExport,
  AuditFilterError,
  ExportFailed,
  listAudit,
  MAX_AUDIT_PAGE,
  parseAuditFilter,
} from "./view.js";

/* Reading the log for people (T-905): pages newest first, and an export that records itself. */

let db: Database;
let tenant: string;
let other: string;
const T0 = Date.parse("2026-10-01T10:00:00.000Z");
const at = (minute: number) => new Date(T0 + minute * 60_000);

beforeAll(async () => {
  db = await openTestDatabase();
  tenant = (await seedTenant(db, 1)).tenantId;
  other = (await seedTenant(db, 2)).tenantId;
  const records: AuditRecord[] = [
    { actor: "user:ana", action: "source.run-now", decision: "allow", detail: { source: "a" } },
    { actor: "user:ana", action: "search", decision: "allow", client: "claude" },
    { actor: "user:bo", action: "source.resume", decision: "deny" },
    { actor: "user:bo", action: "sourcex", decision: "allow" },
    { actor: "user:ana", action: "share.link", decision: "allow" },
  ];
  for (const [i, r] of records.entries()) {
    await db.withTenant(tenant, (tx) => appendAudit(tx, tenant, r, at(i)));
  }
  await db.withTenant(other, (tx) =>
    appendAudit(tx, other, { actor: "user:zed", action: "search", decision: "allow" }, at(0)),
  );
}, 60_000);
afterAll(() => db?.close());

describe("listAudit", () => {
  it("pages the tenant's events newest first, and only its own", async () => {
    const first = await listAudit(db, tenant, {}, { limit: 2 });
    expect(first.events.map((e) => e.action)).toEqual(["share.link", "sourcex"]);
    expect(first.events.every((e) => e.tenantId === tenant && /^[0-9a-f]{64}$/.test(e.hash))).toBe(
      true,
    );
    expect(first.next).toBe(first.events.at(-1)?.seq);
    const second = await listAudit(db, tenant, {}, { limit: 2, before: first.next ?? 0 });
    expect(second.events.map((e) => e.action)).toEqual(["source.resume", "search"]);
    const last = await listAudit(db, tenant, {}, { limit: 2, before: second.next ?? 0 });
    expect(last).toMatchObject({ events: [{ action: "source.run-now" }], next: null });
    expect((await listAudit(db, other, {})).events.map((e) => e.actor)).toEqual(["user:zed"]);
  });

  it("filters as the export does, and by an action's start, taken literally", async () => {
    const actions = async (filter: Parameters<typeof listAudit>[2]) =>
      (await listAudit(db, tenant, filter)).events.map((e) => e.action);
    expect(await actions({ actionPrefix: "source." })).toEqual(["source.resume", "source.run-now"]);
    // `%` and `_` are characters here, not patterns (no action holds them).
    expect(await actions({ actionPrefix: "%" })).toEqual([]);
    expect(await actions({ actionPrefix: "s_urce" })).toEqual([]);
    expect(await actions({ actor: "user:bo", decision: "deny" })).toEqual(["source.resume"]);
    expect(await actions({ from: at(1), to: at(3) })).toEqual(["source.resume", "search"]);
  });

  it("refuses a page size or a cursor out of range", async () => {
    for (const limit of [0, MAX_AUDIT_PAGE + 1, 1.5]) {
      await expect(listAudit(db, tenant, {}, { limit })).rejects.toThrow(RangeError);
    }
    await expect(listAudit(db, tenant, {}, { before: 0 })).rejects.toThrow(RangeError);
    await expect(listAudit(db, tenant, { from: new Date(Number.NaN) })).rejects.toThrow(RangeError);
  });
});

describe("auditedExport", () => {
  it("records an export after it, with what was asked, so the next one shows it", async () => {
    const out: string[] = [];
    const n = await auditedExport(
      db,
      other,
      { actor: "user:zed", client: "openhoard-admin", asked: { action: "search" } },
      { action: "search" },
      "csv",
      (c) => void out.push(c),
    );
    expect(n).toBe(1);
    // The header and one event: the record of this export isn't in it.
    expect(out).toHaveLength(2);
    const { events } = await listAudit(db, other, { action: "audit.export" });
    expect(events).toMatchObject([
      {
        actor: "user:zed",
        client: "openhoard-admin",
        decision: "allow",
        detail: { format: "csv", events: 1, action: "search" },
      },
    ]);
    expect(await verifyAudit(db, other)).toMatchObject({ ok: true });
  });

  it("records a reader going away part way as incomplete, and says how far it got", async () => {
    let calls = 0;
    const failed = await auditedExport(
      db,
      tenant,
      { actor: "user:ana", asked: {} },
      {},
      "ndjson",
      () => {
        if (++calls === 3) throw new Error("the reader went away");
      },
    ).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(ExportFailed);
    expect(failed).toMatchObject({ events: 3, recorded: true });
    const [record] = (await listAudit(db, tenant, { action: "audit.export" })).events;
    expect(record?.detail).toEqual({ format: "ndjson", events: 3, incomplete: true });
  });
});

describe("parseAuditFilter", () => {
  it("reads what a person typed, and what to record of it", () => {
    expect(
      parseAuditFilter({ actionPrefix: "source.", decision: "deny", from: "2026-10-01" }),
    ).toEqual({
      filter: { actionPrefix: "source.", decision: "deny", from: new Date("2026-10-01") },
      asked: { actionPrefix: "source.", decision: "deny", from: "2026-10-01T00:00:00.000Z" },
    });
    expect(parseAuditFilter({ to: "2026-10-01T09:30:00+02:00" }).filter.to).toEqual(
      new Date("2026-10-01T07:30:00Z"),
    );
  });

  it("names the field it refuses", () => {
    const refused: [Parameters<typeof parseAuditFilter>[0], string][] = [
      [{ actor: "" }, "actor"],
      [{ object: "x".repeat(1025) }, "object"],
      [{ client: "a\0b" }, "client"],
      [{ actionPrefix: "\ud800" }, "actionPrefix"],
      [{ decision: "maybe" }, "decision"],
      [{ from: "2026-02-30" }, "from"],
      [{ to: "2026-10-01T24:00Z" }, "to"],
      [{ from: "2026-10-01", to: "2026-10-01" }, "from"],
    ];
    for (const [text, field] of refused) {
      const e = (() => {
        try {
          parseAuditFilter(text);
        } catch (err) {
          return err;
        }
      })();
      expect(e, JSON.stringify(text)).toBeInstanceOf(AuditFilterError);
      expect((e as AuditFilterError).field).toBe(field);
    }
  });

  it("takes a backslash in an action's start literally", async () => {
    const { filter } = parseAuditFilter({ actionPrefix: "source\\" });
    expect((await listAudit(db, tenant, filter)).events).toEqual([]);
  });
});
