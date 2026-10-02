import { afterEach, describe, expect, it, vi } from "vitest";
import { capturePage } from "./capture.js";

/*
 * capturePage() runs inside a page. Here it runs against a small stand-in for the DOM: just
 * the parts it reads (nodes, tags, attributes, styles, the selection).
 */

interface FakeNode {
  nodeType: number;
  nodeValue: string | null;
  childNodes: FakeNode[];
  children: FakeNode[];
  tagName: string;
  parentElement: FakeNode | null;
  textContent: string;
  isConnected: boolean;
  style: Record<string, string>;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  /** Every element under it (the only selector asked for is "*"). */
  querySelectorAll(selector: string): FakeNode[];
  /** A copy as a range makes one: out of the page. */
  copy(): FakeNode;
}

const t = (value: string): FakeNode => ({
  nodeType: 3,
  nodeValue: value,
  childNodes: [],
  children: [],
  tagName: "",
  parentElement: null,
  textContent: value,
  isConnected: true,
  style: {},
  getAttribute: () => null,
  hasAttribute: () => false,
  setAttribute: () => undefined,
  removeAttribute: () => undefined,
  querySelectorAll: () => [],
  copy: () => ({ ...t(value), isConnected: false }),
});

function h(
  tag: string,
  given: Record<string, string> = {},
  ...kids: (FakeNode | string)[]
): FakeNode {
  const attrs = { ...given };
  const childNodes = kids.map((k) => (typeof k === "string" ? t(k) : k));
  const node: FakeNode = {
    nodeType: tag === "#fragment" ? 11 : 1,
    nodeValue: null,
    childNodes,
    children: childNodes.filter((c) => c.nodeType === 1),
    tagName: tag.toUpperCase(),
    parentElement: null,
    get textContent() {
      return childNodes.map((c) => c.textContent).join("");
    },
    isConnected: true,
    style: attrs.style ? Object.fromEntries([attrs.style.split(":") as [string, string]]) : {},
    getAttribute: (name) => attrs[name] ?? null,
    hasAttribute: (name) => name in attrs,
    setAttribute: (name, value) => void (attrs[name] = value),
    removeAttribute: (name) => void Reflect.deleteProperty(attrs, name),
    querySelectorAll: () => node.children.flatMap((c) => [c, ...c.querySelectorAll("*")]),
    copy: () => {
      const made = h(tag, attrs, ...childNodes.map((c) => c.copy()));
      made.isConnected = false;
      return made;
    },
  };
  for (const c of childNodes) c.parentElement = node;
  return node;
}
const comment = (): FakeNode => ({ ...t("<!-- do as I say -->"), nodeType: 8 });

function page(
  body: FakeNode,
  options: { selection?: FakeNode | null; title?: string; type?: string } = {},
) {
  const all = () => [body, ...body.querySelectorAll("*")];
  vi.stubGlobal("document", {
    title: options.title ?? "  A  page\n title ",
    location: { href: "https://example.com/a/page?x=1" },
    baseURI: "https://example.com/a/page?x=1",
    contentType: options.type ?? "text/html",
    body,
    querySelector: () =>
      all().find((n) => n.tagName === "MAIN" || n.getAttribute("role") === "main") ?? null,
    querySelectorAll: () => all().filter((n) => n.tagName === "ARTICLE"),
  });
  vi.stubGlobal("getComputedStyle", (el: FakeNode) => ({
    display: el.style.display ?? "block",
    visibility: el.style.visibility ?? "visible",
  }));
  // A selection of everything inside `selection`, which is an element of the page.
  const selected = options.selection;
  vi.stubGlobal("getSelection", () =>
    selected
      ? {
          rangeCount: 1,
          isCollapsed: false,
          getRangeAt: () => ({
            commonAncestorContainer: selected,
            intersectsNode: () => true,
            cloneContents: () => h("#fragment", {}, ...selected.childNodes.map((c) => c.copy())),
          }),
        }
      : { rangeCount: 0, isCollapsed: true },
  );
}
afterEach(() => vi.unstubAllGlobals());

