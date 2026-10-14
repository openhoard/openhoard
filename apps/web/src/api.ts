/*
 * What the admin pages ask the server. Every request is this origin's, with the session cookie
 * (T-102); the server decides what the person may have, here only what to show.
 */

/** Nobody is signed in (or the session ended): the page leaves for the sign-in. */
export class SignedOut extends Error {}

/** The server refused, failed, or couldn't be reached (`status` 0). */
export class ApiError extends Error {
  constructor(readonly status: number) {
    super(status === 0 ? "the server could not be reached" : `the server answered ${status}`);
  }
}

export interface Me {
  user: { id: string; displayName: string; email: string | null; kind: string };
  tenantId: string;
  /** Whether to offer administration; the admin API decides for itself on every request. */
  admin: boolean;
}

/** Where a source's sync stands (core/jobs syncStanding()): what waits on an admin, else how it goes. */
export type Standing =
  | { is: "held" | "confirmed"; count: number }
  | { is: "stopped"; code: string }
  | { is: "retrying"; code: string | null }
  | { is: "unavailable"; code: string }
  /** `since`: when the catalog last matched the source (ISO 8601). */
  | { is: "stale"; since: string; code: string | null }
  | {
      is:
        | "identity-changed"
        | "deferred"
        | "waiting-for-owner"
        | "not-run"
        | "reading"
        | "catching-up"
        | "cancelled"
        | "current";
    };

/** A connector sync, as GET /api/admin/sources gives it (what the pages use of it). */
export interface Source {
  source: string;
  connector: string;
  standing: Standing;
  lastRunAt: string | null;
  lastCounts: Record<string, number> | null;
}

export type Trust = "local" | "commercial" | "consumer";
/** The kinds an admin chooses from, the one given least first. */
export const TRUSTS: readonly Trust[] = ["consumer", "commercial", "local"];

/** An AI client, as GET /api/admin/clients gives it (what the pages use of it). */
export interface Client {
  clientKey: string;
  /** What identifies it: its metadata document's URL, or (null) the addresses below. */
  clientId: string | null;
  /** Where a sign-in through it returns to. */
  redirectUris: string[];
  status: "pending" | "approved" | "refused";
  /** The label it gets tokens with now; null when it gets none. */
  trust: Trust | null;
  /** Who decides: this app's admins, or the server's config file. */
  managedBy: "app" | "config";
  /** The label the config gives it, when it lists it: the only one it can be approved with. */
  configTrust: Trust | null;
  requestedAt: string | null;
  /** What it calls itself: shown, never trusted. */
  claimedName: string;
  /** People connected through it now, and when it last got a token. */
  people: number;
  lastUsedAt: string | null;
}

/** What an admin does about a client. */
export type ClientDecision = { action: "approve"; trust: Trust } | { action: "refuse" | "revoke" };

/**
 * How a change ended. `sign-in-again`: the server wants a recent sign-in for it. `conflict`:
 * it no longer applies (someone else decided, or the server's config decides). `gone`: the
 * client is no longer there (a request nobody decided lapses after 30 days).
 */
export type Changed = "done" | "sign-in-again" | "conflict" | "gone" | "refused" | "failed";

/** Why a suggested tag waits for a person (core/catalog ReviewReason, and `primary`). */
export type ReviewReason =
  "new-value" | "low-confidence" | "sensitive" | "conflict" | "agent" | "primary";

/** An open review item, as GET /api/review gives it. */
export interface ReviewItem {
  id: string;
  /** The file's title, as the person is shown it. */
  title: string;
  /** `facet:value`. */
  tag: string;
  reason: ReviewReason | string;
  /** Who suggested it: `model:…`, `user:…`, `rule:…`; null when not recorded. */
  appliedBy: string | null;
  confidence: number;
  createdAt: string | null;
  /** Some decision on it takes a tenant admin. */
  admin: boolean;
}

export interface ReviewInbox {
  items: ReviewItem[];
  /** More wait than were listed. */
  more: boolean;
  /** So many files have open items that not all were looked at. */
  capped: boolean;
}

