/*
 * What is saved of a page (T-1207): its readable text as Markdown, with the address it came
 * from. Not a copy of the page: OpenHoard's extractor reads text, Markdown, PDFs and office
 * files, and a page's HTML is mostly what a reader never sees.
 *
 * capturePage() runs inside the page (the worker injects it, scripting.executeScript), so it is
 * one function with everything it needs inside: nothing here may name anything outside it.
 *
 * - The page's main part (`main`, `[role=main]`, or its one `article`), else its body; or the
 *   selection.
 * - What a reader doesn't see isn't kept: scripts, styles, forms, navigation, hidden elements
 *   (`hidden`, `aria-hidden`, `display: none`, `visibility: hidden`), comments. Hidden text is
 *   where instructions for an AI are put; this drops the plain cases, not every trick.
 * - Headings, paragraphs, lists, quotes, code, tables, links (http and https only, made
 *   absolute) and images that have a description.
 * - At most `limit` characters; a longer page is cut, and says so.
 */

export interface Captured {
  title: string;
  url: string;
  markdown: string;
  /** The document's media type, e.g. `text/html`, or `application/pdf` in a PDF viewer. */
  contentType: string;
  /** False when there was nothing to save (no selection, an empty page). */
  found: boolean;
}

export function capturePage(mode: "page" | "selection", limit = 2_000_000): Captured {
  const SKIP = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "SVG",
    "CANVAS",
    "IFRAME",
    "OBJECT",
    "EMBED",
    "NAV",
    "FORM",
    "BUTTON",
    "INPUT",
    "SELECT",
    "TEXTAREA",
    "DIALOG",
    "HEAD",
    "AUDIO",
    "VIDEO",
  ]);
  const BLOCK = new Set([
    "P",
    "DIV",
    "SECTION",
    "ARTICLE",
    "MAIN",
    "HEADER",
    "FOOTER",
    "ASIDE",
    "FIGURE",
    "FIGCAPTION",
    "UL",
    "OL",
    "DL",
    "DT",
    "DD",
    "TABLE",
    "ADDRESS",
    "DETAILS",
    "SUMMARY",
  ]);
  const squeeze = (s: string) => s.replace(/[ \t\r\n\f\u00a0]+/g, " ");
  const link = (href: string | null): string | null => {
    if (!href) return null;
    try {
      const u = new URL(href, document.baseURI);
      return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
    } catch {
      return null;
    }
  };
  /** Put on what a selection's copy can't be asked about (see below), for the copy to carry. */
  const MARK = "data-openhoard-unseen";
  const hidden = (el: Element): boolean => {
    if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return true;
    if (el.hasAttribute(MARK)) return true;
    // Only an element of the page has a style to ask for (a selection's copy has none).
    if (typeof getComputedStyle !== "function" || !el.isConnected) return false;
    const style = getComputedStyle(el);
    return style.display === "none" || style.visibility === "hidden";
  };

  /** One node's text, in line (no block breaks). */
  const one = (child: Node): string => {
    if (child.nodeType === 3) return squeeze(child.nodeValue ?? "");
    if (child.nodeType !== 1) return "";
    const el = child as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag) || hidden(el)) return "";
    if (tag === "BR") return "\n";
    if (tag === "IMG") {
      const alt = squeeze(el.getAttribute("alt") ?? "").trim();
      const src = link(el.getAttribute("src"));
      return alt !== "" && src !== null ? `![${alt}](${src})` : "";
    }
    if (tag === "CODE" || tag === "KBD" || tag === "SAMP") {
      const code = (el.textContent ?? "").trim();
      return code === "" ? "" : `\`${code}\``;
    }
    const text = inline(el);
    const bare = text.trim();
    if (bare === "") return text === "" ? "" : " ";
    // A block met in line (a paragraph inside a table cell or a link): apart from its neighbours.
    if (BLOCK.has(tag) || /^(H[1-6]|LI|PRE|BLOCKQUOTE|TR)$/.test(tag)) return ` ${bare} `;
    if (tag === "A") {
      const href = link(el.getAttribute("href"));
      return href === null || href === bare ? text : `[${bare}](${href})`;
    }
    if (tag === "STRONG" || tag === "B") return `**${bare}**`;
    if (tag === "EM" || tag === "I") return `*${bare}*`;
    return text;
  };
  /** The text of what is inside `node`, in line. */
  const inline = (node: Node): string => {
    let out = "";
    for (const child of node.childNodes) out += one(child);
    return out;
  };

  const blocks: string[] = [];
  /** Which blocks are list items or table rows: neighbours of the same kind sit on consecutive lines. */
  const tight: ("" | "item" | "row")[] = [];
  const add = (block: string, close: "" | "item" | "row" = "") => {
    blocks.push(block);
    tight.push(close);
  };
  const push = (text: string, prefix = "", close: "" | "item" | "row" = "") => {
    const clean = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .join("\n");
    if (clean !== "") add(prefix === "" ? clean : clean.replace(/^/gm, prefix), close);
  };
  const isBlock = (tag: string) => BLOCK.has(tag) || /^(H[1-6]|PRE|BLOCKQUOTE|LI|HR|TR)$/.test(tag);
  /** Whether an element holds blocks, at any depth (then its text is theirs, not one paragraph). */
  const holdsBlocks = (el: Element): boolean => {
    for (const c of el.children) {
      const t = c.tagName.toUpperCase();
      if (SKIP.has(t)) continue;
      if (isBlock(t) || holdsBlocks(c)) return true;
    }
    return false;
  };

  const walk = (node: Node, quote: string): void => {
    let run = "";
    const flush = () => {
      push(run, quote);
      run = "";
    };
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        run += squeeze(child.nodeValue ?? "");
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      const tag = el.tagName.toUpperCase();
      if (SKIP.has(tag) || hidden(el)) continue;
      const heading = /^H([1-6])$/.exec(tag);
      if (heading) {
        flush();
        push(`${"#".repeat(Number(heading[1]))} ${inline(el).replace(/\n/g, " ").trim()}`, quote);
      } else if (tag === "PRE") {
        flush();
        const code = (el.textContent ?? "").replace(/\s+$/, "");
        if (code.trim() !== "") add(`${quote}\`\`\`\n${code}\n\`\`\``.replace(/\n/g, `\n${quote}`));
      } else if (tag === "BLOCKQUOTE") {
        flush();
        walk(el, `${quote}> `);
      } else if (tag === "HR") {
        flush();
        add(`${quote}---`);
      } else if (tag === "LI") {
        flush();
        const list = el.parentElement;
        let marker = "- ";
        if (list?.tagName.toUpperCase() === "OL") {
          // Its number, as the page shows it ("see step 3" should still mean something).
          const items = [...list.children].filter((c) => c.tagName.toUpperCase() === "LI");
          const start = Number(list.getAttribute("start") ?? "1");
          marker = `${(Number.isInteger(start) ? start : 1) + Math.max(0, items.indexOf(el))}. `;
        }
        if (holdsBlocks(el)) {
          // Its blocks, indented under the marker, which the first of them carries.
          const indent = `${quote}${" ".repeat(marker.length)}`;
          const at = blocks.length;
          walk(el, indent);
          const first = blocks[at];
          if (first !== undefined) {
            blocks[at] = `${quote}${marker}${first.slice(indent.length)}`;
            tight[at] = "item";
          }
        } else push(`${marker}${inline(el).replace(/\n/g, " ").trim()}`, quote, "item");
      } else if (tag === "TR") {
        flush();
        const cells = [...el.children]
          .filter((c) => !SKIP.has(c.tagName.toUpperCase()) && !hidden(c))
          .map((c) =>
            inline(c).replace(/\n/g, " ").replace(/\|/g, "\\|").replace(/ {2,}/g, " ").trim(),
          );
        if (cells.some((c) => c !== "")) push(`| ${cells.join(" | ")} |`, quote, "row");
      } else if (BLOCK.has(tag) || tag === "TBODY" || tag === "THEAD" || tag === "TFOOT") {
        flush();
        if (holdsBlocks(el) || tag === "TABLE" || /^T(BODY|HEAD|FOOT)$/.test(tag)) walk(el, quote);
        else push(inline(el), quote);
      } else if (holdsBlocks(el)) {
        flush();
        walk(el, quote);
      } else {
        // In line with the text around it (a link, a span, emphasis).
        run += one(el);
      }
    }
    flush();
  };

  const title = squeeze(document.title || "").trim();
  const url = document.location.href;
  const contentType = document.contentType || "text/html";
  let root: Node | null = null;
  if (mode === "selection") {
    const selection = typeof getSelection === "function" ? getSelection() : null;
    if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
      const range = selection.getRangeAt(0);
      // The copy isn't in the page, so it has no styles to ask about: what a style hides is
      // marked in the page for the moment of the copy, and the copy carries the marks.
      const around = range.commonAncestorContainer;
      const scope = around.nodeType === 1 ? (around as Element) : around.parentElement;
      const marked: Element[] = [];
      // (Found first, marked after: a mark made between two questions makes the page work
      // its styles out again each time.)
      for (const el of scope?.querySelectorAll("*") ?? []) {
        if (range.intersectsNode(el) && hidden(el)) marked.push(el);
      }
      try {
        for (const el of marked) el.setAttribute(MARK, "");
        root = range.cloneContents();
      } finally {
        for (const el of marked) el.removeAttribute(MARK);
      }
    }
  } else {
    // The page's main part; a lone article; else all of it (a page of several articles is a
    // list of them, and the first alone isn't the page).
    const articles = document.querySelectorAll("article");
    root =
      document.querySelector("main, [role=main]") ??
      (articles.length === 1 ? (articles[0] as Element) : document.body);
  }
  if (root !== null) walk(root, "");
  let body = blocks
    .map((b, i) =>
      i === 0 ? b : `${tight[i] !== "" && tight[i] === tight[i - 1] ? "\n" : "\n\n"}${b}`,
    )
    .join("");
  const found = body.trim() !== "";
  if (body.length > limit) {
    // (Not through the middle of a character.)
    const cut = body.slice(0, limit).replace(/[\ud800-\udbff]$/, "");
    body = `${cut}\n\n(Cut here: the page was longer than what is saved.)`;
  }
  const what = mode === "selection" ? "Selection from" : "Saved from";
  const head = `# ${title || url}\n\n${what} <${url}> on ${new Date().toISOString().slice(0, 10)}.`;
  return { title: title || url, url, markdown: `${head}\n\n${body}\n`, contentType, found };
}
