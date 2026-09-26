import { cleanForMatching, invisibleVariants, mixedScriptWords, skeleton } from "./clean.js";

/*
 * Prompt-injection flagging (T-408): does a file look like it carries instructions meant for an
 * AI rather than for a person? Spike S8 found that sanitising characters stops none of the plain
 * language payloads in the corpus, so the pipeline flags files instead: a flagged file gets the
 * trusted `risk:injection` tag, which makes it metadata-only for AI clients and keeps it from
 * every model (core/jobs injection-flag step).
 *
 * Detection is deliberately simple and explainable: a fixed list of phrase patterns, each with a
 * weight, scored over the file's name, its visible text, and the samples of hidden text the
 * extractor reports (white or tiny text, comments, document properties…). Hidden text carrying
 * an instruction is the strongest sign; plain text needs a strong phrase ("ignore all previous
 * instructions"), or two weaker ones. It is a tripwire, not a classifier: a document that
 * discusses prompt injection is flagged too, and a determined attacker can word around it. That
 * is why summaries are also filtered (output.ts) and clients treat every card as quoted data.
 *
 * Patterns never see raw text: it is cleaned first (clean.ts: invisible characters deleted, HTML
 * entities decoded, NFKC, lower case), and the English patterns run on its skeleton, where
 * Cyrillic, Greek and other look-alike letters are Latin ones ("іgnore" with a Cyrillic "і" is
 * "ignore"). A short list of the common "ignore the previous instructions" phrasings in French,
 * Spanish, German, Portuguese, Italian, Russian, Chinese and Japanese runs on the cleaned text
 * (the skeleton would garble them). No list covers every language or paraphrase: the real
 * defence for what gets through is that clients quote cards as data (T-802).
 *
 * Everything here runs on untrusted input, so the matching is linear-time: every pattern is
 * literals, small alternations and bounded gaps, with no nested or overlapping quantifiers.
 * Inputs are cut at {@link MAX_SCAN_CHARS} as well. Results carry pattern ids, never the matched text, so they
 * can go to logs and job output without repeating the payload.
 */

/**
 * How much of one text is scanned, in UTF-16 units: the extractor's default text cap (1 MiB of
 * UTF-8), and far more than any model is sent (a summary prompt carries its first 24,000
 * characters). Text past it isn't scored.
 */
export const MAX_SCAN_CHARS = 1024 * 1024;

/** A score of this or more flags the file. */
export const FLAG_THRESHOLD = 3;

/** The weights: a strong phrase flags on its own; a weak one needs company. */
const STRONG = 3;
const WEAK = 2;

interface Pattern {
  id: string;
  weight: number;
  re: RegExp;
  /** Matched against the text with its line breaks (the others see them as spaces). */
  lines?: boolean;
  /** Matched against the cleaned text rather than its Latin skeleton (other scripts). */
  script?: boolean;
}

/*
 * Every pattern runs on normalized text: lower case, NFKC, spaces collapsed to one ` ` and line
 * breaks kept as `\n`. `[^.!?\n]{0,N}` is a bounded gap inside one sentence.
 */
