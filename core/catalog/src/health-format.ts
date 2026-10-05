import { csvRecord } from "@openhoard/core-audit";
import {
  HEALTH_SECTIONS,
  type HealthItem,
  type HealthReason,
  type HealthReport,
  type HealthSection,
} from "./health.js";

/*
 * The File Health Report as its reader gets it (T-1002): a page of plain text for the tenant's
 * owner, who may not be technical, and a CSV with every file listed, for a spreadsheet.
 *
 * Everything here is said in words that need no knowledge of OpenHoard: "can view", not
 * "read grant"; "your own labels", not "tags"; "people outside your organization", not
 * "guests". The page puts what to act on first, says for each finding why it matters and what
 * to do, and keeps apart what is only for information and what couldn't be checked.
 *
 * Titles, names and addresses are the tenant's own text, some of it from a source: shown as
 * text, with what a terminal or a spreadsheet would act on taken out or guarded.
 */

interface Wording {
  /** The finding, in a few words. */
  heading: string;
  /** Why it is worth looking at, and what to do. */
  advice: string;
}

/**
 * The order the page lists findings in: what exposes something first, housekeeping after,
 * and last what is a matter of setup, exposing nothing.
 */
export const HEALTH_PAGE_ORDER: readonly HealthSection[] = Object.freeze([
  "sensitiveWide",
  "publicLinks",
  "guests",
  "formerStaff",
  "organization",
  "stale",
  "duplicates",
  "large",
  "unmatched",
] as const);

/** Sections whose size matters to their reader (the others are about who can open a file). */
const SIZED: ReadonlySet<HealthSection> = new Set(["stale", "duplicates", "large"]);

const count = (n: number) => n.toLocaleString("en-US");
const files = (n: number) => `${count(n)} ${n === 1 ? "file" : "files"}`;

/** A number of days, as people say it: `3 years`, `90 days`. */
function span(days: number): string {
  if (days >= 365 && days % 365 === 0) {
    const years = days / 365;
    return years === 1 ? "a year" : `${years} years`;
  }
  return days === 1 ? "a day" : `${count(days)} days`;
}

/** What each section is, said to an owner, for this report's thresholds. */
export function healthWording(
  section: HealthSection,
  thresholds: HealthReport["thresholds"],
): Wording {
  switch (section) {
    case "sensitiveWide":
      return {
        heading: "Labelled as restricted, yet widely shared",
        advice:
          "The labels on these files say they should be restricted (the label is shown beside each file), yet most or all of your organization, or anyone with a link, can open them. Start here: remove the wide sharing, or correct the label if it is wrong.",
      };
    case "publicLinks":
      return {
        heading: "Open to anyone with the link",
        advice:
          "Anyone who gets hold of the link can open these, without signing in. Remove the links nobody needs any more, and set an end date on the rest (in SharePoint, from the file's Manage access panel).",
      };
    case "guests":
      return {
        heading: "Shared with people outside your organization",
        advice:
          "People outside your organization can open these (they are named beside each file). Check that each still needs it, and remove those who don't, for example after a project ends or you stop using a supplier.",
      };
    case "formerStaff":
      return {
        heading: "Tied to people who have left",
        advice:
          'Someone who has left still owns these, is still listed as able to open them, or was the one who created or last changed them. Remove access that is left over, and ask whoever set up OpenHoard to give the ones still in use a current owner. ("Left" here means their account is locked, disabled or closed.)',
      };
    case "organization":
      return {
        heading: "Shared with all or most of your organization",
        advice:
          "Everyone in your organization, or a group of at least half of it, can open these. That is right for a handbook and wrong for a salary sheet: check the ones meant for fewer people.",
      };
    case "stale":
      return {
        heading: `Not changed in ${span(thresholds.staleAfterDays)} or more`,
        advice:
          "Nothing has changed in these for a long time. Old files often still have sharing nobody remembers: archive or delete what nobody needs.",
      };
    case "duplicates":
      return {
        heading: "Exact copies of another file",
        advice:
          "Each of these has exactly the same content as at least one other file. Copies drift apart and people find the wrong one: keep one, and link to it.",
      };
    case "large":
      return {
        heading: `Larger than ${exactBytes(thresholds.largeBytes)}`,
        advice: "These take the most room. Check that each is still needed where it is.",
      };
    case "unmatched":
      return {
        heading: "Shared with people OpenHoard doesn't know yet",
        advice:
          "Where these are kept (in SharePoint, say) they are shared with people or groups that have no OpenHoard account. Nothing is exposed by this; those people simply can't find these files through OpenHoard. If they should, ask whoever set up OpenHoard to add them. Otherwise ignore this.",
      };
  }
}

