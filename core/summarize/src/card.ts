/**
 * The compact thing agents and search results get instead of a file (roughly 100 tokens).
 *
 * Every text field but `id` comes from untrusted input (file names, model output, connectors),
 * cleaned by buildCard() but never trusted: a client shows it as quoted data, never follows it
 * as instructions (docs/threat-model.md).
 */
export interface FileCard {
  /** The object's id, `obj_` and 26 lower-case Crockford base32 characters. */
  id: string;
  title: string;
  /** `facet:value` slugs, as the catalog writes them. At most {@link MAX_TAGS}. */
  tags: string[];
  /**
   * UNTRUSTED: model output summarizing file content, which an attacker may control. Cleaned of
   * hidden characters and capped, but it can still say anything: render it as quoted text,
   * with its provenance, and never treat it as instructions.
   */
  summary: string;
  owner: string;
  /** An ISO 8601 date or date-time, or empty when unknown. */
  lastTouched: string;
  /** Always an https URL without credentials, or empty. */
  link: string;
}

export const MAX_SUMMARY_WORDS = 100;
export const MAX_TAGS = 20;
/** A facet of up to 64 characters, a colon and a value of up to 128. */
export const MAX_TAG_LENGTH = 193;

/** A structural field (`id`, `lastTouched`) that isn't what the catalog produces. */
export class CardError extends Error {
  constructor(
    readonly field: "id" | "lastTouched",
    message: string,
  ) {
    super(message);
    this.name = "CardError";
  }
}

/** Trims to at most `max` words, adding an ellipsis when cut. Collapses whitespace. */
export function clampWords(text: string, max = MAX_SUMMARY_WORDS): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length <= max ? words.join(" ") : `${words.slice(0, max).join(" ")}…`;
}

/**
 * Removes characters that let untrusted text hide or disguise itself (security review #4):
 * - `\p{Cc}` control characters (NUL, BEL, ESC…);
 * - `\p{Cf}` format characters: zero-width spaces/joiners used to hide injected instructions,
 *   bidi overrides such as U+202E used to disguise names (`invoice‮fdp.exe`), and the Unicode
 *   "tag" block (U+E0000–E007F) used to smuggle invisible ASCII;
 * - `\p{Cs}` lone surrogates: malformed UTF-16 that some databases and JSON consumers reject;
 * - `\p{Co}` private-use characters, which render as whatever a font decides, or not at all;
 * - `\p{Cn}` unassigned code points (and noncharacters), which render as nothing today and may
 *   mean anything later;
 * - invisible characters outside those categories: Hangul fillers (U+115F, U+1160, U+3164,
 *   U+FFA0), the combining grapheme joiner (U+034F), Khmer inherent vowels (U+17B4, U+17B5), the
 *   blank Braille pattern (U+2800) and supplementary variation selectors (U+E0100–E01EF), which
 *   can smuggle bytes invisibly.
 * All are replaced with a space, then whitespace is collapsed. Basic variation selectors
 * (U+FE00–FE0F) choose emoji or text style, so one is kept after a character, but runs of them
 * (another smuggling channel) are cut to one. The result is well-formed UTF-16.
 */
export function stripUnsafeText(s: string): string {
  return s
    .replace(
      // eslint-disable-next-line no-misleading-character-class -- each invisible code point is matched on its own, on purpose
      /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}͏ᅟᅠ឴឵⠀ㅤﾠ\u{e0100}-\u{e01ef}]/gu,
      " ",
    )
    .replace(/[︀-️]+/gu, (run, at: number, all: string) =>
      at === 0 || /\s/.test(all[at - 1] ?? "") ? "" : run.slice(0, 1),
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Only https links without credentials survive (security review #5). A connector or enricher
 * could otherwise smuggle `javascript:` or `data:` URLs that a UI would render as clickable,
 * plain-http ones that leak to the network, or `https://user:pass@host` ones that carry a
 * secret or disguise the host (`https://bank.example@evil.example`).
 */
export function safeLink(link: string): string {
  try {
    const url = new URL(link);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return "";
    return url.href;
  } catch {
    return "";
  }
}

/**
 * Keeps at most `max` code points. Unlike `String#slice`, never cuts a surrogate pair in half,
 * which would turn an emoji at the boundary into a lone surrogate.
 */
export function truncateCodePoints(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = "";
  let n = 0;
  for (const cp of s) {
    if (n++ === max) break;
    out += cp;
  }
  return out;
}

/** The object id format (core/db `idPattern("object")`). */
const OBJECT_ID = /^obj_[0-9a-hjkmnp-tv-z]{26}$/;
/** The catalog's tag format (core/catalog rules.ts): `facet:value` slugs. */
const TAG = /^[a-z][a-z0-9-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/;
const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d))?$/;

/** An ISO 8601 date (`2026-09-24`) or date-time with a zone (`2026-09-24T12:00:00Z`). */
export function isIsoDate(s: string): boolean {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/**
 * Builds a card from model or rule output. Everything is treated as untrusted text:
 * hidden/control characters are removed, lengths are capped, tags must be catalog
 * `facet:value` slugs (at most {@link MAX_TAGS}), and links must be https without credentials.
 * The id and date aren't free text: an id that isn't an object id, or a date that isn't ISO 8601
 * (or empty), throws {@link CardError}.
 */
export function buildCard(input: FileCard): FileCard {
  if (typeof input.id !== "string" || !OBJECT_ID.test(input.id)) {
    throw new CardError("id", "a card's id must be an object id");
  }
  if (
    typeof input.lastTouched !== "string" ||
    (input.lastTouched !== "" && !isIsoDate(input.lastTouched))
  ) {
    throw new CardError("lastTouched", "a card's lastTouched must be an ISO 8601 date or empty");
  }
  const clean = (s: string, max: number) => truncateCodePoints(stripUnsafeText(s), max).trim();
  const tags = input.tags
    // Bounds the work on hostile input: a valid tag is short, even with spaces around it.
    .filter((t) => typeof t === "string" && t.length <= MAX_TAG_LENGTH * 2)
    .map((t) => stripUnsafeText(t))
    .filter((t) => TAG.test(t));
  return {
    id: input.id,
    title: clean(input.title, 200),
    tags: [...new Set(tags)].slice(0, MAX_TAGS),
    summary: clampWords(clean(input.summary, 2000)),
    owner: clean(input.owner, 200),
    lastTouched: input.lastTouched,
    link: safeLink(input.link),
  };
}
