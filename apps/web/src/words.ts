import type { Client, ReviewItem, Source, Trust } from "./api.js";

/*
 * A source's sync in an admin's words. Which state it is in, and so which command lifts it, the
 * server says (`standing`, core/jobs syncStanding()); here are only the words. What an admin
 * can't do from this app yet names the command that does, whole, for whoever runs the server.
 */

export type Tone = "ok" | "busy" | "attention";

export interface SourceStatus {
  tone: Tone;
  /** Where the source stands. */
  text: string;
  /** What to do about it, when something is to be done: each choice and its command. */
  steps?: { does: string; command: string }[];
}

const CONNECTORS: Record<string, string> = {
  "connector-sharepoint": "SharePoint",
  "connector-fs": "A folder on the server",
};

/** A connector's name as people know it; its own id when it's one this page hasn't met. */
export function connectorName(connector: string): string {
  return CONNECTORS[connector] ?? connector;
}

export function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en")} ${n === 1 ? one : many}`;
}

export function sourceStatus(s: Source, tenantId: string): SourceStatus {
  const command = (name: string) =>
    `openhoard admin source ${name} --tenant ${tenantId} --source ${s.source}`;
  const st = s.standing;
  switch (st.is) {
    case "held":
      return {
        tone: "attention",
        text: `${count(st.count, "file")} here ${st.count === 1 ? "is" : "are"} no longer at the source. That is more than OpenHoard removes without being told to, so it removes nothing and takes no changes from this source until someone decides.`,
        steps: [
          {
            does: "If they were really deleted or moved away, remove them here too:",
            command: command("confirm-reconcile"),
          },
          {
            does: "If that looks wrong (a library that was offline, say), remove nothing and read the source again from the beginning:",
            command: command("discard-reconcile"),
          },
        ],
      };
    case "confirmed":
      return {
        tone: "busy",
        text: `${count(st.count, "file")} no longer at the source ${st.count === 1 ? "is" : "are"} being removed here, as an admin confirmed.`,
      };
    case "identity-changed":
      return {
        tone: "attention",
        text: "What is at this source's address is not what OpenHoard first read there (a site recreated, another folder in its place). It has stopped reading it, so nothing is removed by mistake.",
        steps: [
          {
            does: "If the source is meant to be this one now, accept it; everything is read again from the beginning:",
            command: command("accept-identity"),
          },
        ],
      };
    case "stopped":
      return {
        tone: "attention",
        text: `Reading this source stopped after a failure (${st.code}). What was read before stays; nothing new is read until it is started again.`,
        steps: [{ does: "Once the cause is fixed, start it again:", command: command("resume") }],
      };
    case "deferred":
      return {
        tone: "attention",
        text: "Part of this source couldn't be read the last time everything was read, so nothing was removed then: files deleted at the source since may still be listed here.",
        steps: [
          {
            does: "Once the source can be read in full, read it again from the beginning:",
            command: command("discard-reconcile"),
          },
        ],
      };
    case "waiting-for-owner":
      return {
        tone: "attention",
        text: "Waiting for its owner. Nothing is read until the person this source is set up under has signed in to OpenHoard once.",
      };
    case "not-run":
      return {
        tone: "busy",
        text: "No sync has finished yet. Files appear as they are read.",
      };
    case "reading":
      return {
        tone: "busy",
        text: "Reading everything at the source. Files appear as they are read.",
      };
    case "catching-up":
      return { tone: "busy", text: "Catching up on changes at the source." };
    case "retrying":
      return {
        tone: "busy",
        text: `The last sync ended early${st.code ? ` (${st.code})` : ""}. It is tried again by itself.`,
      };
    case "cancelled":
      return { tone: "busy", text: "The last sync was cut short. The next one runs on schedule." };
    case "current":
      return { tone: "ok", text: "Up to date." };
    default:
      // A state this page doesn't know: said as it is, never as fine.
      return { tone: "busy", text: `State: ${(st as { is: string }).is}.` };
  }
}

/** What the last sync counted; nothing when it counted nothing worth saying. */
export function countsText(counts: Record<string, number> | null): string | null {
  if (counts === null) return null;
  const n = (key: string) => (Number.isFinite(counts[key]) ? (counts[key] as number) : 0);
  const parts: string[] = [];
  if (n("ingested") > 0) parts.push(`${count(n("ingested"), "file")} recorded`);
  if (n("unchanged") > 0) parts.push(`${n("unchanged").toLocaleString("en")} unchanged`);
  const removed = n("deleted") + n("reconciled");
  if (removed > 0) parts.push(`${removed.toLocaleString("en")} removed`);
  if (n("skipped") > 0) parts.push(`${n("skipped").toLocaleString("en")} left out`);
  return parts.length === 0 ? null : parts.join(", ");
}

