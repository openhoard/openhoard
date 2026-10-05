import { describe, expect, it } from "vitest";
import {
  HEALTH_CSV_COLUMNS,
  HEALTH_PAGE_ORDER,
  healthCsv,
  healthCsvCut,
  healthText,
  healthWording,
  plainLine,
  readableBytes,
  reasonsText,
  reasonText,
} from "./health-format.js";
import {
  HEALTH_SECTIONS,
  type HealthFinding,
  type HealthItem,
  type HealthReason,
  type HealthReport,
} from "./health.js";

/* T-1002: the File Health Report as a page of text and as a sheet. */

const THRESHOLDS = {
  staleAfterDays: 1095,
  largeBytes: 1024 ** 3,
  wideGroupShare: 0.5,
  wideGroupMin: 10,
};
const none = (): HealthFinding => ({ count: 0, bytes: 0, items: [] });
function reportOf(more: Partial<HealthReport> = {}): HealthReport {
  return {
    generatedAt: new Date("2026-10-05T08:00:00Z"),
    files: 1204,
    bytes: 5 * 1024 ** 3,
    undated: 0,
    unattributed: 0,
    unknownPeople: 0,
    formerStaffInGroups: 0,
    thresholds: THRESHOLDS,
    sections: Object.fromEntries(
      HEALTH_SECTIONS.map((s) => [s, none()]),
    ) as HealthReport["sections"],
    ...more,
  };
}
const LINK: HealthReason = {
  k: "share",
  share: "link-anyone",
  who: "L1",
  role: "read",
  until: null,
};
const item = (n: number, more: Partial<HealthItem> = {}): HealthItem => ({
  objectId: `obj_${n}`,
  title: `File ${n}.docx`,
  source: "sp",
  url: `https://sp.example/${n}`,
  bytes: 2048,
  reasons: [LINK],
  detail: "link-anyone (read)",
  ...more,
});

describe("readableBytes", () => {
  it("says a size as people do", () => {
    expect(
      [
        0,
        1,
        2,
        1023,
        1024,
        1536,
        150 * 1024,
        1024 ** 2 - 1,
        1024 ** 3 - 1,
        5 * 1024 ** 3,
        1024 ** 6,
        -1,
        Number.NaN,
      ].map(readableBytes),
    ).toEqual([
      "0 bytes",
      "1 byte",
      "2 bytes",
      "1023 bytes",
      "1 KB",
      "1.5 KB",
      "150 KB",
      "1 MB",
      "1 GB",
      "5 GB",
      "1024 PB",
      "?",
      "?",
    ]);
  });
});

describe("plainLine", () => {
  it("takes out what a terminal would act on, and keeps what writing needs", () => {
    expect(plainLine("a\u001b[31m\nb\tc\u2028d")).toBe("a [31m b c d");
    // Direction overrides, soft hyphens and marks go, without leaving a gap.
    expect(plainLine("in\u202evoice\u00ad.txt\u200e")).toBe("invoice.txt");
    // The joiners scripts and emoji are written with stay.
    for (const text of ["क्\u200dष", "می\u200cخواهم", "👨\u200d👩\u200d👧"]) {
      expect(plainLine(text)).toBe(text);
    }
    expect(plainLine(" \u0007 ")).toBe("");
  });
});