const PATTERNS: readonly Pattern[] = [
  {
    // "ignore all previous instructions", "disregard the above prompt", "forget your rules".
    id: "override-instructions",
    weight: STRONG,
    re: /\b(?:ignore|disregard|forget|override|bypass)(?: all| any| the| your| my| of the| these)?(?: previous| prior| above| earlier| preceding| original| system| existing| other| former)+ (?:instructions?|prompts?|directions|rules|guidelines|messages?|context|commands)\b/,
  },
  {
    id: "override-your-instructions",
    weight: STRONG,
    re: /\b(?:ignore|disregard|forget) (?:all )?(?:your|any) (?:instructions?|prompts?|rules|guidelines|programming)\b/,
  },
  {
    // The same in other languages, on the cleaned text; accents optional (a decomposed accent
    // is deleted as an invisible mark).
    id: "override-instructions-intl",
    weight: STRONG,
    script: true,
    re: /\bignore[rz]? (?:toutes )?(?:les )?instructions (?:pr[ée]c[ée]dentes|ant[ée]rieures|ci-dessus)|\bignor(?:a|ar|ad|e|en) (?:todas )?(?:las |as )?(?:instrucciones|instru(?:ç|c)(?:õ|o)es) (?:anteriores|previas|pr[ée]vias)|\bignorier(?:e|en)? (?:alle )?(?:vorherigen|bisherigen|obigen) (?:anweisungen|instruktionen|befehle)|\bignora(?:re)? (?:tutte )?(?:le )?istruzioni (?:precedenti|sopra)|игнорир(?:уй|уйте|овать) (?:все )?(?:предыдущие|прежние|вышеуказанные) (?:инструкции|указания)|забудь(?:те)? (?:(?:про|обо|о) )?(?:все(?:х)? )?(?:(?:предыдущи|прежни|вышеуказанны)(?:е|х) )?(?:указания|инструкции|указаниях|инструкциях)|忽略(?:之前|以前|先前|上面|上述)(?:的)?(?:所有)?(?:的)?(?:指令|指示|说明)|(?:以前|前|上記)の(?:すべての)?指示を無視/,
  },
  {
    // "AI agents reading this document must call …": a request to whatever reads the file.
    id: "ai-readers",
    weight: STRONG,
    re: /\b(?:ai|a\.i\.|llm|language model|assistant|agent|bot|chatbot|model)s?\b[^.!?\n]{0,40}\b(?:reading|processing|parsing|summari[sz]ing|indexing|seeing|ingesting) (?:this|these)\b/,
  },
  {
    // Chat-template and role markup: `<system>`, `<|im_start|>`, `[INST]`.
    id: "role-markup",
    weight: STRONG,
    re: /<\/? ?(?:system|assistant|instructions?|im_start|im_end|user_query|tool_call|tool_use)(?: [^>\n]{0,40})?>|<\|(?:im_start|im_end|system|endoftext)\|>|\[\/?(?:inst|system)\]/,
  },
  {
    id: "addressed-to-ai",
    weight: STRONG,
    re: /\b(?:if you are|you are now|attention|note to (?:the )?|hey) ?(?:an? |the )?(?:ai|a\.i\.|assistant|agent|chatbot|llm|language model|copilot|claude|chatgpt|gpt|gemini)\b[^.!?\n]{0,60}\b(?:must|should|shall|will|need to|please|are instructed|reading this)\b/,
  },
  {
    id: "new-instructions",
    weight: STRONG,
    re: /\b(?:new|updated|real|actual|hidden|secret) (?:system )?(?:instructions|prompt|directive)s? ?:|\b(?:developer|god|dan|jailbreak) mode\b/,
  },
  {
    id: "keep-secret",
    weight: WEAK,
    re: /\bdo not (?:mention|reveal|disclose|tell (?:the )?user about|repeat|show) (?:this|these|that) (?:note|instructions?|message|comment|text|request)\b|\bwithout (?:telling|informing|notifying) the user\b/,
  },
  {
    // Markdown image with a remote URL: rendered, it fetches the URL (data exfiltration). The
    // alt text stops at the next "[" too, so "![![![…" costs one step per opener.
    id: "markdown-image-link",
    weight: STRONG,
    re: /!\[[^[\]\n]{0,200}\]\( ?(?:https?:|\/\/)/,
  },
  {
    id: "tool-call",
    weight: STRONG,
    re: /"(?:tool|tool_name|function_call|tool_calls|recipient)" ?: ?[{"[]|\bfunctions\.[a-z_]{1,40}\(|<(?:function_calls|invoke)\b/,
  },
  {
    id: "decode-and-follow",
    weight: STRONG,
    re: /\b(?:decode|base64[- ]decode|decrypt|unscramble|reverse) (?:and|then) (?:follow|execute|run|obey|apply)\b/,
  },
  {
    // A role label at the start of a line: fake chat transcripts.
    id: "role-line",
    weight: WEAK,
    lines: true,
    re: /(?:^|\n) ?(?:system|assistant|ai|chatbot)(?: message)? ?:/,
  },
  {
    // "share … with x@y", "send … to https://…".
    id: "send-out",
    weight: WEAK,
    re: /\b(?:share|send|forward|upload|email|e-mail|post|exfiltrate|transmit|leak)\b[^.!?\n]{0,80}\b(?:to|with) (?:https?:|www\.|[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}\.)/,
  },
  {
    id: "destroy",
    weight: WEAK,
    re: /\b(?:delete|remove|erase|wipe|purge|empty|destroy)(?: all| every| the| any| these| this| my| your)?(?: [a-z]{1,20})? (?:drafts?|files?|folders?|documents?|recycle bin|trash|emails?|records|backups?|data)\b/,
  },
  {
    id: "loosen-levels",
    weight: WEAK,
    re: /\b(?:set|change|make|mark|tag|switch|update|reclassify)\b[^.!?\n]{0,40}\b(?:sensitivity|visibility|exposure|classification|permissions?)\b[^.!?\n]{0,40}\b(?:public|readable|full|discoverable|unrestricted|everyone)\b/,
  },
  {
    id: "quote-elsewhere",
    weight: WEAK,
    re: /\b(?:quote|include|paste|reveal|list)\b[^.!?\n]{0,60}\bin your (?:answer|response|reply|summary|output)\b/,
  },
  {
    // Spreadsheet formula and DDE payloads.
    id: "formula-payload",
    weight: WEAK,
    re: /(?:^|[\t ,;"])[=+@-] ?(?:hyperlink|webservice|importxml|importdata|image)\(|\bcmd ?\|/,
  },
];

const BY_ID = new Map(PATTERNS.map((p) => [p.id, p]));

/** Hidden-text signals (the extractor's SIGNAL_KINDS) that hide text from a person. */
const HIDING = new Set([
  "hidden-text",
  "invisible-text",
  "white-text",
  "tiny-text",
  "off-page-text",
  "hidden-sheet",
  "very-hidden-sheet",
  "hidden-slide",
  "comment",
  "annotation",
  "tracked-deletion",
  "document-properties",
  "defined-name",
  "html-comment",
  "invisible-characters",
  "formula",
]);

/**
 * Signals worth a point on their own: hidden text a person would not normally see. Comments,
 * document properties, formulas and invisible characters are too common in ordinary files to
 * count without an instruction in them.
 */
const SUSPICIOUS_ALONE = new Set([
  "hidden-text",
  "invisible-text",
  "white-text",
  "tiny-text",
  "off-page-text",
  "hidden-sheet",
  "hidden-slide",
  "html-comment",
]);

/**
 * Characters that flag a file name: C0 and C1 controls, the zero-width space, word joiner and
 * invisible operators (U+200B, U+2060 to U+2064, U+FEFF), bidi embeddings and overrides (U+202A
 * to U+202E), bidi isolates (U+2066 to U+2069) and Unicode tag characters. Not the zero-width
 * joiner and non-joiner (emoji, Indic and Persian names), left-to-right and right-to-left marks
 * (names in Hebrew or Arabic on Windows and macOS) or soft hyphens.
 */
const NAME_CONTROL =
  /[\p{Cc}\u200b\u2060-\u2064\ufeff\u202a-\u202e\u2066-\u2069\u{e0000}-\u{e007f}]/u;

/** Patterns a file name may match without counting more than in text. */
const NAME_PLAIN = new Set(["destroy", "send-out", "quote-elsewhere"]);

/** A sheet only macros can show: nobody makes one by accident. Flags on its own. */
const FLAGS_ALONE = new Set(["very-hidden-sheet"]);

/** Where a finding was made. Never the text itself. */
export type FindingSource = "name" | "text" | "hidden" | "metadata" | "decoded" | "reversed";

export interface InjectionFinding {
  /** A pattern id (`override-instructions`…), a signal kind, or a name check (`name-control`). */
  id: string;
  source: FindingSource;
  weight: number;
}

export interface InjectionVerdict {
  flagged: boolean;
  score: number;
  /** What counted, each id once per source, strongest first. Safe to log. */
  findings: InjectionFinding[];
}

/** What the detector looks at: all of it untrusted. */
export interface InjectionInput {
  /** The file's name (the object's title). */
  name?: string;
  /** The visible text the extractor kept. */
  text?: string;
  /** The extractor's hidden-text signals (`{ kind, count, sample? }`), as stored. */
  signals?: readonly unknown[];
  /** Metadata from inside the file (title, author, sheet names), as stored. */
  metadata?: Record<string, unknown>;
}

/**
 * Text as the patterns see it (clean.ts): cut to `max` characters, invisible characters
 * deleted, HTML entities decoded, NFKC, lower case, spaces collapsed, line breaks kept.
 */
export function normalizeForMatching(s: string, max = MAX_SCAN_CHARS): string {
  return cleanForMatching(s, max);
}

/**
 * The patterns that match cleaned text. English ones run on its skeleton (look-alike letters
 * folded to Latin), the other-script ones on the cleaned text itself. Phrases see line breaks
 * as spaces (a wrapped line doesn't break "ignore all previous / instructions"); the line-start
 * ones (`role-line`) see them.
 */
function matchPatterns(cleaned: string, skel = skeleton(cleaned)): Pattern[] {
  const flat = { skel: skel.replaceAll("\n", " "), cleaned: cleaned.replaceAll("\n", " ") };
  return PATTERNS.filter((p) =>
    p.re.test(p.lines === true ? (p.script ? cleaned : skel) : p.script ? flat.cleaned : flat.skel),
  );
}

/**
 * Ids of the phrase patterns found in a text, for output filtering: cleaned with invisible
 * characters deleted and, again, with them as spaces (what storage makes of them).
 */
export function instructionPatterns(text: string): string[] {
  const ids = new Set<string>();
  for (const invisibleAs of invisibleVariants(text)) {
    for (const p of matchPatterns(cleanForMatching(text, MAX_SCAN_CHARS, invisibleAs)))
      ids.add(p.id);
  }
  return [...ids];
}

/** Runs of base64 long enough to hide a sentence; at most this many are decoded. */
const MAX_BASE64_RUNS = 32;
const MAX_BASE64_RUN = 64 * 1024;

/**
 * Text hidden in base64 runs (at least 40 characters), decoded as UTF-8 where it decodes to
 * mostly printable text. Bounded: at most {@link MAX_BASE64_RUNS} runs of at most 64 KiB each.
 */
function decodedBase64(text: string): string[] {
  const out: string[] = [];
  // One character class, one quantifier: linear.
  const run = /[A-Za-z0-9+/]{40,}/g;
  let m: RegExpExecArray | null;
  while ((m = run.exec(text)) !== null && out.length < MAX_BASE64_RUNS) {
    const chunk = m[0].slice(0, MAX_BASE64_RUN);
    const decoded = Buffer.from(chunk.slice(0, chunk.length - (chunk.length % 4)), "base64")
      .toString("utf8")
      .replace(/\p{C}/gu, " ");
    const printable = decoded.replace(/[^\p{L}\p{N}\p{P} ]/gu, "").length;
    if (decoded.length > 0 && printable / decoded.length > 0.9) out.push(decoded);
  }
  return out;
}

/** Signals as stored: plain JSON, so every field is checked before use. */
function readSignals(signals: readonly unknown[]): { kind: string; sample: string }[] {
  const out: { kind: string; sample: string }[] = [];
  for (const s of signals.slice(0, 256)) {
    if (typeof s !== "object" || s === null) continue;
    const { kind, sample } = s as { kind?: unknown; sample?: unknown };
    if (typeof kind !== "string") continue;
    out.push({ kind, sample: typeof sample === "string" ? sample.slice(0, 4096) : "" });
  }
  return out;
}

/** Strings from inside the file that a person rarely reads: title, author, sheet names. */
function metadataStrings(metadata: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["title", "author", "subject", "keywords", "description"]) {
    const v = metadata[key];
    if (typeof v === "string") out.push(v.slice(0, 4096));
  }
  const sheets = metadata.sheets;
  if (Array.isArray(sheets)) {
    for (const s of sheets.slice(0, 1_000)) {
      const name = (s as { name?: unknown } | null)?.name;
      if (typeof name === "string") out.push(name.slice(0, 256));
    }
  }
  return out;
}

/**
 * Scores a file for prompt injection. See the header: flagged at {@link FLAG_THRESHOLD}.
 *
 * - Every phrase pattern counts once per file, at its weight, wherever it is found; found in a
 *   hidden-text sample, the name, or metadata (places a person doesn't read as prose), it
 *   counts one more.
 * - Hidden-text signals count one point on their own (once for all of them), except a very
 *   hidden sheet, which flags alone.
 * - The name also flags on control or format characters (a line break, a right-to-left
 *   override, zero-width characters) and on path traversal (`../`).
 * - Base64 runs are decoded, and the text is also scanned reversed, for the override phrases.
 */
export function detectInjection(input: InjectionInput): InjectionVerdict {
  const found = new Map<string, InjectionFinding>();
  const add = (id: string, source: FindingSource, weight: number) => {
    const key = `${id}@${source}`;
    const had = found.get(key);
    if (!had || had.weight < weight) found.set(key, { id, source, weight });
  };
  /** The score so far: each id once, at its heaviest. */
  const total = () => {
    const best = new Map<string, number>();
    for (const f of found.values()) best.set(f.id, Math.max(best.get(f.id) ?? 0, f.weight));
    let n = 0;
    for (const w of best.values()) n += w;
    return n;
  };
  const flagged = () => total() >= FLAG_THRESHOLD;
  /**
   * Scores one text, cleaned once per variant (invisible characters deleted, then as spaces,
   * the second only when the text has any), each variant's skeleton made once and shared by
   * every pattern. Returns the first variant's skeleton, for the reversed scan.
   */
  const scan = (text: string, source: FindingSource, bonus: number): string => {
    if (text === "") return "";
    let first: string | undefined;
    for (const invisibleAs of invisibleVariants(text)) {
      const cleaned = cleanForMatching(text, MAX_SCAN_CHARS, invisibleAs);
      const skel = skeleton(cleaned);
      first ??= skel;
      for (const p of matchPatterns(cleaned, skel)) {
        // "Delete old files" is a fine name for a file: only in hidden text does it count more.
        const extra = source === "name" && NAME_PLAIN.has(p.id) ? 0 : bonus;
        add(p.id, source, p.weight + extra);
      }
      // Words mixing Latin with another script's letters: look-alike spoofing, whatever the
      // script. One is suspicious; several are what a spoofed sentence looks like.
      const mixed = mixedScriptWords(cleaned);
      if (mixed > 0) add("mixed-script", source, (mixed >= 2 ? STRONG : WEAK) + bonus);
    }
    return first ?? "";
  };

  const name = typeof input.name === "string" ? input.name.slice(0, 4096) : "";
  if (name !== "") {
    // Control characters (a line break), bidi overrides and isolates, and tag characters: no
    // honest file name needs them. Joiners in emoji, marks for right-to-left names and soft
    // hyphens are ordinary, and pass.
    if (NAME_CONTROL.test(name)) add("name-control", "name", STRONG);
    if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(name)) add("name-traversal", "name", STRONG);
    scan(name, "name", 1);
  }

  // Once flagged, the rest can't unflag it: later scans are skipped (the findings then list
  // what flagged it, not everything there is).
  const text = typeof input.text === "string" ? input.text : "";
  const textSkeleton = flagged() ? "" : scan(text, "text", 0);
  if (textSkeleton !== "" && !flagged()) {
    const scanned = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
    for (const decoded of decodedBase64(scanned)) {
      scan(decoded, "decoded", 0);
      if (flagged()) break;
    }
  }
  if (textSkeleton !== "" && !flagged()) {
    // Text stored reversed inside a right-to-left override reads normally on screen.
    let reversed = "";
    for (let i = textSkeleton.length - 1; i >= 0; i--) reversed += textSkeleton[i];
    for (const id of ["override-instructions", "override-your-instructions"]) {
      const p = BY_ID.get(id);
      if (p?.re.test(reversed)) add(id, "reversed", p.weight);
    }
  }

  let hiddenAlone = false;
  for (const { kind, sample } of readSignals(input.signals ?? [])) {
    if (flagged()) break;
    if (!HIDING.has(kind)) continue;
    if (FLAGS_ALONE.has(kind)) add(kind, "hidden", STRONG);
    if (SUSPICIOUS_ALONE.has(kind)) hiddenAlone = true;
    // A formula's text is visible in its cell (only its source is not): no extra weight.
    scan(sample, "hidden", kind === "formula" ? 0 : 1);
  }
  if (hiddenAlone) add("hidden-text-present", "hidden", 1);

  for (const s of metadataStrings(input.metadata ?? {})) {
    if (flagged()) break;
    scan(s, "metadata", 1);
  }

  // Each pattern once per file, where it weighs most.
  const best = new Map<string, InjectionFinding>();
  for (const f of found.values()) {
    const had = best.get(f.id);
    if (!had || had.weight < f.weight) best.set(f.id, f);
  }
  const findings = [...best.values()].sort(
    (a, b) => b.weight - a.weight || a.id.localeCompare(b.id),
  );
  const score = findings.reduce((n, f) => n + f.weight, 0);
  return { flagged: score >= FLAG_THRESHOLD, score, findings };
}
