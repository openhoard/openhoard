import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  auditParams,
  createApi,
  SignedOut,
  type Api,
  type AuditEvent,
  type AuditPage,
  type Exported,
} from "./api.js";
import { Audit } from "./audit.js";

/* T-905: the audit log page. (What the server records and refuses: apps/server sign-in-links.test.ts.) */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const event = (seq: number, over: Partial<AuditEvent> = {}): AuditEvent => ({
  seq,
  at: "2026-10-05T07:00:00.000Z",
  actor: "user:usr_1",
  action: "source.run-now",
  decision: "allow",
  client: null,
  object: null,
  detail: { source: "finance" },
  hash: "a".repeat(64),
  ...over,
});

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
    audit: vi.fn<Api["audit"]>(async () => ({ events: [event(2), event(1)], next: null })),
    exportAudit: vi.fn<Api["exportAudit"]>(async () => ({
      ended: "done",
      file: new Blob(["x"]),
      name: "audit-2026-10-14.csv",
    })),
    verifyAudit: vi.fn<Api["verifyAudit"]>(async () => ({ ok: true, count: 7, head: "h" })),
    ...over,
  } as unknown as Api;
  const signedOut = vi.fn();
  const signInAgain = vi.fn(async () => true);
  const save = vi.fn();
  const show = () =>
    act(async () => {
      root.render(
        <Audit api={api} onSignedOut={signedOut} onSignInAgain={signInAgain} save={save} />,
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
    ?.querySelector("input, select") as HTMLInputElement | HTMLSelectElement;
/** Types into a field as a person would: React hears the input event. */
const type = (label: string, value: string) =>
  act(async () => {
    const el = field(label);
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
const events = () => [...host.querySelectorAll(".audit-events > li")].map((li) => li.textContent);

describe("the audit log page (T-905)", () => {
  it("lists events newest first, with who, what and how it went, and pages older ones", async () => {
    const audit = vi
      .fn<Api["audit"]>()
      .mockResolvedValueOnce({
        events: [
          event(3, {
            action: "export.file",
            decision: "deny",
            client: "claude",
            object: "obj_9",
            detail: { reason: "sign-in-again" },
          }),
          event(2),
        ],
        next: 2,
      })
      .mockResolvedValueOnce({ events: [event(1, { action: "search" })], next: null });
    const { show } = page({ audit });
    await show();
    expect(events()).toHaveLength(2);
    const [first] = events();
    expect(first).toContain("export.file");
    expect(first).toContain("Refused");
    expect(first).toContain("user:usr_1");
    expect(first).toContain("through claude");
    expect(first).toContain("on obj_9");
    expect(first).toContain("reason: sign-in-again");
    expect(events()[1]).toContain("Allowed");

    await click(button("Show older"));
    expect(audit).toHaveBeenLastCalledWith({}, 2);
    expect(events()).toHaveLength(3);
    expect(events()[2]).toContain("search");
    expect(button("Show older")).toBeUndefined();
    // Focus goes to the first of them, not to nowhere with the button gone.
    expect(document.activeElement?.getAttribute("data-seq")).toBe("1");
  });

  it("finds by the filter when it's sent, and downloads what it found", async () => {
    const { api, show, save } = page();
    await show();
    await type("Who", "user:usr_2");
    await type("Action starts with", "source.");
    await type("Outcome", "deny");
    await type("From", "2026-10-01");
    await type("Until", "2026-10-03");
    // Not until it's sent.
    expect(api.audit).toHaveBeenCalledTimes(1);
    await click(button("Show"));
    const asked = {
      actor: "user:usr_2",
      action: "source.",
      decision: "deny",
      from: "2026-10-01",
      until: "2026-10-03",
    };
    expect(api.audit).toHaveBeenLastCalledWith(asked);
    expect(text()).toContain("Downloads the events that match");

    await click(button("Download CSV"));
    expect(api.exportAudit).toHaveBeenCalledWith(asked, "csv");
    expect(save).toHaveBeenCalledWith(expect.any(Blob), "audit-2026-10-14.csv");
    expect(text()).toContain("Downloaded audit-2026-10-14.csv.");

    await click(button("Clear"));
    expect(api.audit).toHaveBeenLastCalledWith({});
    expect((field("Who") as HTMLInputElement).value).toBe("");
  });

  it("drops a download taken before the filter changed", async () => {
    let finish: (e: Exported) => void = () => undefined;
    const { show, save } = page({
      exportAudit: vi.fn(() => new Promise<Exported>((done) => (finish = done))),
    });
    await show();
    await click(button("Download CSV"));
    expect(button("Download CSV").disabled).toBe(true);
    await type("Who", "user:usr_2");
    await click(button("Show"));
    await act(async () => finish({ ended: "done", file: new Blob(["x"]), name: "old.csv" }));
    expect(save).not.toHaveBeenCalled();
    expect(text()).not.toContain("Downloaded");
  });

  it("refuses a range that ends before it starts, without asking", async () => {
    const { api, show } = page();
    await show();
    await type("From", "2026-10-05");
    await type("Until", "2026-10-01");
    await click(button("Show"));
    expect(api.audit).toHaveBeenCalledTimes(1);
    expect(text()).toContain("“From” must be on or before “Until”.");
  });

  it("asks for a fresh sign-in for a download when the server does", async () => {
    const { show, signInAgain, save } = page({
      exportAudit: vi.fn(async (): Promise<Exported> => ({ ended: "sign-in-again" })),
    });
    await show();
    await click(button("Download NDJSON"));
    expect(save).not.toHaveBeenCalled();
    expect(text()).toContain("takes a recent sign-in");
    await click(button("Sign out and in again"));
    expect(signInAgain).toHaveBeenCalled();
  });

  it("says what a download came to when it wasn't done", async () => {
    const cases: [Exported, string][] = [
      [{ ended: "refused" }, "You aren't allowed to download the log."],
      [{ ended: "invalid", field: "from" }, "didn't accept the filter (From)"],
      [{ ended: "failed" }, "The download didn't finish."],
    ];
    for (const [ended, says] of cases) {
      const { show } = page({ exportAudit: vi.fn(async () => ended) });
      await show();
      await click(button("Download CSV"));
      expect(text()).toContain(says);
    }
  });

  it("checks the log, and says plainly where it's broken", async () => {
    const verifyAudit = vi
      .fn<Api["verifyAudit"]>()
      .mockResolvedValueOnce({ ok: true, count: 7, head: "h" })
      .mockResolvedValueOnce({ ok: false, count: 4, seq: 5, problem: "hash mismatch" })
      .mockRejectedValueOnce(new ApiError(500));
    const { show } = page({ verifyAudit });
    await show();
    await click(button("Check the log"));
    expect(text()).toContain("The log is whole: 7 events");
    await click(button("Check the log"));
    expect(text()).toContain("changed or damaged at event 5: hash mismatch. The 4 events before");
    await click(button("Check the log"));
    expect(text()).toContain("The check couldn't be run.");
  });

  it("says when it can't load, isn't allowed, or nobody is signed in", async () => {
    const failing = page({
      audit: vi.fn(async (): Promise<AuditPage> => Promise.reject(new ApiError(0))),
    });
    await failing.show();
    expect(text()).toContain("The log couldn't be loaded.");

    const refused = page({
      audit: vi.fn(async (): Promise<AuditPage> => Promise.reject(new ApiError(403))),
    });
    await refused.show();
    expect(text()).toContain("You aren't allowed to see this.");

    const out = page({
      audit: vi.fn(async (): Promise<AuditPage> => Promise.reject(new SignedOut())),
    });
    await out.show();
    expect(out.signedOut).toHaveBeenCalled();

    const empty = page({ audit: vi.fn(async () => ({ events: [], next: null })) });
    await empty.show();
    expect(text()).toContain("The log is empty.");
  });
});

describe("the audit log over the API (T-905)", () => {
  it("asks for the browser's own days, the last included, and an action by its start", () => {
    const p = auditParams({ action: "source.", from: "2026-10-01", until: "2026-12-31" });
    expect(p.get("actionPrefix")).toBe("source.");
    expect(p.get("from")).toBe(new Date(2026, 9, 1).toISOString());
    expect(p.get("to")).toBe(new Date(2027, 0, 1).toISOString());
    // Not a day: the server says so.
    expect(auditParams({ until: "2026-02-30" }).get("to")).toBe("2026-02-30");
  });

  it("hands over a download with the server's file name, and reads its refusals", async () => {
    const answers = [
      new Response("seq,at\n", {
        headers: { "content-disposition": 'attachment; filename="audit-2026-10-14.csv"' },
      }),
      Response.json({ error: "sign in again", signIn: "/auth/sign-in" }, { status: 403 }),
      Response.json({ error: "no" }, { status: 403 }),
      Response.json({ error: "bad", field: "to" }, { status: 400 }),
      new Response("", { status: 500 }),
      // The server errors the body when an export fails part way: never a whole-looking file.
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("seq,at\n"));
            c.error(new Error("cut"));
          },
        }),
      ),
    ];
    const fetcher = vi.fn(async () => answers.shift() as Response);
    const api = createApi(fetcher as unknown as typeof fetch);
    const done = await api.exportAudit({ decision: "deny" }, "csv");
    expect(done).toMatchObject({ ended: "done", name: "audit-2026-10-14.csv" });
    expect(await (done as { file: Blob }).file.text()).toBe("seq,at\n");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/audit/export",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ decision: "deny", format: "csv" }),
      }),
    );
    expect(await api.exportAudit({}, "csv")).toEqual({ ended: "sign-in-again" });
    expect(await api.exportAudit({}, "csv")).toEqual({ ended: "refused" });
    expect(await api.exportAudit({}, "csv")).toEqual({ ended: "invalid", field: "to" });
    expect(await api.exportAudit({}, "csv")).toEqual({ ended: "failed" });
    expect(await api.exportAudit({}, "csv")).toEqual({ ended: "failed" });
  });

  it("reads a page of events, and the check's answer", async () => {
    const answers = [
      Response.json({
        events: [{ ...event(4), detail: { n: 1, nested: { no: 1 } } }],
        next: 4,
      }),
      Response.json({ ok: false, count: 3, seq: 4, problem: "hash mismatch" }),
    ];
    const fetcher = vi.fn(async () => answers.shift() as Response);
    const api = createApi(fetcher as unknown as typeof fetch);
    const got = await api.audit({ actor: "user:usr_1" }, 9);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/audit?actor=user%3Ausr_1&before=9",
      expect.anything(),
    );
    expect(got).toEqual({ events: [{ ...event(4), detail: { n: 1 } }], next: 4 });
    expect(await api.verifyAudit()).toEqual({
      ok: false,
      count: 3,
      seq: 4,
      problem: "hash mismatch",
    });
  });
});
