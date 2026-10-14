import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApi, type Api, type Source, type SourceSkips } from "./api.js";
import { Overview } from "./overview.js";
import { LEFT_OUT_CODES, leftOutText } from "./words.js";

/* What a source's syncs left out, on its card (#93's API). */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FINANCE: Source = {
  source: "finance",
  connector: "connector-sharepoint",
  standing: { is: "current" },
  lastRunAt: "2026-10-05T07:00:00.000Z",
  lastCounts: { ingested: 2, skipped: 3 },
};
const SKIPS: SourceSkips = {
  total: 3,
  byReason: { "too-large": 2, "ingest-weird": 1 },
  skips: [
    {
      externalId: "item-1",
      reason: "too-large",
      path: ["Finance", "Video.mp4"],
      firstSeenAt: "2026-10-01T07:00:00.000Z",
      lastSeenAt: "2026-10-05T07:00:00.000Z",
    },
    {
      externalId: "item-2",
      reason: "ingest-weird",
      path: null,
      firstSeenAt: "2026-10-02T07:00:00.000Z",
      lastSeenAt: "2026-10-05T07:00:00.000Z",
    },
  ],
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

function page(sourceSkips: Api["sourceSkips"]) {
  const api = {
    sources: vi.fn(async () => [FINANCE]),
    sourceSkips: vi.fn(sourceSkips),
  } as unknown as Api;
  const signedOut = vi.fn();
  const show = () =>
    act(async () => {
      root.render(<Overview api={api} tenantId="ten_1" onSignedOut={signedOut} />);
    });
  return { api, show, signedOut };
}
const text = () => host.textContent ?? "";
const button = (name: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith(name)) as
    HTMLButtonElement | undefined;
const click = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });

describe("what a source's syncs left out", () => {
  it("is asked for only when opened, and says why each file is out, by where it is", async () => {
    const { api, show } = page(async () => SKIPS);
    await show();
    expect(api.sourceSkips).not.toHaveBeenCalled();
    await click(button("What was left out") as HTMLButtonElement);
    expect(api.sourceSkips).toHaveBeenCalledWith("finance", undefined);
    expect(text()).toContain("3 items left out.");
    // Focus goes to what opened.
    expect(document.activeElement?.textContent).toBe("Left out of finance");
    expect(text()).toContain("Too large to read: 2");
    expect(text()).toContain("Another reason (ingest-weird): 1");
    expect(text()).toContain("Finance / Video.mp4");
    // No path known: its id in the source.
    expect(text()).toContain("item-2");
    expect(text()).toContain(
      "of 3. On the server, admin source skips --tenant ten_1 --source finance",
    );

    // One reason at a time, and back.
    await click(button("Too large to read") as HTMLButtonElement);
    expect(api.sourceSkips).toHaveBeenLastCalledWith("finance", "too-large");
    expect(button("Too large to read")?.getAttribute("aria-pressed")).toBe("true");
    await click(button("Hide") as HTMLButtonElement);
    expect(document.activeElement).toBe(button("What was left out"));
    expect(button("What was left out")?.getAttribute("aria-label")).toBe(
      "What was left out of finance",
    );
    // Opened again: asked again.
    await click(button("What was left out") as HTMLButtonElement);
    expect(api.sourceSkips).toHaveBeenCalledTimes(3);
  });

  it("says when nothing is out, and when it can't be loaded", async () => {
    const empty = page(async () => ({ total: 0, byReason: {}, skips: [] }));
    await empty.show();
    await click(button("What was left out") as HTMLButtonElement);
    expect(text()).toContain("Nothing is kept as left out.");

    act(() => root.unmount());
    root = createRoot(host);
    let fail = true;
    const failing = page(async () => {
      if (fail) throw new ApiError(0);
      return SKIPS;
    });
    await failing.show();
    await click(button("What was left out") as HTMLButtonElement);
    expect(text()).toContain("couldn't be loaded");
    fail = false;
    await click(button("Try again") as HTMLButtonElement);
    expect(text()).toContain("3 items left out.");
  });

  it("says a refusal, a first sync with nothing kept yet, and drops an answer for a closed panel", async () => {
    const refused = page(async () => Promise.reject(new ApiError(403)));
    await refused.show();
    await click(button("What was left out") as HTMLButtonElement);
    expect(text()).toContain("You aren't allowed to see this.");
    act(() => root.unmount());
    root = createRoot(host);

    const first = page(async () => Promise.reject(new ApiError(404)));
    await first.show();
    await click(button("What was left out") as HTMLButtonElement);
    expect(text()).toContain("Nothing is kept as left out.");
    act(() => root.unmount());
    root = createRoot(host);

    let answer: (s: SourceSkips) => void = () => undefined;
    const slow = page(() => new Promise<SourceSkips>((done) => (answer = done)));
    await slow.show();
    await click(button("What was left out") as HTMLButtonElement);
    await click(button("Hide") as HTMLButtonElement);
    await act(async () => answer(SKIPS));
    expect(text()).not.toContain("items left out");
  });

  it("words every reason the server keeps, and any other as it is", () => {
    // What the server keeps: core/jobs sync.ts (its own, the connector errors it keeps, the
    // NOT_SERVED warnings), core/catalog IngestErrorCode as ingest-…, and skips.ts's `other`.
    const kept = [
      "too-large",
      "invalid-acl",
      "invalid",
      ...["invalid", "unknown-zone", "zone-mismatch", "needs-location", "blob-mismatch"].map(
        (c) => `ingest-${c}`,
      ),
      "changed",
      "not-found",
      "permanent",
      "resync",
      "unreadable",
      "invalid-item",
      "unplaced-item",
      "unsupported-item",
      "unlisted-folder",
      "other",
    ];
    expect([...LEFT_OUT_CODES].sort()).toEqual([...kept].sort());
    for (const code of kept) expect(leftOutText(code), code).not.toMatch(/^Another reason \(/);
    // Not the object's own: a code named like one is still said as it is.
    expect(leftOutText("constructor")).toBe("Another reason (constructor)");
    expect(leftOutText("x-new")).toBe("Another reason (x-new)");
  });

  it("asks the server for a page, by reason, and reads its answer", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ ...SKIPS, byReason: { ...SKIPS.byReason, bad: "x" } }),
    );
    const api = createApi(fetcher as unknown as typeof fetch);
    const got = await api.sourceSkips("fin ance", "too-large");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/sources/fin%20ance/skips?limit=100&reason=too-large",
      expect.anything(),
    );
    expect(got).toEqual(SKIPS);
    fetcher.mockResolvedValueOnce(
      Response.json({ total: 1, byReason: {}, skips: [{ reason: "x" }] }),
    );
    await expect(api.sourceSkips("finance")).rejects.toBeInstanceOf(ApiError);
    fetcher.mockResolvedValueOnce(Response.json({ byReason: {}, skips: [] }));
    await expect(api.sourceSkips("finance")).rejects.toBeInstanceOf(ApiError);
  });
});