export type ReviewDecision =
  | { decision: "approve"; replace?: boolean }
  | { decision: "reject" }
  | { decision: "merge"; into: string; replace?: boolean };

/**
 * How a decision ended. `replace`: it would take another value of the same kind off the file;
 * ask again with `replace`. `gone`: no longer open (decided meanwhile), or not the person's.
 * `not-yours`: they may not tag the file. `admin-only`: it takes a tenant admin.
 */
export type Reviewed =
  | { ended: "done"; applied: string | null; replaced: string[]; alsoClosed: number }
  /** The tags that would come off the file. */
  | { ended: "replace"; replaces: string[] }
  | { ended: "gone" | "not-yours" | "admin-only" | "invalid" | "failed" };

/** A value of the vocabulary, as GET /api/admin/vocabulary gives it. */
export interface VocabularyValue {
  value: string;
  tag: string;
  label: string;
  approved: boolean;
  visibility: string | null;
  exposure: string | null;
  /** Open review items proposing it. */
  waiting: number;
}

export interface VocabularyFacet {
  key: string;
  label: string;
  /** Shown on the card of a file someone can't open. */
  public: boolean;
  /** A file carries one value of it at most. */
  single: boolean;
  values: VocabularyValue[];
}

export interface Vocabulary {
  facets: VocabularyFacet[];
  cut: boolean;
}

/** An audit event, as GET /api/admin/audit gives it: as hashed, with its hash. */
export interface AuditEvent {
  seq: number;
  at: string;
  /** `user:usr_…`, `system:…`, `source:…`: who, as the log names them. */
  actor: string;
  action: string;
  decision: "allow" | "deny";
  client: string | null;
  object: string | null;
  detail: Record<string, string | number | boolean> | null;
  hash: string;
}

/** What to look for in the log; dates are days (`2026-10-01`), `until` included. */
export interface AuditQuery {
  actor?: string;
  /** Actions starting with this. */
  action?: string;
  decision?: "allow" | "deny";
  object?: string;
  from?: string;
  until?: string;
}

export interface AuditPage {
  events: AuditEvent[];
  /** Pass as `before` for older events; null when there are none. */
  next: number | null;
}

/** How a download ended; `invalid`: the server refused the filter (`field` says which). */
export type Exported =
  | { ended: "done"; file: Blob; name: string }
  | { ended: "sign-in-again" | "refused" | "failed" }
  | { ended: "invalid"; field: string | null };

export type Verified =
  | { ok: true; count: number; head: string }
  | { ok: false; count: number; seq: number; problem: string };

export interface Api {
  me(): Promise<Me>;
  audit(query: AuditQuery, before?: number): Promise<AuditPage>;
  exportAudit(query: AuditQuery, format: "csv" | "ndjson"): Promise<Exported>;
  verifyAudit(): Promise<Verified>;
  sources(): Promise<Source[]>;
  review(): Promise<ReviewInbox>;
  decideReview(id: string, decision: ReviewDecision): Promise<Reviewed>;
  vocabulary(): Promise<Vocabulary>;
  clients(): Promise<Client[]>;
  decideClient(clientKey: string, decision: ClientDecision): Promise<Changed>;
  signOut(): Promise<void>;
}

