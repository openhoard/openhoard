import { createHash } from "node:crypto";
import { appendAudit } from "@openhoard/core-audit";
import { ingest, INGEST_LIMITS, IngestError, type IngestResult } from "@openhoard/core-catalog";
import { getTenant, isId, type Database, type Tx } from "@openhoard/core-db";
import { findUserByEmail, getUser, userPrincipal, type User } from "@openhoard/core-identity";
import { blobPath, type BlobStore } from "@openhoard/core-storage";
import { ImapFlow } from "imapflow";
import type { Logger } from "pino";
import PostalMime, { type Address, type Email } from "postal-mime";
import { mailPasswordEnv, type MailboxConfig } from "./config.js";
import { managedZone, ZoneKindError } from "./managed.js";
import { retrying } from "./retry.js";
import { uploadTitle } from "./uploads.js";

/*
 * Email-in (T-1208): a dedicated mailbox is polled over IMAP, and what arrives there becomes
 * files. Forward a message to the mailbox and its text and attachments are in OpenHoard.
 *
 * - Each configured mailbox (`mailIn`) is read every `everyMinutes` (5 by default), on a worker:
 *   its unread messages, oldest first, 50 at most in a run. The password comes from the
 *   environment only (OPENHOARD_MAIL_<ID>_PASSWORD), never the config.
 * - A message becomes a Markdown file (who, when, the subject, the text) and one file for each
 *   attachment, in a managed zone (`zone`, "Mail" by default), OpenHoard keeping the bytes
 *   (core/storage). They are recorded and enriched as uploads are (T-1206).
 * - Whose they are: the sender's, when the sender is an active member of the tenant (their
 *   email address); or `owner`'s, for a sender listed in `allowFrom`. Mail from anyone else is
 *   refused. Nobody but the owner reads the files until they share them.
 * - Who the sender is, is what the mailbox's own server says: a From line is anyone's to write.
 *   With `authserv` (the names the mailbox's provider signs its Authentication-Results header
 *   with), a message is taken only when that header says DMARC passed for the From domain,
 *   and the message has one From line.
 *   Without it the config must say `allowUnauthenticated`, and then a From line is believed.
 * - A message is handled once: taken or refused, it is marked read (a refused one is flagged
 *   too, so it stands out in the mailbox). One that couldn't be handled just now (the database,
 *   the store) stays unread for the next run; after five runs it is given up on (refused as
 *   `failed`), so it doesn't hold up what came after it. If the server stops between recording a message
 *   and marking it, the next run records it again as the same files (they are named by the
 *   message's bytes), not as twins.
 * - Nothing in a message is followed or run: no links are fetched, no remote images loaded.
 *   Its text is content like any file's, and enrichment treats it as untrusted.
 * - Every message is audited: `mail.receive`, allowed (with the files it became) or denied
 *   (with why). Sender addresses are in the audit; subjects and text are not.
 */

/** The `source` of items that arrived by mail. */
export const MAIL_SOURCE = "mail";
const ACTOR = "system:mail-in";
/** Messages handled in one run of one mailbox. */
const RUN_MAX = 50;
/** Attachments taken from one message. */
const ATTACHMENTS_MAX = 50;
/** The first run after start, so a restart loop doesn't hammer a mail server. */
const FIRST_RUN_MS = 10_000;

/** One connection to a mailbox, for one run. */
export interface MailSession {
  /** The ids (IMAP UIDs) of unread messages, oldest first. */
  unread(): Promise<number[]>;
  /** A message's size in bytes, or null when it is gone. */
  size(uid: number): Promise<number | null>;
  /** A message whole, or null when it is gone. */
  fetch(uid: number): Promise<Uint8Array | null>;
  /** Marks it read; `flag` it too when it was refused. */
  done(uid: number, flag: boolean): Promise<void>;
  close(): Promise<void>;
  /** Drops the connection at once (the server is stopping): what is under way fails. */
  abort(): void;
}

