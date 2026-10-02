import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAudit } from "@openhoard/core-audit";
import type { IngestResult } from "@openhoard/core-catalog";
import { objects, sourceRefs, versions, zones, type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { createUser, lockUser, type User } from "@openhoard/core-identity";
import { BlobStore } from "@openhoard/core-storage";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, mailPasswordEnv, MailboxSchema, type MailboxConfig } from "./config.js";
import { startFakeImap, type FakeImap } from "./mail-in.fixtures.js";
import {
  filesOf,
  htmlToText,
  MAIL_SOURCE,
  checkMailboxes,
  runMailbox,
  senderAuthenticated,
  startMailIn,
  type MailInDeps,
} from "./mail-in.js";

/*
 * T-1208: a message sent to the mailbox becomes files. "Done when: a forwarded email and its
 * attachments are searchable": here, that they are recorded as files OpenHoard holds, owned by
 * who sent them, queued for enrichment; the mailbox is a stand-in IMAP server (mail-in.fixtures).
 */

const PASSWORD = 'p"w d';
const KEY = new Uint8Array(32).fill(9);
const AUTH =
  "Authentication-Results: mx.mail.example; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=pass (p=REJECT) header.from=example.com";

let db: Database;
let t: SeededTenant;
let ana: User;
let dir: string;
let store: BlobStore;
let imap: FakeImap;
let enqueued: IngestResult[];
let deps: MailInDeps;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  ana = await db.withTenant(t.tenantId, (tx) =>
    createUser(tx, t.tenantId, { email: "ana@example.com", displayName: "Ana", source: "local" }),
  );
  dir = mkdtempSync(join(tmpdir(), "oh-mail-"));
  store = BlobStore.open({ kind: "fs", root: dir });
  imap = await startFakeImap("inbox@mail.example", PASSWORD);
  enqueued = [];
  deps = {
    db,
    store,
    tenantKey: () => Promise.resolve(KEY),
    enqueue: (_tenantId, result) => {
      enqueued.push(result);
      return Promise.resolve(true);
    },
  };
});
afterEach(async () => {
  await imap?.close();
  await db?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const mailbox = (over: Record<string, unknown> = {}): MailboxConfig =>
  MailboxSchema.parse({
    id: "inbox",
    tenantId: t.tenantId,
    host: "127.0.0.1",
    port: imap.port,
    secure: false,
    user: "inbox@mail.example",
    authserv: "mx.mail.example",
    ...over,
  });

/** A message with a text part and attachments, as a mail program sends it. */
function message(
  o: {
    from?: string;
    subject?: string;
    text?: string;
    html?: string;
    auth?: string | null;
    attachments?: { name: string; type: string; body: string; inline?: boolean }[];
    extra?: string;
  } = {},
): string {
  const head = [
    ...(o.auth === null ? [] : [o.auth ?? AUTH]),
    `From: ${o.from ?? "Ana Lima <ana@example.com>"}`,
    "To: inbox@mail.example",
    `Subject: ${o.subject ?? "Fwd: Site visit notes"}`,
    "Date: Thu, 01 Oct 2026 09:30:00 +0000",
    "Message-ID: <abc@example.com>",
    "MIME-Version: 1.0",
    ...(o.extra ? [o.extra] : []),
  ];
  const body =
    o.html !== undefined
      ? `Content-Type: text/html; charset=utf-8\n\n${o.html}`
      : `Content-Type: text/plain; charset=utf-8\n\n${o.text ?? "The roof needs work.\nSee attached."}`;
  if (!o.attachments?.length) return `${head.join("\n")}\n${body}\n`;
  const parts = o.attachments.map(
    (a) =>
      `--b1\nContent-Type: ${a.type}; name="${a.name}"\nContent-Disposition: ${a.inline ? "inline" : "attachment"}; filename="${a.name}"\n${a.inline ? "Content-ID: <logo@x>\n" : ""}Content-Transfer-Encoding: base64\n\n${Buffer.from(a.body).toString("base64")}\n`,
  );
  return `${head.join("\n")}\nContent-Type: multipart/mixed; boundary="b1"\n\n--b1\n${body}\n${parts.join("")}--b1--\n`;
}

const files = () =>
  db.withTenant(t.tenantId, (tx) =>
    tx
      .select({
        title: objects.title,
        owner: objects.ownerId,
        zone: zones.name,
        kind: zones.kind,
        mime: versions.mime,
        blobId: versions.blobId,
        externalId: sourceRefs.externalId,
      })
      .from(objects)
      .innerJoin(zones, and(eq(zones.tenantId, objects.tenantId), eq(zones.id, objects.zoneId)))
      .innerJoin(
        sourceRefs,
        and(eq(sourceRefs.tenantId, objects.tenantId), eq(sourceRefs.objectId, objects.id)),
      )
      .innerJoin(
        versions,
        and(eq(versions.tenantId, objects.tenantId), eq(versions.objectId, objects.id)),
      )
      .where(and(eq(objects.tenantId, t.tenantId), eq(sourceRefs.source, MAIL_SOURCE)))
      .orderBy(asc(sourceRefs.externalId), asc(versions.seq)),
  );
const textOf = async (blobId: string) =>
  Buffer.from(await store.read(t.tenantId, blobId)).toString();

async function audit() {
  const lines: string[] = [];
  await exportAudit(db, t.tenantId, {}, "ndjson", (s: string) => void lines.push(s));
  return lines
    .join("")
    .split("\n")
    .filter(Boolean)
    .map(
      (l) =>
        JSON.parse(l) as {
          actor: string;
          action: string;
          decision: string;
          detail: Record<string, unknown>;
        },
    )
    .filter((r) => r.action === "mail.receive");
}

describe("a mailbox, read over IMAP", () => {
  it("turns a member's message into files: its text, and each attachment", async () => {
    imap.deliver(
      message({
        attachments: [
          { name: "Survey report.pdf", type: "application/pdf", body: "%PDF-1.4 survey" },
          { name: "costs.csv", type: "text/csv", body: "item,cost\nroof,1200\n" },
          { name: "logo.png", type: "image/png", body: "PNG", inline: true },
        ],
      }),
    );
    expect(await runMailbox(deps, mailbox(), PASSWORD)).toEqual({
      taken: 1,
      refused: 0,
      deferred: 0,
    });

    const got = await files();
    expect(got.map((f) => [f.title, f.mime, f.owner, f.zone, f.kind])).toEqual([
      ["Survey report.pdf", "application/pdf", `user:${ana.id}`, "Mail", "managed"],
      ["costs.csv", "text/csv", `user:${ana.id}`, "Mail", "managed"],
      // Shown in place by the mail program, but a file all the same (a phone sends photos so).
      ["logo.png", "image/png", `user:${ana.id}`, "Mail", "managed"],
      ["Fwd: Site visit notes.md", "text/markdown", `user:${ana.id}`, "Mail", "managed"],
    ]);
    expect(await textOf(got[0]?.blobId as string)).toBe("%PDF-1.4 survey");
    expect(await textOf(got[3]?.blobId as string)).toBe(
      [
        "# Fwd: Site visit notes",
        "",
        "- From: Ana Lima <ana@example.com>",
        "- To: inbox@mail.example",
        "- Date: 2026-10-01T09:30:00.000Z",
        "- Attachments: Survey report.pdf; costs.csv; logo.png",
        "",
        "---",
        "",
        "The roof needs work.",
        "See attached.",
        "",
      ].join("\n"),
    );
    // Read now, and not flagged; queued for enrichment; audited with what it became.
    expect([...(imap.messages[0]?.flags ?? [])]).toEqual(["\\Seen"]);
    expect(enqueued).toHaveLength(4);
    const [record] = await audit();
    expect(record).toMatchObject({
      actor: "system:mail-in",
      decision: "allow",
      detail: {
        mailbox: "inbox",
        from: "ana@example.com",
        owner: `user:${ana.id}`,
        attachments: 3,
      },
    });
    expect(String(record?.detail.objects).split(" ")).toHaveLength(4);
    expect(JSON.stringify(record)).not.toContain("Site visit");
    // Nothing more to read.
    expect(await runMailbox(deps, mailbox(), PASSWORD)).toEqual({
      taken: 0,
      refused: 0,
      deferred: 0,
    });
    // It signed in with the password, never sent in the clear as a LOGIN line.
    expect(imap.commands.join("\n")).not.toContain("LOGIN");
  });

  it("records a message handled twice as the same files", async () => {
    const raw = message({ attachments: [{ name: "a.txt", type: "text/plain", body: "a" }] });
    imap.deliver(raw);
    await runMailbox(deps, mailbox(), PASSWORD);
    // The server stopped before marking it: unread again.
    imap.messages[0]?.flags.clear();
    expect(await runMailbox(deps, mailbox(), PASSWORD)).toMatchObject({ taken: 1 });
    expect(await files()).toHaveLength(2);
    // The same message sent anew is the same bytes here; a different one is new files.
    imap.deliver(message({ subject: "Another", text: "other" }));
    await runMailbox(deps, mailbox(), PASSWORD);
    expect((await files()).map((f) => f.title).sort()).toEqual([
      "Another.md",
      "Fwd: Site visit notes.md",
      "a.txt",
    ]);
  });

  it("takes mail from a listed sender for the mailbox's owner, and refuses anyone else", async () => {
    const box = mailbox({ allowFrom: ["Scanner@Office.Example"], owner: "ana@example.com" });
    const scanner =
      "Authentication-Results: mx.mail.example; dmarc=pass header.from=office.example";
    imap.deliver(message({ from: "scanner@office.example", subject: "Scan 1", auth: scanner }));
    imap.deliver(
      message({
        from: "stranger@elsewhere.example",
        subject: "Open me",
        auth: "Authentication-Results: mx.mail.example; dmarc=pass header.from=elsewhere.example",
      }),
    );
    expect(await runMailbox(deps, box, PASSWORD)).toEqual({ taken: 1, refused: 1, deferred: 0 });
    expect((await files()).map((f) => [f.title, f.owner])).toEqual([
      ["Scan 1.md", `user:${ana.id}`],
    ]);
    // Refused: read and flagged, so it isn't tried again and stands out in the mailbox.
    expect([...(imap.messages[1]?.flags ?? [])].sort()).toEqual(["\\Flagged", "\\Seen"]);
    expect((await audit()).map((r) => [r.decision, r.detail.reason, r.detail.from])).toEqual([
      ["allow", undefined, "scanner@office.example"],
      ["deny", "sender", "stranger@elsewhere.example"],
    ]);
  });

  it("refuses a listed sender's mail when the owner can't own it", async () => {
    imap.deliver(
      message({
        from: "scanner@office.example",
        auth: "Authentication-Results: mx.mail.example; dmarc=pass header.from=office.example",
      }),
    );
    const box = mailbox({ allowFrom: ["scanner@office.example"], owner: "nobody@example.com" });
    expect(await runMailbox(deps, box, PASSWORD)).toMatchObject({ refused: 1 });
    expect((await audit())[0]?.detail.reason).toBe("no-owner");
  });

  it("believes the mailbox's server about the sender, not the From line", async () => {
    const cases: [string, string | null][] = [
      ["no header at all", null],
      [
        "DMARC failed",
        "Authentication-Results: mx.mail.example; spf=pass; dmarc=fail header.from=example.com",
      ],
      [
        "another domain passed",
        "Authentication-Results: mx.mail.example; dmarc=pass header.from=evil.example",
      ],
      [
        "a header the sender wrote",
        "Authentication-Results: mx.evil.example; dmarc=pass header.from=example.com",
      ],
    ];
    for (const [, auth] of cases) imap.deliver(message({ auth, subject: "Forged" }));
    expect(await runMailbox(deps, mailbox(), PASSWORD)).toEqual({
      taken: 0,
      refused: 4,
      deferred: 0,
    });
    expect((await audit()).map((r) => r.detail.reason)).toEqual(Array(4).fill("unauthenticated"));
    expect(await files()).toEqual([]);
    // A mailbox whose config says to believe the From line does.
    imap.deliver(message({ auth: null, subject: "Trusting" }));
    const trusting = mailbox({ authserv: undefined, allowUnauthenticated: true });
    expect(await runMailbox(deps, trusting, PASSWORD)).toMatchObject({ taken: 1 });
  });

  it("refuses a member who can't act any more, and a message with no sender", async () => {
    await db.withTenant(t.tenantId, (tx) => lockUser(tx, t.tenantId, ana.id, "system:test"));
    imap.deliver(message());
    imap.deliver("Subject: nobody\n\nhello\n");
    expect(
      await runMailbox(
        deps,
        mailbox({ authserv: undefined, allowUnauthenticated: true }),
        PASSWORD,
      ),
    ).toEqual({
      taken: 0,
      refused: 2,
      deferred: 0,
    });
    expect((await audit()).map((r) => r.detail.reason)).toEqual(["sender", "no-sender"]);
  });

  it("refuses a message over the limit without fetching it, and leaves out an attachment over it", async () => {
    imap.deliver(message({ text: "x".repeat(3000) }));
    const small = mailbox({ maxBytes: 2048 });
    expect(await runMailbox(deps, small, PASSWORD)).toMatchObject({ refused: 1 });
    expect(imap.commands.filter((c) => c.includes("BODY.PEEK[]"))).toEqual([]);
    expect((await audit())[0]?.detail).toMatchObject({ reason: "too-large" });
  });

  it("opens a message forwarded as an attachment: its text and its attachments are files too", async () => {
    const original = [
      "From: Bo <bo@other.example>",
      "Subject: Plans",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="i"',
      "",
      "--i",
      "Content-Type: text/plain",
      "",
      "Original text here.",
      "",
      "--i",
      'Content-Type: application/pdf; name="plan.pdf"',
      'Content-Disposition: attachment; filename="plan.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("%PDF plan").toString("base64"),
      "--i--",
      "",
    ].join("\n");
    imap.deliver(
      [
        AUTH,
        "From: =?UTF-8?B?QW5hIEzDrW1h?= <ana@example.com>",
        "To: inbox@mail.example",
        "Subject: =?UTF-8?Q?Fwd:_caf=C3=A9_plans?=",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="o"',
        "",
        "--o",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "See the forwarded message, caf=C3=A9.",
        "",
        "--o",
        "Content-Type: message/rfc822",
        'Content-Disposition: attachment; filename="original.eml"',
        "",
        original,
        "--o--",
        "",
      ].join("\n"),
    );
    expect(await runMailbox(deps, mailbox(), PASSWORD)).toMatchObject({ taken: 1 });
    const got = await files();
    expect(got.map((f) => [f.externalId.split("/").slice(2).join("/"), f.title, f.mime])).toEqual([
      ["a/1/a/1", "plan.pdf", "application/pdf"],
      ["a/1/body", "Plans.md", "text/markdown"],
      ["body", "Fwd: caf\u00e9 plans.md", "text/markdown"],
    ]);
    expect(await textOf(got[2]?.blobId as string)).toBe(
      [
        "# Fwd: caf\u00e9 plans",
        "",
        "- From: Ana L\u00edma <ana@example.com>",
        "- To: inbox@mail.example",
        "- Forwarded messages: Plans.md",
        "",
        "---",
        "",
        "See the forwarded message, caf\u00e9.",
        "",
      ].join("\n"),
    );
    expect(await textOf(got[1]?.blobId as string)).toContain("- From: Bo <bo@other.example>");
    expect(await textOf(got[1]?.blobId as string)).toContain("- Attachments: plan.pdf");
    expect(await textOf(got[1]?.blobId as string)).toContain("Original text here.");
  });

  it("refuses a message with two From lines, whatever the server vouched for", async () => {
    imap.deliver(message({ extra: "From: Someone Else <boss@example.com>" }));
    expect(await runMailbox(deps, mailbox(), PASSWORD)).toMatchObject({ taken: 0, refused: 1 });
    expect((await audit())[0]?.detail.reason).toBe("no-sender");
  });

  it("names the file by the whole subject, and dates it no later than now", async () => {
    imap.deliver(
      message({ subject: "Re: Q3/Q4 plan 10\\02", extra: "X-Note: n" }).replace(
        "Date: Thu, 01 Oct 2026 09:30:00 +0000",
        "Date: Fri, 01 Jan 2100 00:00:00 +0000",
      ),
    );
    imap.deliver(
      message({ subject: "Old" }).replace(
        "Date: Thu, 01 Oct 2026 09:30:00 +0000",
        "Date: Mon, 01 Jan 1900 00:00:00 +0000",
      ),
    );
    expect(await runMailbox(deps, mailbox(), PASSWORD)).toMatchObject({ taken: 2 });
    expect((await files()).map((f) => f.title).sort()).toEqual([
      "Old.md",
      "Re: Q3-Q4 plan 10-02.md",
    ]);
    const saved = await db.withTenant(t.tenantId, (tx) =>
      tx
        .select({ createdAt: versions.createdAt })
        .from(versions)
        .innerJoin(sourceRefs, eq(sourceRefs.objectId, versions.objectId))
        .where(eq(sourceRefs.source, MAIL_SOURCE)),
    );
    expect(saved).toHaveLength(2);
  });

  it("records a file whose type is too long to keep, under the plain type", async () => {
    imap.deliver(
      message({
        attachments: [{ name: "odd.bin", type: `application/x-${"y".repeat(1500)}`, body: "z" }],
      }),
    );
    expect(await runMailbox(deps, mailbox(), PASSWORD)).toMatchObject({ taken: 1 });
    expect((await files()).map((f) => [f.title, f.mime])).toContainEqual([
      "odd.bin",
      "application/octet-stream",
    ]);
  });

  it("gives up on a message that keeps failing, so it doesn't hold up the rest", async () => {
    imap.deliver(message({ subject: "Poison" }));
    const tries = new Map<number, number>();
    const failing: MailInDeps = { ...deps, tenantKey: () => Promise.reject(new Error("away")) };
    for (let run = 0; run < 5; run++) {
      expect(await runMailbox(failing, mailbox(), PASSWORD, { tries })).toMatchObject({
        deferred: 1,
      });
    }
    expect(await runMailbox(failing, mailbox(), PASSWORD, { tries })).toEqual({
      taken: 0,
      refused: 1,
      deferred: 0,
    });
    expect([...(imap.messages[0]?.flags ?? [])].sort()).toEqual(["\\Flagged", "\\Seen"]);
    expect((await audit()).at(-1)?.detail).toMatchObject({ reason: "failed" });
    expect(tries.size).toBe(0);
  });

  it("stops between messages when the server is stopping", async () => {
    imap.deliver(message({ subject: "First" }));
    imap.deliver(message({ subject: "Second" }));
    const stopping = new AbortController();
    const once: MailInDeps = {
      ...deps,
      enqueue: (_t, result) => {
        stopping.abort();
        return deps.enqueue?.(_t, result) ?? Promise.resolve();
      },
    };
    const report = await runMailbox(once, mailbox(), PASSWORD, { signal: stopping.signal });
    expect(report.taken).toBeLessThanOrEqual(1);
    expect((await files()).map((f) => f.title)).toEqual(["First.md"]);
    // Already stopping: nothing is read at all.
    expect(await runMailbox(deps, mailbox(), PASSWORD, { signal: stopping.signal })).toEqual({
      taken: 0,
      refused: 0,
      deferred: 0,
    });
  });

  it("makes text of a message that has only HTML", async () => {
    imap.deliver(
      message({
        subject: "Newsletter",
        html: "<html><head><style>p{color:red}</style></head><body><p>Hello&nbsp;<b>there</b> &amp; welcome.</p><script>steal()</script><!-- hidden --><div>1 &lt; 2 &#8212; true</div></body></html>",
      }),
    );
    await runMailbox(deps, mailbox(), PASSWORD);
    const [file] = await files();
    expect((await textOf(file?.blobId as string)).split("\n---\n\n").at(-1)).toBe(
      "Hello there & welcome.\n\n1 < 2 \u2014 true\n",
    );
  });

  it("leaves a message unread when it couldn't be handled, and takes it the next time", async () => {
    imap.deliver(message());
    const failing: MailInDeps = {
      ...deps,
      tenantKey: () => Promise.reject(new Error("the key store is away")),
    };
    expect(await runMailbox(failing, mailbox(), PASSWORD)).toEqual({
      taken: 0,
      refused: 0,
      deferred: 1,
    });
    expect(imap.messages[0]?.flags.size).toBe(0);
    expect(await audit()).toEqual([]);
    expect(await runMailbox(deps, mailbox(), PASSWORD)).toMatchObject({ taken: 1 });
  });

  it("refuses mail into a zone that isn't a managed one, and says so in the audit", async () => {
    imap.deliver(message());
    // The seeded tenant's own zone, an indexed one.
    const [taken] = await db.withTenant(t.tenantId, (tx) =>
      tx.select({ name: zones.name }).from(zones).where(eq(zones.tenantId, t.tenantId)).limit(1),
    );
    expect(await runMailbox(deps, mailbox({ zone: taken?.name }), PASSWORD)).toMatchObject({
      refused: 1,
    });
    expect((await audit())[0]?.detail.reason).toBe("zone-kind");
  });

  it("fails the run, not the server, when the mailbox can't be opened", async () => {
    await expect(runMailbox(deps, mailbox(), "wrong")).rejects.toThrow();
    await expect(runMailbox(deps, mailbox({ folder: "Nope" }), PASSWORD)).rejects.toThrow();
    await expect(runMailbox(deps, mailbox({ port: 1 }), PASSWORD)).rejects.toThrow();
    // A connection lost mid-run ends the run: the message waits, and isn't counted as failing.
    imap.deliver(message());
    imap.failOn = "UID FETCH";
    const tries = new Map<number, number>();
    await expect(runMailbox(deps, mailbox(), PASSWORD, { tries })).rejects.toThrow();
    expect(tries.size).toBe(0);
    expect(await runMailbox(deps, mailbox(), PASSWORD, { tries })).toMatchObject({ taken: 1 });
  });
});

describe("the schedule", () => {
  it("reads each mailbox that has a password, soon after start and then on its turn", async () => {
    imap.deliver(message());
    const logged: string[] = [];
    const log = {
      info: (_o: unknown, m: string) => void logged.push(`info ${m}`),
      warn: (_o: unknown, m: string) => void logged.push(`warn ${m}`),
      error: (_o: unknown, m: string) => void logged.push(`error ${m}`),
    } as unknown as NonNullable<MailInDeps["log"]>;
    const running = startMailIn(
      { ...deps, log },
      [mailbox(), mailbox({ id: "no-password" }), mailbox({ id: "bad", port: 1 })],
      { OPENHOARD_MAIL_INBOX_PASSWORD: PASSWORD, OPENHOARD_MAIL_BAD_PASSWORD: "x" },
      { firstRunMs: 10 },
    );
    const said = (line: string) => logged.includes(line);
    for (
      let i = 0;
      i < 800 && !(said("info mail-in: run finished") && said("warn mail-in: run failed"));
      i++
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await running.close();
    expect(await files()).toHaveLength(1);
    expect(logged).toContain(
      "error mail-in: OPENHOARD_MAIL_NO_PASSWORD_PASSWORD isn't set, so this mailbox isn't read",
    );
    expect(logged).toContain("info mail-in: run finished");
    expect(logged).toContain("warn mail-in: run failed");
    // Closed: nothing runs afterwards.
    imap.deliver(message({ subject: "Later" }));
    await new Promise((r) => setTimeout(r, 60));
    expect(await files()).toHaveLength(1);
  });

  it("doesn't keep shutdown waiting on a mailbox that has stopped answering", async () => {
    let aborted = false;
    const stuck: MailInDeps = {
      ...deps,
      open: () =>
        Promise.resolve({
          unread: () => new Promise<number[]>(() => undefined),
          size: () => Promise.resolve(null),
          fetch: () => Promise.resolve(null),
          done: () => Promise.resolve(),
          close: () => Promise.resolve(),
          abort: () => void (aborted = true),
        }),
    };
    const running = startMailIn(
      stuck,
      [mailbox()],
      { OPENHOARD_MAIL_INBOX_PASSWORD: PASSWORD },
      {
        firstRunMs: 1,
      },
    );
    await new Promise((r) => setTimeout(r, 50));
    const started = performance.now();
    await running.close(100);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(aborted).toBe(true);
  });

  it("stops the server's start for a mailbox whose tenant isn't there", async () => {
    await expect(checkMailboxes(db, [mailbox()])).resolves.toBeUndefined();
    await expect(
      checkMailboxes(db, [mailbox({ id: "lost", tenantId: `ten_${"0".repeat(26)}` })]),
    ).rejects.toThrow("mailIn lost: no tenant");
  });

  it("names a mailbox's password variable by its id", () => {
    expect(mailPasswordEnv("inbox")).toBe("OPENHOARD_MAIL_INBOX_PASSWORD");
    expect(mailPasswordEnv("scans.office-2")).toBe("OPENHOARD_MAIL_SCANS_OFFICE_2_PASSWORD");
  });
});

describe("senderAuthenticated", () => {
  const h = (value: string, key = "authentication-results") => [{ key, value }];
  const ok = (headers: { key: string; value: string }[], from = "a@example.com") =>
    senderAuthenticated(headers, ["mx.mail.example", "mx2.mail.example"], from);

  it("takes the first header the mailbox's own server signed, saying DMARC passed for the sender's domain", () => {
    expect(ok(h("mx.mail.example; dmarc=pass header.from=example.com"))).toBe(true);
    expect(
      ok(
        h(
          "MX2.Mail.Example 1; dkim=pass; dmarc=pass (p=none (nested) dis=none) header.from=Example.com",
        ),
      ),
    ).toBe(true);
    for (const value of [
      "mx.mail.example; dmarc=fail header.from=example.com",
      "mx.mail.example; dmarc=passed header.from=example.com",
      "mx.mail.example; spf=pass; dkim=pass",
      // It must say whose domain passed.
      "mx.mail.example; dmarc=pass",
      "mx.mail.example; dmarc=pass header.from=other.example",
      "mx.mail.example; dmarc=pass header.from=sub.example.com",
      "mx.mail.example.evil.example; dmarc=pass header.from=example.com",
      "mx.mail.example (dmarc=pass header.from=example.com); none",
      "",
    ]) {
      expect(ok(h(value)), value).toBe(false);
    }
    // The first one from that server decides: one further down may be the sender's own.
    expect(
      ok([
        ...h("mx.mail.example; dmarc=fail header.from=example.com"),
        ...h("mx.mail.example; dmarc=pass header.from=example.com"),
      ]),
    ).toBe(false);
    expect(
      ok([
        ...h("mx.other.example; dmarc=fail header.from=example.com"),
        ...h("mx.mail.example; dmarc=pass header.from=example.com"),
      ]),
    ).toBe(true);
    expect(ok(h("mx.mail.example; dmarc=pass header.from=example.com", "x-other"))).toBe(false);
  });

  it("believes nothing below a header it can't read", () => {
    // The server's own, with a comment a sender unbalanced; then the sender's forgery.
    expect(
      ok([
        ...h(
          "mx.mail.example; spf=pass (domain of (( designates) x; dmarc=fail header.from=example.com",
        ),
        ...h("mx.mail.example; dmarc=pass header.from=example.com"),
      ]),
    ).toBe(false);
  });

  it("isn't taken in by what a sender can put inside the server's header", () => {
    for (const value of [
      // A result of the sender's own, inside a quoted value the server copied.
      'mx.mail.example; dkim=pass header.i="a; dmarc=pass header.from=example.com ;x"@evil.example; dmarc=fail header.from=example.com',
      // Inside a comment, with a parenthesis the simple way of reading would stop at.
      "mx.mail.example; spf=pass (sender is a(b; dmarc=pass header.from=example.com ;c) d) smtp.mailfrom=evil.example; dmarc=fail header.from=example.com",
      // An escaped quote doesn't end the quoted string.
      'mx.mail.example; dkim=pass header.i="x\\"; dmarc=pass header.from=example.com; y"; dmarc=fail header.from=example.com',
      // Two DMARC results: which one is the server's?
      "mx.mail.example; dmarc=pass header.from=example.com; dmarc=fail header.from=example.com",
      // A quoted domain isn't the domain.
      'mx.mail.example; dmarc=pass header.from="example.com"',
      // Never closed.
      'mx.mail.example; dmarc=pass header.from=example.com; x="open',
      "mx.mail.example; dmarc=pass header.from=example.com (open",
      // Two domains named.
      "mx.mail.example; dmarc=pass header.from=example.com header.from=evil.example",
    ]) {
      expect(ok(h(value)), value).toBe(false);
    }
  });
});

describe("htmlToText and filesOf", () => {
  it("reads entities once, and leaves no tag", () => {
    expect(htmlToText("a&lt;script&gt;b &#x41;&#66; &bogus; &#0; &#xD800;")).toBe(
      "a<script>b AB &bogus; &#0; &#xD800;",
    );
    // One odd tag, as a browser reads it (`scr<script`), and no tag comes out of the pieces.
    expect(htmlToText("<p>one</p><p>two<br>three</p><scr<script>x</script>ipt>four")).toBe(
      "one\n\ntwo\nthree\nxiptfour",
    );
    expect(htmlToText("<table><tr><td>a</td><th>b</th></tr><tr><td>c</td></tr></table>")).toBe(
      "a b\n\nc",
    );
    expect(htmlToText("<p>a<p>b<ul><li>c<li>d</ul><H2>e</H2>f<BR/>g")).toBe(
      "a\nb\n\nc\nd\n\ne\nf\ng",
    );
    // Letters whose lower case is longer don't shift what is hidden.
    expect(htmlToText("\u0130\u0130\u0130<script>hidden</script>shown")).toBe(
      "\u0130\u0130\u0130shown",
    );
    expect(htmlToText("x<style>p{}</style>y<SCRIPT>z</SCRIPT >w<!-- c -->v<title>t")).toBe("xywv");
    expect(htmlToText("kept <b>bold</b> then <unclosed and lost")).toBe("kept bold then");
    expect(htmlToText("a <!-- never closed")).toBe("a");
    expect(htmlToText("")).toBe("");
  });

  it("reads hostile HTML in one pass", () => {
    const started = performance.now();
    for (const hostile of [
      "<!--".repeat(200_000),
      "<script ".repeat(100_000),
      "<".repeat(400_000),
      "<a ".repeat(200_000),
      `${"&".repeat(300_000)}#x`,
    ]) {
      htmlToText(hostile);
    }
    // Seconds, each, when read with a regular expression that backtracks; a blink here.
    expect(performance.now() - started).toBeLessThan(5000);
    // Only so much HTML is read at all.
    expect(htmlToText(`${"<p>x</p>".repeat(300_000)}<p>END</p>`)).not.toContain("END");
  });

  it("names an unnamed attachment, and takes fifty at most", async () => {
    const attachments = Array.from({ length: 55 }, (_, i) => ({
      filename: i === 0 ? null : `f${i}.txt`,
      mimeType: i === 1 ? "" : "text/plain",
      disposition: "attachment" as const,
      content: i === 2 ? "as text" : new Uint8Array([1]),
    }));
    const { files: made, skipped } = await filesOf(
      { headers: [], headerLines: [], attachments },
      1024,
    );
    expect(made).toHaveLength(51);
    expect(skipped).toBe(5);
    expect(made[0]).toMatchObject({ part: "body", title: "(no subject).md" });
    expect(made[1]).toMatchObject({ part: "a/1", title: "attachment 1" });
    expect(made[2]?.mime).toBe("application/octet-stream");
    expect(Buffer.from(made[3]?.bytes as Uint8Array).toString()).toBe("as text");
  });
});

describe("configuration", () => {
  const base = { dataDir: "/tmp/unused" };
  const box = {
    id: "inbox",
    tenantId: `ten_${"0".repeat(26)}`,
    host: "imap.mail.example",
    user: "inbox@mail.example",
    authserv: "mx.mail.example",
  };
  const problems = (mailIn: unknown[], more: Record<string, unknown> = {}) => {
    const parsed = ConfigSchema.safeParse({ ...base, ...more, mailIn });
    return parsed.success ? [] : parsed.error.issues.map((i) => i.path.join("."));
  };
  it("fills in the defaults", () => {
    expect(ConfigSchema.parse({ ...base, mailIn: [box] }).mailIn[0]).toEqual({
      ...box,
      authserv: ["mx.mail.example"],
      port: 993,
      secure: true,
      folder: "INBOX",
      zone: "Mail",
      everyMinutes: 5,
      allowUnauthenticated: false,
      allowFrom: [],
      maxBytes: 25 * 1024 * 1024,
    });
    expect(ConfigSchema.parse(base).mailIn).toEqual([]);
  });
  it("asks how a sender is known, for an owner, for TLS, and for a zone of its own", () => {
    const { authserv: _a, ...bare } = box;
    expect(problems([bare])).toEqual(["mailIn.0.authserv"]);
    expect(problems([{ ...bare, allowUnauthenticated: true }])).toEqual([]);
    expect(problems([{ ...box, allowFrom: ["a@b.example"] }])).toEqual(["mailIn.0.owner"]);
    expect(problems([{ ...box, secure: false }])).toEqual(["mailIn.0.secure"]);
    expect(problems([{ ...box, host: "127.0.0.1", secure: false }])).toEqual([]);
    expect(problems([box, box])).toEqual(["mailIn.1.id"]);
    // Their passwords would be one variable.
    expect(
      problems([
        { ...box, id: "a.b" },
        { ...box, id: "a-b" },
      ]),
    ).toEqual(["mailIn.1.id"]);
    expect(problems([{ ...box, allowUnauthenticated: true }])).toEqual([
      "mailIn.0.allowUnauthenticated",
    ]);
    expect(problems([{ ...box, authserv: ["mx1.mail.example", "mx2.mail.example"] }])).toEqual([]);
    expect(problems([{ ...box, maxBytes: 200 * 1024 * 1024 }])).toEqual(["mailIn.0.maxBytes"]);
    expect(problems([{ ...box, password: "x" }])).toEqual(["mailIn.0"]);
    const auth = {
      publicUrl: "https://files.example.com",
      cookieKey: "k".repeat(43),
      passkeys: true,
    };
    expect(problems([{ ...box, zone: "Uploads" }], { auth, uploads: {} })).toEqual([
      "mailIn.0.zone",
    ]);
    const source = {
      id: "mail",
      connector: "fs",
      tenantId: box.tenantId,
      root: process.platform === "win32" ? "C:\\docs" : "/docs",
      zone: "Mail",
      owner: "a@b.example",
    };
    expect(problems([box], { sources: [source] }).sort()).toEqual([
      "mailIn.0.zone",
      "sources.0.id",
    ]);
  });
});
