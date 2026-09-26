import { Sanitizer } from "./text.ts";
import {
  CSV_TYPES,
  EXTRACTION_KINDS,
  MAX_SHEETS,
  PERMANENT_FAILURES,
  SAMPLE_CHARS,
  SHEET_STATES,
  SIGNAL_KINDS,
  TEXT_ENCODINGS,
  WARNING_CODES,
  type Extraction,
  type ExtractLimits,
  type ExtractStats,
  type PermanentFailure,
} from "./types.ts";

/*
 * The parent's check of what the child answered. The child parsed a hostile file, so its
 * answer is treated as hostile too: every key must be known, every value of the right type,
 * within its limit, and every string exactly as the sanitizer leaves it. Anything else is
 * `protocol`, and nothing of it is used.
 */

/** Characters of a title, author, sheet or column name. */
const NAME_CHARS = 256;

export type ChildAnswer =
  | { ok: true; extraction: Extraction; stats: ExtractStats }
  | { ok: false; failure: PermanentFailure; stats: ExtractStats };

/** The child's answer if it is exactly what the protocol allows, else null. */
export function parseAnswer(line: string, limits: ExtractLimits): ChildAnswer | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  try {
    return answer(value, limits);
  } catch (e) {
    if (e instanceof Invalid) return null;
    throw e;
  }
}

class Invalid extends Error {}

function check(condition: boolean): asserts condition {
  if (!condition) throw new Invalid();
}

type Obj = Record<string, unknown>;

/** An object with exactly the required keys, and any of the optional ones. */
function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Obj {
  check(typeof value === "object" && value !== null && !Array.isArray(value));
  const o = value as Obj;
  const keys = Object.keys(o);
  check(required.every((k) => Object.hasOwn(o, k)));
  check(keys.every((k) => required.includes(k) || optional.includes(k)));
  return o;
}

function count(value: unknown): number {
  check(typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  return value as number;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T {
  check(typeof value === "string" && (values as readonly string[]).includes(value));
  return value as T;
}

/** A string as the child's sanitizer leaves it, at most `maxChars` characters (code points). */
function clean(value: unknown, maxChars: number, allowBreaks = false): string {
  check(typeof value === "string");
  const s = value as string;
  check(s.length <= maxChars * 2 && [...s].length <= maxChars);
  check(new Sanitizer().clean(s) === s);
  if (!allowBreaks) check(!s.includes("\n") && !s.includes("\t"));
  return s;
}

function answer(value: unknown, limits: ExtractLimits): ChildAnswer {
  const top = object(value, ["v", "ok", "stats"], ["extraction", "failure"]);
  check(top.v === 1);
  const s = object(top.stats, ["bytesRead", "peakRssBytes"]);
  const stats: ExtractStats = {
    bytesRead: count(s.bytesRead),
    peakRssBytes: count(s.peakRssBytes),
  };
  if (top.ok === true) {
    check(top.extraction !== undefined && top.failure === undefined);
    return { ok: true, extraction: extraction(top.extraction, limits), stats };
  }
  check(top.ok === false && top.failure !== undefined && top.extraction === undefined);
  return { ok: false, failure: oneOf(PERMANENT_FAILURES, top.failure), stats };
}

function extraction(value: unknown, limits: ExtractLimits): Extraction {
  const e = object(value, ["kind", "text", "truncated", "metadata", "signals", "warnings"]);
  check(typeof e.text === "string" && typeof e.truncated === "boolean");
  const text = e.text as string;
  check(Buffer.byteLength(text, "utf8") <= limits.maxTextBytes);
  check(new Sanitizer().clean(text) === text);
  check(Array.isArray(e.signals) && Array.isArray(e.warnings));
  const signals = (e.signals as unknown[]).map((raw) => {
    const s = object(raw, ["kind", "count"], ["sample"]);
    const signal: Extraction["signals"][number] = {
      kind: oneOf(SIGNAL_KINDS, s.kind),
      count: count(s.count),
    };
    check(signal.count > 0);
    if (s.sample !== undefined) signal.sample = clean(s.sample, SAMPLE_CHARS);
    return signal;
  });
  check(new Set(signals.map((s) => s.kind)).size === signals.length);
  const warnings = (e.warnings as unknown[]).map((w) => oneOf(WARNING_CODES, w));
  check(new Set(warnings).size === warnings.length);
  return {
    kind: oneOf(EXTRACTION_KINDS, e.kind),
    text,
    truncated: e.truncated as boolean,
    metadata: metadata(e.metadata, limits),
    signals,
    warnings,
  };
}

function metadata(value: unknown, limits: ExtractLimits): Extraction["metadata"] {
  const m = object(value, [], ["title", "author", "pages", "sheets", "slides", "encoding", "csv"]);
  const out: Extraction["metadata"] = {};
  if (m.title !== undefined) out.title = clean(m.title, NAME_CHARS);
  if (m.author !== undefined) out.author = clean(m.author, NAME_CHARS);
  if (m.pages !== undefined) out.pages = count(m.pages);
  if (m.slides !== undefined) out.slides = count(m.slides);
  if (m.encoding !== undefined) out.encoding = oneOf(TEXT_ENCODINGS, m.encoding);
  if (m.sheets !== undefined) {
    check(Array.isArray(m.sheets) && (m.sheets as unknown[]).length <= MAX_SHEETS);
    out.sheets = (m.sheets as unknown[]).map((raw) => {
      const s = object(raw, ["name", "state"]);
      return { name: clean(s.name, NAME_CHARS), state: oneOf(SHEET_STATES, s.state) };
    });
  }
  if (m.csv !== undefined) {
    const c = object(m.csv, ["delimiter", "header", "columns", "rows"]);
    check(typeof c.header === "boolean" && Array.isArray(c.columns));
    check((c.columns as unknown[]).length <= limits.maxColumns);
    out.csv = {
      delimiter: oneOf([",", "\t", ";", "|"], c.delimiter),
      header: c.header as boolean,
      columns: (c.columns as unknown[]).map((raw) => {
        const col = object(raw, ["name", "type"]);
        return { name: clean(col.name, NAME_CHARS), type: oneOf(CSV_TYPES, col.type) };
      }),
      rows: count(c.rows),
    };
  }
  return out;
}

/**
 * The most bytes a valid answer can take, so the parent can stop reading a child that talks
 * too much: JSON escaping at most doubles text (quotes and backslashes), plus metadata.
 */
export function maxAnswerBytes(limits: ExtractLimits): number {
  return (
    2 * limits.maxTextBytes + 2 * NAME_CHARS * 4 * (limits.maxColumns + MAX_SHEETS) + 1024 * 1024
  );
}
