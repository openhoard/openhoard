import { activityEvents, addGrant, facetValues, tagReviews, objectTags } from "@openhoard/core-db";
import { createGroup, addMember } from "@openhoard/core-identity";
import { writeActivity } from "@openhoard/core-catalog";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { TOOLS, whoami } from "../mcp.js";
import { estimateTokens, UNTRUSTED_NOTE } from "./cards.js";
import { DescribeOutput } from "./describe.js";
import { ExplainOutput } from "./explain.js";
import { FindOutput } from "./find.js";
import { OpenOutput } from "./open.js";
import { RecentOutput } from "./recent.js";
import { ProposalLimiter, TagOutput, tagTool } from "./tag.js";
import { startOfDay } from "./time.js";
import { CLIENTS, MIME, openHarness, type Harness } from "./tools.fixtures.js";

/*
 * T-802..T-806 and T-704 through the real /mcp endpoint, with OAuth tokens as the token endpoint
 * issues them: the PRD scenarios 1 (find by intent, open in the native web app), 2 ("what CSVs
 * was I looking at yesterday?"), 4 (why can they see it, read side) and 7 (sensitive stays
 * local), the token budget, scopes, and the audit of every call and every AI read.
 */

let h: Harness;
beforeEach(async () => {
  h = await openHarness();
});
afterEach(() => h?.close());

const OUTPUTS = {
  find: FindOutput,
  recent: RecentOutput,
  describe: DescribeOutput,
  open: OpenOutput,
  tag: TagOutput,
  explain: ExplainOutput,
} as const;

/** Each tool's answer must parse against the output schema it advertises, strictly. */
function shaped<K extends keyof typeof OUTPUTS>(tool: K, data: unknown) {
  expect(TOOLS.find((x) => x.name === tool)?.outputSchema).toBe(OUTPUTS[tool]);
  return z.object(OUTPUTS[tool]).strict().parse(data) as unknown as z.infer<
    z.ZodObject<(typeof OUTPUTS)[K]>
  >;
}

const SHAREPOINT = "https://contoso.sharepoint.com/sites/Sales/Shared%20Documents/Acme%20QBR.pptx";