export function createApi(fetcher: typeof fetch): Api {
  async function send(path: string, method: "GET" | "POST", body?: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await fetcher(path, {
        method,
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ApiError(0);
    }
    if (res.status === 401) throw new SignedOut();
    return res;
  }
  async function ask(path: string, method: "GET" | "POST"): Promise<Response> {
    const res = await send(path, method);
    if (!res.ok) throw new ApiError(res.status);
    return res;
  }
  async function get(path: string): Promise<unknown> {
    const res = await ask(path, "GET");
    try {
      return await res.json();
    } catch {
      // Not this server's answer (a proxy's page, say).
      throw new ApiError(res.status);
    }
  }
  return {
    async me() {
      const body = (await get("/auth/me")) as Partial<Me> | null;
      if (typeof body?.user?.displayName !== "string") throw new ApiError(200);
      return body as Me;
    },
    async sources() {
      const body = (await get("/api/admin/sources")) as { sources?: unknown } | null;
      if (!Array.isArray(body?.sources)) throw new ApiError(200);
      return body.sources.map(asSource);
    },
    async clients() {
      const body = (await get("/api/admin/clients")) as { clients?: unknown } | null;
      if (!Array.isArray(body?.clients)) throw new ApiError(200);
      return body.clients.map(asClient);
    },
    async decideClient(clientKey, decision) {
      if (!/^[0-9a-f]{64}$/.test(clientKey)) return "failed";
      let res: Response;
      try {
        res = await send(
          `/api/admin/clients/${clientKey}/${decision.action}`,
          "POST",
          decision.action === "approve" ? { trust: decision.trust } : {},
        );
      } catch (err) {
        if (err instanceof SignedOut) throw err;
        return "failed";
      }
      if (res.ok) return "done";
      if (res.status === 409) return "conflict";
      if (res.status === 404) return "gone";
      if (res.status !== 403) return "failed";
      const why = (await res.json().catch(() => null)) as { signIn?: unknown } | null;
      return typeof why?.signIn === "string" ? "sign-in-again" : "refused";
    },
    async review() {
      const body = (await get("/api/review")) as Partial<ReviewInbox> | null;
      if (!Array.isArray(body?.items)) throw new ApiError(200);
      return {
        items: body.items.map(asReviewItem),
        more: body.more === true,
        capped: body.capped === true,
      };
    },
    async decideReview(id, decision) {
      if (!/^rev_[0-9a-z]{26}$/.test(id)) return { ended: "failed" };
      const { decision: what, ...rest } = decision;
      let res: Response;
      try {
        res = await send(`/api/review/${id}/${what}`, "POST", rest);
      } catch (err) {
        if (err instanceof SignedOut) throw err;
        return { ended: "failed" };
      }
      const body = (await res.json().catch(() => null)) as {
        code?: unknown;
        replaces?: unknown;
        decided?: { applied?: unknown; replaced?: unknown; alsoClosed?: unknown };
      } | null;
      const tags = (x: unknown) =>
        Array.isArray(x) ? x.filter((r): r is string => typeof r === "string") : [];
      if (res.ok) {
        const d = body?.decided;
        return {
          ended: "done",
          applied: typeof d?.applied === "string" ? d.applied : null,
          replaced: tags(d?.replaced),
          alsoClosed: typeof d?.alsoClosed === "number" ? d.alsoClosed : 0,
        };
      }
      if (res.status === 404) return { ended: "gone" };
      if (res.status === 403) {
        // Anything else refused (the server's own check of where the request came from, say)
        // is not an answer about the item.
        return {
          ended:
            body?.code === "not-admin"
              ? "admin-only"
              : body?.code === "refused"
                ? "not-yours"
                : "failed",
        };
      }
      if (res.status === 409) {
        if (body?.code === "conflict") return { ended: "replace", replaces: tags(body.replaces) };
        return { ended: body?.code === "already-resolved" ? "gone" : "invalid" };
      }
      return { ended: res.status === 400 ? "invalid" : "failed" };
    },
    async audit(query, before) {
      const params = auditParams(query);
      if (before !== undefined) params.set("before", String(before));
      const body = (await get(`/api/admin/audit?${params.toString()}`)) as {
        events?: unknown;
        next?: unknown;
      } | null;
      if (!Array.isArray(body?.events)) throw new ApiError(200);
      return {
        events: body.events.map(asAuditEvent),
        next: typeof body.next === "number" ? body.next : null,
      };
    },
    async exportAudit(query, format) {
      const body = { ...Object.fromEntries(auditParams(query)), format };
      let res: Response;
      try {
        res = await send("/api/admin/audit/export", "POST", body);
      } catch (err) {
        if (err instanceof SignedOut) throw err;
        return { ended: "failed" };
      }
      if (res.ok) {
        // The name the server gave it, kept to what a file name may hold.
        const named = /filename="([\w.-]{1,64})"/.exec(
          res.headers.get("content-disposition") ?? "",
        );
        try {
          return { ended: "done", file: await res.blob(), name: named?.[1] ?? `audit.${format}` };
        } catch {
          return { ended: "failed" };
        }
      }
      const why = (await res.json().catch(() => null)) as {
        signIn?: unknown;
        field?: unknown;
      } | null;
      if (res.status === 400) {
        return { ended: "invalid", field: typeof why?.field === "string" ? why.field : null };
      }
      if (res.status !== 403) return { ended: "failed" };
      return { ended: typeof why?.signIn === "string" ? "sign-in-again" : "refused" };
    },
    async verifyAudit() {
      const res = await send("/api/admin/audit/verify", "POST", {});
      if (!res.ok) throw new ApiError(res.status);
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      if (body?.ok === true && n(body.count) !== null && typeof body.head === "string") {
        return { ok: true, count: n(body.count) as number, head: body.head };
      }
      if (body?.ok === false && n(body.count) !== null && n(body.seq) !== null) {
        return {
          ok: false,
          count: n(body.count) as number,
          seq: n(body.seq) as number,
          problem: typeof body.problem === "string" ? body.problem : "",
        };
      }
      throw new ApiError(200);
    },
    async vocabulary() {
      const body = (await get("/api/admin/vocabulary")) as Partial<Vocabulary> | null;
      if (!Array.isArray(body?.facets)) throw new ApiError(200);
      return { facets: body.facets.map(asFacet), cut: body.cut === true };
    },
    async signOut() {
      await ask("/auth/logout", "POST");
    },
  };
}

/**
 * A source as the pages use it. A row that isn't one means this isn't the server's answer; a
 * standing this app can't word (a newer server's) is kept as unknown, never dropped or shown as
 * fine.
 */
function asSource(x: unknown): Source {
  if (typeof x !== "object" || x === null) throw new ApiError(200);
  const s = x as Record<string, unknown>;
  if (typeof s.source !== "string" || typeof s.connector !== "string") throw new ApiError(200);
  const counts = s.lastCounts;
  return {
    source: s.source,
    connector: s.connector,
    standing: asStanding(s.standing),
    lastRunAt: typeof s.lastRunAt === "string" ? s.lastRunAt : null,
    lastCounts:
      typeof counts === "object" && counts !== null && !Array.isArray(counts)
        ? (counts as Record<string, number>)
        : null,
  };
}

function asStanding(x: unknown): Standing {
  const st = (typeof x === "object" && x !== null ? x : {}) as Record<string, unknown>;
  const is = typeof st.is === "string" ? st.is : "unknown";
  const whole =
    is === "held" || is === "confirmed"
      ? typeof st.count === "number" && Number.isFinite(st.count)
      : is === "stopped"
        ? typeof st.code === "string"
        : is === "retrying"
          ? st.code === null || typeof st.code === "string"
          : true;
  return (whole ? st : { is: "unknown" }) as Standing;
}

/** A client as the pages use it; a row that isn't one means this isn't the server's answer. */
function asClient(x: unknown): Client {
  if (typeof x !== "object" || x === null) throw new ApiError(200);
  const c = x as Record<string, unknown>;
  const status = c.status;
  if (
    typeof c.clientKey !== "string" ||
    (status !== "pending" && status !== "approved" && status !== "refused")
  ) {
    throw new ApiError(200);
  }
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    clientKey: c.clientKey,
    clientId: text(c.clientId),
    redirectUris: Array.isArray(c.redirectUris)
      ? c.redirectUris.filter((u): u is string => typeof u === "string")
      : [],
    status,
    trust: (TRUSTS as readonly unknown[]).includes(c.trust) ? (c.trust as Trust) : null,
    // Anything but the app's own is someone else's to decide: no buttons offered.
    managedBy: c.managedBy === "app" ? "app" : "config",
    configTrust: (TRUSTS as readonly unknown[]).includes(c.configTrust)
      ? (c.configTrust as Trust)
      : null,
    requestedAt: text(c.requestedAt),
    claimedName: text(c.claimedName) ?? "",
    people: typeof c.people === "number" && Number.isFinite(c.people) ? c.people : 0,
    lastUsedAt: text(c.lastUsedAt),
  };
}

