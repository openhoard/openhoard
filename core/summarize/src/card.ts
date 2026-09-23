/** The compact thing agents and search results get instead of a file (roughly 100 tokens). */
export interface FileCard {
  id: string;
  title: string;
  tags: string[];
  summary: string;
  owner: string;
  lastTouched: string;
  /** Always an http(s) URL or empty. */
  link: string;
}

export const MAX_SUMMARY_WORDS = 100;

/** Trims to at most `max` words, adding an ellipsis when cut. Collapses whitespace. */
export function clampWords(text: string, max = MAX_SUMMARY_WORDS): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length <= max ? words.join(" ") : `${words.slice(0, max).join(" ")}…`;
}

/**
 * Removes characters that let untrusted text hide or disguise itself (security review #4):
 * - `\p{Cc}` control characters (NUL, BEL, ESC…);
 * - `\p{Cf}` format characters: zero-width spaces/joiners used to hide injected instructions,
 *   and bidi overrides such as U+202E used to disguise names (`invoice‮fdp.exe`).
 * Both are replaced with a space, then whitespace is collapsed.
 */
export function stripUnsafeText(s: string): string {
  return s
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Only http(s) links survive (security review #5). A connector or enricher could otherwise
 * smuggle `javascript:` or `data:` URLs that a UI would render as clickable.
 */
export function safeLink(link: string): string {
  try {
    const url = new URL(link);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

const TAG = /^[a-z][a-z0-9-]*:[^\s:]\S*$/;

/**
 * Builds a card from model or rule output. Everything is treated as untrusted text:
 * hidden/control characters are removed, lengths are capped, tags must look like
 * `facet:value`, and links must be http(s).
 */
export function buildCard(input: FileCard): FileCard {
  const clean = (s: string, max: number) => stripUnsafeText(s).slice(0, max);
  return {
    id: input.id,
    title: clean(input.title, 200),
    tags: [...new Set(input.tags.map((t) => stripUnsafeText(t)).filter((t) => TAG.test(t)))].slice(
      0,
      20,
    ),
    summary: clampWords(clean(input.summary, 2000)),
    owner: clean(input.owner, 200),
    lastTouched: input.lastTouched,
    link: safeLink(input.link),
  };
}