describe("scenario 1: find by intent, then open in the file's own app", () => {
  it("answers a top match and alternatives as cards, and a checked web link", async () => {
    const deck = await h.addFile({
      title: "Acme QBR deck Q3.pptx",
      mime: MIME.pptx,
      tags: ["client:acme"],
      summary: "Quarterly business review for Acme: renewal, pipeline and support metrics.",
      text: "Acme quarterly business review. Renewal at risk.",
      url: `${SHAREPOINT}?web=1`,
    });
    await h.addFile({
      title: "Acme QBR notes.docx",
      tags: ["client:acme"],
      text: "Notes from the Acme quarterly business review meeting.",
    });
    await h.addFile({
      title: "Acme pricing.xlsx",
      mime: MIME.xlsx,
      tags: ["client:acme"],
      text: "Acme renewal pricing for the quarterly business review.",
    });
    await h.addFile({
      title: "Globex roadmap.pptx",
      mime: MIME.pptx,
      text: "Globex product plans.",
    });
    // Bo's file: Ana may only discover it, so she gets its title card and nothing else.
    await h.addFile({ title: "Acme QBR board prep.pptx", mime: MIME.pptx, owner: h.bo });
    const token = await h.token();
    // Intent, in the person's words: the deck by its words, the rest by meaning (T-503).
    const found = await h.call(token, "find", { query: "acme quarterly business review deck" });
    expect(found.isError).toBe(false);
    const out = shaped("find", found.data);
    expect(out.searchedBy).toEqual(["keywords", "meaning"]);
    expect(out.top).toMatchObject({
      id: deck.objectId,
      title: "Acme QBR deck Q3.pptx",
      kind: "presentation",
      owner: "Ana Lima",
      tags: ["client:acme"],
      access: "read",
      metadataOnly: false,
      summary: "Quarterly business review for Acme: renewal, pipeline and support metrics.",
    });
    expect(out.top?.why).toEqual(expect.arrayContaining(["title"]));
    expect(out.alternatives.length).toBeGreaterThanOrEqual(2);
    expect(out.note).toBe(UNTRUSTED_NOTE);
    expect([out.top, ...out.alternatives].map((c) => c?.title)).not.toContain(
      "Globex roadmap.pptx",
    );
    const board = shaped("find", (await h.call(token, "find", { query: "board prep" })).data).top;
    expect(board).toMatchObject({ access: "title-only", owner: null, modified: null });
    expect(board?.summary).toBeUndefined();
    // The same JSON is the text block a text-only client reads.
    expect(JSON.parse(found.text)).toEqual(found.data);

    const link = await h.call(token, "open", { id: deck.objectId, mode: "link" });
    expect(shaped("open", link.data)).toMatchObject({
      mode: "link",
      link: `${SHAREPOINT}?web=1`,
      content: null,
    });
    expect(link.data.file.summary).toBeUndefined();
  });

  it("hands out only https links, as the URL parser writes them", async () => {
    const cases: [string, string | null][] = [
      ["javascript:alert(document.cookie)", null],
      ["file:///C:/Users/ana/secret.xlsx", null],
      ["https://user:pass@contoso.sharepoint.com/x", null],
      ["data:text/html,<script>alert(1)</script>", null],
      ["https://CONTOSO.sharepoint.com/sites/a b", "https://contoso.sharepoint.com/sites/a%20b"],
    ];
    const token = await h.token();
    for (const [url, expected] of cases) {
      const { objectId } = await h.addFile({ title: "Linked.docx", url });
      const got = await h.call(token, "open", { id: objectId, mode: "link" });
      expect(got.data.link, url).toBe(expected);
      if (expected === null) expect(got.data.reason).toMatch(/no web link/i);
    }
  });

  it("filters by kind, media type and modified range, and pages with a cursor", async () => {
    for (let i = 0; i < 6; i++) {
      await h.addFile({ title: `Forecast ${i}.xlsx`, mime: MIME.xlsx });
      await h.addFile({ title: `Forecast ${i}.csv`, mime: MIME.csv });
    }
    await h.addFile({
      title: "Forecast old.csv",
      mime: MIME.csv,
      updatedAt: new Date("2020-01-01T00:00:00Z"),
    });
    const token = await h.token();
    const csv = shaped(
      "find",
      (await h.call(token, "find", { query: "forecast", kind: "csv", limit: 4 })).data,
    );
    const first = [csv.top, ...csv.alternatives];
    expect(first.every((c) => c?.kind === "csv")).toBe(true);
    expect(csv.total).toBe(7);
    expect(csv.more).not.toBeNull();
    const next = shaped(
      "find",
      (
        await h.call(token, "find", {
          query: "forecast",
          kind: "csv",
          limit: 4,
          cursor: csv.more?.cursor,
        })
      ).data,
    );
    const second = [next.top, ...next.alternatives];
    expect(second).toHaveLength(3);
    expect(new Set([...first, ...second].map((c) => c?.id)).size).toBe(7);
    expect(next.more).toBeNull();
    const recentOnly = shaped(
      "find",
      (
        await h.call(token, "find", {
          query: "forecast",
          mediaType: MIME.csv,
          modifiedAfter: "2025-01-01",
          limit: 25,
        })
      ).data,
    );
    expect(recentOnly.total).toBe(6);
    const old = shaped(
      "find",
      (await h.call(token, "find", { query: "forecast", modifiedBefore: "2021-01-01T00:00:00Z" }))
        .data,
    );
    expect(old.top?.title).toBe("Forecast old.csv");
    // Tag filters go to the catalog as facet:value terms.
    await h.addFile({ title: "Forecast acme.xlsx", mime: MIME.xlsx, tags: ["client:acme"] });
    const tagged = shaped(
      "find",
      (await h.call(token, "find", { query: "forecast", tags: ["client:acme"] })).data,
    );
    expect([tagged.top, ...tagged.alternatives].map((c) => c?.title)).toEqual([
      "Forecast acme.xlsx",
    ]);
    for (const bad of [{ cursor: "!!" }, { cursor: "bzo5OTk5" }, { modifiedAfter: "yesterday" }]) {
      const got = await h.call(token, "find", { query: "forecast", ...bad });
      expect(got.isError, JSON.stringify(bad)).toBe(true);
    }
  });
});

