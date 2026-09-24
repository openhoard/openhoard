import type { Tx } from "@openhoard/core-db";
import { proposeTag, type TagOutcome } from "./tagging.js";

/*
 * The rule tagger (T-403): deterministic tags from where a file lives and what it is called,
 * applied before any model sees it. Rules come from packs and admins as data:
 *
 *   { id: "finance-folder", tag: "department:finance", when: { path: "Finance/**" } }
 *   { id: "spreadsheets", tag: "kind:spreadsheet", when: { extension: ["xlsx", "csv"] } }
 *   { id: "clients", facet: "client", dictionary: { acme: ["Acme", "Acme Corp"] } }
 *
 * Matching is linear in the input (no regular expressions built from rule text), so a rule can't
 * make tagging slow, and case-insensitive over Unicode letters and digits.
 */

/** What rules can look at. Everything is optional; a condition on a missing field fails. */
export interface RuleInput {
  /** Path within its source, `/`-separated, e.g. `Clients/Acme/2026/Plan.docx`. */
  path?: string;
  /** The source's site or drive name, e.g. a SharePoint site. */
  site?: string;
  title?: string;
  mime?: string;
}

export interface MatchRule {
  id: string;
  /** `facet:value` to apply when every condition holds. */
  tag: string;
  when: {
    /** A glob over the path: `*` within a segment, `**` across segments, `?` one character. */
    path?: string;
    /** The site, compared case-insensitively. */
    site?: string;
    /** File extensions without the dot, case-insensitive. */
    extension?: string[];
    /** Media types; `type/*` matches a whole family. */
    mime?: string[];
  };
}

export interface DictionaryRule {
  id: string;
  facet: string;
  /** value → terms. A term matches as whole words in the title or any path segment. */
  dictionary: Record<string, string[]>;
}

export type TagRule = MatchRule | DictionaryRule;

/** The tags `rules` give an input, with the rule that gave each, sorted by tag. */
export function evaluateRules(
  rules: readonly TagRule[],
  input: RuleInput,
): { tag: string; rule: string }[] {
  const found = new Map<string, string>();
  const words = wordsOf([input.title ?? "", ...(input.path ?? "").split("/")]);
  for (const rule of rules) {
    if ("dictionary" in rule) {
      for (const [value, terms] of Object.entries(rule.dictionary)) {
        if (terms.some((term) => containsPhrase(words, tokenize(term)))) {
          const tag = `${rule.facet}:${value}`;
          if (!found.has(tag)) found.set(tag, rule.id);
        }
      }
    } else if (matches(rule, input) && !found.has(rule.tag)) {
      found.set(rule.tag, rule.id);
    }
  }
  return [...found]
    .map(([tag, rule]) => ({ tag, rule }))
    .sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
}

/**
 * Applies the rules' tags to an object through proposeTag(), as source `rule`. Tags whose value
 * isn't approved vocabulary go to the review inbox like anyone else's.
 */
export async function applyRuleTags(
  tx: Tx,
  tenantId: string,
  objectId: string,
  rules: readonly TagRule[],
  input: RuleInput,
): Promise<(TagOutcome & { rule: string })[]> {
  const outcomes: (TagOutcome & { rule: string })[] = [];
  for (const { tag, rule } of evaluateRules(rules, input)) {
    const outcome = await proposeTag(tx, tenantId, {
      objectId,
      tag,
      source: "rule",
      appliedBy: `rule:${rule}`,
      confidence: 1,
    });
    outcomes.push({ ...outcome, rule });
  }
  return outcomes;
}

