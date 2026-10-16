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

/** Where a client stands for an admin (core/identity CLIENT_STANDINGS). */
export const CLIENT_STANDINGS = [
  /** Nobody decided, and it gets nothing. */
  "waiting",
  /** It gets tokens, and admins here decide. */
  "approved",
  /** It gets tokens because the server's config lists it: the config decides. */
  "approved-by-config",
  /** An admin refused or revoked it. */
  "refused",
  /** The config approved it and no longer lists it: it gets nothing until approved here. */
  "lapsed",
] as const;
export type ClientStanding = (typeof CLIENT_STANDINGS)[number];

/** An AI client, as GET /api/admin/clients gives it (what the pages use of it). */
export interface Client {
  clientKey: string;
  /** What identifies it: its metadata document's URL, or (null) the addresses below. */
  clientId: string | null;
  /** Where a sign-in through it returns to. */
  redirectUris: string[];
  status: "pending" | "approved" | "refused";
  /**
   * Where it stands, as the server decides it (core/identity clientStanding()); `unknown` for a
   * standing this app can't word (a newer server's).
   */
  standing: ClientStanding | "unknown";
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

/** A File Health Report finding, worded by the server (core/catalog healthPage()). */
export interface HealthFinding {
  section: string;
  heading: string;
  advice: string;
  count: number;
  size: string | null;
  also: string | null;
  items: {
    objectId: string;
    title: string;
    url: string | null;
    size: string | null;
    why: string;
  }[];
  more: number;
}

export interface HealthReportPage {
  generatedAt: string;
  files: number;
  looked: string;
  summary: string;
  oneThing: string | null;
  findings: HealthFinding[];
  clean: string[];
  gaps: string[];
  thresholds: { staleAfterDays: number; largeBytes: number };
}

/** What the report is judged by; unset, the server's defaults (3 years, 1 GB). */
export interface HealthQuery {
  staleDays?: number;
  largeMb?: number;
}

/** How the sheet's download ended; `cut`: files past 10,000 in a finding, left out. */
export type HealthSheet =
  | { ended: "done"; file: Blob; name: string; cut: number }
  | { ended: "sign-in-again" | "refused" | "invalid" | "failed" };

/** A file a source's syncs left out, and why (GET /api/admin/sources/:source/skips). */
export interface SourceSkip {
  externalId: string;
  /** A code: `too-large`, `invalid-acl`, `ingest-…`, a connector warning's. */
  reason: string;
  /** Where it is in its source, its own name last; null when the sync didn't know. */
  path: string[] | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface SourceSkips {
  /** How many are left out, of every reason. */
  total: number;
  byReason: Record<string, number>;
  /** The most recently met first; a page of them. */
  skips: SourceSkip[];
}

/** Where a tenant's files are kept (GET /api/admin/storage). */
export interface Storage {
  kind: "local" | "s3" | "azblob";
  /** Bucket, region, endpoint, prefix, accessKeyId; account and container: never a key. */
  settings: Record<string, string>;
  hasSecret: boolean;
  phase: "moving" | "active" | "cleaning";
  previous: { kind: "local" | "s3" | "azblob"; settings: Record<string, string> } | null;
  total: number;
  done: number;
  failed: number;
  /** Files in neither place: lost before the move. */
  lost: number;
  lastError: string | null;
  changedAt: string | null;
  changedBy: string | null;
  /** Who chose it, by name, when that was a person. */
  changedByName: string | null;
  /** Whether this server lets storage be changed at all. */
  available: boolean;
  /** Whether endpoints other than S3's and Azure's own may be named. */
  allowEndpoints: boolean;
  /** Whether this server keeps files (uploads or mail-in on). */
  keepsFiles: boolean;
}

/** A place to keep files, as the form sends it. */
export type StorageChoice =
  | { kind: "local" }
  | {
      kind: "s3";
      bucket: string;
      region: string;
      endpoint?: string;
      prefix?: string;
      accessKeyId: string;
      secretAccessKey?: string;
    }
  | {
      kind: "azblob";
      accountName: string;
      container: string;
      endpoint?: string;
      prefix?: string;
      accountKey?: string;
    };

export type ProbeProblem =
  | "not-found"
  | "denied"
  | "cant-list"
  | "wrong-region"
  | "unreachable"
  | "busy"
  | "mismatch"
  | "timeout"
  | "failed";

/** How trying a place went, step by step. */
export interface Probe {
  ok: boolean;
  steps: {
    step: "check" | "write" | "read" | "delete";
    ok: boolean;
    problem?: ProbeProblem;
    code?: string;
  }[];
}

/** How asking for something about storage ended. */
export type StorageAsked =
  | { ended: "done"; outcome?: "unchanged" | "rekeyed" | "moving" }
  | { ended: "tested"; probe: Probe }
  | { ended: "probe-failed"; probe: Probe }
  | { ended: "invalid"; field: string | null; message: string }
  | { ended: "busy"; message: string }
  | { ended: "sign-in-again" | "refused" | "failed" };

export interface Api {
  me(): Promise<Me>;
  storage(): Promise<Storage>;
  testStorage(choice: StorageChoice): Promise<StorageAsked>;
  keepStorage(choice: StorageChoice): Promise<StorageAsked>;
  retryStorageMove(): Promise<StorageAsked>;
  removeOldCopies(): Promise<StorageAsked>;
  sourceSkips(source: string, reason?: string): Promise<SourceSkips>;
  health(query: HealthQuery): Promise<HealthReportPage>;
  exportHealth(query: HealthQuery): Promise<HealthSheet>;
  /** An admin's verdict: this flagged file is not an injection (its flag comes off). */
  dismissInjection(objectId: string): Promise<Changed>;
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
  /** A POST about storage, and how it ended. `test`: a 200 is a probe's answer. */
  async function askStorage(path: string, body: object, test: boolean): Promise<StorageAsked> {
    let res: Response;
    try {
      res = await send(path, "POST", body);
    } catch (err) {
      if (err instanceof SignedOut) throw err;
      return { ended: "failed" };
    }
    const why = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok) {
      if (test) {
        const probe = asProbe(why);
        return probe === null ? { ended: "failed" } : { ended: "tested", probe };
      }
      const outcome = why?.outcome;
      return outcome === "unchanged" || outcome === "rekeyed" || outcome === "moving"
        ? { ended: "done", outcome }
        : { ended: "done" };
    }
    const message = typeof why?.error === "string" ? why.error : "";
    if (res.status === 400) {
      return {
        ended: "invalid",
        field: typeof why?.field === "string" ? why.field : null,
        message,
      };
    }
    if (res.status === 409) {
      const probe = asProbe(why?.probe);
      return probe !== null ? { ended: "probe-failed", probe } : { ended: "busy", message };
    }
    if (res.status === 403) {
      return { ended: typeof why?.signIn === "string" ? "sign-in-again" : "refused" };
    }
    return { ended: "failed" };
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
    async dismissInjection(objectId) {
      if (!/^obj_[0-9a-z]{26}$/.test(objectId)) return "failed";
      let res: Response;
      try {
        res = await send(`/api/admin/files/${objectId}/not-injection`, "POST", {});
      } catch (err) {
        if (err instanceof SignedOut) throw err;
        return "failed";
      }
      if (res.ok) return "done";
      if (res.status === 404) return "gone";
      if (res.status !== 403) return "failed";
      const why = (await res.json().catch(() => null)) as { signIn?: unknown } | null;
      return typeof why?.signIn === "string" ? "sign-in-again" : "refused";
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
    async sourceSkips(source, reason) {
      const params = new URLSearchParams({ limit: "100" });
      if (reason !== undefined) params.set("reason", reason);
      const body = (await get(
        `/api/admin/sources/${encodeURIComponent(source)}/skips?${params.toString()}`,
      )) as Record<string, unknown> | null;
      const byReason = body?.byReason;
      if (
        typeof body?.total !== "number" ||
        typeof byReason !== "object" ||
        byReason === null ||
        !Array.isArray(body.skips)
      ) {
        throw new ApiError(200);
      }
      return {
        total: body.total,
        byReason: Object.fromEntries(
          Object.entries(byReason as Record<string, unknown>).filter(
            (kv): kv is [string, number] => typeof kv[1] === "number" && Number.isFinite(kv[1]),
          ),
        ),
        skips: body.skips.map((x: unknown) => {
          const k = (typeof x === "object" && x !== null ? x : {}) as Record<string, unknown>;
          if (
            typeof k.externalId !== "string" ||
            typeof k.reason !== "string" ||
            typeof k.firstSeenAt !== "string" ||
            typeof k.lastSeenAt !== "string"
          ) {
            throw new ApiError(200);
          }
          const path =
            Array.isArray(k.path) && k.path.every((n) => typeof n === "string")
              ? (k.path as string[])
              : null;
          return {
            externalId: k.externalId,
            reason: k.reason,
            path,
            firstSeenAt: k.firstSeenAt,
            lastSeenAt: k.lastSeenAt,
          };
        }),
      };
    },
    async storage() {
      const b = (await get("/api/admin/storage")) as Record<string, unknown> | null;
      const kinds = ["local", "s3", "azblob"];
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      const settings = (v: unknown) =>
        typeof v === "object" && v !== null && !Array.isArray(v)
          ? Object.fromEntries(
              Object.entries(v as Record<string, unknown>).filter(
                (kv): kv is [string, string] => typeof kv[1] === "string",
              ),
            )
          : {};
      if (
        !b ||
        !kinds.includes(b.kind as string) ||
        !["moving", "active", "cleaning"].includes(b.phase as string)
      ) {
        throw new ApiError(200);
      }
      const prev = b.previous as Record<string, unknown> | null | undefined;
      return {
        kind: b.kind as Storage["kind"],
        settings: settings(b.settings),
        hasSecret: b.hasSecret === true,
        phase: b.phase as Storage["phase"],
        previous:
          prev && kinds.includes(prev.kind as string)
            ? { kind: prev.kind as Storage["kind"], settings: settings(prev.settings) }
            : null,
        total: n(b.total),
        done: n(b.done),
        failed: n(b.failed),
        lost: n(b.lost),
        lastError: text(b.lastError),
        changedAt: text(b.changedAt),
        changedBy: text(b.changedBy),
        changedByName: text(b.changedByName),
        available: b.available === true,
        allowEndpoints: b.allowEndpoints === true,
        keepsFiles: b.keepsFiles === true,
      };
    },
    testStorage: (choice) => askStorage("/api/admin/storage/test", { choice }, true),
    keepStorage: (choice) => askStorage("/api/admin/storage", { choice }, false),
    retryStorageMove: () => askStorage("/api/admin/storage/retry", {}, false),
    removeOldCopies: () => askStorage("/api/admin/storage/remove-old", {}, false),
    async health(query) {
      // A POST: reading it is recorded (the server's Origin check keeps other sites out).
      const res = await send("/api/admin/health", "POST", query);
      if (!res.ok) throw new ApiError(res.status);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new ApiError(res.status);
      }
      return asHealthPage(body);
    },
    async exportHealth(query) {
      let res: Response;
      try {
        res = await send("/api/admin/health/export", "POST", query);
      } catch (err) {
        if (err instanceof SignedOut) throw err;
        return { ended: "failed" };
      }
      if (res.ok) {
        const named = /filename="([\w.-]{1,64})"/.exec(
          res.headers.get("content-disposition") ?? "",
        );
        const cut = Number(res.headers.get("x-report-cut") ?? "0");
        try {
          return {
            ended: "done",
            file: await res.blob(),
            name: named?.[1] ?? "file-health.csv",
            cut: Number.isSafeInteger(cut) && cut > 0 ? cut : 0,
          };
        } catch {
          return { ended: "failed" };
        }
      }
      if (res.status === 400) return { ended: "invalid" };
      if (res.status !== 403) return { ended: "failed" };
      const why = (await res.json().catch(() => null)) as { signIn?: unknown } | null;
      return { ended: typeof why?.signIn === "string" ? "sign-in-again" : "refused" };
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
    standing: (CLIENT_STANDINGS as readonly unknown[]).includes(c.standing)
      ? (c.standing as ClientStanding)
      : "unknown",
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

function asHealthPage(x: unknown): HealthReportPage {
  if (typeof x !== "object" || x === null) throw new ApiError(200);
  const b = x as Record<string, unknown>;
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const clean = strings(b.clean);
  const gaps = strings(b.gaps);
  const t = b.thresholds as Record<string, unknown> | null | undefined;
  if (
    typeof b.looked !== "string" ||
    typeof b.summary !== "string" ||
    typeof b.generatedAt !== "string" ||
    num(b.files) === null ||
    !Array.isArray(b.findings) ||
    clean === null ||
    gaps === null ||
    num(t?.staleAfterDays) === null ||
    num(t?.largeBytes) === null
  ) {
    throw new ApiError(200);
  }
  return {
    generatedAt: b.generatedAt,
    files: b.files as number,
    looked: b.looked,
    summary: b.summary,
    oneThing: text(b.oneThing),
    findings: b.findings.map(asHealthFinding),
    clean,
    gaps,
    thresholds: {
      staleAfterDays: t?.staleAfterDays as number,
      largeBytes: t?.largeBytes as number,
    },
  };
}

function asHealthFinding(x: unknown): HealthFinding {
  if (typeof x !== "object" || x === null) throw new ApiError(200);
  const f = x as Record<string, unknown>;
  if (
    typeof f.section !== "string" ||
    typeof f.heading !== "string" ||
    typeof f.advice !== "string" ||
    typeof f.count !== "number" ||
    typeof f.more !== "number" ||
    !Array.isArray(f.items)
  ) {
    throw new ApiError(200);
  }
  return {
    section: f.section,
    heading: f.heading,
    advice: f.advice,
    count: f.count,
    size: text(f.size),
    also: text(f.also),
    more: f.more,
    items: f.items.map((i: unknown) => {
      const it = (typeof i === "object" && i !== null ? i : {}) as Record<string, unknown>;
      if (typeof it.objectId !== "string" || typeof it.title !== "string") {
        throw new ApiError(200);
      }
      return {
        objectId: it.objectId,
        title: it.title,
        url: text(it.url),
        size: text(it.size),
        why: typeof it.why === "string" ? it.why : "",
      };
    }),
  };
}

const PROBLEMS = [
  "not-found",
  "denied",
  "cant-list",
  "wrong-region",
  "unreachable",
  "busy",
  "mismatch",
  "timeout",
  "failed",
] as const;

function asProbe(x: unknown): Probe | null {
  if (typeof x !== "object" || x === null) return null;
  const p = x as Record<string, unknown>;
  if (typeof p.ok !== "boolean" || !Array.isArray(p.steps)) return null;
  const steps: Probe["steps"] = [];
  for (const raw of p.steps) {
    const s = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    if (
      (s.step !== "check" && s.step !== "write" && s.step !== "read" && s.step !== "delete") ||
      typeof s.ok !== "boolean"
    ) {
      return null;
    }
    steps.push({
      step: s.step,
      ok: s.ok,
      ...((PROBLEMS as readonly unknown[]).includes(s.problem)
        ? { problem: s.problem as ProbeProblem }
        : s.ok
          ? {}
          : { problem: "failed" as const }),
      ...(typeof s.code === "string" && /^[A-Za-z]{1,64}$/.test(s.code) ? { code: s.code } : {}),
    });
  }
  return { ok: p.ok, steps };
}