const UNITS = ["bytes", "KB", "MB", "GB", "TB", "PB"] as const;

/** A size for people: `1.5 GB`, `812 KB`, `1 byte`. */
export function readableBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  let value = bytes;
  let unit = 0;
  const shown = () =>
    unit === 0 || value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  while (unit < UNITS.length - 1 && (value >= 1024 || shown() >= 1024)) {
    value /= 1024;
    unit++;
  }
  return unit === 0 && shown() === 1 ? "1 byte" : `${shown()} ${UNITS[unit] as string}`;
}

/** A threshold, said exactly: `1 GB`, `1100 MB`, never rounded to a size it isn't. */
function exactBytes(bytes: number): string {
  for (const [unit, size] of [
    ["GB", 1024 ** 3],
    ["MB", 1024 ** 2],
    ["KB", 1024],
  ] as const) {
    if (bytes >= size && bytes % size === 0) return `${count(bytes / size)} ${unit}`;
  }
  return `${count(bytes)} ${bytes === 1 ? "byte" : "bytes"}`;
}

/**
 * Text on one line with nothing a terminal would act on: control characters and line
 * separators become a space; invisible formatting characters (direction overrides, soft
 * hyphens) are taken out, except the two joiners that scripts and emoji are written with.
 */
export function plainLine(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/[^\P{Cf}\u200c\u200d]/gu, "")
    .trim();
}
const name = (text: string) => plainLine(text) || "(no name)";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `2026-12-01` as `1 Dec 2026`. */
function day(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${Number(m[3])} ${month} ${m[1]}` : plainLine(iso);
}

const CAN = { read: "can view", write: "can edit", owner: "has full control" } as const;
const ABLE = {
  read: "able to view",
  write: "able to edit",
  owner: "having full control",
} as const;
/** A kind this was never taught to say: a build error, so a new one can't go unsaid. */
const unreachable = (kind: never): string => String(kind);
/** `sensitivity:restricted` as people read a label: `sensitivity: restricted`. */
const label = (tag: string) => plainLine(tag).replace(":", ": ");
const because = (tag: string | null) =>
  tag === null ? "" : `, because the file is labelled ${label(tag)}`;

/** One reason a file is listed, in plain words. */
export function reasonText(reason: HealthReason): string {
  switch (reason.k) {
    case "share": {
      const can = CAN[reason.role];
      const until = reason.until === null ? "" : `, until ${day(reason.until)}`;
      switch (reason.share) {
        case "link-anyone":
          return `anyone with the link ${can}${until || ", with no end date"}`;
        case "link-organization":
          return `anyone in your organization with the link ${can}${until}`;
        case "link-specific":
          return `the people a sharing link names ${can.replace("has", "have")}${until}`;
        case "organization":
          return `everyone in your organization ${can}${until}`;
        case "guest":
          return `${name(reason.who)} (outside your organization) ${can}${until}`;
        case "group":
          return `a group OpenHoard doesn't know ${can}${until}`;
        case "user":
          return `a person OpenHoard doesn't know ${can}${until}`;
        default:
          return unreachable(reason.share);
      }
    }
    case "group":
      return `the group "${name(reason.name)}" (${count(reason.members)} people) ${CAN[reason.role]}${because(reason.tag)}`;
    case "label":
      return `labelled ${label(reason.tag)}`;
    case "guest":
      return `${name(reason.name)} (outside your organization) ${CAN[reason.role]}${
        reason.via === null ? "" : `, as a member of "${name(reason.via)}"`
      }${because(reason.tag)}`;
    case "made":
      return `created by ${name(reason.name)}, who has left`;
    case "changed":
      return `last changed by ${name(reason.name)}, who has left`;
    case "owned":
      return `${name(reason.name)}, who has left, is still its owner`;
    case "former":
      // (Listed, not able: an account that is stopped opens nothing through OpenHoard.)
      return `${name(reason.name)}, who has left, is still listed as ${ABLE[reason.role]}${because(reason.tag)}`;
    case "stale":
      return `last changed on ${day(reason.since)}`;
    case "copies":
      return reason.others === 1
        ? "one other file has the same content"
        : `${count(reason.others)} other files have the same content`;
    case "large":
      return "";
  }
}