describe("a reason, in plain words", () => {
  it("says who can do what, without OpenHoard's own terms", () => {
    const said = (
      [
        [LINK, "anyone with the link can view, with no end date"],
        [
          { ...LINK, role: "write", until: "2026-12-01" },
          "anyone with the link can edit, until 1 Dec 2026",
        ],
        [
          { ...LINK, share: "link-organization" },
          "anyone in your organization with the link can view",
        ],
        [{ ...LINK, share: "link-specific" }, "the people a sharing link names can view"],
        [{ ...LINK, share: "organization", who: "" }, "everyone in your organization can view"],
        [
          { ...LINK, share: "guest", who: "pat@x.test", role: "owner" },
          "pat@x.test (outside your organization) has full control",
        ],
        [
          { ...LINK, share: "group", who: "sitegroup:s:5", role: "write" },
          "a group OpenHoard doesn't know can edit",
        ],
        [
          { k: "former", name: "Lou", role: "owner", tag: "team:x" },
          "Lou, who has left, is still listed as having full control, because the file is labelled team: x",
        ],
        [
          { ...LINK, share: "link-specific", role: "owner" },
          "the people a sharing link names have full control",
        ],
        [{ ...LINK, share: "user", who: "6f1c" }, "a person OpenHoard doesn't know can view"],
        [
          { k: "group", name: "Everyone", members: 1200, role: "read", tag: null },
          'the group "Everyone" (1,200 people) can view',
        ],
        [
          { k: "group", name: "All", members: 12, role: "write", tag: "department:all" },
          'the group "All" (12 people) can edit, because the file is labelled department: all',
        ],
        [{ k: "label", tag: "sensitivity:restricted" }, "labelled sensitivity: restricted"],
        [
          { k: "guest", name: "Pat Lee", via: "Suppliers", role: "write", tag: null },
          'Pat Lee (outside your organization) can edit, as a member of "Suppliers"',
        ],
        [{ k: "made", name: "Lou" }, "created by Lou, who has left"],
        [{ k: "changed", name: "Lou" }, "last changed by Lou, who has left"],
        [{ k: "owned", name: "Lou" }, "Lou, who has left, is still its owner"],
        [
          { k: "former", name: "Lou", role: "read", tag: null },
          "Lou, who has left, is still listed as able to view",
        ],
        [{ k: "stale", since: "2019-03-02" }, "last changed on 2 Mar 2019"],
        [{ k: "copies", others: 1 }, "one other file has the same content"],
        [{ k: "copies", others: 2 }, "2 other files have the same content"],
        [{ k: "large", over: 5 }, ""],
      ] satisfies [HealthReason, string][]
    ).map(([reason, want]) => [reasonText(reason), want]);
    for (const [got, want] of said) expect(got).toBe(want);
    // No word of the catalog's own in any of them.
    for (const [got] of said) {
      expect(got).not.toMatch(/\b(grant|tag|principal|source|sync|read|write|guest)\b/i);
    }
    // Names from a source are shown as text.
    expect(reasonText({ k: "made", name: "Lo\u001b[0mu\n" })).toBe(
      "created by Lo [0mu, who has left",
    );
    expect(reasonText({ k: "owned", name: "\u200e" })).toBe(
      "(no name), who has left, is still its owner",
    );
    expect(
      reasonsText({ reasons: [{ k: "label", tag: "a:b" }, { k: "large", over: 1 }, LINK, LINK] }),
    ).toBe("labelled a: b; anyone with the link can view, with no end date");
    // People and groups it doesn't know are counted, not said one by one.
    const stranger = (share: "user" | "group", who: string): HealthReason => ({
      ...LINK,
      share,
      who,
    });
    expect(
      reasonsText({
        reasons: [stranger("group", "g1"), stranger("group", "g2"), LINK, stranger("user", "u1")],
      }),
    ).toBe(
      "anyone with the link can view, with no end date; 2 groups and a person OpenHoard doesn't know can open it",
    );
    expect(reasonsText({ reasons: [stranger("group", "g1")] })).toBe(
      "a group OpenHoard doesn't know can open it",
    );
    expect(reasonsText({ reasons: [stranger("user", "a"), stranger("user", "b")] })).toBe(
      "2 people OpenHoard doesn't know can open it",
    );
  });
});

