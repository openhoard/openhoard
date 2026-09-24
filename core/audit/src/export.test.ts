import { auditEvents, type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant } from "@openhoard/core-db/testing";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, hashedText, type AuditEvent } from "./chain.js";
import { csvLine, CSV_COLUMNS, exportAudit, filterConditions, type AuditFilter } from "./export.js";
import { appendAudit, verifyAudit, type AuditRecord } from "./store.js";

/* Audit export (T-703): what it writes must be exactly what the same query returns. */

let db: Database;
let tenant: string;
const T0 = Date.parse("2026-09-24T10:00:00.000Z");
const at = (minute: number) => new Date(T0 + minute * 60_000);

beforeAll(async () => {
  db = await openTestDatabase();
  tenant = (await seedTenant(db, 1)).tenantId;
  const records: AuditRecord[] = [
    {
      actor: "user:ana",
      action: "search",
      decision: "allow",
      client: "claude",
      detail: { q: "q3 plan" },
    },
    {
      actor: "user:ana",
      action: "open",
      decision: "allow",
      client: "claude",
      object: "obj_a",
      version: "ver_1",
    },
    { actor: "user:bo", action: "open", decision: "deny", client: "chatgpt", object: "obj_b" },
    { actor: "user:bo", action: "open", decision: "allow", object: "obj_a" },
    // Hostile text for the CSV: a formula, quotes, commas and a line break.
    {
      actor: "user:eve",
      action: "tag",
      decision: "deny",
      object: '=HYPERLINK("http://x","y")',
      detail: { note: 'a "b", c\nd' },
    },
    { actor: "user:ana", action: "open", decision: "allow", client: "claude", object: "obj_b" },
  ];
  for (const [i, r] of records.entries()) {
    await db.withTenant(tenant, (tx) => appendAudit(tx, tenant, r, at(i)));
  }
}, 60_000);
afterAll(() => db?.close());

async function run(filter: AuditFilter, format: "ndjson" | "csv", pageSize?: number) {
  const chunks: string[] = [];
  const count = await exportAudit(
    db,
    tenant,
    filter,
    format,
    async (c) => {
      await Promise.resolve();
      chunks.push(c);
    },
    pageSize === undefined ? {} : { pageSize },
  );
  return { count, text: chunks.join("") };
}

/** The same filter as a plain query, for comparison. */
const expected = (filter: AuditFilter) =>
  db.withTenant(tenant, (tx) =>
    tx
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenant), ...filterConditions(filter)))
      .orderBy(asc(auditEvents.seq)),
  );

const ndjson = (text: string) =>
  text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AuditEvent);

