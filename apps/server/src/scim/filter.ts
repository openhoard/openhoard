import { invalidFilter, invalidPath } from "./errors.js";

/*
 * SCIM filters and attribute paths (RFC 7644 section 3.4.2.2 and 3.5.2): parsed in full, so a
 * well-formed filter OpenHoard can't answer is refused as unsupported rather than misread.
 * What each endpoint answers is decided where the filter is used (users.ts, groups.ts): Entra
 * sends only `eq` and `and`.
 *
 * Attribute names are case-insensitive (RFC 7643 section 2.1), so paths come out lower-cased.
 * A core schema's URN in front of a path (`urn:ietf:params:scim:schemas:core:2.0:User:userName`)
 * is dropped; any other URN is kept in `schema`, and callers treat its attributes as ones they
 * don't keep.
 */

export const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const ENTERPRISE_USER_SCHEMA = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";

const CORE = [USER_SCHEMA, GROUP_SCHEMA].map((s) => s.toLowerCase());

export type CompareOp = "eq" | "ne" | "co" | "sw" | "ew" | "gt" | "ge" | "lt" | "le";
const OPS = new Set<string>(["eq", "ne", "co", "sw", "ew", "gt", "ge", "lt", "le"]);

export type FilterValue = string | number | boolean | null;

export interface AttrPath {
  /** An extension schema's URN, lower-cased; absent for the core schemas. */
  schema?: string;
  /** The attribute, lower-cased: `username`, `emails`, `members`. */
  attr: string;
  /** A value filter on a multi-valued attribute: `emails[type eq "work"]`. */
  filter?: Filter;
  /** The sub-attribute, lower-cased: `value` in `emails[type eq "work"].value`. */
  sub?: string;
}

export type Filter =
  | { kind: "and" | "or"; left: Filter; right: Filter }
  | { kind: "not"; filter: Filter }
  | { kind: "compare"; path: AttrPath; op: CompareOp; value: FilterValue }
  | { kind: "present"; path: AttrPath }
  /** A value path on its own: some value of `path.attr` matches `path.filter`. */
  | { kind: "has"; path: AttrPath & { filter: Filter } };

/** Longest filter or path accepted, and deepest nesting. */
const MAX_LENGTH = 4096;
const MAX_DEPTH = 16;

const NAME = /^(?:\$ref|[A-Za-z][A-Za-z0-9_-]*)$/;

class Parser {
  i = 0;
  depth = 0;
  constructor(
    readonly text: string,
    readonly fail: (detail: string) => Error,
  ) {}

  peek(): string {
    return this.text[this.i] ?? "";
  }

  spaces(): void {
    while (this.peek() === " ") this.i++;
  }

  /** A keyword (`and`, `or`, `not`, `pr`, an operator) at the cursor, if one is there. */
  keyword(word: string): boolean {
    const end = this.i + word.length;
    const next = this.text[end] ?? "";
    if (this.text.slice(this.i, end).toLowerCase() === word && /^[ ()[\]]?$/.test(next)) {
      this.i = end;
      return true;
    }
    return false;
  }

  orExpr(): Filter {
    if (++this.depth > MAX_DEPTH) throw this.fail("filter nests too deeply");
    let left = this.andExpr();
    for (;;) {
      const at = this.i;
      this.spaces();
      if (this.keyword("or")) {
        this.spaces();
        left = { kind: "or", left, right: this.andExpr() };
      } else {
        this.i = at;
        break;
      }
    }
    this.depth--;
    return left;
  }

  andExpr(): Filter {
    let left = this.unary();
    for (;;) {
      const at = this.i;
      this.spaces();
      if (this.keyword("and")) {
        this.spaces();
        left = { kind: "and", left, right: this.unary() };
      } else {
        this.i = at;
        break;
      }
    }
    return left;
  }

  unary(): Filter {
    if (this.keyword("not")) {
      this.spaces();
      if (this.peek() !== "(") throw this.fail("expected ( after not");
      return { kind: "not", filter: this.group() };
    }
    if (this.peek() === "(") return this.group();
    return this.attrExp();
  }

  group(): Filter {
    this.i++; // (
    this.spaces();
    const inner = this.orExpr();
    this.spaces();
    if (this.peek() !== ")") throw this.fail("expected )");
    this.i++;
    return inner;
  }

