import type { Source } from "./api.js";

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