const text = (v: unknown) => (typeof v === "string" ? v : null);

function asReviewItem(x: unknown): ReviewItem {
  if (typeof x !== "object" || x === null) throw new ApiError(200);
  const i = x as Record<string, unknown>;
  if (typeof i.id !== "string" || typeof i.tag !== "string") throw new ApiError(200);
  return {
    id: i.id,
    title: text(i.title) ?? "",
    tag: i.tag,
    reason: text(i.reason) ?? "",
    appliedBy: text(i.appliedBy),
    confidence:
      typeof i.confidence === "number" && Number.isFinite(i.confidence) ? i.confidence : 1,
    createdAt: text(i.createdAt),
    admin: i.admin === true,
  };
}

function asFacet(x: unknown): VocabularyFacet {
  if (typeof x !== "object" || x === null) throw new ApiError(200);
  const f = x as Record<string, unknown>;
  if (typeof f.key !== "string") throw new ApiError(200);
  return {
    key: f.key,
    label: text(f.label) ?? f.key,
    public: f.public === true,
    single: f.single === true,
    values: (Array.isArray(f.values) ? f.values : []).flatMap((y) => {
      if (typeof y !== "object" || y === null) return [];
      const v = y as Record<string, unknown>;
      if (typeof v.value !== "string" || typeof v.tag !== "string") return [];
      return [
        {
          value: v.value,
          tag: v.tag,
          label: text(v.label) ?? v.value,
          approved: v.approved === true,
          visibility: text(v.visibility),
          exposure: text(v.exposure),
          waiting: typeof v.waiting === "number" && Number.isFinite(v.waiting) ? v.waiting : 0,
        },
      ];
    }),
  };
}

