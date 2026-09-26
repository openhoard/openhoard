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
 * Everything here runs on untrusted input, so the matching is linear-time: the text is first
 * normalized (NFKC, lower case, one space for any run of spaces), and every pattern is literals,
 * small alternations and bounded gaps, with no nested or overlapping quantifiers. Inputs are cut
 * at {@link MAX_SCAN_CHARS} as well. Results carry pattern ids, never the matched text, so they
 * can go to logs and job output without repeating the payload.
 */

/** How much of one text is scanned, in UTF-16 units: well above the extractor's 1 MiB default. */
export const MAX_SCAN_CHARS = 4 * 1024 * 1024;

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
    // Markdown image with a remote URL: rendered, it fetches the URL (data exfiltration).
    id: "markdown-image-link",
    weight: STRONG,
    re: /!\[[^\]\n]{0,200}\]\( ?(?:https?:|\/\/)/,
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
 * Normalizes text for matching: cut to `max` characters, NFKC (fullwidth and other compatibility
 * forms fold to plain letters), lower case, runs of spaces and tabs to one space, runs of line
 * breaks to one `\n`. Linear in the input.
 */
export function normalizeForMatching(s: string, max = MAX_SCAN_CHARS): string {
  const cut = s.length > max ? s.slice(0, max) : s;
  return cut
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n[\s]*/g, "\n");
}

/**
 * The patterns that match normalized text. Phrases run on the text with line breaks as spaces
 * (a wrapped line doesn't break "ignore all previous / instructions"); the line-start ones
 * (`role-line`) on the text with its line breaks.
 */
function matchPatterns(normalized: string): Pattern[] {
  const flat = normalized.replaceAll("\n", " ");
  return PATTERNS.filter((p) => p.re.test(p.lines === true ? normalized : flat));
}

/** Ids of the phrase patterns found in a text (normalized here). For output filtering. */
export function instructionPatterns(text: string): string[] {
  return matchPatterns(normalizeForMatching(text)).map((p) => p.id);
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
  const scan = (text: string, source: FindingSource, bonus: number) => {
    if (text === "") return;
    for (const p of matchPatterns(normalizeForMatching(text))) {
      // "Delete old files" is a fine name for a file: only in hidden text does it count more.
      const extra = source === "name" && NAME_PLAIN.has(p.id) ? 0 : bonus;
      add(p.id, source, p.weight + extra);
    }
  };

  const name = typeof input.name === "string" ? input.name.slice(0, 4096) : "";
  if (name !== "") {
    // Line breaks, bidi overrides, zero-width characters: no honest file name needs them.
    if (/[\p{Cc}\p{Cf}]/u.test(name)) add("name-control", "name", STRONG);
    if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(name)) add("name-traversal", "name", STRONG);
    scan(name, "name", 1);
  }

  const text = typeof input.text === "string" ? input.text : "";
  scan(text, "text", 0);
  if (text !== "") {
    const scanned = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
    for (const decoded of decodedBase64(scanned)) scan(decoded, "decoded", 0);
    // Text stored reversed inside a right-to-left override reads normally on screen.
    const reversed = normalizeForMatching(scanned).split("").reverse().join("");
    for (const id of ["override-instructions", "override-your-instructions"]) {
      const p = BY_ID.get(id);
      if (p?.re.test(reversed)) add(id, "reversed", p.weight);
    }
  }

  let hiddenAlone = false;
  for (const { kind, sample } of readSignals(input.signals ?? [])) {
    if (!HIDING.has(kind)) continue;
    if (FLAGS_ALONE.has(kind)) add(kind, "hidden", STRONG);
    if (SUSPICIOUS_ALONE.has(kind)) hiddenAlone = true;
    // A formula's text is visible in its cell (only its source is not): no extra weight.
    scan(sample, "hidden", kind === "formula" ? 0 : 1);
  }
  if (hiddenAlone) add("hidden-text-present", "hidden", 1);

  for (const s of metadataStrings(input.metadata ?? {})) scan(s, "metadata", 1);

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