describe("the token budget (T-802 done-when: find answers within 2,000 tokens by default)", () => {
  it("keeps every list answer within budget, conservatively estimated, with a cursor for the rest", async () => {
    const long = "Quarterly revenue forecast by region and product line ".repeat(3);
    const summary =
      `${"This workbook projects revenue for every region and quarter ".repeat(6)}`.trim();
    for (let i = 0; i < 30; i++) {
      await h.addFile({
        title: `${long} ${i} 预测 数据.xlsx`,
        mime: MIME.xlsx,
        tags: ["client:acme", "project:atlas", "dept:finance"],
        summary,
      });
    }
    const token = await h.token();
    for (const maxTokens of [undefined, 500, 4000]) {
      const got = await h.call(token, "find", {
        query: "revenue forecast",
        limit: 25,
        ...(maxTokens ? { maxTokens } : {}),
      });
      const budget = maxTokens ?? 2000;
      expect(estimateTokens(got.text), String(maxTokens)).toBeLessThanOrEqual(budget);
      const out = shaped("find", got.data);
      expect(out.top).not.toBeNull();
      expect(out.more).not.toBeNull();
    }
    // recent and describe too.
    const ids = (await h.call(token, "find", { query: "revenue", limit: 25, maxTokens: 8000 }))
      .data;
    const all = [ids.top, ...ids.alternatives] as { id: string }[];
    for (const c of all) await h.call(token, "describe", { id: c.id });
    const rec = await h.call(token, "recent", { period: "today", limit: 50 });
    expect(estimateTokens(rec.text)).toBeLessThanOrEqual(2000);
    expect(shaped("recent", rec.data).more).not.toBeNull();
  });

  it("estimates conservatively: a third of a token per ASCII character, two per other", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(2);
    expect(estimateTokens("数据")).toBe(4);
    expect(estimateTokens("😀")).toBe(2);
  });
});

