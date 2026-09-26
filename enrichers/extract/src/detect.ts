import type { ExtractHint, ExtractionKind } from "./types.ts";

/*
 * What a file is. The media type and the name say what the source believes; the first bytes
 * say what it is. The bytes win for the binary formats (a PDF named .docx is read as a PDF,
 * with a `type-mismatch` warning), and text types are only ever read as text when the declared
 * type says so: arbitrary bytes are never guessed to be text.
 */

const OOXML = {
  docx: [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-word.document.macroenabled.12",
  ],
  xlsx: [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel.sheet.macroenabled.12",
  ],
  pptx: [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.ms-powerpoint.presentation.macroenabled.12",
  ],
} as const;

const BY_MIME: ReadonlyMap<string, ExtractionKind> = new Map<string, ExtractionKind>([
  ["text/plain", "text"],
  ["text/markdown", "markdown"],
  ["text/x-markdown", "markdown"],
  ["text/csv", "csv"],
  ["application/csv", "csv"],
  ["text/tab-separated-values", "csv"],
  ["application/pdf", "pdf"],
  ...OOXML.docx.map((m) => [m, "docx"] as const),
  ...OOXML.xlsx.map((m) => [m, "xlsx"] as const),
  ...OOXML.pptx.map((m) => [m, "pptx"] as const),
]);

const BY_EXTENSION: ReadonlyMap<string, ExtractionKind> = new Map<string, ExtractionKind>([
  ["txt", "text"],
  ["text", "text"],
  ["log", "text"],
  ["md", "markdown"],
  ["markdown", "markdown"],
  ["csv", "csv"],
  ["tsv", "csv"],
  ["pdf", "pdf"],
  ["docx", "docx"],
  ["docm", "docx"],
  ["xlsx", "xlsx"],
  ["xlsm", "xlsx"],
  ["pptx", "pptx"],
  ["pptm", "pptx"],
]);

/** Media types that say nothing about the content: only its bytes can tell. */
const UNTYPED = new Set(["application/octet-stream", "binary/octet-stream"]);

/** What the caller's hint says the content is: by media type first, then by extension. */
export function declaredKind(hint: ExtractHint): ExtractionKind | null {
  const mime = essence(hint.mime);
  const byMime = BY_MIME.get(mime);
  if (byMime !== undefined) return byMime;
  const byName = hint.name === undefined ? undefined : BY_EXTENSION.get(extensionOf(hint.name));
  return byName ?? null;
}

/**
 * Whether extraction may have something to find: a declared kind, or no type at all (the bytes
 * may still be a PDF or an Office file). An image, a video or an archive doesn't start a child.
 */
export function mayExtract(hint: ExtractHint): boolean {
  return declaredKind(hint) !== null || UNTYPED.has(essence(hint.mime));
}

/** What the first bytes show: a PDF, a ZIP archive (Office files are), an OLE compound file. */
export type Magic = "pdf" | "zip" | "cfb" | null;

/** Bytes to look at: PDF readers accept the header anywhere in the first KiB. */
export const SNIFF_BYTES = 1024;

export function sniff(head: Uint8Array): Magic {
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return "zip";
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "cfb";
  const pdf = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  for (let i = 0; i + pdf.length <= head.byteLength; i++) {
    if (pdf.every((b, j) => head[i + j] === b)) return "pdf";
  }
  return null;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.byteLength >= prefix.length && prefix.every((b, i) => bytes[i] === b);
}

/** A media type's essence in lower case: `text/csv; charset=utf-8` → `text/csv`. */
function essence(mime: string): string {
  const semi = mime.indexOf(";");
  return (semi === -1 ? mime : mime.slice(0, semi)).trim().toLowerCase();
}

/** The extension of a file name in lower case, or "" (a name with no dot, or a leading dot). */
function extensionOf(name: string): string {
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  const base = name.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** Whether a kind is one of the Office formats (a ZIP of XML parts). */
export function isOoxml(kind: ExtractionKind | null): kind is "docx" | "xlsx" | "pptx" {
  return kind === "docx" || kind === "xlsx" || kind === "pptx";
}

/** Whether a kind is read as text. */
export function isTextual(kind: ExtractionKind | null): kind is "text" | "markdown" | "csv" {
  return kind === "text" || kind === "markdown" || kind === "csv";
}