describe("the report as text", () => {
  it("says so when no check found anything, and still what was checked and what wasn't", () => {
    const text = healthText(reportOf(), { tenant: "Acme" });
    expect(text.split("\n").slice(0, 5)).toEqual([
      "File health report for Acme, 5 Oct 2026",
      "OpenHoard looked at 1,204 files (5 GB in all).",
      "None of the checks below found anything.",
      "",
      "What was checked:",
    ]);
    for (const section of HEALTH_SECTIONS) {
      expect(text).toContain(`  - ${healthWording(section, THRESHOLDS).heading}\n`);
    }
    expect(text).toContain("What this report can't tell you:");
    expect(text).toContain('"nothing found" means "not checked".');
    expect(text.endsWith("\n")).toBe(true);
    // Something to do that is in no file's list is not hidden behind "nothing found".
    const leavers = healthText(reportOf({ formerStaffInGroups: 2 }), { tenant: "Acme" });
    expect(leavers.split("\n").slice(2, 6)).toEqual([
      "None of the checks below found anything.",
      "",
      "One thing to do:",
      "  2 people who have left are still members of groups. Ask whoever manages your user accounts to remove them from every group. This report does not list, file by file, what those groups can open.",
    ]);
  });

  it("leads with what to act on: what it is, what to do, the first files, how many more", () => {
    const report = reportOf({
      undated: 3,
      unattributed: 1,
      unknownPeople: 2,
      formerStaffInGroups: 1,
    });
    report.sections.publicLinks = {
      count: 12,
      bytes: 3 * 1024 * 1024,
      items: [1, 2, 3].map((n) => item(n)),
    };
    report.sections.sensitiveWide = {
      count: 1,
      bytes: 1,
      items: [item(5, { reasons: [{ k: "label", tag: "sensitivity:restricted" }, LINK] })],
    };
    report.sections.duplicates = {
      count: 2,
      bytes: 4096,
      items: [item(8, { reasons: [{ k: "copies", others: 1 }], url: null })],
    };
    report.sections.formerStaff = {
      count: 1,
      bytes: 1,
      items: [item(9, { reasons: [{ k: "owned", name: "Lou" }], url: null })],
    };
    report.sections.unmatched = { count: 1, bytes: 1, items: [item(7)] };
    const text = healthText(report, { tenant: "Acme", show: 2 });
    const lines = text.split("\n");
    expect(lines[2]).toBe("5 things to look at, most pressing first; 4 checks found nothing.");
    const at = lines.indexOf("Open to anyone with the link: 12 files");
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1, at + 7)).toEqual([
      `  ${healthWording("publicLinks", THRESHOLDS).advice}`,
      "  - File 1.docx: anyone with the link can view, with no end date",
      "    https://sp.example/1",
      "  - File 2.docx: anyone with the link can view, with no end date",
      "    https://sp.example/2",
      "  … and 10 more (the spreadsheet version of this report lists them).",
    ]);
    // Most pressing first; setup last; sizes only where size is the point.
    const order = [
      "Labelled as restricted, yet widely shared: 1 file",
      "Open to anyone with the link: 12 files",
      "Tied to people who have left: 1 file",
      "Exact copies of another file: 2 files (the extra copies take 4 KB)",
      "Shared with people OpenHoard doesn't know yet: 1 file",
      "Nothing found:",
      "What this report can't tell you:",
    ].map((heading) => lines.indexOf(heading));
    expect(order.every((n) => n > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain(
      "  - File 5.docx: labelled sensitivity: restricted; anyone with the link can view, with no end date",
    );
    expect(text).toContain(
      "  - File 8.docx (2 KB): one other file has the same content\n  … and 1 more (the spreadsheet",
    );
    // People who left and are still in groups are said where the reader acts on it, once.
    const former = lines.indexOf("Tied to people who have left: 1 file");
    expect(lines[former + 2]).toMatch(
      /^ {2}Also: 1 person who has left is still a member of a group\. Ask whoever manages/,
    );
    expect(text.match(/still a member of a group/g)).toHaveLength(1);
    expect(text).not.toContain("One thing to do:");
    // What is clean is a line each; what couldn't be checked is said in plain words.
    expect(text).toContain("  - Shared with people outside your organization\n");
    expect(text).toContain(
      "3 files have no last-changed date, so OpenHoard couldn't tell whether they are old.",
    );
    expect(text).toContain("1 file doesn't record who created or changed it");
    expect(text).toContain(
      "2 files were created or changed by someone OpenHoard can't match to a person.",
    );
  });

  it("says its findings by the thresholds they were judged with, exactly", () => {
    const report = reportOf({
      thresholds: { ...THRESHOLDS, staleAfterDays: 30, largeBytes: 1100 * 1024 * 1024 },
    });
    report.sections.large = {
      count: 2,
      bytes: 3 * 1024 ** 3,
      items: [item(1, { bytes: 2 * 1024 ** 3, reasons: [{ k: "large", over: 1 }] })],
    };
    const text = healthText(report, { tenant: "Acme" });
    expect(text).toContain("  - Not changed in 30 days or more\n");
    expect(text).toContain("Larger than 1,100 MB: 2 files (3 GB in all)\n");
    expect(text).toContain("  - File 1.docx (2 GB)\n");
    expect(healthWording("stale", THRESHOLDS).heading).toBe("Not changed in 3 years or more");
    expect(healthWording("large", THRESHOLDS).heading).toBe("Larger than 1 GB");
    const at = (days: number, largeBytes: number) => {
      const t = { ...THRESHOLDS, staleAfterDays: days, largeBytes };
      return [healthWording("stale", t).heading, healthWording("large", t).heading];
    };
    expect(at(365, 1024)).toEqual(["Not changed in a year or more", "Larger than 1 KB"]);
    expect(at(1, 1)).toEqual(["Not changed in a day or more", "Larger than 1 byte"]);
    expect(at(366, 1500)).toEqual(["Not changed in 366 days or more", "Larger than 1,500 bytes"]);
  });

  it("shows the tenant's text as text: nothing a terminal would act on", () => {
    const report = reportOf();
    report.sections.large = {
      count: 2,
      bytes: 1,
      items: [
        item(1, {
          title: "evil\u001b[31m\nname\u202e.txt",
          reasons: [{ k: "large", over: 1 }],
          url: "https://x.example/\u0007",
        }),
        item(2, { title: "\u200e", reasons: [], url: null }),
      ],
    };
    const text = healthText(report, { tenant: "Ac\nme", show: Number.NaN });
    expect(text).toContain("File health report for Ac me,");
    expect(text).toContain("  - evil [31m name.txt (2 KB)\n    https://x.example/\n");
    expect(text).toContain("  - (no name) (2 KB)\n");
    // (Only the page's own line breaks.)
    expect([...text].filter((c) => c !== "\n" && /\p{Cc}/u.test(c))).toEqual([]);
  });

  it("has words for every section, in an order that has them all, none of them OpenHoard's own", () => {
    expect([...HEALTH_PAGE_ORDER].sort()).toEqual([...HEALTH_SECTIONS].sort());
    const headings = new Set<string>();
    for (const section of HEALTH_SECTIONS) {
      const { heading, advice } = healthWording(section, THRESHOLDS);
      headings.add(heading);
      expect(advice).toMatch(/[.)]$/);
      expect(`${heading} ${advice}`).not.toMatch(
        /\b(grant|tag|principal|source|sync|provision|exposure|tenant|index|guest)/i,
      );
    }
    expect(headings.size).toBe(HEALTH_SECTIONS.length);
  });
});

