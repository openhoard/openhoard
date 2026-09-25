import { facets, objectTags, tagOf, tagReviews, type Tx } from "@openhoard/core-db";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { lockObject } from "./locks.js";
import { clearPrimaryTag, makePrimary, primaryTagOf, type PrimaryTag } from "./primary.js";
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
  /**
   * Make the tag the object's primary tag, its home (T-409), when this rule applies it: how a
   * folder layout (`Projects/Apollo/**` → `project:apollo`) carries over. Never over a home a
   * person chose; when several primary rules match, the first in the list wins.
   */
  primary?: boolean;
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
  /**
   * Rule tags no rule gives any more that a model had proposed first: not taken off, but the
   * model's unreviewed tags again, so they still tighten visibility and no longer grant; sorted.
   */
  reverted: string[];
  /** The rules' open review items for tags no rule gives any more, closed as withdrawn. */
  withdrawn: string[];
  /**
   * Tags the rules give that they didn't propose, on a single-value facet: a person chose
   * another value of it for this object, or a rule earlier in the list gives one; sorted.
   */
  skipped: string[];
  /** The object's primary tag afterwards, whoever set it. */
  primary: PrimaryTag | null;
}

/**
 * Makes an object's rule tags exactly what the rules give it now. Tags the rules give are
 * applied through proposeTag(), as source `rule`; values that aren't approved vocabulary go to
 * the review inbox like anyone else's. Rule tags the object carries that no rule gives any more
 * (the file moved from Clients/Acme/ to HR/, say) are taken off, and with them the grants they
 * carried, even when a person approved the value the rule proposed. Tags from other sources
 * (people, packs, models) are left alone, and so is a model's guess a rule took over: it goes
 * back to being the model's unreviewed tag, since taking it off could loosen visibility that no
 * person decided to loosen. A rule's open review item for a tag no rule gives is withdrawn.
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
  const { matched, skipped } = await singleValued(
    tx,
    tenantId,
    objectId,
    rules,
    evaluateRules(rules, input),
  );
  const wanted = new Set(matched.map((m) => m.tag));
  const current = await tx
    .select({
      facet: objectTags.facet,
      value: objectTags.value,
      model: isNotNull(objectTags.modelConfidence).mapWith(Boolean),
    })
    .from(objectTags)
    .where(
      and(
        eq(objectTags.tenantId, tenantId),
        eq(objectTags.objectId, objectId),
        eq(objectTags.source, "rule"),
      ),
    );
  const stale = current.filter((r) => !wanted.has(tagOf(r.facet, r.value)));
  const staleTags = (rows: typeof stale) =>
    and(
      eq(objectTags.tenantId, tenantId),
      eq(objectTags.objectId, objectId),
      eq(objectTags.source, "rule"),
      or(...rows.map((r) => and(eq(objectTags.facet, r.facet), eq(objectTags.value, r.value)))),
    );
  const removed = stale.filter((r) => !r.model);
  const reverted = stale.filter((r) => r.model);
  if (removed.length > 0) await tx.delete(objectTags).where(staleTags(removed));
  if (reverted.length > 0) {
    await tx
      .update(objectTags)
      .set({
        source: "model",
        appliedBy: sql`${objectTags.modelAppliedBy}`,
        confidence: sql`${objectTags.modelConfidence}`,
        reviewed: false,
        modelAppliedBy: null,
        modelConfidence: null,
        // A model's guess is no home.
        primaryBy: null,
      })
      .where(staleTags(reverted));
  }
  // Proposed after the stale tags are gone, so a file moving from one rule's value of a
  // single-value facet to another's never conflicts with the value it is leaving.
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
  // Under the object's lock, so no decision on these items runs meanwhile (each takes it).
  const withdrawn = await tx
    .update(tagReviews)
    .set({
      decision: "withdrawn",
      resolvedBy: sql`coalesce(${tagReviews.appliedBy}, 'rule:unknown')`,
      resolvedAt: sql`greatest(now(), ${tagReviews.createdAt})`,
    })
    .where(
      and(
        eq(tagReviews.tenantId, tenantId),
        eq(tagReviews.objectId, objectId),
        eq(tagReviews.source, "rule"),
        isNull(tagReviews.resolvedAt),
        wanted.size === 0
          ? undefined
          : sql`(${tagReviews.facet} || ':' || ${tagReviews.value}) not in (${sql.join(
              [...wanted].map((t) => sql`${t}`),
              sql`, `,
            )})`,
      ),
    )
    .returning({ id: tagReviews.id });
  const tags = (rows: typeof stale) => rows.map((r) => tagOf(r.facet, r.value)).sort();
  return {
    outcomes,
    removed: tags(removed),
    reverted: tags(reverted),
    withdrawn: withdrawn.map((w) => w.id).sort(),
    skipped,
    primary: await syncPrimary(tx, tenantId, objectId, rules, input, outcomes),
  };
}

/**
 * On single-value facets, what the rules propose: nothing where a person chose the object's
 * value (their choice stands, so no conflict is raised again on every sync), and otherwise the
 * value the first rule in the list gives (two rules never take turns replacing each other).
 */