/** Checks rules loaded from a pack or an admin; returns what is wrong, empty when fine. */
export function validateRules(rules: unknown): string[] {
  if (!Array.isArray(rules)) return ["rules must be a list"];
  const problems: string[] = [];
  const ids = new Set<string>();
  const TAG = /^[a-z][a-z0-9-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/;
  const FACET = /^[a-z][a-z0-9-]{0,63}$/;
  const VALUE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
  const strings = (v: unknown) =>
    Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s.length > 0);
  rules.forEach((r: unknown, i) => {
    const at = `rule ${i}`;
    if (typeof r !== "object" || r === null) return void problems.push(`${at}: not an object`);
    const rule = r as Record<string, unknown>;
    if (typeof rule.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(rule.id)) {
      return void problems.push(`${at}: id must be a lower-case slug`);
    }
    if (ids.has(rule.id)) problems.push(`${at}: duplicate id ${rule.id}`);
    ids.add(rule.id);
    if ("dictionary" in rule) {
      if (typeof rule.facet !== "string" || !FACET.test(rule.facet)) {
        problems.push(`${rule.id}: facet must be a facet key`);
      }
      const dict = rule.dictionary;
      if (typeof dict !== "object" || dict === null || Array.isArray(dict)) {
        return void problems.push(`${rule.id}: dictionary must map values to terms`);
      }
      for (const [value, terms] of Object.entries(dict)) {
        if (!VALUE.test(value)) problems.push(`${rule.id}: ${value} is not a value slug`);
        if (!strings(terms)) problems.push(`${rule.id}: ${value} needs a list of terms`);
        else if ((terms as string[]).some((t) => tokenize(t).length === 0)) {
          problems.push(`${rule.id}: ${value} has a term with no letters or digits`);
        }
      }
      return;
    }
    if (typeof rule.tag !== "string" || !TAG.test(rule.tag)) {
      problems.push(`${rule.id}: tag must be facet:value`);
    }
    const when = rule.when as Record<string, unknown> | undefined;
    if (typeof when !== "object" || when === null) {
      return void problems.push(`${rule.id}: when must be an object`);
    }
    const keys = Object.keys(when);
    if (keys.length === 0) problems.push(`${rule.id}: when needs at least one condition`);
    for (const key of keys) {
      if (!["path", "site", "extension", "mime"].includes(key)) {
        problems.push(`${rule.id}: unknown condition ${key}`);
      }
    }
    for (const key of ["path", "site"] as const) {
      if (key in when && (typeof when[key] !== "string" || when[key] === "")) {
        problems.push(`${rule.id}: ${key} must be a non-empty string`);
      }
    }
    for (const key of ["extension", "mime"] as const) {
      if (key in when && !strings(when[key])) problems.push(`${rule.id}: ${key} must list strings`);
    }
  });
  return problems;
}

function matches(rule: MatchRule, input: RuleInput): boolean {
  const { when } = rule;
  if (when.path !== undefined && (input.path === undefined || !globMatch(when.path, input.path)))
    return false;
  if (when.site !== undefined && lower(input.site) !== lower(when.site)) return false;
  if (when.extension !== undefined) {
    const name = (input.path ?? input.title ?? "").split("/").pop() ?? "";
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? lower(name.slice(dot + 1)) : undefined;
    if (ext === undefined || !when.extension.some((e) => lower(e) === ext)) return false;
  }
  if (when.mime !== undefined) {
    const mime = lower(input.mime);
    if (mime === undefined) return false;
    const ok = when.mime.some((m) => {
      const want = lower(m) ?? "";
      return want.endsWith("/*") ? mime.startsWith(want.slice(0, -1)) : mime === want;
    });
    if (!ok) return false;
  }
  return true;
}

const lower = (s: string | undefined) => s?.toLowerCase();

/**
 * Glob matching over `/`-separated paths, case-insensitive. Segments are matched one by one;
 * `**` spans any number of segments. Iterative with backtracking to the last `**` and the last
 * `*` only, so the cost is linear-ish in the input for any pattern.
 */
export function globMatch(pattern: string, path: string): boolean {
  const pat = pattern.toLowerCase().split("/").filter(Boolean);
  const segs = path.toLowerCase().split("/").filter(Boolean);
  let p = 0;
  let s = 0;
  let starP = -1;
  let starS = -1;
  while (s < segs.length) {
    if (p < pat.length && pat[p] === "**") {
      starP = p++;
      starS = s;
    } else if (p < pat.length && segmentMatch(pat[p] as string, segs[s] as string)) {
      p++;
      s++;
    } else if (starP !== -1) {
      p = starP + 1;
      s = ++starS;
    } else {
      return false;
    }
  }
  while (p < pat.length && pat[p] === "**") p++;
  return p === pat.length;
}

/** `*` and `?` within one path segment, by the same two-pointer method. */
function segmentMatch(pattern: string, text: string): boolean {
  const pc = [...pattern];
  const tc = [...text];
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < tc.length) {
    if (p < pc.length && (pc[p] === "?" || pc[p] === tc[t])) {
      p++;
      t++;
    } else if (p < pc.length && pc[p] === "*") {
      star = p++;
      mark = t;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (p < pc.length && pc[p] === "*") p++;
  return p === pc.length;
}

/** Lower-case runs of Unicode letters and digits. */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function wordsOf(texts: string[]): string[][] {
  return texts.map(tokenize).filter((w) => w.length > 0);
}

/** Whether `phrase` appears as consecutive whole words in any of the word lists. */
function containsPhrase(lists: string[][], phrase: string[]): boolean {
  if (phrase.length === 0) return false;
  return lists.some((words) => {
    for (let i = 0; i + phrase.length <= words.length; i++) {
      if (phrase.every((w, j) => words[i + j] === w)) return true;
    }
    return false;
  });
}