/**
 * Why a file is listed, in plain words: its reasons, joined. People and groups OpenHoard
 * doesn't know are said once, counted (the sheet's `detail` has which), and nothing twice.
 */
export function reasonsText(item: Pick<HealthItem, "reasons">): string {
  const unknown = { group: 0, user: 0 };
  const said: string[] = [];
  for (const reason of item.reasons) {
    if (reason.k === "share" && (reason.share === "group" || reason.share === "user")) {
      unknown[reason.share]++;
      continue;
    }
    const text = reasonText(reason);
    if (text !== "" && !said.includes(text)) said.push(text);
  }
  const some = [
    unknown.group === 0 ? "" : unknown.group === 1 ? "a group" : `${count(unknown.group)} groups`,
    unknown.user === 0 ? "" : unknown.user === 1 ? "a person" : `${count(unknown.user)} people`,
  ].filter((part) => part !== "");
  if (some.length > 0) said.push(`${some.join(" and ")} OpenHoard doesn't know can open it`);
  return said.join("; ");
}

export interface HealthTextOptions {
  /** What the tenant is called, for the heading. */
  tenant: string;
  /** Files shown per finding, at most. Default 10. */
  show?: number;
}

/**
 * The report as a page of plain text: what was found, most pressing first, each with what it
 * means, what to do and its first few files; then what is clean, and what couldn't be checked.
 */
