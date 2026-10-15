import { describe, expect, it } from "vitest";
import { STALE_AFTER_MS, syncStanding } from "./sync-admin.js";

type State = Parameters<typeof syncStanding>[0];
const state = (over: Partial<State> = {}): State => ({
  phase: "delta",
  reconcileHeld: null,
  reconcileConfirmed: null,
  reconcileDeferred: false,
  stoppedAt: null,
  stoppedError: null,
  lastStatus: "done",
  lastError: null,
  lastCurrentAt: null,
  ...over,
});
const STOPPED = new Date("2026-10-04T00:00:00Z");

describe("where a source's sync stands", () => {
  it("is how the last run ended, while nothing waits on an admin", () => {
    expect(syncStanding(state())).toEqual({ is: "current" });
    expect(syncStanding(state({ lastStatus: null }))).toEqual({ is: "not-run" });
    expect(syncStanding(state({ phase: "crawl" }))).toEqual({ is: "reading" });
    expect(syncStanding(state({ phase: "crawl", lastStatus: "partial" }))).toEqual({
      is: "reading",
    });
    // A delta that ran out of time is not behind on anything unreadable: it continues.
    expect(syncStanding(state({ lastStatus: "partial" }))).toEqual({ is: "catching-up" });
    expect(syncStanding(state({ lastStatus: "cancelled" }))).toEqual({ is: "cancelled" });
    expect(syncStanding(state({ lastStatus: "retry", lastError: "throttled" }))).toEqual({
      is: "retrying",
      code: "throttled",
    });
    expect(syncStanding(state({ lastStatus: "retry" }))).toEqual({ is: "retrying", code: null });
  });

  it("tells a source that waits for its owner from one that will run by itself", () => {
    expect(syncStanding(state({ lastStatus: "retry", lastError: "unknown-owner" }))).toEqual({
      is: "waiting-for-owner",
    });
  });

  it("names a stop by what lifts it", () => {
    // The guards stop the source as they hold: the hold is what an admin decides, not a resume.
    for (const code of ["reconcile-guard"]) {
      expect(
        syncStanding(
          state({
            reconcileHeld: 1204,
            stoppedAt: STOPPED,
            stoppedError: code,
            lastStatus: "failed",
          }),
        ),
      ).toEqual({ is: "held", count: 1204 });
    }
    expect(
      syncStanding(
        state({ stoppedAt: STOPPED, stoppedError: "source-identity", lastStatus: "failed" }),
      ),
    ).toEqual({ is: "identity-changed" });
    expect(
      syncStanding(state({ stoppedAt: STOPPED, stoppedError: "auth", lastStatus: "failed" })),
    ).toEqual({ is: "stopped", code: "auth" });
    expect(syncStanding(state({ stoppedAt: STOPPED }))).toEqual({ is: "stopped", code: "failed" });
  });

  it("puts a stop for another cause before a hold: deciding the hold wouldn't lift it", () => {
    expect(
      syncStanding(
        state({ reconcileHeld: 60, stoppedAt: STOPPED, stoppedError: "source-identity" }),
      ),
    ).toEqual({ is: "identity-changed" });
    expect(
      syncStanding(state({ reconcileHeld: 60, stoppedAt: STOPPED, stoppedError: "auth" })),
    ).toEqual({ is: "stopped", code: "auth" });
  });

  it("is reading again after a discard or an accepted identity, not retrying what was settled", () => {
    for (const lastError of ["reconcile-guard", "source-identity"]) {
      expect(syncStanding(state({ phase: "crawl", lastStatus: "failed", lastError }))).toEqual({
        is: "reading",
      });
    }
  });

  it("doesn't call a source current while a clean-up is deferred", () => {
    expect(syncStanding(state({ reconcileDeferred: true }))).toEqual({ is: "deferred" });
    // The crawl that settles it is under way.
    expect(syncStanding(state({ reconcileDeferred: true, phase: "crawl" }))).toEqual({
      is: "reading",
    });
    expect(
      syncStanding(state({ reconcileDeferred: true, stoppedAt: STOPPED, stoppedError: "auth" })),
    ).toEqual({ is: "stopped", code: "auth" });
  });

  it("follows a hold through an admin's decision", () => {
    // Resumed by hand with the hold undecided: still held (the next run holds it again).
    expect(syncStanding(state({ reconcileHeld: 9, lastStatus: "failed" }))).toEqual({
      is: "held",
      count: 9,
    });
    // Confirmed: the schedule runs again, and the next sync removes them.
    expect(
      syncStanding(state({ reconcileHeld: 9, reconcileConfirmed: 9, lastStatus: "failed" })),
    ).toEqual({ is: "confirmed", count: 9 });
    // More went missing than was confirmed: held again, for the larger count.
    expect(
      syncStanding(
        state({
          reconcileHeld: 12,
          reconcileConfirmed: 9,
          stoppedAt: STOPPED,
          stoppedError: "reconcile-guard",
          lastStatus: "failed",
        }),
      ),
    ).toEqual({ is: "held", count: 12 });
    // Confirmed, then stopped for something else: that comes first.
    expect(
      syncStanding(
        state({
          reconcileHeld: 9,
          reconcileConfirmed: 9,
          stoppedAt: STOPPED,
          stoppedError: "auth",
        }),
      ),
    ).toEqual({ is: "stopped", code: "auth" });
    // Resumed after a failure, not run since.
    expect(syncStanding(state({ lastStatus: "failed", lastError: "auth" }))).toEqual({
      is: "retrying",
      code: "auth",
    });
  });

  it("is stale when the catalog last matched the source too long ago, and nothing waits", () => {
    const now = new Date("2026-10-14T12:00:00Z");
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const at = { now };
    // Within the day: as before.
    expect(syncStanding(state({ lastCurrentAt: ago(STALE_AFTER_MS) }), at)).toEqual({
      is: "current",
    });
    // Past it: stale, whether the last run finished (the schedule since stopped running) or
    // every run since ended early, with why.
    const since = ago(STALE_AFTER_MS + 1);
    expect(syncStanding(state({ lastCurrentAt: since }), at)).toEqual({
      is: "stale",
      since,
      code: null,
    });
    expect(
      syncStanding(
        state({ lastCurrentAt: since, lastStatus: "retry", lastError: "throttled" }),
        at,
      ),
    ).toEqual({ is: "stale", since, code: "throttled" });
    for (const lastStatus of ["partial", "cancelled"] as const) {
      expect(syncStanding(state({ lastCurrentAt: since, lastStatus }), at).is).toBe("stale");
    }
    // The source's own limit.
    expect(
      syncStanding(state({ lastCurrentAt: ago(2 * 3_600_000) }), {
        now,
        staleAfterMs: 3_600_000,
      }).is,
    ).toBe("stale");
    // What waits on an admin, or on the owner, comes first; never up to date isn't stale.
    expect(
      syncStanding(state({ lastCurrentAt: since, stoppedAt: STOPPED, stoppedError: "auth" }), at),
    ).toEqual({ is: "stopped", code: "auth" });
    expect(
      syncStanding(
        state({ lastCurrentAt: since, lastStatus: "retry", lastError: "unknown-owner" }),
        at,
      ),
    ).toEqual({ is: "waiting-for-owner" });
    expect(syncStanding(state({ lastCurrentAt: since, reconcileHeld: 3 }), at)).toEqual({
      is: "held",
      count: 3,
    });
    expect(syncStanding(state({ phase: "crawl" }), at)).toEqual({ is: "reading" });
    // A deferred reconcile or confirmed removals don't stop the schedule: they can fall behind.
    expect(syncStanding(state({ lastCurrentAt: since, reconcileDeferred: true }), at).is).toBe(
      "stale",
    );
    expect(
      syncStanding(state({ lastCurrentAt: since, reconcileHeld: 3, reconcileConfirmed: 3 }), at).is,
    ).toBe("stale");
    expect(syncStanding(state({ lastCurrentAt: now, reconcileDeferred: true }), at).is).toBe(
      "deferred",
    );
  });

  it("is unavailable when the server couldn't start the source, whatever was stored", () => {
    expect(syncStanding(state(), { unavailable: "no-credential" })).toEqual({
      is: "unavailable",
      code: "no-credential",
    });
    expect(
      syncStanding(state({ stoppedAt: STOPPED, stoppedError: "auth" }), {
        unavailable: "no-credential",
      }),
    ).toEqual({ is: "unavailable", code: "no-credential" });
  });
});