export interface MailInDeps {
  db: Database;
  store: BlobStore;
  tenantKey: (tenantId: string) => Promise<Uint8Array>;
  /** Queues enrichment once a file committed (core/jobs enqueueAfterIngest). */
  enqueue?: (tenantId: string, result: IngestResult) => Promise<unknown>;
  log?: Logger;
  /** Opens a mailbox; IMAP by default (tests pass their own). */
  open?: (mailbox: MailboxConfig, password: string) => Promise<MailSession>;
}

export interface RunReport {
  taken: number;
  refused: number;
  /** Left unread, to try again. */
  deferred: number;
}

// --- IMAP -------------------------------------------------------------------------------------

/** A mailbox over IMAP (imapflow): one folder, opened for the run. */
export async function imapSession(mailbox: MailboxConfig, password: string): Promise<MailSession> {
  const client = new ImapFlow({
    host: mailbox.host,
    port: mailbox.port,
    secure: mailbox.secure,
    auth: { user: mailbox.user, pass: password },
    logger: false,
    disableAutoIdle: true,
    // A server that stops answering fails the run, to be tried again at the next turn.
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 120_000,
  });
  // A connection that drops mid-run rejects the command under way; this keeps the event from
  // being an unhandled one.
  client.on("error", () => undefined);
  await client.connect();
  let lock: { release(): void };
  try {
    lock = await client.getMailboxLock(mailbox.folder);
  } catch (e) {
    await client.logout().catch(() => undefined);
    throw e;
  }
  return {
    async unread() {
      const found = await client.search({ seen: false }, { uid: true });
      return (found || []).slice().sort((a, b) => a - b);
    },
    async size(uid) {
      const m = await client.fetchOne(String(uid), { size: true, uid: true }, { uid: true });
      return m && typeof m.size === "number" ? m.size : null;
    },
    async fetch(uid) {
      const m = await client.fetchOne(String(uid), { source: true, uid: true }, { uid: true });
      return m && m.source ? new Uint8Array(m.source) : null;
    },
    async done(uid, flag) {
      await client.messageFlagsAdd(String(uid), flag ? ["\\Seen", "\\Flagged"] : ["\\Seen"], {
        uid: true,
      });
    },
    async close() {
      lock.release();
      await client.logout().catch(() => undefined);
    },
    abort() {
      client.close();
    },
  };
}

// --- A message --------------------------------------------------------------------------------

const address = (a: Address | undefined): string | null =>
  a && typeof a.address === "string" && a.address !== "" ? a.address.trim().toLowerCase() : null;
const shown = (a: Address): string =>
  a.group
    ? `${a.name}: ${a.group.map((m) => m.address).join(", ")}`
    : a.name
      ? `${a.name} <${a.address}>`
      : a.address;
/** On one line. */
const line = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * An Authentication-Results header's value (RFC 8601) as its parts between semicolons, in lower
 * case, with comments removed and each quoted string replaced by `""`: nothing a sender put in
 * a comment or in quotes can pass for one of the server's own results. Null when a quote or a
 * comment never closes.
 */
function authResults(value: string): string[] | null {
  const parts: string[] = [];
  let part = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string;
    if (quoted) {
      if (ch === "\\") i++;
      else if (ch === '"') quoted = false;
    } else if (depth > 0) {
      if (ch === "\\") i++;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
    } else if (ch === '"') {
      quoted = true;
      part += '""';
    } else if (ch === "(") {
      depth = 1;
      part += " ";
    } else if (ch === ";") {
      parts.push(part);
      part = "";
    } else part += ch;
  }
  if (quoted || depth > 0) return null;
  parts.push(part);
  return parts.map((p) => p.replace(/\s+/g, " ").trim().toLowerCase());
}

/**
 * Whether the mailbox's own server says the message is from the domain in its From line.
 *
 * Only an Authentication-Results header signed with one of `authserv` counts (RFC 8601: a
 * provider removes any such header that arrives claiming its name), and of those the first,
 * which is the one the last hop added. It must hold exactly one DMARC result, `dmarc=pass`,
 * naming the From address's domain (`header.from=`).
 */
