import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtractContext } from "./context.ts";
import { ExtractError } from "./errors.ts";
import { PROPERTY_CHARS, sampleOf } from "./text.ts";

/*
 * PDF, through pdf.js (pdfjs-dist, legacy build for Node). Text comes page by page from
 * getTextContent(), a line per text line and a blank line between pages; the page count is
 * exact even when the text stops at its limit or at `maxPages`.
 *
 * pdf.js runs with everything it doesn't need for text switched off (and the child forbids
 * eval anyway): no font loading, no system fonts, no WebAssembly decoders, no image decoding (`maxImageSize: 0`
 * removes every image from the operator lists), no XFA, no fetching (character maps and
 * standard fonts are read from its own package folder, which is all the child may read).
 *
 * Signals come from each page's operator list: text drawn invisibly (render mode 3 or 7: a
 * scanned PDF's OCR layer, or a hidden payload, so it is kept), in white, at 1 point or less,
 * or placed off the page; and annotations with text (left out).
 */

/** The pdf.js package folder: character maps and standard fonts are read from it. */
export function pdfjsFolder(): string {
  // Resolved like an import (node:module, and so createRequire, is locked away in the child).
  const entry = fileURLToPath(import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
  return dirname(dirname(dirname(entry)));
}

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m × n, PDF's row-vector convention: apply m, then n. */
function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

/** Six finite numbers, from an array or a typed array (pdf.js passes both), or null. */
function matrixOf(value: unknown): Matrix | null {
  if (!Array.isArray(value) && !(ArrayBuffer.isView(value) && !(value instanceof DataView))) {
    return null;
  }
  const numbers = Array.from(value as ArrayLike<unknown>);
  return numbers.length === 6 && numbers.every((v) => typeof v === "number" && Number.isFinite(v))
    ? (numbers as Matrix)
    : null;
}

/** 1 point or less: nobody reads it. */
const TINY_POINTS = 1;

export async function extractPdf(context: ExtractContext): Promise<void> {
  const { limits, sink, signals, metadata, warnings } = context;
  const bytes = await context.input.readAll(limits.maxInputBytes);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const folder = pdfjsFolder() + sep;
  const task = pdfjs.getDocument({
    data: bytes,
    disableFontFace: true,
    useSystemFonts: false,
    useWasm: false,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    maxImageSize: 0,
    enableXfa: false,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    stopAtErrors: false,
    verbosity: 0,
    cMapUrl: join(folder, "cmaps") + sep,
    cMapPacked: true,
    standardFontDataUrl: join(folder, "standard_fonts") + sep,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    await task.destroy();
    if (e instanceof Error && e.name === "PasswordException") {
      throw new ExtractError("encrypted", "password-protected PDF", { cause: e });
    }
    throw new ExtractError("malformed", "not a readable PDF", { cause: e });
  }
  try {
    metadata.pages = doc.numPages;
    const info = await doc
      .getMetadata()
      .then((m) => (m.info ?? {}) as Record<string, unknown>)
      .catch(() => ({}) as Record<string, unknown>);
    const property = (name: string) => (typeof info[name] === "string" ? info[name] : "");
    const title = sampleOf(property("Title"), PROPERTY_CHARS);
    const author = sampleOf(property("Author"), PROPERTY_CHARS);
    if (title !== "") metadata.title = title;
    if (author !== "") metadata.author = author;
    for (const name of ["Subject", "Keywords"]) {
      if (property(name).trim() !== "") {
        signals.add("document-properties", `${name}: ${property(name)}`);
      }
    }

    const pages = Math.min(doc.numPages, limits.maxPages);
    if (doc.numPages > pages) warnings.add("pages-truncated");
    for (let n = 1; n <= pages && !sink.truncated; n++) {
      context.checkMemory();
      try {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        for (const item of content.items) {
          if (!("str" in item)) continue;
          sink.write(item.str);
          if (item.hasEOL) sink.write("\n");
        }
        sink.write("\n\n");
        const operators = await page.getOperatorList();
        pageSignals(context, pdfjs.OPS, operators, page.view as number[]);
        for (const annotation of await page.getAnnotations()) {
          const contents = (annotation as { contentsObj?: { str?: unknown } }).contentsObj?.str;
          if (typeof contents === "string" && contents.trim() !== "") {
            signals.add("annotation", contents);
          }
        }
        page.cleanup();
      } catch (e) {
        if (e instanceof ExtractError) throw e;
        warnings.add("pages-failed");
      }
    }
  } finally {
    await task.destroy();
  }
}

interface OperatorList {
  fnArray: number[];
  argsArray: unknown[];
}

interface GraphicsState {
  ctm: Matrix;
  fontSize: number;
  mode: number;
  fill: string;
}

/**
 * Walks a page's operators with a small model of PDF's graphics and text state (enough to know
 * where each piece of text starts, how large it is, its fill colour and render mode), and
 * records what a reader wouldn't see.
 */
function pageSignals(
  context: ExtractContext,
  OPS: Record<string, number>,
  operators: OperatorList,
  view: number[],
): void {
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = view;
  const stack: GraphicsState[] = [];
  let state: GraphicsState = { ctm: IDENTITY, fontSize: 0, mode: 0, fill: "#000000" };
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let leading = 0;
  const moveText = (tx: number, ty: number) => {
    tlm = multiply([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
  };
  const { fnArray, argsArray } = operators;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = (Array.isArray(argsArray[i]) ? argsArray[i] : []) as unknown[];
    switch (fn) {
      case OPS.save:
        stack.push({ ...state });
        break;
      case OPS.restore:
        state = stack.pop() ?? state;
        break;
      case OPS.transform: {
        const m = matrixOf(args);
        if (m) state.ctm = multiply(m, state.ctm);
        break;
      }
      case OPS.paintFormXObjectBegin: {
        stack.push({ ...state });
        const m = matrixOf(args[0]);
        if (m) state.ctm = multiply(m, state.ctm);
        break;
      }
      case OPS.paintFormXObjectEnd:
        state = stack.pop() ?? state;
        break;
      case OPS.beginText:
        tm = tlm = IDENTITY;
        break;
      case OPS.setFont:
        if (typeof args[1] === "number") state.fontSize = args[1];
        break;
      case OPS.setTextRenderingMode:
        if (typeof args[0] === "number") state.mode = args[0];
        break;
      case OPS.setFillRGBColor:
        if (typeof args[0] === "string") state.fill = args[0].toLowerCase();
        break;
      case OPS.setLeading:
        if (typeof args[0] === "number") leading = args[0];
        break;
      case OPS.moveText:
        if (typeof args[0] === "number" && typeof args[1] === "number") moveText(args[0], args[1]);
        break;
      case OPS.setLeadingMoveText:
        if (typeof args[0] === "number" && typeof args[1] === "number") {
          leading = -args[1];
          moveText(args[0], args[1]);
        }
        break;
      case OPS.nextLine:
        moveText(0, -leading);
        break;
      case OPS.setTextMatrix: {
        const m = matrixOf(args) ?? matrixOf(args[0]);
        if (m) tm = tlm = m;
        break;
      }
      case OPS.showText:
        showText(context, state, multiply(tm, state.ctm), args[0], [x0, y0, x1, y1]);
        break;
    }
  }
}

function showText(
  context: ExtractContext,
  state: GraphicsState,
  m: Matrix,
  glyphs: unknown,
  [x0, y0, x1, y1]: number[],
): void {
  if (!Array.isArray(glyphs)) return;
  let text = "";
  for (const g of glyphs) {
    const unicode = (g as { unicode?: unknown } | null)?.unicode;
    if (typeof unicode === "string" && text.length < 1024) text += unicode;
  }
  if (text.trim() === "") return;
  const { signals } = context;
  const invisible = state.mode % 4 === 3;
  if (invisible) signals.add("invisible-text", text);
  else if (state.fill === "#ffffff") signals.add("white-text", text);
  const size = Math.abs(state.fontSize) * Math.hypot(m[2], m[3]);
  if (size <= TINY_POINTS) signals.add("tiny-text", text);
  const x = m[4];
  const y = m[5];
  const margin = 1;
  const lowX = Math.min(x0 as number, x1 as number);
  const highX = Math.max(x0 as number, x1 as number);
  const lowY = Math.min(y0 as number, y1 as number);
  const highY = Math.max(y0 as number, y1 as number);
  if (x < lowX - margin || x > highX + margin || y < lowY - margin || y > highY + margin) {
    signals.add("off-page-text", text);
  }
}
