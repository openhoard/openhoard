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

export interface Api {
  me(): Promise<Me>;
  sources(): Promise<Source[]>;
  signOut(): Promise<void>;
}

export function createApi(fetcher: typeof fetch): Api {
  async function ask(path: string, method: "GET" | "POST"): Promise<Response> {
    let res: Response;
    try {
      res = await fetcher(path, {
        method,
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
    } catch {
      throw new ApiError(0);
    }
    if (res.status === 401) throw new SignedOut();
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