export function senderAuthenticated(
  headers: readonly { key: string; value: string }[],
  authserv: readonly string[],
  from: string,
): boolean {
  const wanted = authserv.map((a) => a.toLowerCase());
  for (const h of headers) {
    if (h.key.toLowerCase() !== "authentication-results") continue;
    const parts = authResults(h.value);
    // One that can't be read might be the server's own: nothing below it is believed.
    if (parts === null) return false;
    // "authserv-id [version]", then the results.
    const id = parts[0]?.split(" ")[0];
    if (id === undefined || !wanted.includes(id)) continue;
    const dmarc = parts.slice(1).filter((r) => /^dmarc ?=/.test(r));
    const only = dmarc[0];
    if (dmarc.length !== 1 || only === undefined || !/^dmarc ?= ?pass( |$)/.test(only)) {
      return false;
    }
    const named = [...only.matchAll(/ header\.from ?= ?(\S+)/g)].map((m) => m[1]);
    return named.length === 1 && named[0] === from.slice(from.lastIndexOf("@") + 1);
  }
  return false;
}

/** The longest HTML read as text; the rest of a longer message's text is left out. */
const HTML_MAX = 2_000_000;
const UNSHOWN_TAGS = new Set(["script", "style", "head", "title"]);
const LINE_TAGS = new Set(["br", "p", "div", "tr", "li", "blockquote", "table", "ul", "ol"]);

/**
 * A message's HTML as plain text: what is between the tags, a line per block. One pass over the
 * text, whatever it holds (mail is other people's HTML, and some of it is written to be slow).
 */
export function htmlToText(given: string): string {
  const html = given.length > HTML_MAX ? given.slice(0, HTML_MAX) : given;
  // (ASCII only: lower-casing some other letters changes how long the text is.)
  const lower = html.replace(/[A-Z]+/g, (c) => c.toLowerCase());
  let out = "";
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf("<", at);
    if (open < 0) {
      out += html.slice(at);
      break;
    }
    out += html.slice(at, open);
    if (lower.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      at = end < 0 ? html.length : end + 3;
      continue;
    }
    const close = html.indexOf(">", open + 1);
    // A tag that never closes: no text after it is the reader's.
    if (close < 0) break;
    const name = /^\/?[a-z][a-z0-9]*/.exec(lower.slice(open + 1, open + 20))?.[0] ?? "";
    at = close + 1;
    if (UNSHOWN_TAGS.has(name)) {
      // To its end tag (or the end): what is inside isn't shown.
      const end = lower.indexOf(`</${name}`, at);
      const after = end < 0 ? -1 : html.indexOf(">", end);
      at = after < 0 ? html.length : after + 1;
    } else if (LINE_TAGS.has(name.replace("/", "")) || /^\/?h[1-6]$/.test(name)) out += "\n";
    else if (name === "/td" || name === "/th") out += " ";
  }
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  // A ">" with no tag to close isn't markup. Then the entities, once: a "<" the message wrote
  // as text (`&lt;`) is text.
  const decoded = out
    .replace(/>/g, "")
    .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi, (whole, name: string) => {
      if (name[0] !== "#") return entities[name.toLowerCase()] ?? whole;
      const code =
        name[1] === "x" || name[1] === "X"
          ? Number.parseInt(name.slice(2), 16)
          : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : whole;
    });
  return decoded
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface FileOfMessage {
  /** What tells it from the message's other files: `body`, or `a/<n>`. */
  part: string;
  title: string;
  mime: string;
  bytes: Uint8Array;
}

/** How deep a message forwarded inside a message inside a message is still opened. */
const NESTED_MAX = 3;
/** How many forwarded messages are opened in one message, at any depth. */
const NESTED_BUDGET = 20;

/**
 * The files a parsed message becomes: its text as Markdown, then its attachments. A message
 * forwarded as an attachment (message/rfc822) is opened in turn: its own text and attachments
 * are files too, since nothing reads an `.eml` whole. `maxBytes` is each file's limit; fifty
 * attachments are taken in all.
 */
