/*
 * What an extraction produces, and the limits it runs under (T-402). The child process that
 * parses a file sends one of these back as JSON; the parent checks every field against the
 * shapes here (schema.ts) before anyone uses it, so nothing a hostile file makes the child say
 * reaches the catalog unchecked.
 */

/** What the content turned out to be, whatever its name or media type said. */
export const EXTRACTION_KINDS = ["text", "markdown", "csv", "docx", "xlsx", "pptx", "pdf"] as const;
export type ExtractionKind = (typeof EXTRACTION_KINDS)[number];

/**
 * Cheap hints that a file carries text a reader wouldn't see, for injection flagging (T-408).
 * Hidden text that can be told apart safely is left out of `text` (a `w:vanish` run, a hidden
 * sheet or slide, an HTML comment in Markdown, invisible characters); the rest stays in, since
 * dropping it would lose real content (a scanned PDF's OCR layer is invisible text).
 */
export const SIGNAL_KINDS = [
  /** Word runs marked hidden (`w:vanish`): left out. */
  "hidden-text",
  /** PDF text drawn in an invisible render mode (3 or 7): kept, since OCR layers use it. */
  "invisible-text",
  /** Text coloured white (Word `FFFFFF`, PDF fill `#ffffff`): kept, the background may be dark. */
  "white-text",
  /** Text at 1 point or smaller: kept. */
  "tiny-text",
  /** PDF text placed outside the page. */
  "off-page-text",
  /** Spreadsheet sheets hidden (`hidden`), or only visible to macros (`veryHidden`): left out. */
  "hidden-sheet",
  "very-hidden-sheet",
  /** Slides marked not to show: left out. */
  "hidden-slide",
  /** Reviewer comments (Word, Excel, PowerPoint): left out. */
  "comment",
  /** PDF annotations with text (sticky notes and the like): left out. */
  "annotation",
  /** Deleted text still in a Word file's tracked changes: left out. */
  "tracked-deletion",
  /** Document properties beyond title and author (subject, keywords, description): left out. */
  "document-properties",
  /** Named formulas or constants in a workbook: left out. */
  "defined-name",
  /** Formulas (spreadsheet cells, or CSV cells starting like one): their values are kept. */
  "formula",
  /** HTML comments in Markdown, which a renderer doesn't show: left out. */
  "html-comment",
  /** Zero-width, bidirectional-override and Unicode tag characters: removed. */
  "invisible-characters",
  /** Files embedded in an Office document: not opened. */
  "embedded-object",
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/** How many times a kind of hidden text was seen, and the start of the first. */
export interface Signal {
  kind: SignalKind;
  count: number;
  /** Up to {@link SAMPLE_CHARS} characters of the first occurrence, sanitized like `text`. */
  sample?: string;
}

/** The most characters a signal's sample keeps. */
export const SAMPLE_CHARS = 200;

/** Things worth knowing about an extraction that still succeeded. */
export const WARNING_CODES = [
  /** The bytes are another type than the name or media type said; extracted as what they are. */
  "type-mismatch",
  /** Not valid UTF-8: decoded as Windows-1252. */
  "legacy-encoding",
  /** A workbook's shared strings went past their limit; later cells may be missing. */
  "strings-truncated",
  /** A CSV had more columns than the schema keeps. */
  "columns-truncated",
  /** Some PDF pages could not be read; the others were. */
  "pages-failed",
  /** A PDF had more pages than are read; the page count is still exact. */
  "pages-truncated",
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

/** Types a CSV column's values are guessed as, from a bounded sample of rows. */
export const CSV_TYPES = [
  "empty",
  "integer",
  "number",
  "boolean",
  "date",
  "datetime",
  "string",
] as const;
export type CsvType = (typeof CSV_TYPES)[number];

export interface CsvColumn {
  name: string;
  type: CsvType;
}

export const SHEET_STATES = ["visible", "hidden", "very-hidden"] as const;
/** Sheets a workbook's metadata lists; a workbook with more is still extracted. */
export const MAX_SHEETS = 1_000;
export type SheetState = (typeof SHEET_STATES)[number];

export const TEXT_ENCODINGS = ["utf-8", "utf-16le", "utf-16be", "windows-1252"] as const;
export type TextEncoding = (typeof TEXT_ENCODINGS)[number];

/**
 * Facts about the file, as far as its kind has them. Title and author come from inside the file
 * (document properties), so they are content like `text`: exposure rules apply to them.
 */
export interface ExtractionMetadata {
  title?: string;
  author?: string;
  /** PDF: the exact page count. */
  pages?: number;
  /** Workbook sheets in order, hidden ones included. */
  sheets?: { name: string; state: SheetState }[];
  /** Presentation: the slide count, hidden slides included. */
  slides?: number;
  /** Text, Markdown and CSV: how the bytes were decoded. */
  encoding?: TextEncoding;
  csv?: {
    delimiter: string;
    /** Whether the first row was taken as column names. */
    header: boolean;
    columns: CsvColumn[];
    /** Data rows, header excluded: exact, counted over the whole file. */
    rows: number;
  };
}

export interface Extraction {
  kind: ExtractionKind;
  /**
   * The visible text, in reading order, sanitized: no control characters but tab and newline,
   * no invisible characters, well-formed Unicode. At most `maxTextBytes` of UTF-8.
   */
  text: string;
  /** Whether `text` stops short of the end: the file had more. */
  truncated: boolean;
  metadata: ExtractionMetadata;
  signals: Signal[];
  warnings: WarningCode[];
}

/**
 * Why an extraction failed. The permanent ones are the file's own: trying it again gives the
 * same answer, so enrichment records it and moves on instead of spending retries.
 */
export const PERMANENT_FAILURES = [
  /** No extractor for what the bytes are. */
  "unsupported",
  /** The bytes don't parse as the type they are. */
  "malformed",
  /** Password-protected or encrypted. */
  "encrypted",
  /** A text type whose bytes are binary. */
  "binary",
  /** Larger than the extractor reads for its type. */
  "too-large",
  /** An archive (Office file) past a limit: entries, sizes or compression ratio (a zip bomb). */
  "archive-limits",
  /** XML with a DOCTYPE (entities), or nested too deep. */
  "xml-limits",
  /** One CSV record larger than the limit (a file without line breaks, say). */
  "record-too-large",
  /** The extractor ran out of time. */
  "timeout",
  /** The extractor ran out of memory. */
  "memory-limit",
  /** The extractor's answer was larger than allowed. */
  "output-too-large",
  /** The extractor process died. */
  "crashed",
  /** The extractor's answer wasn't the expected shape. */
  "protocol",
] as const;
/** Failures of the moment, not of the file: enrichment tries again later. */
export const TRANSIENT_FAILURES = [
  /** The extractor process could not start (out of processes or memory on the host). */
  "spawn-failed",
  /**
   * Reading the content failed: the store or the source was unreachable, stalled, or sent more
   * or fewer bytes than the content's size.
   */
  "input-failed",
  /**
   * The extractor process was killed by a signal the extractor didn't send (the host's
   * out-of-memory killer, say). Try once more; if it happens again, treat it as the file's.
   */
  "killed",
] as const;
export type PermanentFailure = (typeof PERMANENT_FAILURES)[number];
export type TransientFailure = (typeof TRANSIENT_FAILURES)[number];
export type FailureCode = PermanentFailure | TransientFailure;

/** What the extractor measured about its own run. */
export interface ExtractStats {
  /** Bytes of content it read. */
  bytesRead: number;
  /** The child process's largest resident set size seen, in bytes. */
  peakRssBytes: number;
}

export type ExtractResult =
  | { ok: true; extraction: Extraction; stats: ExtractStats }
  | { ok: false; failure: PermanentFailure; permanent: true; stats?: ExtractStats }
  | { ok: false; failure: TransientFailure; permanent: false };

/**
 * The limits one extraction runs under. Every one is enforced in the child process; memory and
 * time are also enforced from outside it (see sandbox.ts).
 */
export interface ExtractLimits {
  /** Wall-clock time before the child is killed. Default: 30 s plus 100 ms per MiB, up to 10 min. */
  timeoutMs: number;
  /** The child's resident memory, in MiB. Default 768. */
  memoryMb: number;
  /** The child's JavaScript heap (V8 old space), in MiB; below `memoryMb`. Default 512. */
  heapMb: number;
  /** Bytes read for types parsed whole (PDF, Office). Text and CSV stream. Default 256 MiB. */
  maxInputBytes: number;
  /** UTF-8 bytes of text kept. Default 1 MiB; at most the catalog's 4 MiB. */
  maxTextBytes: number;
  /** PDF pages read for text; the page count is always exact. Default 5,000. */
  maxPages: number;
  /** Entries in an Office archive. Default 10,000. */
  maxEntries: number;
  /** Uncompressed bytes read from an Office archive, all entries together. Default 512 MiB. */
  maxUncompressedBytes: number;
  /** Uncompressed size / compressed size of an entry over 1 MiB. Default 500. */
  maxCompressionRatio: number;
  /** Nesting of XML elements. Default 256. */
  maxXmlDepth: number;
  /** Characters of a workbook's shared strings kept for its cells. Default 16 Mi. */
  maxSharedStringChars: number;
  /** Bytes in one CSV record. Default 1 MiB. */
  maxRecordBytes: number;
  /** CSV columns described in the schema (the rest are still counted as data). Default 1,000. */
  maxColumns: number;
  /** CSV data rows sampled to guess column types. Default 1,000. */
  sampleRows: number;
}

/** The type the caller believes the content has: its media type and its file name, if any. */
export interface ExtractHint {
  mime: string;
  name?: string;
}