describe("scenario 2: what CSVs was I looking at yesterday?", () => {
  it("answers from the caller's own activity, in their time zone, reading no content", async () => {
    const zone = "America/Denver";
    const now = new Date();
    const yesterdayNoon = new Date(startOfDay(now, zone, -1).getTime() + 12 * 3600_000);
    const twoDaysAgo = new Date(startOfDay(now, zone, -2).getTime() + 12 * 3600_000);
    const vendors = await h.addFile({ title: "Vendors.csv", mime: MIME.csv, text: "a,b" });
    const prices = await h.addFile({ title: "Prices.csv", mime: MIME.csv });
    const budget = await h.addFile({ title: "Budget.xlsx", mime: MIME.xlsx });
    const older = await h.addFile({ title: "Older.csv", mime: MIME.csv });
    const bos = await h.addFile({ title: "Bo's list.csv", mime: MIME.csv, owner: h.bo });
    const ana = `user:${h.ana.id}`;
    await h.inTenant((tx) =>
      writeActivity(tx, h.tenantId, [
        { type: "open", actor: ana, objectId: vendors.objectId, at: yesterdayNoon },
        { type: "view", actor: ana, objectId: prices.objectId, at: yesterdayNoon },
        { type: "open", actor: ana, objectId: budget.objectId, at: yesterdayNoon },
        { type: "open", actor: ana, objectId: older.objectId, at: twoDaysAgo },
        { type: "open", actor: `user:${h.bo.id}`, objectId: bos.objectId, at: yesterdayNoon },
      ]),
    );
    const before = await h.inTenant((tx) => tx.select().from(activityEvents));
    const token = await h.token();
    const opened = await h.call(token, "recent", {
      period: "yesterday",
      timeZone: zone,
      kind: "csv",
      actions: ["open"],
    });
    const out = shaped("recent", opened.data);
    expect(out.files.map((f) => f.title)).toEqual(["Vendors.csv"]);
    expect(out.files[0]).toMatchObject({
      lastAction: "open",
      lastAt: yesterdayNoon.toISOString(),
      kind: "csv",
    });
    expect(out.range).toEqual({
      from: startOfDay(now, zone, -1).toISOString(),
      to: startOfDay(now, zone).toISOString(),
      timeZone: zone,
    });
    // Looked at (viewed or opened): both CSVs, newest first.
    const looked = shaped(
      "recent",
      (await h.call(token, "recent", { period: "yesterday", timeZone: zone, kind: "csv" })).data,
    );
    expect(looked.files.map((f) => f.title).sort()).toEqual(["Prices.csv", "Vendors.csv"]);
    // An explicit range, and a media type.
    const ranged = shaped(
      "recent",
      (
        await h.call(token, "recent", {
          from: twoDaysAgo.toISOString(),
          to: now.toISOString(),
          mediaType: MIME.xlsx,
        })
      ).data,
    );
    expect(ranged.files.map((f) => f.title)).toEqual(["Budget.xlsx"]);
    // No content read, and a listing records nothing.
    expect(await h.inTenant((tx) => tx.select().from(activityEvents))).toHaveLength(before.length);
    expect(await h.audit("ai.read")).toEqual([]);
    // Bad arguments are refused plainly.
    for (const bad of [
      { timeZone: "Mars/Olympus" },
      { period: "today", from: "2026-01-01" },
      { from: "last week" },
      { kind: "image" },
      { cursor: "@@" },
    ]) {
      expect((await h.call(token, "recent", bad)).isError, JSON.stringify(bad)).toBe(true);
    }
  });
});

describe("describe", () => {
  it("answers one card and a reader's versions; unknown and hidden files alike", async () => {
    const doc = await h.addFile({ title: "Plan.docx", summary: "A plan." });
    const token = await h.token();
    const got = await h.call(token, "describe", { id: doc.objectId });
    const out = shaped("describe", got.data);
    expect(out.file).toMatchObject({ id: doc.objectId, title: "Plan.docx", summary: "A plan." });
    expect(out.versions).toEqual([
      expect.objectContaining({
        number: 1,
        author: "Ana Lima",
        current: true,
        mediaType: MIME.docx,
      }),
    ]);
    expect(out.versionCount).toBe(1);
    // Bo's file as a title card: no versions for a non-reader.
    const bos = await h.addFile({ title: "Bo.docx", owner: h.bo });
    expect(
      shaped("describe", (await h.call(token, "describe", { id: bos.objectId })).data),
    ).toMatchObject({
      file: { access: "title-only" },
      versions: [],
    });
    // A hidden (unprocessed) one and a made-up id: the same "not found".
    const hidden = await h.addFile({ title: "Hidden.docx", owner: h.bo, processed: false });
    for (const id of [hidden.objectId, "obj_01k5xr3c8v0q6m2d4n7p9s1t3w", "nonsense"]) {
      const miss = await h.call(token, "describe", { id });
      expect(miss).toMatchObject({ isError: true, text: "not found" });
    }
  });
});