export async function filesOf(
  mail: Email,
  maxBytes: number,
  at = "",
  depth = 0,
  /** How many more forwarded messages may be opened, in the whole message. */
  budget = { nested: NESTED_BUDGET },
): Promise<{ files: FileOfMessage[]; skipped: number }> {
  // Every part that isn't the text, but what a multipart/related message embeds in its HTML
  // (a logo in a signature). A picture "shown in place" is kept: phones send photos that way.
  const attachments = mail.attachments.filter(
    (a) => !(a.related === true && a.disposition !== "attachment"),
  );
  const kept: FileOfMessage[] = [];
  const inside: FileOfMessage[] = [];
  let skipped = 0;
  for (const [i, a] of attachments.entries()) {
    const part = `${at}a/${i + 1}`;
    const bytes =
      typeof a.content === "string"
        ? new TextEncoder().encode(a.content)
        : a.content instanceof Uint8Array
          ? a.content
          : new Uint8Array(a.content);
    if (i >= ATTACHMENTS_MAX || bytes.byteLength > maxBytes) {
      skipped++;
      continue;
    }
    if (a.mimeType.toLowerCase() === "message/rfc822" && depth < NESTED_MAX && budget.nested > 0) {
      budget.nested--;
      const nested = await PostalMime.parse(bytes).then(
        (m) => filesOf(m, maxBytes, `${part}/`, depth + 1, budget),
        () => null,
      );
      if (nested !== null) {
        inside.push(...nested.files);
        skipped += nested.skipped;
        continue;
      }
      // Not readable as a message: kept as the file it is.
    }
    kept.push({
      part,
      title: uploadTitle(a.filename ?? `attachment ${i + 1}`),
      // (A type too long to record says nothing useful about the file.)
      mime:
        a.mimeType !== "" && a.mimeType.length <= INGEST_LIMITS.mime
          ? a.mimeType
          : "application/octet-stream",
      bytes,
    });
  }
  const subject = line(mail.subject ?? "") || "(no subject)";
  const people = (list: Address[] | undefined) => (list ?? []).map(shown).map(line).join("; ");
  const text = (mail.text ?? "").trim() || htmlToText(mail.html ?? "");
  const forwarded = inside.filter(
    (f) => f.part.endsWith("/body") && f.part.split("/").length === at.split("/").length + 2,
  );
  const head = [
    `# ${subject}`,
    "",
    ...(mail.from ? [`- From: ${line(shown(mail.from))}`] : []),
    ...(mail.to?.length ? [`- To: ${people(mail.to)}`] : []),
    ...(mail.cc?.length ? [`- Cc: ${people(mail.cc)}`] : []),
    ...(mail.date ? [`- Date: ${line(mail.date)}`] : []),
    ...(kept.length ? [`- Attachments: ${kept.map((f) => f.title).join("; ")}`] : []),
    ...(forwarded.length
      ? [`- Forwarded messages: ${forwarded.map((f) => f.title).join("; ")}`]
      : []),
  ];
  const body: FileOfMessage = {
    part: `${at}body`,
    // (A subject's slashes aren't a path: "Q3/Q4 plan" is the whole name.)
    title: uploadTitle(`${subject.replace(/[\\/]+/g, "-")}.md`),
    mime: "text/markdown; charset=utf-8",
    // A rule between the two: text that starts like a list is not more of the header's.
    bytes: new TextEncoder().encode(`${head.join("\n")}\n\n---\n\n${text}\n`),
  };
  // Fifty files of a message besides its text, however they are nested.
  const all = [...kept, ...inside];
  const taken = depth === 0 ? all.slice(0, ATTACHMENTS_MAX) : all;
  return { files: [body, ...taken], skipped: skipped + all.length - taken.length };
}

type Refusal =
  | "too-large"
  | "unreadable"
  | "no-sender"
  | "unauthenticated"
  | "sender"
  | "no-owner"
  | "zone-kind"
  | "invalid"
  /** It kept failing: given up on, so it doesn't hold up what came after it. */
  | "failed";

