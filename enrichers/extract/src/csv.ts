import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CsvError, parse } from "csv-parse";
import type { ExtractContext } from "./context.ts";
import { decodeText } from "./decode.ts";
import { ExtractError } from "./errors.ts";
import { sampleOf } from "./text.ts";
import type { CsvColumn, CsvType } from "./types.ts";

/*
 * CSV (and TSV): streamed from start to end, so the row count is exact for any size, while
 * memory stays flat: one record at a time, a bounded sample of rows for the column types, and
 * text only up to its limit. One record larger than `maxRecordBytes` (a file with no line
 * breaks, say) fails with `record-too-large` instead of growing without end.
 */

/** Delimiters considered, in the order ties go. */
const DELIMITERS = [",", "\t", ";", "|"] as const;
/** Text looked at to choose the delimiter. */
const SNIFF_CHARS = 64 * 1024;
/** Lines looked at to choose the delimiter. */
const SNIFF_LINES = 20;
/** Characters of a column name kept. */
const NAME_CHARS = 256;

export async function extractCsv(context: ExtractContext, tab: boolean): Promise<void> {
  const { encoding, chunks } = await decodeText(context.input);
  context.metadata.encoding = encoding;
  const { limits, sink, signals, warnings } = context;

  // Look at the start to choose the delimiter, then parse it and the rest.
  const head: string[] = [];
  let headLength = 0;
  let first = await chunks.next();
  while (!first.done) {
    head.push(first.value);
    headLength += first.value.length;
    if (headLength >= SNIFF_CHARS) break;
    first = await chunks.next();
  }
  const delimiter = tab ? "\t" : chooseDelimiter(head.join("").slice(0, SNIFF_CHARS));
  async function* all(): AsyncGenerator<string> {
    yield* head;
    if (!first.done) yield* chunks;
  }

  const columns: Column[] = [];
  let header: boolean | undefined;
  let rows = 0;
  let textOpen = true;
  const record = (cells: string[]) => {
    if (header === undefined) {
      header = looksLikeHeader(cells);
      if (header) {
        cells.forEach((name, i) => {
          if (i < limits.maxColumns) columns.push(newColumn(nameOf(name, i)));
        });
        if (cells.length > limits.maxColumns) warnings.add("columns-truncated");
        textOpen = sink.write(cells.join("\t") + "\n");
        return;
      }
    }
    rows++;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i] as string;
      if (looksLikeFormula(cell)) signals.add("formula", cell);
      if (i >= limits.maxColumns) {
        warnings.add("columns-truncated");
        continue;
      }
      while (columns.length <= i) columns.push(newColumn(nameOf("", columns.length)));
      if (rows <= limits.sampleRows) observe(columns[i] as Column, cell);
    }
    if (textOpen) textOpen = sink.write(cells.join("\t") + "\n");
  };

  const parser = parse({
    delimiter,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    max_record_size: limits.maxRecordBytes,
  });
  try {
    await pipeline(Readable.from(all()), parser, async (records: AsyncIterable<string[]>) => {
      let n = 0;
      for await (const cells of records) {
        record(cells);
        if (++n % 1024 === 0) context.checkMemory();
      }
    });
  } catch (e) {
    if (e instanceof CsvError && e.code === "CSV_MAX_RECORD_SIZE") {
      throw new ExtractError("record-too-large", "a CSV record is over the limit", { cause: e });
    }
    if (e instanceof CsvError) throw new ExtractError("malformed", e.code, { cause: e });
    throw e;
  }

  context.metadata.csv = {
    delimiter,
    header: header === true,
    columns: columns.map((c): CsvColumn => ({ name: c.name, type: typeOf(c) })),
    rows,
  };
}

/**
 * The candidate delimiter whose count per line is most often the same non-zero number over the
 * first lines (quoted text skipped), ties in the order of {@link DELIMITERS}.
 */
export function chooseDelimiter(text: string): string {
  const lines = splitLines(text, SNIFF_LINES);
  let best: string = DELIMITERS[0];
  let bestScore = 0;
  for (const d of DELIMITERS) {
    const counts = lines.map((line) => countOutsideQuotes(line, d));
    const frequency = new Map<number, number>();
    for (const n of counts) if (n > 0) frequency.set(n, (frequency.get(n) ?? 0) + 1);
    const score = Math.max(0, ...frequency.values());
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** The first `max` complete lines of `text` (a last line cut off by the sample is dropped). */
function splitLines(text: string, max: number): string[] {
  const lines: string[] = [];
  let from = 0;
  while (lines.length < max) {
    const nl = text.indexOf("\n", from);
    if (nl === -1) {
      if (lines.length === 0 && from < text.length) lines.push(text.slice(from));
      break;
    }
    lines.push(text.slice(from, nl));
    from = nl + 1;
  }
  return lines;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let quoted = false;
  let n = 0;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === delimiter) n++;
  }
  return n;
}