describe("exportAudit", () => {
  it.each<[string, AuditFilter, number[]]>([
    ["everything", {}, [1, 2, 3, 4, 5, 6]],
    ["by actor", { actor: "user:ana" }, [1, 2, 6]],
    ["by action", { action: "open" }, [2, 3, 4, 6]],
    ["by decision", { decision: "deny" }, [3, 5]],
    ["by client", { client: "claude" }, [1, 2, 6]],
    ["by object", { object: "obj_a" }, [2, 4]],
    ["from a time, inclusive", { from: at(4) }, [5, 6]],
    ["to a time, exclusive", { to: at(2) }, [1, 2]],
    ["combined", { actor: "user:bo", action: "open", from: at(3) }, [4]],
    ["nothing", { actor: "user:nobody" }, []],
  ])("exports %s, exactly as the query returns it", async (_, filter, seqs) => {
    const rows = await expected(filter);
    expect(rows.map((r) => r.seq)).toEqual(seqs);
    const { count, text } = await run(filter, "ndjson");
    const lines = ndjson(text);
    expect(count).toBe(seqs.length);
    expect(lines.map((e) => e.seq)).toEqual(seqs);
    for (const [i, e] of lines.entries()) {
      // Each line is the hashed event plus its hash: the stored text and hash, byte for byte.
      expect(hashedText(e)).toBe(rows[i]?.event);
      expect(e.hash).toBe(rows[i]?.hash);
      expect(text.split("\n")[i]).toBe(canonicalJson(e));
    }
  });

  it("gives the same result in small pages", async () => {
    expect((await run({}, "ndjson", 2)).text).toBe((await run({}, "ndjson")).text);
    expect((await run({ action: "open" }, "csv", 1)).text).toBe(
      (await run({ action: "open" }, "csv")).text,
    );
  });

  it("writes RFC 4180 CSV with the same values, formulas neutralized", async () => {
    const { text, count } = await run({}, "csv");
    const records = parseCsv(text);
    expect(records[0]).toEqual([...CSV_COLUMNS]);
    expect(records).toHaveLength(count + 1);
    const events = ndjson((await run({}, "ndjson")).text);
    for (const [i, e] of events.entries()) {
      const row = Object.fromEntries(CSV_COLUMNS.map((c, j) => [c, records[i + 1]?.[j]]));
      expect(row).toMatchObject({
        seq: String(e.seq),
        at: e.at,
        decision: e.decision,
        hash: e.hash,
        prev_hash: e.prevHash,
      });
      expect(row.client).toBe(e.client ?? "");
    }
    const hostile = Object.fromEntries(CSV_COLUMNS.map((c, j) => [c, records[5]?.[j]]));
    expect(hostile.object).toBe(`'=HYPERLINK("http://x","y")`);
    expect(JSON.parse(hostile.detail ?? "")).toEqual({ note: 'a "b", c\nd' });
  });

  it("neutralizes every formula prefix", () => {
    const base = {
      tenantId: "t",
      seq: 1,
      at: "2026-01-01T00:00:00.000Z",
      action: "open",
      decision: "allow" as const,
      prevHash: "0",
      hash: "1",
    };
    for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
      const cells = parseCsv(csvLine({ ...base, actor: `${lead}cmd` }))[0];
      expect(cells?.[2]).toBe(`'${lead}cmd`);
    }
    expect(parseCsv(csvLine({ ...base, actor: "user:a" }))[0]?.[2]).toBe("user:a");
  });

  it("refuses bad arguments before touching the database", async () => {
    await expect(run({}, "ndjson", 0)).rejects.toThrow("invalid pageSize");
    await expect(run({}, "xml" as "csv")).rejects.toThrow("unknown export format");
    await expect(run({ from: new Date("nope") }, "csv")).rejects.toThrow("invalid date");
  });

  it("holds no transaction while the sink waits, and exports the chain as it was at the start", async () => {
    const other = await openTestDatabase();
    try {
      const t = (await seedTenant(other, 2)).tenantId;
      const u = (await seedTenant(other, 3)).tenantId;
      const add = (tenantId: string, n: number) =>
        other.withTenant(tenantId, (tx) =>
          appendAudit(tx, tenantId, {
            actor: "user:a",
            action: "open",
            decision: "allow",
            object: `o${n}`,
          }),
        );
      for (let n = 1; n <= 3; n++) await add(t, n);
      const lines: string[] = [];
      const exported = exportAudit(
        other,
        t,
        {},
        "ndjson",
        async (line) => {
          if (lines.length === 0) {
            // With a transaction open, this would wait forever on PGlite (one connection) and
            // pin a connection on PostgreSQL. Another tenant, and this one, carry on.
            await add(u, 1);
            await add(t, 4);
          }
          lines.push(line);
        },
        { pageSize: 2 },
      );
      expect(await exported).toBe(3);
      expect(ndjson(lines.join("")).map((e) => e.object)).toEqual(["o1", "o2", "o3"]);
      // The event appended meanwhile is there for the next export, and verifies.
      expect(await exportAudit(other, t, {}, "ndjson", () => {})).toBe(4);
      expect(await verifyAudit(other, t, { pageSize: 3 })).toMatchObject({ ok: true, count: 4 });
    } finally {
      await other.close();
    }
  });

  it("names the event it cannot read", async () => {
    const other = await openTestDatabase();
    try {
      const t = (await seedTenant(other, 2)).tenantId;
      await other.withTenant(t, (tx) =>
        appendAudit(tx, t, { actor: "user:a", action: "open", decision: "allow" }),
      );
      await other.withTenant(t, async (tx) => {
        await tx.execute(sql`alter table audit.events disable trigger events_append_only`);
        await tx.execute(sql`alter table audit.events no force row level security`);
        await tx.execute(sql`update audit.events set event = '{' where seq = 1`);
      });
      await expect(exportAudit(other, t, {}, "ndjson", () => {})).rejects.toThrow(
        "audit event 1 is not valid JSON",
      );
    } finally {
      await other.close();
    }
  });
});

/** A strict RFC 4180 parser, to read back what csvLine wrote. */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let i = 0;
  let quoted = false;
  while (i < text.length) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      i++;
    } else if (ch === ",") {
      record.push(field);
      field = "";
      i++;
    } else if (ch === "\r" && text[i + 1] === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      i += 2;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== "" || record.length) records.push([...record, field]);
  return records;
}
