import { inflateSync } from "node:zlib";
import { unzip } from "./zip.js";

export interface ExtractedPart {
  /** Where the text came from, e.g. `word/comments.xml` or `pdf:info`. */
  source: string;
  text: string;
}

/**
 * A deliberately NAIVE text extractor: it returns every piece of text a careless enricher would
 * feed to a model, hidden or not (white text, vanished runs, comments, metadata, hidden sheets,
 * formulas, off-page and invisible PDF text). The injection harness uses it as the "no
 * defences" baseline; real enrichers must do at least as well as the baseline's detections.
 */
export function extractText(name: string, mime: string, bytes: Uint8Array): ExtractedPart[] {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (mime.includes("officedocument") || ext === "docx" || ext === "xlsx" || ext === "pptx")
    return fromOoxml(bytes);
  if (mime === "application/pdf" || ext === "pdf") return fromPdf(bytes);
  return [{ source: "text", text: new TextDecoder().decode(bytes) }];
}

function fromOoxml(bytes: Uint8Array): ExtractedPart[] {
  const parts: ExtractedPart[] = [];
  const dec = new TextDecoder();
  for (const [path, data] of unzip(bytes)) {
    if (!path.endsWith(".xml") || path.startsWith("[Content_Types]") || path.includes("_rels/"))
      continue;
    const doc = dec.decode(data);
    const text = [...sheetNames(doc), xmlText(doc)].join(" ").trim();
    if (text) parts.push({ source: path, text });
  }
  return parts;
}

/** Text content of an XML document: tags become spaces, entities are decoded. */
function xmlText(doc: string): string {
  return decodeEntities(stripTags(doc)).replace(/\s+/g, " ").trim();
}

/** Replaces every `<…>` with a space. An indexOf scan: linear even for "<<<<…" input. */
function stripTags(doc: string): string {
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const lt = doc.indexOf("<", at);
    if (lt < 0) {
      out.push(doc.slice(at));
      break;
    }
    out.push(doc.slice(at, lt), " ");
    const gt = doc.indexOf(">", lt);
    if (gt < 0) break; // an unterminated tag: drop the rest
    at = gt + 1;
  }
  return out.join("");
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (e[0] !== "#") return named[e.toLowerCase()] ?? "";
    const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

/**
 * Sheet names live in attributes but are visible text in Excel, so keep them. A linear scan
 * with indexOf (no backtracking regex), because the input is untrusted.
 */
function sheetNames(doc: string): string[] {
  const names: string[] = [];
  let at = doc.indexOf("<sheet ");
  while (at >= 0) {
    const close = doc.indexOf(">", at);
    if (close < 0) break;
    const name = /\bname="([^"]*)"/.exec(doc.slice(at, close))?.[1];
    if (name !== undefined) names.push(decodeEntities(name));
    at = doc.indexOf("<sheet ", close);
  }
  return names;
}

function fromPdf(bytes: Uint8Array): ExtractedPart[] {
  const raw = Buffer.from(bytes).toString("latin1");
  const parts: ExtractedPart[] = [];
  const outside: string[] = [];
  let last = 0;
  // Content streams (inflated when compressed) hold the page text.
  for (const s of pdfStreams(raw)) {
    outside.push(raw.slice(last, s.start));
    last = s.end;
    let body = s.body;
    if (s.dict.includes("/FlateDecode")) {
      try {
        body = inflateSync(Buffer.from(body, "latin1"), {
          maxOutputLength: 64 * 1024 * 1024,
        }).toString("latin1");
      } catch {
        continue;
      }
    }
    const text = pdfStrings(body);
    if (text) parts.push({ source: "pdf:content", text });
  }
  outside.push(raw.slice(last));
  // Everything outside streams: /Info, annotations (/Contents), outlines.
  const text = pdfStrings(outside.join(" "));
  if (text) parts.push({ source: "pdf:objects", text });
  return parts;
}

/**
 * Finds `stream … endstream` bodies and the dictionary before each, in one forward pass. Every
 * search starts after the previous stream and looks back no further than it, so the scan is
 * linear even on hostile input (a regex here backtracked for minutes on 50 KB of "obj<<").
 */
function pdfStreams(raw: string): { dict: string; body: string; start: number; end: number }[] {
  const out: { dict: string; body: string; start: number; end: number }[] = [];
  let from = 0;
  for (let kw = raw.indexOf("stream", from); kw >= 0; kw = raw.indexOf("stream", from)) {
    if (raw.startsWith("end", kw - 3)) {
      from = kw + 6; // a stray "endstream"
      continue;
    }
    let bodyStart = kw + 6;
    if (raw[bodyStart] === "\r") bodyStart++;
    if (raw[bodyStart] !== "\n") {
      from = kw + 6; // "stream" inside some other token
      continue;
    }
    bodyStart++;
    const endAt = raw.indexOf("endstream", bodyStart);
    if (endAt < 0) break;
    let bodyEnd = endAt;
    if (raw[bodyEnd - 1] === "\n") bodyEnd--;
    if (raw[bodyEnd - 1] === "\r") bodyEnd--;
    const window = raw.slice(from, kw);
    const objAt = window.lastIndexOf("obj");
    const start = objAt >= 0 ? from + objAt : kw;
    out.push({
      dict: raw.slice(start, kw),
      body: raw.slice(bodyStart, Math.max(bodyStart, bodyEnd)),
      start,
      end: endAt + 9,
    });
    from = endAt + 9;
  }
  return out;
}

/**
 * All literal strings `( … )` in PDF syntax, unescaped and joined. PDF strings may contain
 * balanced nested parentheses and backslash escapes. This is a single forward scan: the regex it
 * replaces was quadratic on runs of escaped parentheses.
 */
function pdfStrings(s: string): string {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (depth > 0 && c === "\\") {
      i++; // skip the escaped character
    } else if (c === "(") {
      if (depth++ === 0) start = i + 1;
    } else if (c === ")" && depth > 0 && --depth === 0) {
      out.push(unescapePdf(s.slice(start, i)));
    }
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

function unescapePdf(raw: string): string {
  const map: Record<string, string> = {
    n: "\n",
    r: "\r",
    t: "\t",
    b: "\b",
    f: "\f",
    "(": "(",
    ")": ")",
    "\\": "\\",
  };
  return raw.replace(
    /\\([nrtbf()\\]|[0-7]{1,3})/g,
    (_, e: string) => map[e] ?? String.fromCharCode(parseInt(e, 8)),
  );
}