/** An active member: never a guest, a service account, or someone locked or retired. */
const usable = (user: User | null): user is User =>
  user !== null && user.kind === "member" && user.active && user.retired === null;

/**
 * Handles one message: its files recorded and audited, or its refusal audited. Resolves with
 * the refusal's reason, or null when it was taken. Throws when it couldn't be handled now.
 */
export async function takeMessage(
  deps: MailInDeps,
  mailbox: MailboxConfig,
  raw: Uint8Array,
): Promise<Refusal | null> {
  const { db, log } = deps;
  const { tenantId } = mailbox;
  const refuse = async (reason: Refusal, from: string | null): Promise<Refusal> => {
    await db.withTenant(tenantId, (tx) =>
      appendAudit(tx, tenantId, {
        actor: ACTOR,
        action: "mail.receive",
        decision: "deny",
        detail: { mailbox: mailbox.id, reason, ...(from ? { from } : {}), size: raw.byteLength },
      }),
    );
    return reason;
  };

  // (The server's word for its size was checked before it was fetched; this is the fact.)
  if (raw.byteLength > mailbox.maxBytes) return refuse("too-large", null);
  let mail: Email;
  try {
    mail = await PostalMime.parse(raw);
  } catch {
    return refuse("unreadable", null);
  }
  const from = address(mail.from);
  // One From line: with two, which one a server vouched for is anyone's guess. (Of several
  // addresses on it the first is the sender here, and the vouching must be for its domain.)
  const fromLines = mail.headers.filter((h) => h.key.toLowerCase() === "from").length;
  if (from === null || fromLines !== 1) return refuse("no-sender", null);
  if (mailbox.authserv === undefined) {
    // The config said so (allowUnauthenticated): the From line is believed.
  } else if (!senderAuthenticated(mail.headers, mailbox.authserv, from)) {
    return refuse("unauthenticated", from);
  }

  // Whose the files are: the sender's own, or the mailbox's owner's for a listed sender.
  const ownerOf = async (tx: Tx): Promise<User | Refusal> => {
    const member = await findUserByEmail(tx, tenantId, from);
    if (usable(member)) return member;
    if (!mailbox.allowFrom.includes(from)) return "sender";
    const named = mailbox.owner;
    if (named === undefined) return "no-owner";
    const owner = isId("user", named)
      ? await getUser(tx, tenantId, named)
      : await findUserByEmail(tx, tenantId, named);
    return usable(owner) ? owner : "no-owner";
  };
  const first = await db.withTenant(tenantId, ownerOf, { accessMode: "read only" });
  if (typeof first === "string") return refuse(first, from);

  const { files, skipped } = await filesOf(mail, mailbox.maxBytes);
  // Named by the message's bytes: handled twice, it is the same files, not twins.
  const digest = createHash("sha256").update(raw).digest("hex");
  // When it says it was sent, if that is a time there has been: a Date line is the sender's.
  const said = mail.date === undefined ? Number.NaN : Date.parse(mail.date);
  const when = said > 0 && said <= Date.now() ? new Date(said) : new Date();
  const recorded: { object: string; part: string }[] = [];
  const queued: IngestResult[] = [];
  const key = await deps.tenantKey(tenantId);
  try {
    for (const file of files) {
      const stored = await deps.store.put({ id: tenantId, key }, file.bytes);
      const done = await retrying(() =>
        db.withTenant(tenantId, async (tx) => {
          // Still theirs to receive, now: not only when the message was first looked at.
          const owner = await ownerOf(tx);
          if (typeof owner === "string") throw new Refused(owner);
          const zoneId = (await managedZone(tx, tenantId, mailbox.zone, {
            create: true,
            actor: ACTOR,
          })) as string;
          const principal = userPrincipal(owner.id);
          return ingest(tx, tenantId, {
            source: MAIL_SOURCE,
            externalId: `${mailbox.id}/${digest}/${file.part}`,
            zoneId,
            title: file.title,
            ownerId: principal,
            content: {
              blobId: stored.blobId,
              size: stored.size,
              location: blobPath(tenantId, stored.blobId),
            },
            mime: file.mime,
            authorId: principal,
            modifiedAt: when,
          });
        }),
      );
      recorded.push({ object: done.objectId, part: file.part });
      queued.push(done);
    }
  } catch (e) {
    if (e instanceof Refused) return refuse(e.reason, from);
    if (e instanceof ZoneKindError) {
      log?.error({ mailbox: mailbox.id, zone: mailbox.zone }, `mail-in: ${e.message}`);
      return refuse("zone-kind", from);
    }
    if (e instanceof IngestError) {
      log?.warn({ mailbox: mailbox.id, code: e.code }, "mail-in: a file was refused");
      return refuse("invalid", from);
    }
    throw e;
  }
  await db.withTenant(tenantId, (tx) =>
    appendAudit(tx, tenantId, {
      actor: ACTOR,
      action: "mail.receive",
      decision: "allow",
      detail: {
        mailbox: mailbox.id,
        from,
        owner: userPrincipal(first.id),
        // (The message's text first, then its attachments.)
        objects: recorded.map((r) => r.object).join(" "),
        attachments: recorded.length - 1,
        ...(skipped > 0 ? { skipped } : {}),
      },
    }),
  );
  // After the commits. A file that isn't queued now is found by maintenance.
  for (const result of queued) {
    await deps
      .enqueue?.(tenantId, result)
      .catch((err: unknown) =>
        log?.warn({ err, tenantId, object: result.objectId }, "mail-in: enqueueing failed"),
      );
  }
  return null;
}

