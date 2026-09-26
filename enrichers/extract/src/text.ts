import { SAMPLE_CHARS, SIGNAL_KINDS, type Signal, type SignalKind } from "./types.ts";

/*
 * Text as it leaves an extractor: control characters removed (tab and newline stay, other line
 * breaks become newlines), invisible characters removed and counted, well-formed Unicode, and
 * no more UTF-8 than the limit. Everything works a character at a time, without regular
 * expressions, so no input can make it slow.
 */

/**
 * Invisible characters that carry nothing a reader sees and are used to hide or reorder text:
 * zero-width space, word joiner and invisible operators, the BOM, bidirectional embeddings,
 * overrides and isolates ("Trojan Source"), the soft hyphen, Hangul fillers, the Mongolian
 * vowel separator, Unicode tag characters (which spell out ASCII invisibly) and the variation
 * selectors supplement. Kept: zero-width joiner and non-joiner and the directional marks, which
 * real text in many scripts needs.
 */
export function isInvisible(cp: number): boolean {
  return (
    cp === 0x00ad ||
    cp === 0x115f ||
    cp === 0x1160 ||
    cp === 0x180e ||
    cp === 0x200b ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    cp === 0x3164 ||
    cp === 0xfeff ||
    cp === 0xffa0 ||
    (cp >= 0xe0000 && cp <= 0xe007f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

/** Cleans text a piece at a time; a CR at the end of one piece and an LF at the start of the next are one line break. */
export class Sanitizer {
  /** Invisible characters removed so far. */
  invisible = 0;
  private afterCr = false;

  clean(s: string): string {
    const parts: string[] = [];
    let from = 0;
    for (let i = 0; i < s.length; i++) {
      let cp = s.charCodeAt(i);
      let width = 1;
      if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
        const low = s.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          cp = ((cp - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
          width = 2;
        }
      }
      const afterCr = this.afterCr;
      this.afterCr = false;
      let replacement: string | undefined;
      if (cp === 13) {
        replacement = "\n";
        this.afterCr = true;
      } else if (cp === 10) {
        if (afterCr) replacement = "";
      } else if (cp === 11 || cp === 12) {
        replacement = "\n";
      } else if ((cp < 32 && cp !== 9) || (cp >= 0x7f && cp <= 0x9f)) {
        replacement = "";
      } else if (isInvisible(cp)) {
        replacement = "";
        this.invisible++;
      }
      if (replacement !== undefined) {
        parts.push(s.slice(from, i), replacement);
        from = i + width;
      }
      i += width - 1;
    }
    if (from === 0) return s.toWellFormed();
    parts.push(s.slice(from));
    return parts.join("").toWellFormed();
  }
}

/** UTF-8 length of one code point. */
function utf8Length(cp: number): number {
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/** The longest start of `s` that fits in `maxBytes` of UTF-8, never splitting a character. */
export function utf8Prefix(s: string, maxBytes: number): string {
  let bytes = 0;
  let i = 0;
  while (i < s.length) {
    const cp = s.codePointAt(i) as number;
    const n = utf8Length(cp);
    if (bytes + n > maxBytes) break;
    bytes += n;
    i += cp > 0xffff ? 2 : 1;
  }
  return s.slice(0, i);
}

/**
 * Where an extractor writes the text it finds, in order. It keeps at most `maxBytes` of UTF-8;
 * once something had to be left out, `truncated` is set and extractors stop reading.
 */
export class TextSink {
  readonly sanitizer: Sanitizer;
  truncated = false;
  private readonly parts: string[] = [];
  private bytes = 0;
  private readonly maxBytes: number;

  /** `sanitizer`: to count invisible characters together with another sink's. */
  constructor(maxBytes: number, sanitizer: Sanitizer = new Sanitizer()) {
    this.maxBytes = maxBytes;
    this.sanitizer = sanitizer;
  }

  /** Adds text; returns false once the sink has had to leave something out. */
  write(s: string): boolean {
    if (s === "") return !this.truncated;
    const clean = this.sanitizer.clean(s);
    if (clean === "") return !this.truncated;
    if (this.truncated) return false;
    const size = Buffer.byteLength(clean, "utf8");
    if (this.bytes + size <= this.maxBytes) {
      this.parts.push(clean);
      this.bytes += size;
      return true;
    }
    const fit = utf8Prefix(clean, this.maxBytes - this.bytes);
    this.parts.push(fit);
    this.bytes += Buffer.byteLength(fit, "utf8");
    this.truncated = true;
    return false;
  }

  /** The text: runs of blank lines collapsed to one, no whitespace at either end. */
  text(): string {
    return collapseBlankLines(this.parts.join("")).trim();
  }
}

/** Replaces three or more newlines (with only spaces or tabs between) by two. */
function collapseBlankLines(s: string): string {
  const out: string[] = [];
  let from = 0;
  let i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) !== 10) {
      i++;
      continue;
    }
    // A run of newlines and blanks starting here: count its newlines.
    let j = i;
    let newlines = 0;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === 10) newlines++;
      else if (c !== 32 && c !== 9) break;
      j++;
    }
    // A single line break stays as it is, blanks and all.
    if (newlines >= 2) {
      out.push(s.slice(from, i), "\n\n");
      from = j;
    }
    i = j;
  }
  if (from === 0) return s;
  out.push(s.slice(from));
  return out.join("");
}

/** Characters of a title, an author or a sheet name kept. */
export const PROPERTY_CHARS = 256;

/** Collects {@link Signal}s: a count per kind and a sample of the first occurrence. */
export class Signals {
  private readonly seen = new Map<SignalKind, Signal>();

  add(kind: SignalKind, sample?: string, count = 1): void {
    if (count <= 0) return;
    const signal = this.seen.get(kind);
    if (signal) {
      signal.count += count;
      if (signal.sample === undefined && sample !== undefined) {
        const s = sampleOf(sample);
        if (s !== "") signal.sample = s;
      }
      return;
    }
    const next: Signal = { kind, count };
    if (sample !== undefined) {
      const s = sampleOf(sample);
      if (s !== "") next.sample = s;
    }
    this.seen.set(kind, next);
  }

  /** The signals, in the order {@link SIGNAL_KINDS} lists them. */
  list(): Signal[] {
    return SIGNAL_KINDS.flatMap((kind) => {
      const s = this.seen.get(kind);
      return s ? [{ ...s }] : [];
    });
  }
}

/**
 * A short string as signals and metadata keep it: sanitized, whitespace runs as one space, at
 * most `max` characters.
 */
export function sampleOf(s: string, max: number = SAMPLE_CHARS): string {
  const clean = new Sanitizer().clean(s.slice(0, max * 4));
  const words: string[] = [];
  let word = "";
  for (const ch of clean) {
    if (ch === " " || ch === "\n" || ch === "\t") {
      if (word !== "") words.push(word);
      word = "";
    } else {
      word += ch;
    }
  }
  if (word !== "") words.push(word);
  return Array.from(words.join(" ")).slice(0, max).join("");
}
