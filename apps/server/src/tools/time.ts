/*
 * Days in the caller's time zone, for `recent` ("yesterday" means the person's yesterday, not
 * the server's). The zone is an IANA name the client passes (most assistants know the user's);
 * without one, UTC. Built on Intl only: no zone data of our own to go stale.
 */

export const PERIODS = ["today", "yesterday", "last-7-days", "last-30-days"] as const;
export type Period = (typeof PERIODS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether `zone` is an IANA time zone this runtime knows. */
export function isTimeZone(zone: string): boolean {
  if (zone.length === 0 || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock date and time in `zone` at `at`, as if it were UTC (milliseconds). */
function wallClock(at: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
}

/**
 * The instant local midnight starts the day `days` after the one `at` falls on, in `zone`
 * (days may be negative). Offsets are found at the answer itself, twice, so a day that starts
 * or ends a DST change still starts at its real midnight (or the first moment after a gap).
 */
export function startOfDay(at: Date, zone: string, days = 0): Date {
  const local = wallClock(at.getTime(), zone);
  const midnight = Math.floor(local / DAY_MS) * DAY_MS + days * DAY_MS;
  let guess = midnight - (wallClock(midnight, zone) - midnight);
  guess = midnight - (wallClock(guess, zone) - guess);
  return new Date(guess);
}

/** A named period as [from, to) in `zone`, relative to `now`. */
export function periodRange(period: Period, zone: string, now: Date): { from: Date; to: Date } {
  switch (period) {
    case "today":
      return { from: startOfDay(now, zone), to: startOfDay(now, zone, 1) };
    case "yesterday":
      return { from: startOfDay(now, zone, -1), to: startOfDay(now, zone) };
    case "last-7-days":
      return { from: startOfDay(now, zone, -6), to: startOfDay(now, zone, 1) };
    case "last-30-days":
      return { from: startOfDay(now, zone, -29), to: startOfDay(now, zone, 1) };
  }
}