class Refused extends Error {
  constructor(readonly reason: Refusal) {
    super(reason);
  }
}

// --- A run, and the schedule --------------------------------------------------------------------

/** How many runs a message may fail in before it is given up on. */
const TRIES_MAX = 5;

export interface RunOptions {
  /**
   * Aborted when the server is stopping: the connection is dropped and the run ends. A message
   * it was on stays unread (if it was recorded already, the next run finds the same files).
   */
  signal?: AbortSignal;
  /**
   * How often each message (by UID) has failed, kept between runs: one that keeps failing is
   * given up on (refused as `failed`), so it doesn't hold up everything that came after it.
   */
  tries?: Map<number, number>;
}

/**
 * Reads one mailbox once. Throws when the mailbox can't be opened or stops answering; a
 * message that can't be handled (the database, the store) is deferred, and the run goes on.
 */
export async function runMailbox(
  deps: MailInDeps,
  mailbox: MailboxConfig,
  password: string,
  options: RunOptions = {},
): Promise<RunReport> {
  const { signal, tries } = options;
  const report: RunReport = { taken: 0, refused: 0, deferred: 0 };
  const deny = (reason: Refusal, size: number) =>
    deps.db.withTenant(mailbox.tenantId, (tx) =>
      appendAudit(tx, mailbox.tenantId, {
        actor: ACTOR,
        action: "mail.receive",
        decision: "deny",
        detail: { mailbox: mailbox.id, reason, size },
      }),
    );
  if (signal?.aborted) return report;
  const session = await (deps.open ?? imapSession)(mailbox, password);
  const stop = () => session.abort();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    if (signal?.aborted) return report;
    const all = await session.unread();
    // Only what is still there to read is remembered as having failed.
    for (const uid of tries?.keys() ?? []) if (!all.includes(uid)) tries?.delete(uid);
    for (const uid of all.slice(0, RUN_MAX)) {
      if (signal?.aborted) break;
      // What the mailbox itself fails at (the connection gone) ends the run: it says nothing
      // about the message, and the next run starts where this one stopped.
      const size = await session.size(uid);
      if (size === null) continue;
      let refusal: Refusal | null;
      if (size > mailbox.maxBytes) {
        await deny("too-large", size);
        refusal = "too-large";
      } else if ((tries?.get(uid) ?? 0) >= TRIES_MAX) {
        await deny("failed", size);
        refusal = "failed";
      } else {
        const raw = await session.fetch(uid);
        if (raw === null) continue;
        try {
          refusal = await takeMessage(deps, mailbox, raw);
        } catch (err) {
          // The database, the store: unread still, for the next run.
          report.deferred++;
          tries?.set(uid, (tries.get(uid) ?? 0) + 1);
          deps.log?.warn(
            { err, mailbox: mailbox.id, uid },
            "mail-in: a message couldn't be handled",
          );
          continue;
        }
      }
      await session.done(uid, refusal !== null);
      tries?.delete(uid);
      if (refusal === null) report.taken++;
      else report.refused++;
    }
  } catch (err) {
    // Stopping: the connection was dropped on purpose.
    if (!signal?.aborted) throw err;
  } finally {
    signal?.removeEventListener("abort", stop);
    await session.close().catch(() => undefined);
  }
  return report;
}

