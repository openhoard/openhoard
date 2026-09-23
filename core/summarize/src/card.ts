/** The compact thing agents and search results get instead of a file (roughly 100 tokens). */
export interface FileCard {
  id: string;
  title: string;
  tags: string[];
  summary: string;
  owner: string;
  lastTouched: string;
  link: string;
}

export const MAX_SUMMARY_WORDS = 100;

/** Trims to at most `max` words, adding an ellipsis when cut. Collapses whitespace. */
export function clampWords(text: string, max = MAX_SUMMARY_WORDS): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length <= max ? words.join(" ") : `${words.slice(0, max).join(" ")}…`;
}

/**
 * Builds a card from model or rule output. Everything is treated as untrusted text:
 * control characters are removed, lengths are capped, and tags must look like `facet:value`.
 */
export function buildCard(input: FileCard): FileCard {
  const clean = (s: string, max: number) =>
    s
      .replace(/\p{Cc}/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  return {
    id: input.id,
    title: clean(input.title, 200),
    tags: [...new Set(input.tags.filter((t) => /^[a-z][a-z0-9-]*:[^\s:][^\s]*$/.test(t)))].slice(
      0,
      20,
    ),
    summary: clampWords(clean(input.summary, 2000)),
    owner: clean(input.owner, 200),
    lastTouched: input.lastTouched,
    link: input.link,
  };
}