describe("scenario 4 (read side): who can see this, for the file's owner", () => {
  it("lists who has access and why a named person can read it; others are refused", async () => {
    const finance = await h.inTenant(async (tx) => {
      const g = await createGroup(tx, h.tenantId, { name: "Finance", source: "local" });
      await addMember(tx, h.tenantId, g.id, h.bo.id, "local");
      return g;
    });
    const doc = await h.addFile({
      title: "Salaries 2026.xlsx",
      mime: MIME.xlsx,
      tags: ["dept:finance"],
    });
    await h.inTenant((tx) =>
      addGrant(tx, h.tenantId, {
        principal: `group:${finance.id}`,
        role: "read",
        target: { tag: "dept:finance" },
        grantedBy: `user:${h.ana.id}`,
      }),
    );
    const token = await h.token();
    const got = await h.call(token, "explain", { id: doc.objectId, person: "bo@example.com" });
    const out = shaped("explain", got.data);
    expect(out).toMatchObject({
      file: { id: doc.objectId, title: "Salaries 2026.xlsx" },
      owner: "Ana Lima",
      visibility: "discoverable",
      access: [{ name: "Finance", kind: "group", role: "read", via: "tag dept:finance" }],
      person: { name: "Bo Chen", canRead: true, sees: "card" },
    });
    expect(out.person?.explanation).toMatch(/Bo Chen can read/);
    expect(
      shaped(
        "explain",
        (await h.call(token, "explain", { id: doc.objectId, person: "nobody@example.com" })).data,
      ).person,
    ).toMatchObject({ canRead: false });
    // Bo can read it, but it isn't his: no explanation for him.
    const boToken = await h.token({ user: h.bo });
    const refused = await h.call(boToken, "explain", { id: doc.objectId });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/owner/);
    expect((await h.call(boToken, "explain", { id: "nonsense" })).text).toBe("not found");
    const [deny] = (await h.audit("mcp.tool")).filter(
      (e) => e.detail.tool === "explain" && e.decision === "deny",
    );
    expect(deny).toMatchObject({
      actor: `user:${h.bo.id}`,
      object: doc.objectId,
      detail: { outcome: "refused" },
    });
  });
});

describe("explain within budget", () => {
  it("leaves out access entries past the budget, and says how many", async () => {
    const doc = await h.addFile({ title: "Shared widely.docx" });
    await h.inTenant(async (tx) => {
      for (let i = 0; i < 40; i++) {
        const g = await createGroup(tx, h.tenantId, {
          name: `Team with a rather long name number ${i}`,
          source: "local",
        });
        await addGrant(tx, h.tenantId, {
          principal: `group:${g.id}`,
          role: "read",
          target: { objectId: doc.objectId },
          grantedBy: `user:${h.ana.id}`,
        });
      }
    });
    const token = await h.token();
    const got = await h.call(token, "explain", { id: doc.objectId, maxTokens: 500 });
    const out = shaped("explain", got.data);
    expect(estimateTokens(got.text)).toBeLessThanOrEqual(500);
    expect(out.omitted).toBeGreaterThan(0);
    expect(out.access.length + out.omitted).toBe(40);
  });
});

describe("scenario 7: sensitive stays local", () => {
  it("gives AI clients below local trust metadata only, audits what it withheld, and a local one the text", async () => {
    const doc = await h.addFile({
      title: "Merger plan.docx",
      tags: ["sensitivity:confidential"],
      summary: "Secret merger summary.",
      text: "The merger closes in March.",
    });
    for (const trust of ["commercial", "consumer"] as const) {
      const token = await h.token({ trust });
      const card = shaped("find", (await h.call(token, "find", { query: "merger" })).data).top;
      expect(card, trust).toMatchObject({ id: doc.objectId, metadataOnly: true, access: "read" });
      expect(card?.summary, trust).toBeUndefined();
      const opened = await h.call(token, "open", { id: doc.objectId, mode: "content" });
      expect(opened.isError).toBe(false);
      expect(shaped("open", opened.data)).toMatchObject({
        content: null,
        file: { metadataOnly: true },
      });
      expect(opened.data.reason).toMatch(/metadata only/i);
      expect(opened.text).not.toMatch(/merger closes|Secret merger/);
      // The link still works: the person opens it in the source, under its permissions.
      expect((await h.call(token, "open", { id: doc.objectId, mode: "link" })).data.reason).toMatch(
        /no web link/i,
      );
    }
    const withheld = await h.audit("object.open");
    expect(withheld.map((e) => e.client).sort()).toEqual(
      [CLIENTS.commercial.id, CLIENTS.consumer.id].sort(),
    );
    expect(withheld[0]).toMatchObject({
      decision: "deny",
      object: doc.objectId,
      detail: { reason: "exposure" },
    });
    expect(await h.audit("ai.read")).toEqual([]);
    // Through a local client: the content, as untrusted data.
    const local = await h.token({ trust: "local" });
    const opened = await h.call(local, "open", { id: doc.objectId, mode: "content" });
    const out = shaped("open", opened.data);
    expect(out.content?.text).toBe(
      `BEGIN-FILE-TEXT-${out.content?.nonce}\nThe merger closes in March.\nEND-FILE-TEXT-${out.content?.nonce}`,
    );
    expect(out.note).toContain(UNTRUSTED_NOTE);
    expect(out.content).toMatchObject({ offset: 0, next: null, truncatedAtSource: false });
  });
});

