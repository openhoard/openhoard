import { describe, expect, it } from "vitest";
import { isTimeZone, periodRange, startOfDay } from "./time.js";

/* `recent`'s days, in the person's time zone. */

describe("time zones", () => {
  it("knows IANA zones and nothing else", () => {
    for (const zone of ["UTC", "America/Denver", "Asia/Kolkata", "Europe/Paris"]) {
      expect(isTimeZone(zone), zone).toBe(true);
    }
    for (const zone of ["", "Mars/Olympus", "x".repeat(65), "America/Denver\n"]) {
      expect(isTimeZone(zone), zone).toBe(false);
    }
  });

  it("starts days at local midnight, across DST changes and half-hour offsets", () => {
    const ny = "America/New_York";
    // The day DST starts (clocks jump 02:00 to 03:00): midnight is still EST.
    expect(startOfDay(new Date("2026-03-08T12:00:00Z"), ny).toISOString()).toBe(
      "2026-03-08T05:00:00.000Z",
    );
    expect(startOfDay(new Date("2026-03-08T12:00:00Z"), ny, 1).toISOString()).toBe(
      "2026-03-09T04:00:00.000Z",
    );
    // The day it ends: midnight is EDT, the next one EST.
    expect(startOfDay(new Date("2026-11-01T12:00:00Z"), ny).toISOString()).toBe(
      "2026-11-01T04:00:00.000Z",
    );
    expect(startOfDay(new Date("2026-11-01T12:00:00Z"), ny, 1).toISOString()).toBe(
      "2026-11-02T05:00:00.000Z",
    );
    // 20:00 UTC is already tomorrow in Kolkata (+05:30).
    expect(startOfDay(new Date("2026-09-25T20:00:00Z"), "Asia/Kolkata").toISOString()).toBe(
      "2026-09-25T18:30:00.000Z",
    );
  });

  it("turns named periods into [from, to) ranges", () => {
    const now = new Date("2026-09-26T15:00:00Z");
    const day = (iso: string) => new Date(iso);
    expect(periodRange("today", "UTC", now)).toEqual({
      from: day("2026-09-26T00:00:00Z"),
      to: day("2026-09-27T00:00:00Z"),
    });
    expect(periodRange("yesterday", "America/Denver", now)).toEqual({
      from: day("2026-09-25T06:00:00Z"),
      to: day("2026-09-26T06:00:00Z"),
    });
    expect(periodRange("last-7-days", "UTC", now).from).toEqual(day("2026-09-20T00:00:00Z"));
    expect(periodRange("last-30-days", "UTC", now).from).toEqual(day("2026-08-28T00:00:00Z"));
  });
});