/** The server stops counting people or groups it can't match here: "at least this many". */
const MOST_COUNTED = 10_000;

/**
 * People and groups the source gives access to that OpenHoard doesn't know: access the source
 * gives them doesn't apply here until they are provisioned. Worth a line of its own on a pilot.
 */
export function unmatchedText(counts: Record<string, number> | null): string | null {
  if (counts === null) return null;
  const users = Number.isFinite(counts.unmappedUsers) ? (counts.unmappedUsers as number) : 0;
  const groups = Number.isFinite(counts.unmappedGroups) ? (counts.unmappedGroups as number) : 0;
  if (users <= 0 && groups <= 0) return null;
  const many = (n: number, one: string, more: string) =>
    (n >= MOST_COUNTED ? "at least " : "") + count(n, one, more);
  const who = [
    users > 0 ? many(users, "person", "people") : null,
    groups > 0 ? many(groups, "group", "groups") : null,
  ]
    .filter((x) => x !== null)
    .join(" and ");
  const one = users + groups === 1;
  return `The source gives access to ${who} OpenHoard doesn't know yet. Until ${one ? (users === 1 ? "that person is" : "that group is") : "they are"} added to OpenHoard, that access doesn't apply here.`;
}

/** A time for people: the day and the minute, in their own zone and language. */
export function when(iso: string, locale?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

/*
 * AI clients (T-904). A client is shown by what identifies it, which it can't choose freely: the
 * address of the document it publishes about itself, or the addresses a sign-in through it
 * returns to. The name it gives itself is anyone's to claim.
 */

/**
 * A trust label for an admin: where what the app reads ends up, which decides what it is given
 * (core/policy exposureAllowsContent()). By where the content goes, not where the program runs:
 * a desktop app that talks to a cloud AI is that cloud AI's kind. The server's own approval page
 * says the same in the same words (apps/server oauth/pages.ts): change both together.
 */
export const TRUST_WORDS: Record<Trust, { label: string; means: string }> = {
  consumer: {
    label: "Personal AI",
    means:
      "An AI app on personal or free terms, including paid personal plans. Gets the content only of files cleared for any AI.",
  },
  commercial: {
    label: "Organization AI",
    means:
      "An AI service your organization has a business agreement with. Gets everything except files marked \u201Cour computers only\u201D.",
  },
  local: {
    label: "Stays on our computers",
    means:
      "The AI runs on your own machines; nothing leaves them. A desktop app that uses a cloud AI doesn't count.",
  },
};

/**
 * The site a client is identified by, and the addresses under it. Addresses are shown as the
 * browser would go to them (an international look-alike of a known site shows in its `xn--`
 * form, as in the title), never as the client wrote them.
 */
export function clientIdentity(c: Pick<Client, "clientId" | "redirectUris">): {
  title: string;
  detail: string;
  addresses: string[];
  /** Where a sign-in through it returns to, when that isn't what identifies it. */
  returnsTo: string[];
} {
  const returns = [...new Set(c.redirectUris.map(asWritten))];
  if (c.clientId !== null) {
    return {
      title: hostOf(c.clientId) ?? asWritten(c.clientId),
      detail: "Identified by the document it publishes about itself at:",
      addresses: [asWritten(c.clientId)],
      returnsTo: returns,
    };
  }
  const hosts = [...new Set(c.redirectUris.map((u) => hostOf(u) ?? asWritten(u)))];
  const local = hosts.length > 0 && hosts.every((h) => LOOPBACK.has(h));
  return {
    title: local ? "A program on the person's own computer" : hosts.join(", ") || "Unknown app",
    detail: local
      ? "It registered itself. Any program on that computer can register the same way. A sign-in through it returns to:"
      : "It registered itself. A sign-in through it returns to:",
    addresses: returns,
    returnsTo: [],
  };
}

/** An address as a browser would go to it; one that isn't an address, with nothing unprintable. */
function asWritten(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    try {
      return encodeURI(url);
    } catch {
      // Half a character: not text a browser could show or go to.
      return "(an address that can't be shown)";
    }
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * How much a client is in use: the people connected through it now, and the last request it
 * made (to within a minute).
 */
export function clientUseText(c: Pick<Client, "people" | "lastUsedAt">, locale?: string): string {
  const connected =
    c.people > 0
      ? `${count(c.people, "person", "people")} connected through it.`
      : "Nobody is connected through it.";
  const last =
    c.lastUsedAt === null
      ? "No request made yet."
      : `Last request made ${when(c.lastUsedAt, locale)}.`;
  return `${connected} ${last}`;
}

/** Where a client stands for an admin: what it gets now, and who can change that. */
export type ClientStanding =
  /** Nobody decided, and it gets nothing. */
  | "waiting"
  /** It gets tokens, and admins here decide. */
  | "approved"
  /** It gets tokens because the server's config lists it: the config decides. */
  | "approved-by-config"
  /** An admin refused or revoked it. */
  | "refused"
  /** The config approved it and no longer lists it: it gets nothing until approved here. */
  | "lapsed";

export function clientStanding(c: Pick<Client, "status" | "trust" | "managedBy">): ClientStanding {
  if (c.trust !== null) return c.managedBy === "config" ? "approved-by-config" : "approved";
  return c.status === "pending" ? "waiting" : c.status === "refused" ? "refused" : "lapsed";
}

/*
 * Tags to review, and the vocabulary (T-903). A tag is `facet:value`: shown as "kind: value",
 * with the value's own label where the vocabulary has one.
 */

/** A tag's two halves. */
export function tagParts(tag: string): { facet: string; value: string } {
  const at = tag.indexOf(":");
  return at <= 0
    ? { facet: "", value: tag }
    : { facet: tag.slice(0, at), value: tag.slice(at + 1) };
}

/**
 * Why a suggested tag waits for a person. `inVocabulary`: the value has been approved since
 * (on another file), whatever the item's own reason says.
 */
export function reviewReasonText(
  item: Pick<ReviewItem, "reason" | "confidence">,
  inVocabulary = false,
): string {
  if (item.reason === "new-value" && inVocabulary) {
    return "This value was new when it was suggested; it has been added to your vocabulary since.";
  }
  switch (item.reason) {
    case "agent":
      return "An AI assistant suggested it while working for someone. Assistants can only suggest.";
    case "low-confidence":
      return `The AI that read the file wasn't sure (${Math.round(item.confidence * 100)}% confident).`;
    case "new-value":
      return "This value isn't in your vocabulary yet. Approving it adds it to the vocabulary, for use on any file.";
    case "sensitive":
      return "This tag changes who can see the file or which AI gets it, so a person decides.";
    case "conflict":
      return "The file already has another value of this kind, and it can only have one.";
    case "primary":
      return "The file already has this tag. The suggestion is to make it the file's main tag: where the file belongs.";
    default:
      return "It waits for a person to decide.";
  }
}

/** Who suggested a tag, as far as an admin needs. */
export function suggestedBy(appliedBy: string | null): string {
  if (appliedBy === null) return "Suggested automatically";
  if (appliedBy.startsWith("model:agent/")) return "Suggested by an AI assistant";
  if (appliedBy.startsWith("model:")) return "Suggested by the AI that reads new files";
  if (appliedBy.startsWith("user:")) return "Suggested by a person";
  if (appliedBy.startsWith("rule:")) return "Suggested by a rule";
  return "Suggested automatically";
}

const VISIBILITY_WORDS: Record<string, string> = {
  hidden: "Hides the file from people who can't open it.",
  discoverable: "People who can't open the file can see that it exists.",
  readable:
    "Everyone in your organization can see the file's card and summary, without being able to open it.",
};

const EXPOSURE_WORDS: Record<string, string> = {
  "metadata-only": "No AI gets the file's content, only its details.",
  "local-only": "Only AI that stays on your computers gets the file's content.",
  "commercial-only": "Personal AI doesn't get the file's content.",
  full: "Any approved AI gets the file's content.",
};

/** What carrying a value does to a file, in sentences; none for a value that only labels. */
export function valueEffects(v: { visibility: string | null; exposure: string | null }): string[] {
  const out: string[] = [];
  if (v.visibility !== null)
    out.push(VISIBILITY_WORDS[v.visibility] ?? `Visibility: ${v.visibility}.`);
  if (v.exposure !== null) out.push(EXPOSURE_WORDS[v.exposure] ?? `AI access: ${v.exposure}.`);
  return out;
}