/** A first row is a header when every cell is a distinct, non-empty word, not a value. */
function looksLikeHeader(cells: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const cell of cells) {
    const v = cell.trim();
    if (v === "" || seen.has(v) || valueType(v) !== "string") return false;
    seen.add(v);
  }
  return cells.length > 0;
}

function nameOf(name: string, i: number): string {
  const clean = sampleOf(name).slice(0, NAME_CHARS);
  return clean === "" ? `column_${i + 1}` : clean;
}

/** A cell a spreadsheet would run as a formula (CSV injection): `=…`, `@…`, `+`/`-` not a number. */
function looksLikeFormula(cell: string): boolean {
  const c = cell.charCodeAt(0);
  if (c === 61 || c === 64) return cell.length > 1; // = @
  if (c === 43 || c === 45) return cell.length > 1 && valueType(cell.trim()) === "string"; // + -
  return false;
}

interface Column {
  name: string;
  seen: Set<CsvType>;
}

function newColumn(name: string): Column {
  return { name, seen: new Set() };
}

function observe(column: Column, cell: string): void {
  const v = cell.trim();
  if (v !== "") column.seen.add(valueType(v));
}

/** One type that fits every value seen: numbers widen to `number`, dates to `datetime`. */
function typeOf(column: Column): CsvType {
  const seen = column.seen;
  if (seen.size === 0) return "empty";
  if (seen.size === 1) return [...seen][0] as CsvType;
  const only = (...types: CsvType[]) => [...seen].every((t) => types.includes(t));
  if (only("integer", "number")) return "number";
  if (only("date", "datetime")) return "datetime";
  return "string";
}

/** What one non-empty, trimmed value looks like. Character checks only: no backtracking. */
export function valueType(v: string): CsvType {
  if (v.length > 64) return "string";
  if (isInteger(v)) return "integer";
  if (isNumber(v)) return "number";
  const lower = v.toLowerCase();
  if (lower === "true" || lower === "false") return "boolean";
  if (isDate(v, 0) && v.length === 10) return "date";
  if (isDateTime(v)) return "datetime";
  return "string";
}

const isDigit = (c: number) => c >= 48 && c <= 57;

function digitsFrom(v: string, at: number): number {
  let i = at;
  while (i < v.length && isDigit(v.charCodeAt(i))) i++;
  return i - at;
}

function isInteger(v: string): boolean {
  const start = v[0] === "+" || v[0] === "-" ? 1 : 0;
  const n = digitsFrom(v, start);
  return n > 0 && start + n === v.length;
}

/** `[+-]digits[.digits][e[+-]digits]`, with a digit before or after the point. */
function isNumber(v: string): boolean {
  let i = v[0] === "+" || v[0] === "-" ? 1 : 0;
  const whole = digitsFrom(v, i);
  i += whole;
  let fraction = 0;
  if (v[i] === ".") {
    fraction = digitsFrom(v, i + 1);
    i += 1 + fraction;
  }
  if (whole + fraction === 0) return false;
  if (v[i] === "e" || v[i] === "E") {
    i++;
    if (v[i] === "+" || v[i] === "-") i++;
    const exponent = digitsFrom(v, i);
    if (exponent === 0) return false;
    i += exponent;
  }
  return i === v.length;
}

/** `YYYY-MM-DD` at `at`, a real calendar date. */
function isDate(v: string, at: number): boolean {
  if (v.length < at + 10 || v[at + 4] !== "-" || v[at + 7] !== "-") return false;
  if (digitsFrom(v, at) !== 4 || digitsFrom(v, at + 5) !== 2 || digitsFrom(v, at + 8) !== 2) {
    return false;
  }
  const y = Number(v.slice(at, at + 4));
  const m = Number(v.slice(at + 5, at + 7));
  const d = Number(v.slice(at + 8, at + 10));
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** A date, `T` or a space, `HH:MM`, and whatever else Date.parse() accepts after that. */
function isDateTime(v: string): boolean {
  if (!isDate(v, 0) || v.length < 16 || (v[10] !== "T" && v[10] !== " ")) return false;
  if (digitsFrom(v, 11) !== 2 || v[13] !== ":" || digitsFrom(v, 14) !== 2) return false;
  return Number.isFinite(Date.parse(v[10] === " " ? `${v.slice(0, 10)}T${v.slice(11)}` : v));
}
