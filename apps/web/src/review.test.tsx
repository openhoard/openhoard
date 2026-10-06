import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  SignedOut,
  type Api,
  type ReviewInbox,
  type ReviewItem,
  type Reviewed,
  type Vocabulary as Vocab,
} from "./api.js";
import { Review } from "./review.js";
import { Vocabulary } from "./vocabulary.js";
import { reviewReasonText, suggestedBy, tagParts, valueEffects } from "./words.js";

/*
 * T-903: tags to review, and the vocabulary. (The round trip to the file's tags and to search
 * is the server's: apps/server review-api.test.ts.)
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ID = (c: string) => `rev_${c.repeat(26)}`;
const item = (over: Partial<ReviewItem> = {}): ReviewItem => ({
  id: ID("a"),
  title: "Q3 board deck.pptx",
  tag: "client:globex",
  reason: "agent",
  appliedBy: "model:agent/cli_x",
  confidence: 1,
  createdAt: "2026-10-05T07:00:00.000Z",
  admin: false,
  ...over,
});
const VOCAB: Vocab = {
  cut: false,
  facets: [
    {
      key: "client",
      label: "Client",
      public: false,
      single: false,
      values: [
        {
          value: "globex",
          tag: "client:globex",
          label: "Globex",
          approved: true,
          visibility: null,
          exposure: null,
          waiting: 1,
        },
        {
          value: "globex-inc",
          tag: "client:globex-inc",
          label: "Globex Inc",
          approved: false,
          visibility: null,
          exposure: null,
          waiting: 2,
        },
        {
          value: "initech",
          tag: "client:initech",
          label: "Initech",
          approved: true,
          visibility: null,
          exposure: null,
          waiting: 0,
        },
      ],
    },
    {
      key: "sensitivity",
      label: "Sensitivity",
      public: true,
      single: true,
      values: [
        {
          value: "restricted",
          tag: "sensitivity:restricted",
          label: "Restricted",
          approved: true,
          visibility: "hidden",
          exposure: "local-only",
          waiting: 0,
        },
      ],
    },
  ],
};

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  window.history.replaceState(null, "", "/admin/review");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function page(
  inbox: ReviewItem[] | (() => Promise<ReviewInbox>),
  ended: Reviewed | Error | ((n: number) => Reviewed) = {
    ended: "done",
    applied: "client:globex",
    replaced: [],
    alsoClosed: 0,
  },
  vocabulary: Vocab | Error = VOCAB,
) {
  const review = vi.fn(
    typeof inbox === "function"
      ? inbox
      : async () => ({ items: inbox, more: false, capped: false }),
  );
  let n = 0;
  const decideReview = vi.fn<Api["decideReview"]>(async () => {
    if (ended instanceof Error) throw ended;
    return typeof ended === "function" ? ended(n++) : ended;
  });
  const api = {
    review,
    decideReview,
    vocabulary: vi.fn(async () => {
      if (vocabulary instanceof Error) throw vocabulary;
      return vocabulary;
    }),
  } as unknown as Api;
  const signedOut = vi.fn();
  const show = () =>
    act(async () => {
      root.render(<Review api={api} onSignedOut={signedOut} />);
    });
  return { show, review, decideReview, signedOut, api };
}
const text = () => host.textContent ?? "";
const card = (n = 0) => host.querySelectorAll("li.card")[n] as HTMLElement;
const button = (name: string, within: ParentNode = host) =>
  [...within.querySelectorAll("button")].find((b) => b.textContent === name) as HTMLButtonElement;
const click = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
const pick = (select: HTMLSelectElement, value: string) =>
  act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });

describe("tags to review (T-903)", () => {
  it("shows a suggestion by its file, the tag in the vocabulary's words, and why it waits", async () => {
    const { show } = page([
      item(),
      item({
        id: ID("b"),
        tag: "client:globex-inc",
        reason: "new-value",
        admin: true,
        appliedBy: "model:haiku",
      }),
    ]);
    await show();
    expect(card().querySelector("h3")?.textContent).toBe("Q3 board deck.pptx");
    expect(card().querySelector(".tag")?.textContent).toBe("Client: Globex");
    expect(card().textContent).toContain("An AI assistant suggested it");
    expect(card().textContent).toContain("Suggested by an AI assistant, ");
    expect(card().querySelector(".badge")).toBeNull();
    expect(card(1).querySelector(".tag")?.textContent).toBe("Client: Globex Inc");
    // Its name is the proposer's: the id it would get is shown beside it.
    expect(card(1).textContent).toContain("(as client:globex-inc)");
    expect(card().textContent).not.toContain("(as ");
    expect(card(1).querySelector(".badge")?.textContent).toBe("Admin decides");
    expect(card(1).textContent).toContain("isn't in your vocabulary yet");
  });

  it("approves, and says so where the list was", async () => {
    let open = true;
    const { show, decideReview, review } = page(async () => ({
      items: open ? [item()] : [],
      more: false,
      capped: false,
    }));
    await show();
    open = false;
    await click(button("Approve"));
    expect(decideReview).toHaveBeenCalledWith(ID("a"), { decision: "approve" });
    expect(review).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "Q3 board deck.pptx: client:globex approved.",
    );
    expect(text()).toContain("Nothing is waiting for you.");
    expect(document.activeElement?.id).toBe("review-top");
  });

  it("rejects, and says what else closed with it", async () => {
    const { show, decideReview } = page([item()], {
      ended: "done",
      applied: null,
      replaced: [],
      alsoClosed: 3,
    });
    await show();
    await click(button("Reject"));
    expect(decideReview).toHaveBeenCalledWith(ID("a"), { decision: "reject" });
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "Q3 board deck.pptx: client:globex rejected. 3 other suggestions of the same value closed with it.",
    );
  });

  it("files a suggestion under a value the vocabulary already has", async () => {
    const { show, decideReview } = page([item({ tag: "client:globex-inc", reason: "new-value" })], {
      ended: "done",
      applied: "client:globex",
      replaced: [],
      alsoClosed: 0,
    });
    await show();
    const select = card().querySelector("select") as HTMLSelectElement;
    // The approved values of the same kind, not itself, not other kinds'.
    expect([...select.options].map((o) => o.textContent)).toEqual(["Choose…", "Globex", "Initech"]);
    expect(button("Use that instead").disabled).toBe(true);
    await pick(select, "globex");
    await click(button("Use that instead"));
    expect(decideReview).toHaveBeenCalledWith(ID("a"), { decision: "merge", into: "globex" });
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "Q3 board deck.pptx: tagged client:globex, instead of client:globex-inc.",
    );
  });

  it("asks before taking another value off the file, and only then replaces", async () => {
    const { show, decideReview, review } = page(
      [item({ tag: "sensitivity:restricted", reason: "conflict" })],
      (n) =>
        n === 0
          ? { ended: "replace", replaces: ["sensitivity:internal"] }
          : {
              ended: "done",
              applied: "sensitivity:restricted",
              replaced: ["sensitivity:internal"],
              alsoClosed: 0,
            },
    );
    await show();
    await click(button("Approve"));
    expect(review).toHaveBeenCalledTimes(1);
    expect(card().querySelector('.next[role="alert"]')?.textContent).toContain(
      "can have only one Sensitivity value, and it has sensitivity:internal. Going ahead takes that off the file and puts sensitivity:restricted on it.",
    );
    expect(document.activeElement).toBe(card().querySelector("h3"));
    await click(button("Replace it"));
    expect(decideReview).toHaveBeenLastCalledWith(ID("a"), { decision: "approve", replace: true });
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "Q3 board deck.pptx: sensitivity:restricted approved, in place of sensitivity:internal.",
    );
  });

  it("says what a decision came to when it wasn't made", async () => {
    for (const [ended, said] of [
      ["gone", "no longer waiting"],
      ["not-yours", "aren't allowed to tag it"],
      ["admin-only", "takes an admin"],
      ["invalid", "can't be done"],
      ["failed", "didn't go through"],
    ] as const) {
      act(() => root.unmount());
      root = createRoot(host);
      const { show } = page([item()], { ended });
      await show();
      await click(button("Approve"));
      expect(card().querySelector('[role="alert"]')?.textContent, ended).toContain(said);
      expect(host.querySelector('[role="status"]')?.textContent).toBe("");
      expect(button("Reject").disabled).toBe(false);
    }
    // The item went with the reload: said at the top instead.
    act(() => root.unmount());
    root = createRoot(host);
    let open = true;
    const gone = page(async () => ({ items: open ? [item()] : [], more: false, capped: false }), {
      ended: "gone",
    });
    await gone.show();
    open = false;
    await click(button("Approve"));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Q3 board deck.pptx: That suggestion is no longer waiting",
    );
  });

  it("answers the question about what was asked, whatever the page shows by then", async () => {
    const { show, decideReview } = page(
      [item({ tag: "client:globex-inc", reason: "new-value" })],
      (n) =>
        n === 0
          ? { ended: "replace", replaces: [] }
          : { ended: "done", applied: "client:globex", replaced: [], alsoClosed: 0 },
    );
    await show();
    const select = card().querySelector("select") as HTMLSelectElement;
    await pick(select, "globex");
    await click(button("Use that instead"));
    // The question says what goes on, and the choice can't be changed under it.
    expect(card().textContent).toContain(
      "and it has another. Going ahead takes that off the file and puts client:globex on it.",
    );
    expect(select.disabled).toBe(true);
    expect(button("Use that instead").disabled).toBe(true);
    await click(button("Replace it"));
    expect(decideReview).toHaveBeenLastCalledWith(ID("a"), {
      decision: "merge",
      into: "globex",
      replace: true,
    });
  });

  it("words a suggested main tag as what it is: the tag is on the file either way", async () => {
    const { show, decideReview } = page([item({ reason: "primary" })], (n) => ({
      ended: "done",
      applied: n === 0 ? null : "client:globex",
      replaced: [],
      alsoClosed: 0,
    }));
    await show();
    expect(card().textContent).toContain("Suggested main tag: Client: Globex");
    expect(card().textContent).toContain("The file already has this tag.");
    expect(card().querySelector("select")).toBeNull();
    await click(button("Leave it as it is"));
    expect(decideReview).toHaveBeenLastCalledWith(ID("a"), { decision: "reject" });
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "Q3 board deck.pptx: client:globex stays on the file, and isn't its main tag.",
    );
    await click(button("Make it the main tag"));
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "Q3 board deck.pptx: client:globex is now its main tag.",
    );
  });

  it("doesn't call a value new once the vocabulary has it", async () => {
    const { show } = page([item({ reason: "new-value" })]);
    await show();
    expect(card().textContent).toContain("has been added to your vocabulary since");
    expect(card().textContent).not.toContain("isn't in your vocabulary yet");
  });

  it("fails to load, plainly, when the vocabulary fails for any reason but not being its reader", async () => {
    const { show } = page([item()], undefined, new ApiError(500));
    await show();
    expect(host.querySelector('.notice[role="alert"]')?.textContent).toContain(
      "couldn't be loaded",
    );
    expect(host.querySelectorAll("li.card")).toHaveLength(0);
  });

  it("still shows suggestions, by their tags, to someone who can't read the vocabulary", async () => {
    const { show } = page([item()], undefined, new ApiError(403));
    await show();
    expect(card().querySelector(".tag")?.textContent).toBe("client: globex");
    expect(card().querySelector("select")).toBeNull();
    expect(button("Approve")).toBeDefined();
  });

  it("says when there is nothing, when there is more, and when it can't load", async () => {
    const more = page(async () => ({ items: [item()], more: true, capped: true }));
    await more.show();
    expect(text()).toContain("More are waiting");
    expect(text()).toContain("not all were looked at");

    act(() => root.unmount());
    root = createRoot(host);
    const capped = page(async () => ({ items: [], more: false, capped: true }));
    await capped.show();
    expect(text()).toContain("too many to look at them all");

    act(() => root.unmount());
    root = createRoot(host);
    let fail = true;
    const failing = page(async () =>
      fail ? Promise.reject(new ApiError(500)) : { items: [], more: false, capped: false },
    );
    await failing.show();
    expect(host.querySelector('.notice[role="alert"]')?.textContent).toContain(
      "couldn't be loaded",
    );
    fail = false;
    await click(button("Try again"));
    expect(text()).toContain("Nothing is waiting for you.");
  });

  it("goes to sign in when the session has ended, on reading or deciding", async () => {
    const reading = page(async () => Promise.reject(new SignedOut()));
    await reading.show();
    expect(reading.signedOut).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    root = createRoot(host);
    const deciding = page([item()], new SignedOut());
    await deciding.show();
    await click(button("Reject"));
    expect(deciding.signedOut).toHaveBeenCalledTimes(1);
  });
});

describe("the vocabulary page (T-903)", () => {
  const show = async (vocabulary: () => Promise<Vocab>) => {
    const api = { vocabulary: vi.fn(vocabulary) } as unknown as Api;
    const signedOut = vi.fn();
    await act(async () => {
      root.render(<Vocabulary api={api} onSignedOut={signedOut} />);
    });
    return { api, signedOut };
  };

  it("lists each kind of tag with its values, what a value does, and what is only proposed", async () => {
    await show(async () => VOCAB);
    expect([...host.querySelectorAll("h2")].map((h) => h.textContent)).toEqual([
      "Client",
      "Sensitivity",
    ]);
    const [client, sensitivity] = [...host.querySelectorAll("section")] as [
      HTMLElement,
      HTMLElement,
    ];
    expect(client.textContent).toContain("A file can have several of these.");
    expect(client.textContent).toContain("Shown only to people who can open the file.");
    const rows = [...client.querySelectorAll(".values li")];
    expect(rows.map((r) => r.querySelector("strong")?.textContent)).toEqual([
      "Globex",
      "Globex Inc",
      "Initech",
    ]);
    expect(rows[1]?.querySelector(".badge")?.textContent).toBe("Proposed");
    expect(rows[1]?.textContent).toContain("2 suggestions waiting in Tags to review.");
    expect(rows[0]?.textContent).toContain("1 suggestion waiting");
    expect(rows[2]?.textContent).toBe("Initech");
    expect(sensitivity.textContent).toContain("A file has one of these at most.");
    expect(sensitivity.textContent).toContain(
      "Shown on a file's card even to people who can't open it, when they can see the card at all.",
    );
    expect(sensitivity.textContent).toContain(
      "Hides the file from people who can't open it. Only AI that stays on your computers gets the file's content.",
    );
  });

  it("says when there is none, when it is cut, refused, failed, or the session ended", async () => {
    await show(async () => ({ facets: [], cut: true }));
    expect(text()).toContain("There is no vocabulary yet.");
    expect(text()).toContain("too large to show whole");
    for (const [err, said] of [
      [new ApiError(403), "aren't allowed to see this"],
      [new ApiError(500), "couldn't be loaded"],
    ] as const) {
      act(() => root.unmount());
      root = createRoot(host);
      await show(async () => Promise.reject(err));
      expect(text()).toContain(said);
    }
    act(() => root.unmount());
    root = createRoot(host);
    const { signedOut } = await show(async () => Promise.reject(new SignedOut()));
    expect(signedOut).toHaveBeenCalledTimes(1);
  });
});

describe("tags and their review in an admin's words", () => {
  it("splits a tag, and says why one waits and who suggested it", () => {
    expect(tagParts("client:globex")).toEqual({ facet: "client", value: "globex" });
    expect(tagParts("a:b:c")).toEqual({ facet: "a", value: "b:c" });
    expect(tagParts("loose")).toEqual({ facet: "", value: "loose" });
    expect(reviewReasonText({ reason: "low-confidence", confidence: 0.62 })).toContain(
      "62% confident",
    );
    for (const reason of ["agent", "new-value", "sensitive", "conflict", "primary"]) {
      expect(reviewReasonText({ reason, confidence: 1 }), reason).not.toBe(
        "It waits for a person to decide.",
      );
    }
    expect(reviewReasonText({ reason: "something-new", confidence: 1 })).toBe(
      "It waits for a person to decide.",
    );
    expect(suggestedBy("model:agent/cli_x")).toBe("Suggested by an AI assistant");
    expect(suggestedBy("model:haiku")).toBe("Suggested by the AI that reads new files");
    expect(suggestedBy("user:usr_1")).toBe("Suggested by a person");
    expect(suggestedBy("rule:r1")).toBe("Suggested by a rule");
    expect(suggestedBy(null)).toBe("Suggested automatically");
    expect(suggestedBy("odd")).toBe("Suggested automatically");
  });

  it("says what a value does to a file, and nothing for one that only labels", () => {
    expect(valueEffects({ visibility: null, exposure: null })).toEqual([]);
    expect(valueEffects({ visibility: "readable", exposure: "full" })).toEqual([
      "Everyone in your organization can see the file's card and summary, without being able to open it.",
      "Any approved AI gets the file's content.",
    ]);
    expect(valueEffects({ visibility: "discoverable", exposure: "metadata-only" })).toHaveLength(2);
    expect(valueEffects({ visibility: null, exposure: "commercial-only" })).toEqual([
      "Personal AI doesn't get the file's content.",
    ]);
    // A level this page doesn't know is said as it is.
    expect(valueEffects({ visibility: "secret", exposure: "none" })).toEqual([
      "Visibility: secret.",
      "AI access: none.",
    ]);
  });
});