/**
 * What a mailbox needs before it is read: its tenant. Throws (naming the mailbox) when there is
 * none, as a folder's set-up does: mail read into nowhere would be marked read and lost.
 */
export async function checkMailboxes(
  db: Database,
  mailboxes: readonly MailboxConfig[],
): Promise<void> {
  for (const m of mailboxes) {
    const known = await db.withTenant(m.tenantId, (tx) => getTenant(tx, m.tenantId), {
      accessMode: "read only",
    });
    if (!known)
      throw new Error(`invalid OpenHoard config:\n  mailIn ${m.id}: no tenant ${m.tenantId}`);
  }
}

export interface MailIn {
  /**
   * Stops the schedule and the runs under way (their connections are dropped). Waits for them,
   * `graceMs` at most (2 s by default): shutdown has other things to close.
   */
  close(graceMs?: number): Promise<void>;
}

/**
 * Reads every configured mailbox on its schedule, one run of a mailbox at a time. A mailbox
 * with no password in the environment is said once (error) and left alone; a run that fails
 * (the server unreachable, the password refused) is logged and tried again at the next turn.
 */
export function startMailIn(
  deps: MailInDeps,
  mailboxes: readonly MailboxConfig[],
  env: NodeJS.ProcessEnv,
  options: { firstRunMs?: number } = {},
): MailIn {
  const timers: NodeJS.Timeout[] = [];
  const running = new Set<Promise<void>>();
  const stopping = new AbortController();
  for (const mailbox of mailboxes) {
    const password = env[mailPasswordEnv(mailbox.id)];
    if (password === undefined || password === "") {
      deps.log?.error(
        { mailbox: mailbox.id },
        `mail-in: ${mailPasswordEnv(mailbox.id)} isn't set, so this mailbox isn't read`,
      );
      continue;
    }
    let busy = false;
    const tries = new Map<number, number>();
    const turn = () => {
      if (busy || stopping.signal.aborted) return;
      busy = true;
      const run = runMailbox(deps, mailbox, password, { signal: stopping.signal, tries })
        .then(
          (report) => {
            if (report.taken + report.refused + report.deferred > 0) {
              deps.log?.info({ mailbox: mailbox.id, ...report }, "mail-in: run finished");
            }
          },
          (err: unknown) => deps.log?.warn({ err, mailbox: mailbox.id }, "mail-in: run failed"),
        )
        .finally(() => {
          busy = false;
          running.delete(run);
        });
      running.add(run);
    };
    const first = setTimeout(turn, options.firstRunMs ?? FIRST_RUN_MS);
    const every = setInterval(turn, mailbox.everyMinutes * 60_000);
    first.unref();
    every.unref();
    timers.push(first, every);
    deps.log?.info(
      { mailbox: mailbox.id, tenantId: mailbox.tenantId, everyMinutes: mailbox.everyMinutes },
      "mail-in: mailbox ready",
    );
  }
  return {
    async close(graceMs = 2000) {
      stopping.abort();
      for (const t of timers) clearTimeout(t);
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(running),
        new Promise((r) => (timer = setTimeout(r, graceMs))),
      ]);
      clearTimeout(timer);
    },
  };
}