  attrExp(): Filter {
    const path = this.attrPath(true);
    // A value path standing alone (`members[value eq "…"]`), followed by and, or or the end.
    if (path.filter !== undefined && path.sub === undefined) {
      const at = this.i;
      this.spaces();
      const alone =
        this.i === this.text.length ||
        /^[)\]]/.test(this.peek()) ||
        this.keyword("and") ||
        this.keyword("or");
      this.i = at;
      if (alone) return { kind: "has", path: { ...path, filter: path.filter } };
    }
    if (this.peek() !== " ") throw this.fail("expected an operator after the attribute");
    this.spaces();
    if (this.keyword("pr")) return { kind: "present", path };
    const op = /^[A-Za-z]{2}/.exec(this.text.slice(this.i))?.[0].toLowerCase();
    if (op === undefined || !OPS.has(op) || !this.keyword(op)) {
      throw this.fail("expected an operator: eq, ne, co, sw, ew, gt, ge, lt, le or pr");
    }
    if (this.peek() !== " ") throw this.fail("expected a value after the operator");
    this.spaces();
    return { kind: "compare", path, op: op as CompareOp, value: this.value() };
  }

  value(): FilterValue {
    const rest = this.text.slice(this.i);
    if (rest.startsWith('"')) {
      // A JSON string: escapes as JSON has them.
      const m = /^"(?:[^"\\]|\\.)*"/su.exec(rest);
      if (!m) throw this.fail("unterminated string");
      this.i += m[0].length;
      try {
        return JSON.parse(m[0]) as string;
      } catch {
        throw this.fail("invalid string");
      }
    }
    for (const [word, v] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (this.keyword(word)) return v;
    }
    const num = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?=$|[ )\]])/.exec(rest);
    if (num) {
      this.i += num[0].length;
      return Number(num[0]);
    }
    // Not RFC 7644, but one of Microsoft's examples leaves a string unquoted
    // (`externalId eq jyoung`): a bare word is taken as that string.
    const bare = /^[^\s"()[\]]+/.exec(rest);
    if (bare) {
      this.i += bare[0].length;
      return bare[0];
    }
    throw this.fail("expected a value: a string in double quotes, a number, true, false or null");
  }

  /** attrPath, with an optional value filter and sub-attribute when `valueFilter` allows. */
  attrPath(valueFilter: boolean): AttrPath {
    const raw = /^[A-Za-z0-9_$:.-]+/.exec(this.text.slice(this.i))?.[0];
    if (raw === undefined) throw this.fail("expected an attribute");
    this.i += raw.length;
    const path = splitPath(raw, this.fail);
    if (this.peek() === "[") {
      if (!valueFilter || path.sub !== undefined) throw this.fail("unexpected [");
      this.i++;
      this.spaces();
      const filter = this.orExpr();
      this.spaces();
      if (this.peek() !== "]") throw this.fail("expected ]");
      this.i++;
      path.filter = filter;
      if (this.peek() === ".") {
        this.i++;
        const sub = /^[A-Za-z0-9_$-]+/.exec(this.text.slice(this.i))?.[0];
        if (sub === undefined || !NAME.test(sub)) throw this.fail("expected a sub-attribute");
        this.i += sub.length;
        path.sub = sub.toLowerCase();
      }
    }
    return path;
  }
}

/** `[urn:…:]attr[.sub]` as an AttrPath. */
function splitPath(raw: string, fail: (d: string) => Error): AttrPath {
  let schema: string | undefined;
  let rest = raw;
  const lower = raw.toLowerCase();
  if (lower.startsWith("urn:")) {
    const core = CORE.find((c) => lower.startsWith(`${c}:`));
    const cut = core === undefined ? raw.lastIndexOf(":") : core.length;
    if (core === undefined) schema = lower.slice(0, cut);
    rest = raw.slice(cut + 1);
  }
  const [attr = "", sub, ...more] = rest.split(".");
  if (!NAME.test(attr) || (sub !== undefined && !NAME.test(sub)) || more.length > 0) {
    throw fail(`not an attribute path: ${raw.slice(0, 200)}`);
  }
  return {
    ...(schema === undefined ? {} : { schema }),
    attr: attr.toLowerCase(),
    ...(sub === undefined ? {} : { sub: sub.toLowerCase() }),
  };
}

/** Parses a `filter` query parameter; throws invalidFilter (400) when it isn't one. */
export function parseFilter(text: string): Filter {
  if (text.length > MAX_LENGTH) throw invalidFilter("filter is too long");
  const p = new Parser(text.trim(), invalidFilter);
  const filter = p.orExpr();
  if (p.i !== p.text.length) throw invalidFilter("unexpected text after the filter");
  return filter;
}

/** Parses a PATCH operation's `path`; throws invalidPath (400) when it isn't one. */
export function parsePath(text: string): AttrPath {
  if (text.length > MAX_LENGTH) throw invalidPath("path is too long");
  const p = new Parser(text.trim(), invalidPath);
  const path = p.attrPath(true);
  if (p.i !== p.text.length) throw invalidPath("unexpected text after the path");
  return path;
}

/** The `eq` comparisons of a filter made only of `eq` joined by `and`, or null otherwise. */
export function eqConjunction(filter: Filter): { path: AttrPath; value: FilterValue }[] | null {
  if (filter.kind === "and") {
    const left = eqConjunction(filter.left);
    const right = eqConjunction(filter.right);
    return left && right ? [...left, ...right] : null;
  }
  if (filter.kind === "compare" && filter.op === "eq") {
    return [{ path: filter.path, value: filter.value }];
  }
  return null;
}

/** The path written back as text, for messages: `emails[…].value`. */
export function pathName(path: AttrPath): string {
  return `${path.schema === undefined ? "" : `${path.schema}:`}${path.attr}${
    path.filter === undefined ? "" : "[…]"
  }${path.sub === undefined ? "" : `.${path.sub}`}`;
}
