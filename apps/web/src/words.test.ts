import { describe, expect, it } from "vitest";
import type { Source, Standing } from "./api.js";
import { connectorName, count, countsText, sourceStatus, unmatchedText, when } from "./words.js";

const TENANT = "ten_01m45hkvykz3eb5pzgkjvmqh14";
const standing = (s: Standing, over: Partial<Source> = {}): Source => ({
  source: "finance",
  connector: "connector-sharepoint",
  standing: s,
  lastRunAt: "2026-10-05T07:00:00.000Z",
  lastCounts: null,
  ...over,
});
const said = (s: Standing) => sourceStatus(standing(s), TENANT);

describe("a source's sync in an admin's words", () => {
  it("says how it is going, when nothing waits on anyone", () => {
    expect(said({ is: "current" })).toEqual({ tone: "ok", text: "Up to date." });
    for (const is of ["not-run", "reading", "catching-up", "cancelled"] as const) {
      const status = said({ is });
      expect(status.tone, is).toBe("busy");
      expect(status.steps, is).toBeUndefined();
    }
    expect(said({ is: "catching-up" }).text).toBe("Catching up on changes at the source.");
    expect(said({ is: "retrying", code: "throttled" }).text).toBe(
      "The last sync ended early (throttled). It is tried again by itself.",
    );
    expect(said({ is: "retrying", code: null }).text).toBe(
      "The last sync ended early. It is tried again by itself.",
    );
    expect(said({ is: "confirmed", count: 3 })).toEqual({
      tone: "busy",
      text: "3 files no longer at the source are being removed here, as an admin confirmed.",
    });
  });

  it("gives what waits on someone the command that settles it, whole", () => {
    const held = said({ is: "held", count: 1204 });
    expect(held.tone).toBe("attention");
    expect(held.text).toContain("1,204 files here are no longer at the source");
    expect(held.steps?.map((s) => s.command)).toEqual([
      `openhoard admin source confirm-reconcile --tenant ${TENANT} --source finance`,
      `openhoard admin source discard-reconcile --tenant ${TENANT} --source finance`,
    ]);
    // Discarding is not "keep them": the source is read again, and may be held again.
    expect(held.steps?.[1]?.does).toContain("read the source again from the beginning");
    expect(said({ is: "held", count: 1 }).text).toContain("1 file here is no longer");

    const other = said({ is: "identity-changed" });
    expect(other.tone).toBe("attention");
    expect(other.steps?.map((s) => s.command)).toEqual([
      `openhoard admin source accept-identity --tenant ${TENANT} --source finance`,
    ]);

    const stopped = said({ is: "stopped", code: "auth" });
    expect(stopped.tone).toBe("attention");
    expect(stopped.text).toContain("(auth)");
    expect(stopped.steps?.map((s) => s.command)).toEqual([
      `openhoard admin source resume --tenant ${TENANT} --source finance`,
    ]);

    const deferred = said({ is: "deferred" });
    expect(deferred.tone).toBe("attention");
    expect(deferred.steps?.map((s) => s.command)).toEqual([
      `openhoard admin source discard-reconcile --tenant ${TENANT} --source finance`,
    ]);

    // Nothing to run: someone has to sign in.
    const waiting = said({ is: "waiting-for-owner" });
    expect(waiting.tone).toBe("attention");
    expect(waiting.steps).toBeUndefined();
    expect(waiting.text).toContain("has signed in to OpenHoard once");
  });

  it("never calls a state it doesn't know fine", () => {
    const unknown = said({ is: "quarantined" } as unknown as Standing);
    expect(unknown).toEqual({ tone: "busy", text: "State: quarantined." });
  });

  it("counts what the last sync did, leaving out what it didn't", () => {
    expect(countsText(null)).toBeNull();
    expect(countsText({ files: 3, folders: 2, ingested: 0, unchanged: 0 })).toBeNull();
    expect(
      countsText({ ingested: 1, unchanged: 1500, deleted: 2, reconciled: 1, skipped: 4 }),
    ).toBe("1 file recorded, 1,500 unchanged, 3 removed, 4 left out");
    // Not a number: not shown as one.
    expect(countsText({ ingested: Number.NaN })).toBeNull();
  });

  it("says who the source knows and OpenHoard doesn't", () => {
    expect(unmatchedText(null)).toBeNull();
    expect(unmatchedText({ unmappedUsers: 0, unmappedGroups: 0 })).toBeNull();
    expect(unmatchedText({ unmappedUsers: 12, unmappedGroups: 3 })).toBe(
      "The source gives access to 12 people and 3 groups OpenHoard doesn't know yet. Until they are added to OpenHoard, that access doesn't apply here.",
    );
    expect(unmatchedText({ unmappedGroups: 1 })).toBe(
      "The source gives access to 1 group OpenHoard doesn't know yet. Until that group is added to OpenHoard, that access doesn't apply here.",
    );
    expect(unmatchedText({ unmappedUsers: 1 })).toContain("Until that person is added");
    // The server stops counting there.
    expect(unmatchedText({ unmappedUsers: 10_000 })).toContain("at least 10,000 people");
  });

  it("names connectors and times for people", () => {
    expect(connectorName("connector-sharepoint")).toBe("SharePoint");
    expect(connectorName("connector-fs")).toBe("A folder on the server");
    expect(connectorName("connector-box")).toBe("connector-box");
    expect(count(1, "person", "people")).toBe("1 person");
    expect(count(2, "group")).toBe("2 groups");
    expect(when("2026-10-05T07:00:00.000Z", "en-GB")).toMatch(/5 Oct 2026/);
    expect(when("not a time")).toBe("not a time");
  });
});
