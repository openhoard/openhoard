import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, SignedOut, type Api, type Changed, type Client } from "./api.js";
import { Clients } from "./clients.js";
import { clientIdentity, clientStanding, clientUseText, TRUST_WORDS } from "./words.js";

/*
 * T-904: the AI clients page. ("Allowlist changes take effect immediately" is the server's:
 * apps/server admin-api.test.ts, where a relabel and a revocation reach the token already out.)
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = (c: string) => c.repeat(64);
const client = (over: Partial<Client> = {}): Client => ({
  clientKey: KEY("a"),
  clientId: "https://claude.ai/oauth/mcp-client-metadata.json",
  redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
  status: "pending",
  trust: null,
  managedBy: "app",
  configTrust: null,
  requestedAt: "2026-10-05T07:00:00.000Z",
  claimedName: "Claude",
  people: 0,
  lastUsedAt: null,
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

function page(clients: Client[] | (() => Promise<Client[]>), ended: Changed | Error = "done") {
  const list = vi.fn(typeof clients === "function" ? clients : async () => clients);
  const decideClient = vi.fn<Api["decideClient"]>(async () => {
    if (ended instanceof Error) throw ended;
    return ended;
  });
  const signedOut = vi.fn();
  const signInAgain = vi.fn(async () => true);
  const api = { clients: list, decideClient } as unknown as Api;
  const show = () =>
    act(async () => {
      root.render(<Clients api={api} onSignInAgain={signInAgain} onSignedOut={signedOut} />);
    });
  return { show, list, decideClient, signedOut, signInAgain };
}
const text = () => host.textContent ?? "";
const card = (n = 0) => host.querySelectorAll("li.card")[n] as HTMLElement;
const button = (name: string, within: ParentNode = host) =>
  [...within.querySelectorAll("button")].find((b) => b.textContent === name) as HTMLButtonElement;
const click = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
const choose = (within: ParentNode, trust: string) =>
  click(within.querySelector(`input[value="${trust}"]`) as HTMLInputElement);

describe("the AI clients page (T-904)", () => {
  it("shows an app by what identifies it, its claimed name only as a claim", async () => {
    const { show } = page([client({ claimedName: "Totally Claude" })]);
    await show();
    expect(host.querySelector("h2")?.textContent).toBe("Waiting for your decision");
    expect(card().querySelector("h3")?.textContent).toBe("claude.ai");
    expect(card().querySelector("code")?.textContent).toBe(
      "https://claude.ai/oauth/mcp-client-metadata.json",
    );
    expect(card().textContent).toContain("Calls itself “Totally Claude”.");
    expect(card().textContent).toContain("Any app can claim any name");
    expect(card().querySelector("h3")?.textContent).not.toContain("Totally");
    expect(card().textContent).toContain("Nobody is connected through it. No request made yet.");
    // Where a sign-in through it goes is shown too: that is where its codes end up.
    expect([...card().querySelectorAll("code")].map((c) => c.textContent)).toEqual([
      "https://claude.ai/oauth/mcp-client-metadata.json",
      "https://claude.ai/api/mcp/auth_callback",
    ]);
    expect(card().querySelector("time")?.getAttribute("datetime")).toBe("2026-10-05T07:00:00.000Z");
  });

  it("approves only with a kind chosen, and shows the list the server gives back", async () => {
    let approved = false;
    const { show, list, decideClient } = page(async () => [
      approved ? client({ status: "approved", trust: "commercial", people: 2 }) : client(),
    ]);
    await show();
    // Nothing is chosen for the admin.
    expect(card().querySelectorAll("input:checked")).toHaveLength(0);
    expect(button("Approve").disabled).toBe(true);
    for (const t of ["local", "commercial", "consumer"] as const) {
      expect(card().textContent).toContain(TRUST_WORDS[t].label);
    }

    await choose(card(), "commercial");
    expect(button("Approve").disabled).toBe(false);
    approved = true;
    await click(button("Approve"));
    expect(decideClient).toHaveBeenCalledWith(KEY("a"), { action: "approve", trust: "commercial" });
    expect(list).toHaveBeenCalledTimes(2);
    expect([...host.querySelectorAll("h2")].map((h) => h.textContent)).toEqual([
      "Waiting for your decision",
      "Approved",
    ]);
    expect(text()).toContain("Nothing is waiting.");
    expect(card().querySelector(".badge")?.textContent).toBe("Organization AI");
    expect(card().textContent).toContain("2 people connected through it");
    // Said where a screen reader hears it, since the card moved.
    expect(host.querySelector('[role="status"]')?.textContent).toBe("claude.ai: approved.");
    // And the keyboard is on the app, where it now is.
    expect(document.activeElement).toBe(card().querySelector("h3"));
  });

  it("refuses a waiting app", async () => {
    const { show, decideClient } = page([client()]);
    await show();
    await click(button("Refuse"));
    expect(decideClient).toHaveBeenCalledWith(KEY("a"), { action: "refuse" });
  });

  it("relabels an approved app only when the kind changes, and revokes only when told twice", async () => {
    const { show, decideClient } = page([
      client({ status: "approved", trust: "commercial", people: 3 }),
    ]);
    await show();
    expect(card().querySelector<HTMLInputElement>("input:checked")?.value).toBe("commercial");
    expect(button("Save").disabled).toBe(true);
    await choose(card(), "consumer");
    await click(button("Save"));
    expect(decideClient).toHaveBeenLastCalledWith(KEY("a"), {
      action: "approve",
      trust: "consumer",
    });
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "claude.ai: its kind was changed.",
    );

    await click(button("Revoke…"));
    expect(decideClient).toHaveBeenCalledTimes(1);
    expect(card().textContent).toContain("cut off at their next request");
    // The keyboard is where the question is, then back where it was asked.
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Revoke this app?");
    await click(button("Keep it"));
    expect(button("Yes, revoke")).toBeUndefined();
    expect(document.activeElement?.textContent).toBe("Revoke…");
    await click(button("Revoke…"));
    await click(button("Yes, revoke"));
    expect(decideClient).toHaveBeenLastCalledWith(KEY("a"), { action: "revoke" });
  });

  it("lets a refused app in after all", async () => {
    const { show, decideClient } = page([client({ status: "refused" })]);
    await show();
    expect(host.querySelector("h2 + ul")?.previousElementSibling?.textContent).toBe("Not approved");
    await choose(card(), "local");
    await click(button("Approve after all"));
    expect(decideClient).toHaveBeenCalledWith(KEY("a"), { action: "approve", trust: "local" });
  });

  it("goes by what an app gets now, not by what was last decided here", async () => {
    const { show, decideClient } = page([
      // Never decided here, but the config lists it: it gets tokens.
      client({
        clientKey: KEY("b"),
        status: "pending",
        trust: "local",
        managedBy: "config",
        configTrust: "local",
      }),
      // Approved here, then listed in the config with another label.
      client({
        clientKey: KEY("c"),
        status: "approved",
        trust: "consumer",
        managedBy: "config",
        configTrust: "consumer",
      }),
      // Approved by the config, then taken out of it: it gets nothing.
      client({ clientKey: KEY("d"), status: "approved", trust: null }),
      // Refused here, then listed in the config: only the config's label lets it in.
      client({
        clientKey: KEY("e"),
        status: "refused",
        managedBy: "config",
        configTrust: "commercial",
      }),
    ]);
    await show();
    expect([...host.querySelectorAll("h2")].map((h) => h.textContent)).toEqual([
      "Waiting for your decision",
      "Approved",
      "Not approved",
    ]);
    expect(text()).toContain("Nothing is waiting.");
    const [listed, relabelled, lapsed, refused] = [card(0), card(1), card(2), card(3)];
    for (const byConfig of [listed, relabelled]) {
      expect(byConfig.textContent).toContain("Approved in the server's config file");
      expect(byConfig.querySelectorAll("button, input")).toHaveLength(0);
    }
    expect(listed.querySelector(".badge")?.textContent).toBe("Stays on our computers");

    expect(lapsed.querySelector(".badge")).toBeNull();
    expect(lapsed.textContent).toContain("no longer lists it, so it gets nothing now");
    expect(lapsed.textContent).toContain("for the people who had connected it too;");
    expect(button("Approve", lapsed).disabled).toBe(true);
    expect(button("Revoke…", lapsed)).toBeUndefined();
    // It can be cut off for good without being let in first.
    await click(button("Refuse", lapsed));
    expect(decideClient).toHaveBeenLastCalledWith(KEY("d"), { action: "revoke" });

    // No choice to make: the config's label, said, and sent.
    expect(refused.querySelectorAll("input")).toHaveLength(0);
    expect(refused.textContent).toContain("lists this app as Organization AI");
    await click(button("Approve after all", refused));
    expect(decideClient).toHaveBeenCalledWith(KEY("e"), { action: "approve", trust: "commercial" });
  });

  it("starts a card over when the app's standing changes under it", async () => {
    let trust: "commercial" | "consumer" = "commercial";
    const { show } = page(async () => [client({ status: "approved", trust })]);
    await show();
    await click(button("Revoke…"));
    await choose(card(), "local");
    // Another admin relabelled it meanwhile; this admin saves their own change.
    trust = "consumer";
    await click(button("Save"));
    expect(card().querySelector<HTMLInputElement>("input:checked")?.value).toBe("consumer");
    expect(button("Yes, revoke")).toBeUndefined();
    expect(button("Save").disabled).toBe(true);
  });

  it("says what a change came to when it wasn't done", async () => {
    for (const [ended, said, reloads] of [
      ["sign-in-again", "takes a recent sign-in", false],
      ["conflict", "no longer applies", true],
      ["gone", "no longer there", true],
      ["refused", "aren't allowed", true],
      ["failed", "didn't go through", true],
      [new ApiError(0), "didn't go through", false],
    ] as const) {
      act(() => root.unmount());
      root = createRoot(host);
      const { show, list } = page([client()], ended);
      await show();
      await choose(card(), "local");
      await click(button("Approve"));
      expect(card().querySelector('[role="alert"]')?.textContent, String(ended)).toContain(said);
      expect(host.querySelector('[role="status"]')?.textContent).toBe("");
      expect(list).toHaveBeenCalledTimes(reloads ? 2 : 1);
      // The buttons work again.
      expect(button("Refuse").disabled).toBe(false);
    }
  });

  it("says it at the top when the app it is about is no longer listed", async () => {
    let there = true;
    const { show } = page(async () => (there ? [client()] : []), "gone");
    await show();
    there = false;
    await click(button("Refuse"));
    expect(host.querySelectorAll("li.card")).toHaveLength(0);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "claude.ai: That app's request is no longer there: it lapsed, or was removed. Nothing was changed.",
    );
    expect(document.activeElement?.id).toBe("clients-top");
  });

  it("gets a fresh sign-in by signing out first, and says so when that fails", async () => {
    const { show, signInAgain } = page([client()], "sign-in-again");
    await show();
    await choose(card(), "local");
    await click(button("Approve"));
    // A link to the sign-in would come straight back, signed in as before.
    expect(card().querySelector("a")).toBeNull();
    signInAgain.mockResolvedValueOnce(false);
    await click(button("Sign out and in again"));
    expect(card().textContent).toContain("Signing out didn't go through");
    await click(button("Sign out and in again"));
    expect(signInAgain).toHaveBeenCalledTimes(2);
    expect(card().textContent).not.toContain("Signing out didn't go through");
  });

  it("goes to sign in when the session has ended, on reading or on changing", async () => {
    const reading = page(async () => Promise.reject(new SignedOut()));
    await reading.show();
    expect(reading.signedOut).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    root = createRoot(host);
    const changing = page([client()], new SignedOut());
    await changing.show();
    await click(button("Refuse"));
    expect(changing.signedOut).toHaveBeenCalledTimes(1);
  });

  it("says so when there is nothing, when it can't load, and when it is refused", async () => {
    const none = page([]);
    await none.show();
    expect(text()).toContain("No AI app has asked to connect yet.");

    act(() => root.unmount());
    root = createRoot(host);
    let fail = true;
    const failing = page(async () => (fail ? Promise.reject(new ApiError(500)) : []));
    await failing.show();
    expect(host.querySelector('.notice[role="alert"]')?.textContent).toContain(
      "couldn't be loaded",
    );
    fail = false;
    await click(button("Try again"));
    expect(text()).toContain("No AI app has asked");

    act(() => root.unmount());
    root = createRoot(host);
    const refused = page(async () => Promise.reject(new ApiError(403)));
    await refused.show();
    expect(text()).toContain("aren't allowed to see this");
    expect(button("Try again")).toBeUndefined();
  });
});

describe("an AI client in an admin's words", () => {
  it("is named by the site it is identified by, never by what it calls itself", () => {
    expect(
      clientIdentity({ clientId: "https://client.example/x.json", redirectUris: [] }),
    ).toMatchObject({
      title: "client.example",
      addresses: ["https://client.example/x.json"],
    });
    expect(clientIdentity({ clientId: "not a url", redirectUris: [] }).title).toBe("not%20a%20url");
    const registered = clientIdentity({
      clientId: null,
      redirectUris: ["https://a.example/cb", "https://a.example/cb2", "https://b.example/cb"],
    });
    expect(registered.title).toBe("a.example, b.example");
    expect(registered.detail).toContain("registered itself");
    // A loopback redirect names no site: any program on that computer could be behind it.
    const local = clientIdentity({ clientId: null, redirectUris: ["http://127.0.0.1/callback"] });
    expect(local.title).toBe("A program on the person's own computer");
    expect(local.detail).toContain("Any program on that computer can register the same way");
    expect(clientIdentity({ clientId: null, redirectUris: [] }).title).toBe("Unknown app");
  });

  it("shows addresses as a browser would go to them, not as the app wrote them", () => {
    // A Cyrillic "a": the look-alike shows as what it is, in the title and in the address.
    const lookalike = clientIdentity({
      clientId: null,
      redirectUris: ["https://cl\u0430ude.ai/cb"],
    });
    expect(lookalike.title).toBe("xn--clude-5ve.ai");
    expect(lookalike.addresses).toEqual(["https://xn--clude-5ve.ai/cb"]);
    // What reorders the text on screen never reaches it.
    const reordered = clientIdentity({
      clientId: "https://client.example/\u202Egnp.exe",
      redirectUris: ["not an address \u202E"],
    });
    expect(reordered.addresses).toEqual(["https://client.example/%E2%80%AEgnp.exe"]);
    expect(reordered.returnsTo).toEqual(["not%20an%20address%20%E2%80%AE"]);
    // Twice the same place is one line; half a character is no address.
    expect(
      clientIdentity({ clientId: null, redirectUris: ["https://a.example", "https://a.example/"] })
        .addresses,
    ).toEqual(["https://a.example/"]);
    expect(clientIdentity({ clientId: "\uD800", redirectUris: [] }).addresses).toEqual([
      "(an address that can't be shown)",
    ]);
    // The site is the host, whatever is put in front of it.
    expect(
      clientIdentity({ clientId: "https://claude.ai@evil.example/x", redirectUris: [] }).title,
    ).toBe("evil.example");
  });

  it("stands by what it gets now and who decides", () => {
    const of = (status: Client["status"], trust: Client["trust"], managedBy: Client["managedBy"]) =>
      clientStanding({ status, trust, managedBy });
    expect(of("pending", null, "app")).toBe("waiting");
    expect(of("pending", "local", "config")).toBe("approved-by-config");
    expect(of("approved", "local", "app")).toBe("approved");
    expect(of("approved", null, "app")).toBe("lapsed");
    expect(of("refused", null, "config")).toBe("refused");
  });

  it("says how much it is used", () => {
    expect(clientUseText({ people: 0, lastUsedAt: null })).toBe(
      "Nobody is connected through it. No request made yet.",
    );
    expect(clientUseText({ people: 1, lastUsedAt: null })).toBe(
      "1 person connected through it. No request made yet.",
    );
    expect(clientUseText({ people: 4, lastUsedAt: "2026-10-05T07:00:00.000Z" }, "en-GB")).toMatch(
      /^4 people connected through it\. Last request made 5 Oct 2026, .+\.$/,
    );
    expect(clientUseText({ people: 0, lastUsedAt: "2026-10-05T07:00:00.000Z" }, "en-GB")).toMatch(
      /^Nobody is connected through it\. Last request made 5 Oct 2026/,
    );
  });

  it("words each kind by where what the app reads ends up", () => {
    expect(Object.values(TRUST_WORDS).map((w) => w.label)).toEqual([
      "Personal AI",
      "Organization AI",
      "Stays on our computers",
    ]);
    // The mistake to head off: a local program that sends what it reads to a cloud AI.
    expect(TRUST_WORDS.local.means).toContain("A desktop app that uses a cloud AI doesn't count");
    expect(TRUST_WORDS.consumer.means).toContain("including paid personal plans");
  });
});
