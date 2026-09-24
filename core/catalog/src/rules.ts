import { objectTags, tagOf, type Tx } from "@openhoard/core-db";
import { and, eq, or } from "drizzle-orm";
import { lockObject } from "./locks.js";
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
 * make tagging slow, and case-insensitive over Unicode letters and digits. Rules and inputs are
 * compared in Unicode NFC, so a decomposed name (macOS writes "é" as "e" and a combining accent)
 * matches a rule written with the composed one, and the other way round.
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

/** What applyRuleTags() did. */
export interface RuleTagSync {
  /** One per tag the rules give now, sorted by tag: applied, or waiting in review. */
  outcomes: (TagOutcome & { rule: string })[];
  /** Rule tags the object had that no rule gives any more, taken off; sorted. */
  removed: string[];
}

/**
 * Makes an object's rule tags exactly what the rules give it now. Tags the rules give are
 * applied through proposeTag(), as source `rule`; values that aren't approved vocabulary go to
 * the review inbox like anyone else's. Rule tags the object carries that no rule gives any more
 * (the file moved from Clients/Acme/ to HR/, say) are taken off, and with them the grants they
 * carried. Tags from other sources (people, packs, models) are left alone, even when a rule
 * once gave the same tag too.
 *
 * Pass the object's complete rule set and current input: an empty rule list takes every rule
 * tag off.
 */
export async function applyRuleTags(
  tx: Tx,
  tenantId: string,
  objectId: string,
  rules: readonly TagRule[],
  input: RuleInput,
): Promise<RuleTagSync> {
  await lockObject(tx, tenantId, objectId);
  const matched = evaluateRules(rules, input);
  const outcomes: (TagOutcome & { rule: string })[] = [];
  for (const { tag, rule } of matched) {
    const outcome = await proposeTag(tx, tenantId, {
      objectId,
      tag,
      source: "rule",
      appliedBy: `rule:${rule}`,
      confidence: 1,
    });
    outcomes.push({ ...outcome, rule });
  }
  const wanted = new Set(matched.map((m) => m.tag));
  const current = await tx
    .select({ facet: objectTags.facet, value: objectTags.value })
    .from(objectTags)
    .where(
      and(
        eq(objectTags.tenantId, tenantId),
        eq(objectTags.objectId, objectId),
        eq(objectTags.source, "rule"),
      ),
    );
  const stale = current.filter((r) => !wanted.has(tagOf(r.facet, r.value)));
  if (stale.length > 0) {
    await tx
      .delete(objectTags)
      .where(
        and(
          eq(objectTags.tenantId, tenantId),
          eq(objectTags.objectId, objectId),
          eq(objectTags.source, "rule"),
          or(
            ...stale.map((r) => and(eq(objectTags.facet, r.facet), eq(objectTags.value, r.value))),
          ),
        ),
      );
  }
  return { outcomes, removed: stale.map((r) => tagOf(r.facet, r.value)).sort() };
}

/** Checks rules loaded from a pack or an admin; returns what is wrong, empty when fine. */
export function validateRules(rules: unknown): string[] {
  if (!Array.isArray(rules)) return ["rules must be a list"];
  const problems: string[] = [];
  const ids = new Set<string>();
  const TAG = /^[a-z][a-z0-9-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/;
  const FACET = /^[a-z][a-z0-9-]{0,63}$/;
  const VALUE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
  // Control and format characters (a right-to-left override, say) make a rule read differently
  // from what it matches.
  const visible = (s: string) => !/\p{C}/u.test(s);
  const strings = (v: unknown) =>
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((s) => typeof s === "string" && s.length > 0 && visible(s));
  const unknownKeys = (rule: Record<string, unknown>, id: string, allowed: string[]) => {
    for (const k of Object.keys(rule)) {
      if (!allowed.includes(k)) problems.push(`${id}: unknown field ${k}`);
    }
  };
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
      unknownKeys(rule, rule.id, ["id", "facet", "dictionary"]);
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
    unknownKeys(rule, rule.id, ["id", "tag", "when"]);
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
      const v = when[key];
      if (key in when && (typeof v !== "string" || v === "" || !visible(v))) {
        problems.push(`${rule.id}: ${key} must be a non-empty string of visible characters`);
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

/** Case-folded and in NFC, so composed and decomposed spellings compare equal. */
function fold(s: string): string;
function fold(s: string | undefined): string | undefined;
function fold(s: string | undefined) {
  return s?.toLowerCase().normalize("NFC");
}
const lower = fold;

/**
 * Glob matching over `/`-separated paths, case-insensitive and in NFC. Segments are matched one
 * by one; `**` spans any number of segments. Iterative with backtracking to the last `**` and
 * the last `*` only, so the cost is linear-ish in the input for any pattern.
 */
export function globMatch(pattern: string, path: string): boolean {
  const pat = fold(pattern).split("/").filter(Boolean);
  const segs = fold(path).split("/").filter(Boolean);
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

/**
 * Lower-case NFC runs of Unicode letters and digits, with their combining marks (a mark with no
 * precomposed form stays part of its word).
 */
function tokenize(text: string): string[] {
  return fold(text).match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
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
