import { describe, expect, it, vi } from "vitest";
import { ApiError, createApi, SignedOut } from "./api.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const FINANCE = {
  source: "finance",
  connector: "connector-sharepoint",
  standing: { is: "current" },
  lastRunAt: null,
  lastCounts: null,
};

describe("what the admin pages ask the server", () => {
  it("asks this origin, with the session, and gives what it answered", async () => {
    const me = {
      user: { id: "usr_1", displayName: "Ada", email: null, kind: "member" },
      tenantId: "ten_1",
      admin: true,
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input) === "/auth/me"
        ? json(me)
        : json({ sources: [FINANCE, { ...FINANCE, source: "legal", standing: { is: "held" } }] }),
    );
    const api = createApi(fetcher as typeof fetch);
    expect(await api.me()).toEqual(me);
    // A standing that can't be worded is kept as unknown, never dropped or shown as fine.
    expect(await api.sources()).toEqual([
      FINANCE,
      { ...FINANCE, source: "legal", standing: { is: "unknown" } },
    ]);
    expect(fetcher.mock.calls.map(([path, init]) => [path, init])).toEqual([
      [
        "/auth/me",
        { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } },
      ],
      [
        "/api/admin/sources",
        { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } },
      ],
    ]);
  });

  it("signs out with a POST", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    await createApi(fetcher as typeof fetch).signOut();
    expect(fetcher).toHaveBeenCalledWith(
      "/auth/logout",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("tells signed out from refused, failed and unreachable", async () => {
    const answering = (res: () => Response | Promise<Response>) =>
      createApi((async () => res()) as typeof fetch);
    await expect(
      answering(() => json({ error: "not signed in" }, 401)).me(),
    ).rejects.toBeInstanceOf(SignedOut);
    await expect(
      answering(() => json({ error: "forbidden" }, 403)).sources(),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      answering(() => json({ error: "internal error" }, 500)).me(),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      answering(() => Promise.reject(new TypeError("offline"))).me(),
    ).rejects.toMatchObject({
      status: 0,
      message: "the server could not be reached",
    });
    await expect(answering(() => json({}, 401)).signOut()).rejects.toBeInstanceOf(SignedOut);
  });

  it("doesn't take another server's answer for this one's", async () => {
    const answering = (res: () => Response) => createApi((async () => res()) as typeof fetch);
    // A proxy's sign-in page, a captive portal.
    await expect(
      answering(() => new Response("<html>", { status: 200 })).me(),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(answering(() => json({ hello: "world" })).me()).rejects.toBeInstanceOf(ApiError);
    await expect(answering(() => json(null)).me()).rejects.toBeInstanceOf(ApiError);
    await expect(answering(() => json({ sources: "many" })).sources()).rejects.toBeInstanceOf(
      ApiError,
    );
    for (const row of [null, { source: 7 }, { source: "x" }]) {
      await expect(answering(() => json({ sources: [row] })).sources()).rejects.toBeInstanceOf(
        ApiError,
      );
    }
  });
});