export function healthText(report: HealthReport, options: HealthTextOptions): string {
  const asked = options.show ?? 10;
  const show = Number.isFinite(asked) ? Math.max(0, Math.floor(asked)) : 10;
  const wording = (section: HealthSection) => healthWording(section, report.thresholds);
  const out: string[] = [];
  out.push(
    `File health report for ${name(options.tenant)}, ${day(report.generatedAt.toISOString())}`,
  );
  out.push(`OpenHoard looked at ${files(report.files)} (${readableBytes(report.bytes)} in all).`);
  const found = HEALTH_PAGE_ORDER.filter((s) => report.sections[s].count > 0);
  const clean = HEALTH_PAGE_ORDER.filter((s) => report.sections[s].count === 0);
  const checks = (n: number) => `${n} ${n === 1 ? "check" : "checks"}`;
  out.push(
    found.length === 0
      ? "None of the checks below found anything."
      : `${found.length} ${found.length === 1 ? "thing" : "things"} to look at, most pressing first` +
          (clean.length === 0 ? "." : `; ${checks(clean.length)} found nothing.`),
  );
  const leavers = report.formerStaffInGroups;
  const stillInGroups =
    `${count(leavers)} ${leavers === 1 ? "person who has left is still a member of a group" : "people who have left are still members of groups"}. ` +
    "Ask whoever manages your user accounts to remove them from every group. This report does not list, file by file, what those groups can open.";
  if (leavers > 0 && report.sections.formerStaff.count === 0) {
    out.push("", "One thing to do:", `  ${stillInGroups}`);
  }

  for (const section of found) {
    const finding = report.sections[section];
    const { heading, advice } = wording(section);
    const sized = SIZED.has(section);
    const size = !sized
      ? ""
      : section === "duplicates"
        ? ` (the extra copies take ${readableBytes(finding.bytes)})`
        : ` (${readableBytes(finding.bytes)} in all)`;
    out.push("", `${heading}: ${files(finding.count)}${size}`);
    out.push(`  ${advice}`);
    if (section === "formerStaff" && leavers > 0) out.push(`  Also: ${stillInGroups}`);
    for (const item of finding.items.slice(0, show)) {
      const why = reasonsText(item);
      out.push(
        `  - ${name(item.title)}${sized ? ` (${readableBytes(item.bytes)})` : ""}${why === "" ? "" : `: ${why}`}`,
      );
      if (item.url !== null) out.push(`    ${plainLine(item.url)}`);
    }
    const rest = finding.count - Math.min(show, finding.items.length);
    if (rest > 0) {
      out.push(`  … and ${count(rest)} more (the spreadsheet version of this report lists them).`);
    }
  }

  if (clean.length > 0) {
    out.push("", found.length === 0 ? "What was checked:" : "Nothing found:");
    for (const section of clean) out.push(`  - ${wording(section).heading}`);
  }

  out.push("", "What this report can't tell you:");
  const gaps: string[] = [
    'The sharing checks only cover SharePoint, and only files OpenHoard has read since it began recording sharing (complete after its next full scan). Counts may be low until then; for files kept anywhere else, "nothing found" means "not checked".',
    "Files that everyone can find or open because of OpenHoard's own settings and rules, rather than how they are shared, are not listed. Ask whoever set up OpenHoard to show you those.",
  ];
  const one = (n: number) => n === 1;
  if (report.undated > 0) {
    gaps.push(
      `${files(report.undated)} ${one(report.undated) ? "has" : "have"} no last-changed date, so OpenHoard couldn't tell whether ${one(report.undated) ? "it is" : "they are"} old.`,
    );
  }
  if (report.unattributed > 0) {
    const n = report.unattributed;
    gaps.push(
      `${files(n)} ${one(n) ? "doesn't" : "don't"} record who created or changed ${one(n) ? "it" : "them"}, so OpenHoard couldn't check ${one(n) ? "it" : "them"} against people who have left.`,
    );
  }
  if (report.unknownPeople > 0) {
    gaps.push(
      `${files(report.unknownPeople)} ${one(report.unknownPeople) ? "was" : "were"} created or changed by someone OpenHoard can't match to a person. That can mean they left before OpenHoard was connected, or that your accounts aren't linked to your organization's directory yet.`,
    );
  }
  for (const gap of gaps) out.push(`  - ${gap}`);
  return `${out.join("\n")}\n`;
}

export const HEALTH_CSV_COLUMNS = [
  "finding",
  "title",
  "size_bytes",
  "why",
  "where",
  "detail",
  "source",
  "section",
  "object_id",
] as const;

/**
 * The report as CSV (RFC 4180): a header, then a line for each file listed in each finding, in
 * the page's order. `why` is in plain words; `detail` is the same in the report's compact
 * form, with the ids a source names people by. A finding lists its first `limit` files
 * (healthReport()'s option): {@link healthCsvCut} says which were cut. Cells are one line
 * each, and text a spreadsheet would run as a formula is guarded (core/audit csvRecord()).
 */
export function healthCsv(report: HealthReport): string {
  let out = csvRecord(HEALTH_CSV_COLUMNS);
  for (const section of HEALTH_PAGE_ORDER) {
    const { heading } = healthWording(section, report.thresholds);
    for (const item of report.sections[section].items) {
      out += csvRecord([
        heading,
        name(item.title),
        String(item.bytes),
        reasonsText(item),
        plainLine(item.url ?? ""),
        plainLine(item.detail),
        item.source ?? "",
        section,
        item.objectId,
      ]);
    }
  }
  return out;
}

/** The findings that list fewer files than they have, with how many are missing. */
export function healthCsvCut(report: HealthReport): { section: HealthSection; missing: number }[] {
  return HEALTH_SECTIONS.flatMap((section) => {
    const finding = report.sections[section];
    const missing = finding.count - finding.items.length;
    return missing > 0 ? [{ section, missing }] : [];
  });
}