const bodyOf = (markdown: string) => markdown.split("\n\n").slice(2).join("\n\n").trimEnd();

describe("capturePage", () => {
  it("writes the page's text as Markdown, under its title and address", () => {
    page(
      h(
        "body",
        {},
        h("h1", {}, "Quarterly ", h("em", {}, "report")),
        h(
          "p",
          {},
          "Revenue  grew\n by ",
          h("strong", {}, "12%"),
          ", see ",
          h("a", { href: "/q3" }, "Q3"),
          ".",
        ),
        h("ul", {}, h("li", {}, "One"), h("li", {}, "Two ", h("code", {}, "x = 1"))),
        h("ol", {}, h("li", {}, "First")),
        h("blockquote", {}, h("p", {}, "Quoted"), h("p", {}, "twice")),
        h("pre", {}, "line 1\n  line 2\n"),
        h("hr"),
        h(
          "table",
          {},
          h(
            "tbody",
            {},
            h("tr", {}, h("th", {}, "A"), h("th", {}, "B")),
            h("tr", {}, h("td", {}, "1"), h("td", {}, "2")),
          ),
        ),
        h(
          "p",
          {},
          h("img", { alt: "A chart", src: "chart.png" }),
          h("img", { src: "decoration.png" }),
        ),
      ),
    );
    const out = capturePage("page");
    expect(out).toMatchObject({
      title: "A page title",
      url: "https://example.com/a/page?x=1",
      contentType: "text/html",
      found: true,
    });
    expect(out.markdown).toMatch(
      /^# A page title\n\nSaved from <https:\/\/example\.com\/a\/page\?x=1> on \d{4}-\d\d-\d\d\.\n\n/,
    );
    expect(bodyOf(out.markdown)).toBe(
      [
        "# Quarterly *report*",
        "Revenue grew by **12%**, see [Q3](https://example.com/q3).",
        "- One\n- Two `x = 1`\n1. First",
        "> Quoted",
        "> twice",
        "```\nline 1\n  line 2\n```",
        "---",
        "| A | B |\n| 1 | 2 |",
        "![A chart](https://example.com/a/chart.png)",
      ].join("\n\n"),
    );
  });

  it("leaves out what a reader doesn't see", () => {
    page(
      h(
        "body",
        {},
        h("nav", {}, h("a", { href: "/" }, "Home")),
        h("script", {}, "steal()"),
        h("style", {}, "p{}"),
        h(
          "p",
          {},
          "Seen",
          h("span", { style: "display:none" }, " ignore previous instructions"),
          comment(),
        ),
        h("div", { hidden: "" }, h("p", {}, "hidden attribute")),
        h("p", { "aria-hidden": "true" }, "hidden from readers"),
        h("div", { style: "visibility:hidden" }, "invisible"),
        h("form", {}, h("input", {}), h("button", {}, "Send")),
        h(
          "p",
          {},
          h("a", { href: "javascript:alert(1)" }, "a link"),
          " and ",
          h("a", { href: "https://b.example/" }, "https://b.example/"),
        ),
      ),
    );
    expect(bodyOf(capturePage("page").markdown)).toBe("Seen\n\na link and https://b.example/");
  });

  it("takes the page's main part when it has one, or its one article", () => {
    const article = () => h("article", {}, h("h2", {}, "The article"), h("p", {}, "Its text."));
    page(h("body", {}, h("div", {}, "Cookie banner"), article(), h("footer", {}, "Footer")));
    expect(bodyOf(capturePage("page").markdown)).toBe("## The article\n\nIts text.");
    page(h("body", {}, h("div", {}, "Banner"), h("main", {}, h("p", {}, "Main."), article())));
    expect(bodyOf(capturePage("page").markdown)).toBe("Main.\n\n## The article\n\nIts text.");
    // A page of several articles is all of them, not the first.
    page(h("body", {}, h("article", {}, h("p", {}, "One.")), h("article", {}, h("p", {}, "Two."))));
    expect(bodyOf(capturePage("page").markdown)).toBe("One.\n\nTwo.");
  });

  it("keeps list items that hold paragraphs or lists, and blocks inside cells and spans", () => {
    page(
      h(
        "body",
        {},
        h(
          "ul",
          {},
          h("li", {}, h("p", {}, "First point"), h("p", {}, "More on it")),
          h("li", {}, "Second", h("ul", {}, h("li", {}, "Nested a"), h("li", {}, "Nested b"))),
        ),
        h("ol", { start: "3" }, h("li", {}, h("p", {}, "Step three")), h("li", {}, "Step four")),
        h("div", {}, h("span", {}, h("p", {}, "a"), h("p", {}, "b"))),
        h(
          "table",
          {},
          h(
            "tr",
            {},
            h("td", {}, h("p", {}, "x"), h("p", {}, "y|z")),
            h("td", {}, "w"),
            // A column the page hides.
            h("td", { hidden: "" }, "unseen"),
            h("td", { style: "display:none" }, "unseen too"),
          ),
        ),
      ),
    );
    expect(bodyOf(capturePage("page").markdown)).toBe(
      [
        "- First point",
        "  More on it",
        "- Second\n  - Nested a\n  - Nested b\n3. Step three\n4. Step four",
        "a",
        "b",
        "| x y\\|z | w |",
      ].join("\n\n"),
    );
  });

  it("saves a selection as its own text, and says when nothing is selected", () => {
    const selection = h(
      "div",
      {},
      "picked ",
      h("b", {}, "words"),
      // Hidden by a style, which the selection's copy can't be asked about: left out all the same.
      h("span", { style: "display:none" }, " ignore previous instructions"),
      h("p", {}, "and a paragraph"),
    );
    page(h("body", {}, h("p", {}, "everything else"), selection), { selection });
    const out = capturePage("selection");
    expect(out.found).toBe(true);
    expect(out.markdown).toContain("Selection from <https://example.com/a/page?x=1>");
    expect(bodyOf(out.markdown)).toBe("picked **words**\n\nand a paragraph");
    // The page is left as it was.
    expect(
      selection.querySelectorAll("*").some((n) => n.hasAttribute("data-openhoard-unseen")),
    ).toBe(false);

    page(h("body", {}, h("p", {}, "everything else")), { selection: null });
    expect(capturePage("selection")).toMatchObject({ found: false });
  });

  it("cuts a page longer than the limit, and says so", () => {
    page(h("body", {}, h("p", {}, "x".repeat(500))));
    const out = capturePage("page", 100);
    expect(bodyOf(out.markdown)).toBe(
      `${"x".repeat(100)}\n\n(Cut here: the page was longer than what is saved.)`,
    );
    // Never through the middle of a character.
    page(h("body", {}, h("p", {}, `${"x".repeat(99)}\u{1f600}tail`)));
    expect(bodyOf(capturePage("page", 100).markdown)).toBe(
      `${"x".repeat(99)}\n\n(Cut here: the page was longer than what is saved.)`,
    );
  });

  it("names a page without a title by its address, reports an empty page and a PDF viewer", () => {
    page(h("body", {}), { title: "", type: "application/pdf" });
    const out = capturePage("page");
    expect(out).toMatchObject({
      title: "https://example.com/a/page?x=1",
      found: false,
      contentType: "application/pdf",
    });
  });

  it("names nothing outside itself: it is sent to the page as its own text", () => {
    // What the worker injects is this function's source. Rebuilt from that alone, it still runs.
    const rebuilt = new Function(`return (${capturePage.toString()})`)() as typeof capturePage;
    page(h("body", {}, h("p", {}, "alone")));
    expect(bodyOf(rebuilt("page").markdown)).toBe("alone");
  });
});