describe("open (T-803)", () => {
  it("pages long text within the budget, never splitting a character", async () => {
    const text = `${'Line of text with a quote " and a tab\t.\n'.repeat(400)}😀 end`;
    const doc = await h.addFile({ title: "Long.txt", mime: MIME.txt, text });
    const token = await h.token();
    let offset = 0;
    let assembled = "";
    for (let i = 0; i < 50; i++) {
      const got = await h.call(token, "open", {
        id: doc.objectId,
        mode: "content",
        offset,
        maxTokens: 1000,
      });
      expect(estimateTokens(got.text)).toBeLessThanOrEqual(1000);
      const c = shaped("open", got.data).content;
      if (!c) throw new Error("no content");
      const begin = `BEGIN-FILE-TEXT-${c.nonce}\n`;
      assembled += c.text.slice(begin.length, c.text.length - `\nEND-FILE-TEXT-${c.nonce}`.length);
      if (c.next === null) break;
      offset = c.next;
    }
    expect(assembled).toBe(text);
    const past = await h.call(token, "open", {
      id: doc.objectId,
      mode: "content",
      offset: text.length,
    });
    expect(past.data.reason).toMatch(/past the end/);
  });

  it("says why there is no content: no extract yet, a non-reader, an unknown file", async () => {
    const token = await h.token();
    const bare = await h.addFile({ title: "Scan.pdf", mime: MIME.pdf });
    expect(
      (await h.call(token, "open", { id: bare.objectId, mode: "content" })).data.reason,
    ).toMatch(/No text/);
    const bos = await h.addFile({ title: "Bo.pdf", mime: MIME.pdf, owner: h.bo, text: "x" });
    const refused = await h.call(token, "open", { id: bos.objectId, mode: "content" });
    expect(refused.data).toMatchObject({ content: null, file: { access: "title-only" } });
    expect(refused.data.reason).toMatch(/request access/);
    expect((await h.call(token, "open", { id: "nope", mode: "link" })).text).toBe("not found");
  });
});

