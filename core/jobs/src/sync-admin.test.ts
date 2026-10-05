import { describe, expect, it } from "vitest";
import { syncStanding } from "./sync-admin.js";

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
    for (const code of ["reconcile-guard", "delete-guard"]) {
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
    for (const lastError of ["reconcile-guard", "delete-guard", "source-identity"]) {
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
});