describe("the report as CSV", () => {
  it("has a line per file listed, in plain words, one line a cell, guarded against formulas", () => {
    const report = reportOf();
    report.sections.guests = {
      count: 3,
      bytes: 0,
      items: [
        item(1, {
          title: '=HYPERLINK("http://evil","x")',
          reasons: [{ ...LINK, share: "guest", who: "a@b.test" }],
          detail: "guest a@b.test (read)",
        }),
        item(2, {
          title: 'Plan, "final"\n\u001b[2J.docx',
          source: null,
          url: null,
          reasons: [],
          detail: "-x",
        }),
      ],
    };
    report.sections.stale = {
      count: 1,
      bytes: 0,
      items: [
        item(3, {
          reasons: [{ k: "stale", since: "2019-03-02" }],
          detail: "unchanged since 2019-03-02",
        }),
      ],
    };
    const csv = healthCsv(report);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(HEALTH_CSV_COLUMNS.join(","));
    expect(lines[1]).toBe(
      `Shared with people outside your organization,"'=HYPERLINK(""http://evil"",""x"")",2048,a@b.test (outside your organization) can view,https://sp.example/1,guest a@b.test (read),sp,guests,obj_1`,
    );
    expect(lines[2]).toBe(
      `Shared with people outside your organization,"Plan, ""final"" [2J.docx",2048,,,'-x,,guests,obj_2`,
    );
    expect(lines[3]).toBe(
      "Not changed in 3 years or more,File 3.docx,2048,last changed on 2 Mar 2019,https://sp.example/3,unchanged since 2019-03-02,sp,stale,obj_3",
    );
    expect(lines).toHaveLength(5);
    expect([...csv].filter((c) => c !== "\r" && c !== "\n" && /\p{Cc}/u.test(c))).toEqual([]);
    // The sheet says what it lacks: a finding listing fewer files than it has.
    expect(healthCsvCut(report)).toEqual([{ section: "guests", missing: 1 }]);
    // An empty report is a header.
    expect(healthCsv(reportOf())).toBe(`${HEALTH_CSV_COLUMNS.join(",")}\r\n`);
  });
});
