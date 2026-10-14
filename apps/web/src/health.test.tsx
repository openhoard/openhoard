import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createApi,
  SignedOut,
  type Api,
  type HealthReportPage,
  type HealthSheet,
} from "./api.js";
import { Health } from "./health.js";

/* T-1002: the File Health Report page. (Its words are core's: core/catalog health-format.ts.) */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REPORT: HealthReportPage = {
  generatedAt: "2026-10-14T20:00:00.000Z",
  files: 1204,
  looked: "OpenHoard looked at 1,204 files (3.1 GB in all).",
  summary: "2 things to look at, most pressing first; 7 checks found nothing.",
  oneThing: null,
  findings: [
    {
      section: "publicLinks",
      heading: "Open to anyone with the link",
      advice: "Anyone who gets hold of the link can open these.",
      count: 3,
      size: null,
      also: null,
      items: [
        {
          objectId: "obj_1",
          title: "Salaries 2026.xlsx",
          url: "https://contoso.sharepoint.com/x",
          size: null,
          why: "anyone with the link can view, with no end date",
        },
        {
          objectId: "obj_2",
          title: "Odd link.docx",
          url: "javascript:alert(1)",
          size: null,
          why: "",
        },
      ],
      more: 1,
    },
    {
      section: "large",
      heading: "Larger than 1 GB",
      advice: "These take the most room.",
      count: 1,
      size: "1.5 GB in all",
      also: null,
      items: [{ objectId: "obj_3", title: "Video.mp4", url: null, size: "1.5 GB", why: "" }],
      more: 0,
    },
  ],
  clean: ["Shared with people outside your organization"],
  gaps: ["The sharing checks only cover SharePoint."],
  thresholds: { staleAfterDays: 1095, largeBytes: 1024 ** 3 },
};

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function page(over: Partial<Api> = {}) {
  const api = {
    health: vi.fn<Api["health"]>(async () => REPORT),
    exportHealth: vi.fn<Api["exportHealth"]>(async () => ({
      ended: "done",
      file: new Blob(["x"]),
      name: "file-health-2026-10-14.csv",
      cut: 0,
    })),
    ...over,
  } as unknown as Api;
  const signedOut = vi.fn();
  const signInAgain = vi.fn(async () => true);
  const save = vi.fn();
  const show = () =>
    act(async () => {
      root.render(
        <Health api={api} onSignedOut={signedOut} onSignInAgain={signInAgain} save={save} />,
      );
    });
  return { api, show, signedOut, signInAgain, save };
}

const text = () => host.textContent ?? "";
const button = (name: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === name) as HTMLButtonElement;
const click = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
const field = (label: string) =>
  [...host.querySelectorAll("label")]
    .find((l) => l.textContent?.startsWith(label))
    ?.querySelector("input") as HTMLInputElement;