describe("T-704: every AI read is logged with client, model, object and version", () => {
  it("audits each content read and each summary shown, with the model the call reports", async () => {
    const doc = await h.addFile({
      title: "Roadmap.docx",
      summary: "The roadmap.",
      text: "Roadmap text.",
    });
    const token = await h.token();
    const meta = { "openhoard/model": "claude-opus-5" };
    await h.call(token, "find", { query: "roadmap" }, meta);
    await h.call(token, "describe", { id: doc.objectId }, { model: "gpt-x" });
    await h.call(
      token,
      "open",
      { id: doc.objectId, mode: "content" },
      { clientInfo: { model: "local-llm" } },
    );
    await h.call(token, "recent", { period: "today" });
    await h.call(token, "open", { id: doc.objectId, mode: "content" }, { model: "bad\nmodel" });
    const reads = await h.audit("ai.read");
    expect(reads.map((e) => [e.detail.tool, e.detail.kind, e.detail.model])).toEqual([
      ["find", "summary", "claude-opus-5"],
      ["describe", "summary", "gpt-x"],
      ["open", "content", "local-llm"],
      ["recent", "summary", "unknown"],
      ["open", "content", "unknown"],
    ]);
    for (const e of reads) {
      expect(e).toMatchObject({
        actor: `user:${h.ana.id}`,
        decision: "allow",
        client: CLIENTS.commercial.id,
        object: doc.objectId,
        version: doc.versionId,
        detail: { trust: "commercial" },
      });
    }
    // Every content read is an `open` in the activity log too.
    const opens = await h.inTenant((tx) =>
      tx.select().from(activityEvents).where(eq(activityEvents.type, "open")),
    );
    expect(opens.length).toBeGreaterThanOrEqual(1);
    expect(opens[0]).toMatchObject({
      objectId: doc.objectId,
      versionId: doc.versionId,
      clientId: CLIENTS.commercial.id,
    });
    // And every call leaves one `mcp.tool` record, without its arguments.
    const calls = await h.audit("mcp.tool");
    expect(calls.map((e) => e.detail.tool)).toEqual(["find", "describe", "open", "recent", "open"]);
    expect(JSON.stringify(calls)).not.toMatch(/roadmap/i);
    expect(calls[2]).toMatchObject({
      object: doc.objectId,
      detail: { outcome: "ok", model: "local-llm" },
    });
  });

  it("audits whoami and failures too, as calls", async () => {
    const boom = { ...whoami, name: "boom", run: () => Promise.reject(new Error("secret")) };
    const h2 = await openHarness({ tools: [whoami, boom] });
    try {
      const token = await h2.token();
      await h2.call(token, "whoami");
      expect((await h2.call(token, "boom")).text).toBe("internal error");
      expect(
        (await h2.audit("mcp.tool")).map((e) => [e.detail.tool, e.decision, e.detail.outcome]),
      ).toEqual([
        ["whoami", "allow", "ok"],
        ["boom", "deny", "error"],
      ]);
    } finally {
      await h2.close();
    }
  });
});