async function singleValued(
  tx: Tx,
  tenantId: string,
  objectId: string,
  rules: readonly TagRule[],
  matched: { tag: string; rule: string }[],
): Promise<{ matched: { tag: string; rule: string }[]; skipped: string[] }> {
  const facetOf = (tag: string) => tag.slice(0, tag.indexOf(":"));
  const keys = [...new Set(matched.map((m) => facetOf(m.tag)))];
  if (keys.length === 0) return { matched, skipped: [] };
  const single = new Set(
    (
      await tx
        .select({ key: facets.key })
        .from(facets)
        .where(
          and(eq(facets.tenantId, tenantId), inArray(facets.key, keys), eq(facets.single, true)),
        )
    ).map((f) => f.key),
  );
  if (single.size === 0) return { matched, skipped: [] };
  const chosen = new Set(
    (
      await tx
        .select({ facet: objectTags.facet })
        .from(objectTags)
        .where(
          and(
            eq(objectTags.tenantId, tenantId),
            eq(objectTags.objectId, objectId),
            inArray(objectTags.facet, [...single]),
            // A person's value, or a model's a person reviewed; a rule's own approved value is
            // still the rule's.
            or(
              eq(objectTags.source, "user"),
              and(eq(objectTags.source, "model"), eq(objectTags.reviewed, true)),
            ),
          ),
        )
    ).map((r) => r.facet),
  );
  const order = new Map(rules.map((r, i) => [r.id, i]));
  const first = new Map<string, { tag: string; rule: string }>();
  for (const m of matched) {
    const facet = facetOf(m.tag);
    if (!single.has(facet) || chosen.has(facet)) continue;
    const best = first.get(facet);
    const rank = (x: { tag: string; rule: string }) => order.get(x.rule) ?? Infinity;
    if (!best || rank(m) < rank(best) || (rank(m) === rank(best) && m.tag < best.tag)) {
      first.set(facet, m);
    }
  }
  const keep = matched.filter(
    (m) => !single.has(facetOf(m.tag)) || first.get(facetOf(m.tag)) === m,
  );
  return {
    matched: keep,
    skipped: matched.filter((m) => !keep.includes(m)).map((m) => m.tag),
  };
}

/**
 * The home the rules give: the first matching primary rule's tag, once applied. It replaces and
 * clears only a rule's home (including when the rule's tag waits in review); a person's stands.
 */
async function syncPrimary(
  tx: Tx,
  tenantId: string,
  objectId: string,
  rules: readonly TagRule[],
  input: RuleInput,
  outcomes: readonly (TagOutcome & { rule: string })[],
): Promise<PrimaryTag | null> {
  const applied = new Set(outcomes.flatMap((o) => (o.applied ? [o.tag] : [])));
  const rule = rules.find(
    (r): r is MatchRule =>
      !("dictionary" in r) && r.primary === true && applied.has(r.tag) && matches(r, input),
  );
  const current = await primaryTagOf(tx, tenantId, objectId);
  const ours = current === null || current.by.startsWith("rule:");
  if (!ours) return current;
  if (rule) {
    const want = { tag: rule.tag, by: `rule:${rule.id}` };
    if (current?.tag !== want.tag || current.by !== want.by) {
      await makePrimary(tx, tenantId, objectId, want.tag, want.by);
    }
    return want;
  }
  if (current) await clearPrimaryTag(tx, tenantId, objectId);
  return null;
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
    unknownKeys(rule, rule.id, ["id", "tag", "when", "primary"]);
    if (typeof rule.tag !== "string" || !TAG.test(rule.tag)) {
      problems.push(`${rule.id}: tag must be facet:value`);
    }
    if (rule.primary !== undefined && typeof rule.primary !== "boolean") {
      problems.push(`${rule.id}: primary must be true or false`);
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