const type = (label: string, value: string) =>
  act(async () => {
    const el = field(label);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

describe("the File Health page (T-1002)", () => {
  it("says the findings in the server's words, most pressing first, with their files", async () => {
    const { show } = page();
    await show();
    const headings = [...host.querySelectorAll("h2")].map((h) => h.textContent);
    expect(headings).toEqual([
      "Open to anyone with the link: 3 files",
      "Larger than 1 GB: 1 file (1.5 GB in all)",
      "Nothing found",
      "What this report can't tell you",
    ]);
    expect(text()).toContain("OpenHoard looked at 1,204 files");
    expect(text()).toContain("anyone with the link can view, with no end date");
    expect(text()).toContain("… and 1 more file. The spreadsheet lists them all.");
    expect(text()).toContain("1.5 GB");
    // A web address is a link out; anything else is only text.
    const links = [...host.querySelectorAll("main a, section a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(links).toEqual(["https://contoso.sharepoint.com/x"]);
    expect(text()).toContain("Odd link.docx");
    // The fields say what it was judged by.
    expect(field("Not changed in").value).toBe("3");
    expect(field("Larger than").value).toBe("1024");
  });

  it("checks again by other thresholds, and refuses ones that aren't", async () => {
    const { api, show } = page();
    await show();
    await type("Not changed in", "1");
    await type("Larger than", "5");
    await click(button("Check again"));
    expect(api.health).toHaveBeenLastCalledWith({ staleDays: 365, largeMb: 5 });
    await type("Larger than", "0.5");
    await click(button("Check again"));
    expect(api.health).toHaveBeenCalledTimes(2);
    expect(text()).toContain("“Larger than” is a whole number of MB");
  });

  it("keeps what is being typed when a report comes in, and drops a sheet for old thresholds", async () => {
    let answer: (r: HealthReportPage) => void = () => undefined;
    let sheet: (r: HealthSheet) => void = () => undefined;
    const { show, save } = page({
      health: vi
        .fn<Api["health"]>()
        .mockResolvedValueOnce({
          ...REPORT,
          thresholds: { staleAfterDays: 1, largeBytes: 1024 ** 2 },
        })
        .mockImplementationOnce(() => new Promise((done) => (answer = done))),
      exportHealth: vi.fn(() => new Promise<HealthSheet>((done) => (sheet = done))),
    });
    await show();
    // One day is said exactly enough to be sent back as it is.
    expect(field("Not changed in").value).toBe("0.0027");
    await click(button("Download the spreadsheet"));
    await click(button("Check again"));
    expect(text()).not.toContain("is a number of years");
    await type("Larger than", "7");
    await act(async () => answer(REPORT));
    expect(field("Larger than").value).toBe("7");
    await act(async () => sheet({ ended: "done", file: new Blob(["x"]), name: "old.csv", cut: 0 }));
    expect(save).not.toHaveBeenCalled();
  });

  it("says which field it won't take", async () => {
    const { show } = page();
    await show();
    await type("Larger than", "");
    await click(button("Check again"));
    expect(field("Larger than").getAttribute("aria-invalid")).toBe("true");
    expect(field("Larger than").getAttribute("aria-describedby")).toBe("health-problem");
    expect(field("Not changed in").getAttribute("aria-invalid")).toBe("false");
  });

  it("downloads the spreadsheet, and says what it left out", async () => {
    const { api, show, save } = page({
      exportHealth: vi.fn(async (): Promise<HealthSheet> => ({
        ended: "done",
        file: new Blob(["x"]),
        name: "file-health-2026-10-14.csv",
        cut: 12,
      })),
    });
    await show();
    await click(button("Download the spreadsheet"));
    expect(api.exportHealth).toHaveBeenCalledWith({});
    expect(save).toHaveBeenCalledWith(expect.any(Blob), "file-health-2026-10-14.csv");
    expect(text()).toContain("Downloaded file-health-2026-10-14.csv. It leaves out 12 files");
  });

  it("asks for a fresh sign-in for the spreadsheet when the server does", async () => {
    const { show, signInAgain, save } = page({
      exportHealth: vi.fn(async (): Promise<HealthSheet> => ({ ended: "sign-in-again" })),
    });
    await show();
    await click(button("Download the spreadsheet"));
    expect(save).not.toHaveBeenCalled();
    await click(button("Sign out and in again"));
    expect(signInAgain).toHaveBeenCalled();
  });

  it("says when it can't be made, isn't allowed, or nobody is signed in", async () => {
    const failing = page({ health: vi.fn(async () => Promise.reject(new ApiError(0))) });
    await failing.show();
    expect(text()).toContain("The report couldn't be made.");
    const refused = page({ health: vi.fn(async () => Promise.reject(new ApiError(403))) });
    await refused.show();
    expect(text()).toContain("You aren't allowed to see this.");
    const out = page({ health: vi.fn(async () => Promise.reject(new SignedOut())) });
    await out.show();
    expect(out.signedOut).toHaveBeenCalled();
  });
});

describe("the File Health Report over the API (T-1002)", () => {
  it("asks with the thresholds, and reads the report and the sheet's answers", async () => {
    const answers = [
      Response.json({ ...REPORT, findings: [{ ...REPORT.findings[0], items: [{ no: 1 }] }] }),
      Response.json(REPORT),
      new Response("finding\r\n", {
        headers: {
          "content-disposition": 'attachment; filename="file-health-2026-10-14.csv"',
          "x-report-cut": "3",
        },
      }),
      Response.json({ error: "sign in again", signIn: "/auth/sign-in" }, { status: 403 }),
      Response.json({ error: "bad" }, { status: 400 }),
    ];
    const fetcher = vi.fn(async () => answers.shift() as Response);
    const api = createApi(fetcher as unknown as typeof fetch);
    // A report that isn't one is refused, never half shown.
    await expect(api.health({})).rejects.toBeInstanceOf(ApiError);
    expect(await api.health({ staleDays: 365, largeMb: 5 })).toEqual(REPORT);
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/admin/health",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ staleDays: 365, largeMb: 5 }),
      }),
    );
    expect(await api.exportHealth({ staleDays: 30 })).toMatchObject({
      ended: "done",
      name: "file-health-2026-10-14.csv",
      cut: 3,
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/admin/health/export",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ staleDays: 30 }) }),
    );
    expect(await api.exportHealth({})).toEqual({ ended: "sign-in-again" });
    expect(await api.exportHealth({})).toEqual({ ended: "invalid" });
  });
});