describe("tag (T-804): proposals only, existing vocabulary, scoped and rate-limited", () => {
  const openItems = () => h.inTenant((tx) => tx.select().from(tagReviews));
  const tagsOf = (objectId: string) =>
    h.inTenant(async (tx) =>
      (await tx.select().from(objectTags).where(eq(objectTags.objectId, objectId))).map(
        (t) => `${t.facet}:${t.value}`,
      ),
    );

  it("files a review item for a person, and changes no tag", async () => {
    const doc = await h.addFile({ title: "Contract.docx", tags: ["client:acme"] });
    await h.addFile({ title: "Other.docx", tags: ["client:globex"] });
    const token = await h.token({ scopes: ["files:read", "files:tag"] });
    const got = await h.call(token, "tag", { id: doc.objectId, tag: "client:globex" });
    expect(shaped("tag", got.data)).toMatchObject({ status: "proposed", reason: "agent" });
    expect(await tagsOf(doc.objectId)).toEqual(["client:acme"]);
    expect(await openItems()).toMatchObject([
      {
        objectId: doc.objectId,
        facet: "client",
        value: "globex",
        reason: "agent",
        source: "model",
        appliedBy: `model:agent/${CLIENTS.commercial.id}`,
      },
    ]);
    expect(await h.audit("tag.propose")).toMatchObject([
      {
        actor: `user:${h.ana.id}`,
        object: doc.objectId,
        detail: { tag: "client:globex", outcome: "agent" },
      },
    ]);
    // A tag it already has: nothing to do.
    expect(
      shaped("tag", (await h.call(token, "tag", { id: doc.objectId, tag: "client:acme" })).data)
        .status,
    ).toBe("already-tagged");
  });

  it("refuses without files:tag, without write access, and for new vocabulary", async () => {
    const doc = await h.addFile({ title: "Contract.docx" });
    const bos = await h.addFile({ title: "Bo's.docx", owner: h.bo });
    await h.inTenant((tx) =>
      addGrant(tx, h.tenantId, {
        principal: `user:${h.ana.id}`,
        role: "read",
        target: { objectId: bos.objectId },
        grantedBy: "user:admin",
      }),
    );
    await h.addFile({ title: "Vocab.docx", tags: ["client:acme"] });
    const readOnly = await h.token();
    expect((await h.call(readOnly, "tag", { id: doc.objectId, tag: "client:acme" })).text).toMatch(
      /files:tag/,
    );
    const token = await h.token({ scopes: ["files:read", "files:tag"] });
    expect((await h.call(token, "tag", { id: bos.objectId, tag: "client:acme" })).text).toMatch(
      /may not tag/,
    );
    const invented = await h.call(token, "tag", { id: doc.objectId, tag: "client:evil-corp" });
    expect(invented.text).toMatch(/vocabulary/);
    expect((await h.call(token, "tag", { id: doc.objectId, tag: "not a tag" })).isError).toBe(true);
    // Values that decide who sees a file are a person's to set: a level, or a live grant.
    const levels = await h.call(token, "tag", {
      id: doc.objectId,
      tag: "sensitivity:confidential",
    });
    expect(levels.text).toMatch(/only a person/);
    await h.inTenant((tx) =>
      addGrant(tx, h.tenantId, {
        principal: `user:${h.bo.id}`,
        role: "read",
        target: { tag: "client:acme" },
        grantedBy: "user:admin",
      }),
    );
    expect((await h.call(token, "tag", { id: doc.objectId, tag: "client:acme" })).text).toMatch(
      /only a person/,
    );
    expect((await h.call(token, "tag", { id: "nope", tag: "client:acme" })).text).toBe("not found");
    expect(await openItems()).toEqual([]);
    const values = await h.inTenant((tx) =>
      tx
        .select()
        .from(facetValues)
        .where(and(eq(facetValues.facet, "client"), eq(facetValues.value, "evil-corp"))),
    );
    expect(values).toEqual([]);
  });

  it("limits proposals per person and client", async () => {
    const limited = tagTool(new ProposalLimiter({ max: 2, windowMs: 60_000 }));
    const h2 = await openHarness({ tools: [limited] });
    try {
      await h2.addFile({
        title: "Vocab.docx",
        tags: ["client:acme", "client:globex", "client:initech"],
      });
      const doc = await h2.addFile({ title: "Doc.docx" });
      const token = await h2.token({ scopes: ["files:read", "files:tag"] });
      for (const tag of ["client:acme", "client:globex"]) {
        expect((await h2.call(token, "tag", { id: doc.objectId, tag })).data.status).toBe(
          "proposed",
        );
      }
      expect(
        (await h2.call(token, "tag", { id: doc.objectId, tag: "client:initech" })).text,
      ).toMatch(/Too many/);
      // Another client of the same person has its own count.
      const other = await h2.token({ scopes: ["files:read", "files:tag"], trust: "local" });
      expect(
        (await h2.call(other, "tag", { id: doc.objectId, tag: "client:initech" })).data.status,
      ).toBe("proposed");
    } finally {
      await h2.close();
    }
  });
});

describe("ProposalLimiter", () => {
  it("slides its window and forgets the oldest keys past its bound", () => {
    let now = 0;
    const limiter = new ProposalLimiter({ max: 1, windowMs: 10 }, () => now);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
    now = 10;
    expect(limiter.take("a")).toBe(true);
    for (let i = 0; i < 10_001; i++) limiter.take(`k${i}`);
    // "a" was the oldest key: forgotten, so it may go again at once.
    expect(limiter.take("a")).toBe(true);
  });
});
