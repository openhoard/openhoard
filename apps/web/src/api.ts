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

export interface Api {
  me(): Promise<Me>;
  sources(): Promise<Source[]>;
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
