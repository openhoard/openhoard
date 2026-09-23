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
    // Sheet names live in attributes but are visible text in Excel, so keep them.
    const sheetNames = [...doc.matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) =>
      decodeEntities(m[1] ?? ""),
    );
    const text = [...sheetNames, xmlText(doc)].join(" ").trim();
    if (text) parts.push({ source: path, text });
  }
  return parts;
}

/** Text content of an XML document: tags become spaces, entities are decoded. */
function xmlText(doc: string): string {
  return decodeEntities(doc.replace(/<\?[^>]*\?>/g, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (e[0] !== "#") return named[e.toLowerCase()] ?? "";
    const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

function fromPdf(bytes: Uint8Array): ExtractedPart[] {
  const raw = Buffer.from(bytes).toString("latin1");
  const parts: ExtractedPart[] = [];
  // Content streams (inflated when compressed) hold the page text.
  // The dictionary must belong to the same object as the stream: it may not cross "endobj".
  const streams = /obj\s*<<((?:(?!endobj)[^])*?)>>\s*stream\r?\n([^]*?)\r?\nendstream/g;
  for (let m = streams.exec(raw); m; m = streams.exec(raw)) {
    const dict = m[1] ?? "";
    let body = m[2] ?? "";
    if (/\/FlateDecode/.test(dict)) {
      try {
        body = inflateSync(Buffer.from(body, "latin1")).toString("latin1");
      } catch {
        continue;
      }
    }
    const text = pdfStrings(body);
    if (text) parts.push({ source: "pdf:content", text });
  }
  // Everything outside streams: /Info, annotations (/Contents), outlines.
  const outside = pdfStrings(raw.replace(streams, " "));
  if (outside) parts.push({ source: "pdf:objects", text: outside });
  return parts;
}

/** All literal strings `( … )` in PDF syntax, unescaped and joined. */
function pdfStrings(s: string): string {
  const out: string[] = [];
  const re = /\(((?:\\[^]|[^\\()])*)\)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    out.push(
      (m[1] ?? "").replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e: string) => {
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
        return map[e] ?? String.fromCharCode(parseInt(e, 8));
      }),
    );
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}