/**
 * The query as the server reads it. Days are the browser's own: `from` is the start of that day
 * where the admin is, and `until` includes its day, so `to` is the start of the next one. The
 * server takes times with their zone (sent as UTC).
 */
export function auditParams(q: AuditQuery): URLSearchParams {
  const p = new URLSearchParams();
  if (q.actor) p.set("actor", q.actor);
  if (q.action) p.set("actionPrefix", q.action);
  if (q.decision) p.set("decision", q.decision);
  if (q.object) p.set("object", q.object);
  if (q.from) p.set("from", startOfDay(q.from, 0) ?? q.from);
  // Not a day: sent as it is, and the server says so.
  if (q.until) p.set("to", startOfDay(q.until, 1) ?? q.until);
  return p;
}

/** The start of `day` (`2026-10-01`) plus `add` days, where the browser is; null if not a day. */
function startOfDay(day: string, add: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const at = new Date(y, mo, d);
  if (at.getFullYear() !== y || at.getMonth() !== mo || at.getDate() !== d) return null;
  at.setDate(at.getDate() + add);
  return at.toISOString();
}

function asAuditEvent(x: unknown): AuditEvent {
  if (typeof x !== "object" || x === null) throw new ApiError(200);
  const e = x as Record<string, unknown>;
  if (
    typeof e.seq !== "number" ||
    typeof e.at !== "string" ||
    typeof e.actor !== "string" ||
    typeof e.action !== "string" ||
    (e.decision !== "allow" && e.decision !== "deny")
  ) {
    throw new ApiError(200);
  }
  const detail =
    typeof e.detail === "object" && e.detail !== null && !Array.isArray(e.detail)
      ? Object.fromEntries(
          Object.entries(e.detail as Record<string, unknown>).filter(
            (kv): kv is [string, string | number | boolean] =>
              ["string", "number", "boolean"].includes(typeof kv[1]),
          ),
        )
      : null;
  return {
    seq: e.seq,
    at: e.at,
    actor: e.actor,
    action: e.action,
    decision: e.decision,
    client: text(e.client),
    object: text(e.object),
    detail,
    hash: text(e.hash) ?? "",
  };
}
