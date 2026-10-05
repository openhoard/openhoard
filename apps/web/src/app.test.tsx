import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, SignedOut, type Api, type Me, type Source } from "./api.js";
import { App, signInUrl, type Browser } from "./app.js";
import { appPath } from "./router.js";

/*
 * T-901: the shell, in a DOM. (The four browsers of the task's Done-when are a run in each.)
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ADA: Me = {
  user: { id: "usr_1", displayName: "Ada Admin", email: "ada@contoso.example", kind: "member" },
  tenantId: "ten_1",
  admin: true,
};
const FINANCE: Source = {
  source: "finance",
  connector: "connector-sharepoint",
  standing: { is: "current" },
  lastRunAt: "2026-10-05T07:00:00.000Z",
  lastCounts: { ingested: 2, unchanged: 40, unmappedGroups: 3 },
};

function fakeBrowser(at = "/admin/") {
  const notes = new Map<string, string>();
  let now = 1_000_000;
  const left: string[] = [];
  const restored = new Set<() => void>();
  const browser: Browser = {
    leave: (url) => void left.push(url),
    onRestored: (again) => {
      restored.add(again);
      return () => void restored.delete(again);
    },
    here: () => at,
    recall: (key) => notes.get(key) ?? null,
    remember: (key, value) => void (value === null ? notes.delete(key) : notes.set(key, value)),
    now: () => now,
  };
  return {
    browser,
    left,
    notes,
    later: (ms: number) => void (now += ms),
    /** Back, out of the browser's cache of whole pages. */
    restore: () => restored.forEach((again) => again()),
  };
}

function fakeApi(over: Partial<Api> = {}): Api {
  return {
    me: vi.fn(async () => ADA),
    sources: vi.fn(async () => [FINANCE]),
    signOut: vi.fn(async () => undefined),
    ...over,
  };
}

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  // jsdom has no layout to scroll.
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  window.history.replaceState(null, "", "/admin/");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => root.unmount());
  host.remove();
});

async function show(api: Api, browser: Browser) {
  await act(async () => {
    root.render(<App api={api} browser={browser} />);
  });
}
const text = () => host.textContent ?? "";
const button = (name: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === name) as HTMLButtonElement;
const click = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });

describe("the admin shell (T-901)", () => {
  it("shows a signed-in admin who they are, the sections, and the page", async () => {
    const api = fakeApi();
    const { browser, left } = fakeBrowser();
    await show(api, browser);

    expect(left).toEqual([]);
    expect(host.querySelector("header")?.textContent).toContain("Ada Admin");
    expect(host.querySelector(".who-name")?.getAttribute("title")).toBe("ada@contoso.example");
    const current = host.querySelector('nav a[aria-current="page"]');
    expect(current?.textContent).toBe("Overview");
    expect(current?.getAttribute("href")).toBe("/admin/");
    expect(host.querySelector("main h1")?.textContent).toBe("Overview");
    expect(document.title).toBe("Overview · OpenHoard");
    // The skip link's target is there.
    expect(host.querySelector(".skip")?.getAttribute("href")).toBe("#main");
    expect(host.querySelector("#main")).not.toBeNull();

    // The page read the API as the session.
    expect(api.sources).toHaveBeenCalled();
    expect(text()).toContain("finance");
    expect(text()).toContain("SharePoint");
    expect(text()).toContain("Up to date.");
    expect(text()).toMatch(/Last sync .+: 2 files recorded, 40 unchanged\./);
    expect(text()).not.toMatch(/Last sync.*Last sync/);
    expect(text()).toContain("The source gives access to 3 groups OpenHoard doesn't know yet.");
    expect(host.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-05T07:00:00.000Z");
  });

  it("sends whoever isn't signed in to sign in, and back to where they were", async () => {
    const api = fakeApi({ me: vi.fn(async () => Promise.reject(new SignedOut())) });
    const { browser, left } = fakeBrowser("/admin/review?x=1");
    await show(api, browser);

    expect(left).toEqual(["/auth/sign-in?return_to=%2Fadmin%2Freview%3Fx%3D1"]);
    expect(text()).toContain("Taking you to sign in");
    // If the browser doesn't go (or comes back to this very page), the way is still there.
    expect(host.querySelector("a.button")?.getAttribute("href")).toBe(left[0]);
    expect(api.sources).not.toHaveBeenCalled();
    // Only ever back into the app.
    expect(signInUrl("//evil.example/")).toBe("/auth/sign-in?return_to=%2Fadmin%2F");
    expect(signInUrl("/administrator")).toBe("/auth/sign-in?return_to=%2Fadmin%2F");
    expect(signInUrl("/admin")).toBe("/auth/sign-in?return_to=%2Fadmin");
  });

  it("stops, instead of going round, when a sign-in doesn't stick", async () => {
    const api = fakeApi({ me: vi.fn(async () => Promise.reject(new SignedOut())) });
    const { browser, left, later } = fakeBrowser();
    await show(api, browser);
    expect(left).toHaveLength(1);

    // Back from the sign-in ten seconds later, still nobody.
    later(10_000);
    act(() => root.unmount());
    root = createRoot(host);
    await show(api, browser);
    expect(left).toHaveLength(1);
    expect(text()).toContain("You're not signed in");
    expect(host.querySelector("a.button")?.getAttribute("href")).toBe(
      "/auth/sign-in?return_to=%2Fadmin%2F",
    );

    // Much later (a session that ran out) it is a sign-in like any other.
    later(3_600_000);
    act(() => root.unmount());
    root = createRoot(host);
    await show(api, browser);
    expect(left).toHaveLength(2);
  });

  it("asks again who is there when the browser brings the page back as it was left", async () => {
    const me = vi.fn<Api["me"]>().mockRejectedValueOnce(new SignedOut()).mockResolvedValue(ADA);
    const { browser, left, restore } = fakeBrowser();
    await show(fakeApi({ me }), browser);
    expect(text()).toContain("Taking you to sign in");

    // Signed in in another tab meanwhile, then Back to this one.
    await act(async () => restore());
    expect(me).toHaveBeenCalledTimes(2);
    expect(left).toHaveLength(1);
    expect(host.querySelector("main h1")?.textContent).toBe("Overview");
  });

  it("forgets the attempt once someone is signed in", async () => {
    const { browser, notes } = fakeBrowser();
    notes.set("oh-sign-in-tried", "999999");
    await show(fakeApi(), browser);
    expect(notes.size).toBe(0);
  });

  it("offers a member who isn't an admin nothing but the way out", async () => {
    const api = fakeApi({ me: vi.fn(async () => ({ ...ADA, admin: false })) });
    await show(api, fakeBrowser().browser);

    expect(text()).toContain("This area is for admins");
    expect(document.title).toBe("OpenHoard");
    expect(text()).toContain("ada@contoso.example");
    expect(host.querySelector("nav")).toBeNull();
    expect(api.sources).not.toHaveBeenCalled();

    await click(button("Sign out"));
    expect(api.signOut).toHaveBeenCalledTimes(1);
    expect(text()).toContain("You've signed out");
  });

  it("signs out, and doesn't sign straight back in", async () => {
    const api = fakeApi();
    const { browser, left, restore } = fakeBrowser();
    await show(api, browser);
    await click(button("Sign out"));

    expect(api.signOut).toHaveBeenCalledTimes(1);
    expect(left).toEqual([]);
    expect(text()).toContain("You've signed out");
    expect(text()).not.toContain("Ada Admin");
    expect(host.querySelector("a.button")?.getAttribute("href")).toBe(
      "/auth/sign-in?return_to=%2Fadmin%2F",
    );
    expect(document.title).toBe("OpenHoard");

    // Back to this page later: still signed out, not sent to a provider that lets them back in.
    await act(async () => restore());
    expect(api.me).toHaveBeenCalledTimes(1);
    expect(left).toEqual([]);
    expect(text()).toContain("You've signed out");
  });

  it("treats a session that already ended as signed out, and a failure as not", async () => {
    const gone = fakeApi({ signOut: vi.fn(async () => Promise.reject(new SignedOut())) });
    await show(gone, fakeBrowser().browser);
    await click(button("Sign out"));
    expect(text()).toContain("You've signed out");

    act(() => root.unmount());
    root = createRoot(host);
    const failing = fakeApi({ signOut: vi.fn(async () => Promise.reject(new ApiError(0))) });
    await show(failing, fakeBrowser().browser);
    await click(button("Sign out"));
    expect(text()).not.toContain("You've signed out");
    expect(text()).toContain("couldn't be reached");
  });

  it("says so when the server can't be reached, and tries again when asked", async () => {
    const me = vi.fn<Api["me"]>().mockRejectedValueOnce(new ApiError(0)).mockResolvedValue(ADA);
    const { browser, left } = fakeBrowser();
    await show(fakeApi({ me }), browser);
    expect(text()).toContain("OpenHoard couldn't be reached");
    expect(left).toEqual([]);

    await click(button("Try again"));
    expect(me).toHaveBeenCalledTimes(2);
    expect(host.querySelector("main h1")?.textContent).toBe("Overview");
  });

  it("goes to sign in when the session ends under a page", async () => {
    const api = fakeApi({ sources: vi.fn(async () => Promise.reject(new SignedOut())) });
    const { browser, left } = fakeBrowser();
    await show(api, browser);
    expect(left).toEqual(["/auth/sign-in?return_to=%2Fadmin%2F"]);
  });

  it("keeps the shell when a page's data fails, and loads it again when asked", async () => {
    const sources = vi
      .fn<Api["sources"]>()
      .mockRejectedValueOnce(new ApiError(500))
      .mockResolvedValue([]);
    await show(fakeApi({ sources }), fakeBrowser().browser);
    expect(host.querySelector("header")?.textContent).toContain("Ada Admin");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("couldn't be loaded");

    await click(button("Try again"));
    expect(text()).toContain("No source is connected yet");
  });

  it("takes a refusal for an answer: no asking again", async () => {
    const sources = vi.fn<Api["sources"]>().mockRejectedValue(new ApiError(403));
    await show(fakeApi({ sources }), fakeBrowser().browser);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("aren't allowed");
    expect(button("Try again")).toBeUndefined();
    expect(sources).toHaveBeenCalledTimes(1);
    // The way out is still there.
    expect(button("Sign out")).toBeDefined();
  });

  it("keeps the shell when a page falls over", async () => {
    // An answer the page can't word: a hold without its count.
    const broken = { ...FINANCE, standing: { is: "held" } } as unknown as Source;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await show(fakeApi({ sources: vi.fn(async () => [broken]) }), fakeBrowser().browser);
    } finally {
      quiet.mockRestore();
    }
    expect(host.querySelector("header")?.textContent).toContain("Ada Admin");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("couldn't be shown");
  });

  it("shows what needs an admin on a source's card", async () => {
    const stopped: Source = {
      ...FINANCE,
      source: "legal",
      standing: { is: "stopped", code: "auth" },
      lastCounts: null,
    };
    await show(fakeApi({ sources: vi.fn(async () => [FINANCE, stopped]) }), fakeBrowser().browser);
    const cards = [...host.querySelectorAll("li.card")];
    expect(cards).toHaveLength(2);
    expect(cards[0]?.querySelector(".badge")?.textContent).toBe("OK");
    expect(cards[1]?.querySelector(".badge")?.textContent).toBe("Needs attention");
    expect(cards[1]?.querySelector("code")?.textContent).toBe(
      "openhoard admin source resume --tenant ten_1 --source legal",
    );
    expect(cards[0]?.querySelector("code")).toBeNull();
  });

  it("has pages at paths: links move without loading, back works, unknown paths say so", async () => {
    window.history.replaceState(null, "", "/admin/nowhere");
    const api = fakeApi();
    await show(api, fakeBrowser("/admin/nowhere").browser);
    expect(host.querySelector("main h1")?.textContent).toBe("Nothing here");
    expect(host.querySelector('nav a[aria-current="page"]')).toBeNull();
    expect(api.sources).not.toHaveBeenCalled();
    expect(document.title).toBe("OpenHoard");

    const home = host.querySelector("main a") as HTMLAnchorElement;
    expect(home.getAttribute("href")).toBe("/admin/");
    await click(home);
    expect(window.location.pathname).toBe("/admin/");
    expect(host.querySelector("main h1")?.textContent).toBe("Overview");
    // The keyboard and screen readers go to the new page with the eyes.
    expect(document.activeElement?.id).toBe("main");
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);

    // A click meant for the browser (a new tab) is left to it.
    const link = host.querySelector("nav a") as HTMLAnchorElement;
    const modified = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    link.addEventListener("click", (e) => e.preventDefault(), { once: true });
    await act(async () => void link.dispatchEvent(modified));

    await act(async () => {
      window.history.replaceState(null, "", "/admin/nowhere");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(host.querySelector("main h1")?.textContent).toBe("Nothing here");
  });

  it("reads the app's path out of the address", () => {
    expect(appPath("/admin")).toBe("/");
    expect(appPath("/admin/")).toBe("/");
    expect(appPath("/admin/review")).toBe("/review");
    expect(appPath("/admin/review/")).toBe("/review");
    expect(appPath("/elsewhere")).toBe("/elsewhere");
    expect(appPath("/administrator")).toBe("/administrator");
  });
});
