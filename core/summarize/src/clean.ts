/*
 * Text as a pattern should see it (T-405, T-408). Untrusted text hides words from patterns in
 * ways a person reading it never notices: a zero-width space inside a word, an HTML entity, a
 * fullwidth letter, a Cyrillic "і" in "іgnore". Every check in injection.ts and output.ts runs on
 * text cleaned here first, in this order:
 *
 * 1. cut to a bound;
 * 2. delete invisible characters (format characters such as zero-width spaces and joiners,
 *    bidi controls, soft hyphens, variation selectors, tag characters, invisible fillers), so a
 *    word split by one is whole again; control characters other than line breaks become spaces;
 * 3. decode HTML character references (`&lt;`, `&#47;`, `&#x2f;`), once, bounded;
 * 4. NFKC (fullwidth and other compatibility forms fold: `ｈｔｔｐｓ：／／` is `https://`), then
 *    lower case, then spaces collapsed (line breaks kept);
 * 5. for the skeleton: letters that look like Latin ones become them (see CONFUSABLES).
 *
 * The confusables table is a compact subset of Unicode's UTS #39 confusables (Cyrillic, Greek,
 * Armenian and a few Latin extensions that pass for basic Latin letters in lower case), written
 * here by hand rather than taken from the data file: the full table maps whole strings and many
 * scripts, and patterns only need the letters of English words. It is not complete; that is why
 * the summary filter also drops links, markup and sentences addressed to an AI, and why clients
 * treat every card as quoted data (T-802).
 *
 * All linear: one pass each, no backtracking patterns.
 */

/** Invisible characters deleted outright (not replaced with a space: they split words). */
const INVISIBLE =
  // eslint-disable-next-line no-misleading-character-class -- each invisible code point is matched on its own, on purpose
  /[\p{Cf}\p{Mn}\u034f\u115f\u1160\u17b4\u17b5\u2800\u3164\uffa0\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;
/** Control characters other than line breaks: a space (so "a\tb" stays two words). */
const CONTROL = /\p{Cc}/gu;

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  sol: "/",
  colon: ":",
  period: ".",
  commat: "@",
  lpar: "(",
  rpar: ")",
  lsqb: "[",
  rsqb: "]",
  excl: "!",
};

/** HTML character references, decoded once. Bounded alternatives: linear. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});?/gi, (whole, e: string) => {
    if (e[0] !== "#") return NAMED[e.toLowerCase()] ?? whole;
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code)
      : " ";
  });
}

/** Steps 1 to 4: text as a person would read it, in lower case. */
export function cleanForMatching(s: string, max: number): string {
  const cut = s.length > max ? s.slice(0, max) : s;
  return decodeEntities(cut.replace(INVISIBLE, "").replace(CONTROL, (c) => (c === "\n" ? c : " ")))
    .replace(INVISIBLE, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n\s*/g, "\n");
}

/**
 * Lower-case look-alikes of basic Latin letters, by code point. Cyrillic, Greek, Armenian,
 * Cherokee-free (Cherokee has no lower-case forms that fold here), and Latin extensions.
 */
const CONFUSABLES: ReadonlyMap<number, string> = new Map<number, string>([
  // Cyrillic
  [0x0430, "a"],
  [0x0431, "b"],
  [0x0432, "b"],
  [0x0433, "r"],
  [0x0435, "e"],
  [0x0450, "e"],
  [0x0451, "e"],
  [0x0455, "s"],
  [0x0456, "i"],
  [0x0457, "i"],
  [0x0458, "j"],
  [0x043a, "k"],
  [0x043c, "m"],
  [0x043d, "h"],
  [0x043e, "o"],
  [0x043f, "n"],
  [0x0440, "p"],
  [0x0441, "c"],
  [0x0442, "t"],
  [0x0443, "y"],
  [0x0445, "x"],
  [0x044c, "b"],
  [0x0461, "w"],
  [0x048f, "p"],
  [0x04bb, "h"],
  [0x04c0, "l"],
  [0x04cf, "l"],
  [0x0501, "d"],
  [0x051b, "q"],
  [0x051d, "w"],
  // Greek
  [0x03b1, "a"],
  [0x03b2, "b"],
  [0x03b3, "y"],
  [0x03b5, "e"],
  [0x03b7, "n"],
  [0x03b9, "i"],
  [0x03ba, "k"],
  [0x03bd, "v"],
  [0x03bf, "o"],
  [0x03c1, "p"],
  [0x03c3, "o"],
  [0x03c4, "t"],
  [0x03c5, "u"],
  [0x03c7, "x"],
  [0x03c9, "w"],
  [0x03f2, "c"],
  [0x03f3, "j"],
  // Armenian
  [0x0561, "w"],
  [0x0563, "q"],
  [0x0566, "q"],
  [0x0570, "h"],
  [0x0575, "j"],
  [0x0578, "n"],
  [0x057c, "n"],
  [0x057d, "u"],
  [0x0585, "o"],
  // Latin extensions and IPA
  [0x0131, "i"],
  [0x0237, "j"],
  [0x0251, "a"],
  [0x0261, "g"],
  [0x0269, "i"],
  [0x026a, "i"],
  [0x028f, "y"],
  [0x1d00, "a"],
  [0x1d04, "c"],
  [0x1d05, "d"],
  [0x1d07, "e"],
  [0x1d0a, "j"],
  [0x1d0b, "k"],
  [0x1d0d, "m"],
  [0x1d0f, "o"],
  [0x1d18, "p"],
  [0x1d1b, "t"],
  [0x1d1c, "u"],
  [0x1d20, "v"],
  [0x1d21, "w"],
  [0x1d22, "z"],
  [0x0280, "r"],
  [0x0299, "b"],
  [0x029c, "h"],
  [0x029f, "l"],
]);

/** Step 5: the cleaned text with look-alike letters folded to Latin. */
export function skeleton(cleaned: string): string {
  let out = "";
  for (const ch of cleaned) {
    const cp = ch.codePointAt(0) ?? 0;
    out += cp < 0x0100 ? ch : (CONFUSABLES.get(cp) ?? ch);
  }
  return out;
}
