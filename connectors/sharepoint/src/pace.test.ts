import { describe, expect, it } from "vitest";
import { costOf, pacer, sharedPacer, type Pacer } from "./pace.js";

/* T-306: a budget of Graph's resource units, spent before a request is sent. */

const never = new AbortController().signal;

/** A pacer on a clock that sleeping moves. */
function paced(unitsPerMinute: number) {
  const clock = { now: 1_000_000 };
  const p = pacer({
    unitsPerMinute,
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
  });
  return { p, clock };
}
/** Takes `n` turns of `cost` and says how long that took, in seconds. */
async function spend(p: Pacer, clock: { now: number }, n: number, cost = 1): Promise<number> {
  const start = clock.now;
  for (let i = 0; i < n; i++) await p.turn(cost, never);
  return (clock.now - start) / 1000;
}

describe("a budget of requests", () => {
  it("lets a burst through, then as many units a minute as it was given", async () => {
    const { p, clock } = paced(600); // 10 units a second, 100 at once
    expect(await spend(p, clock, 100)).toBe(0);
    // The next 600 units take a minute, whatever each request costs.
    expect(await spend(p, clock, 600)).toBeCloseTo(60, 0);
    expect(await spend(p, clock, 120, 5)).toBeCloseTo(60, 0);
    // Unspent time fills the burst again, and no more than the burst.
    clock.now += 3_600_000;
    expect(await spend(p, clock, 100)).toBe(0);
    expect(await spend(p, clock, 10)).toBeCloseTo(1, 0);
    // A request that costs more than the burst still goes, once the burst is full.
    clock.now += 3_600_000;
    expect(await spend(p, clock, 1, 500)).toBe(0);
    expect(await spend(p, clock, 1)).toBeGreaterThan(40);
    expect(() => pacer({ unitsPerMinute: 0 })).toThrow(RangeError);
  });

  it("stops for as long as Graph said, then goes at half the rate, and finds its way back", async () => {
    const { p, clock } = paced(600);
    await spend(p, clock, 100);
    p.throttled(20_000);
    expect(p.rate).toBe(0.5);
    expect(p.allowance).toBe(300);
    expect(p.waitFor(1)).toBeGreaterThanOrEqual(20_000);
    // Nothing for the 20 s it was told, and what follows at 5 a second, not in a burst.
    expect(await spend(p, clock, 1)).toBeCloseTo(20, 0);
    expect(await spend(p, clock, 100)).toBeCloseTo(20, 0);
    // Requests already on their way meet the same throttle: one pause halves once.
    p.throttled(10_000);
    p.throttled(10_000);
    p.throttled(0);
    expect(p.rate).toBe(0.25);
    clock.now += 10_000;
    // Throttled again and again, pause after pause: never less than a tenth.
    for (let i = 0; i < 10; i++) {
      p.throttled(1000);
      clock.now += 1000;
    }
    expect(p.rate).toBe(0.1);
    // A wait of days (a clock gone wrong, something in between) stops it an hour, no more.
    p.throttled(30 * 86_400_000);
    expect(p.waitFor(1)).toBeLessThanOrEqual(3_600_000);
    clock.now += 3_600_000;
    expect(p.rate).toBe(0.1);
    // Every 50 answers without a throttle give a tenth back...
    for (let i = 0; i < 49; i++) p.answered();
    expect(p.rate).toBe(0.1);
    p.answered();
    expect(p.rate).toBeCloseTo(0.2);
    // ...and so does every minute without one, asked or not.
    clock.now += 3 * 60_000;
    expect(p.rate).toBeCloseTo(0.5);
    expect(p.allowance).toBeCloseTo(300);
    clock.now += 3_600_000;
    expect(p.rate).toBe(1);
  });

  it("gives up a turn that would take longer than its caller may wait, saying how long", async () => {
    const { p, clock } = paced(600);
    await spend(p, clock, 100);
    // An ordinary wait for the budget is taken, whatever the limit.
    await p.turn(1, never, 0);
    p.throttled(120_000);
    const refused = await p.turn(1, never, 60_000).catch((e: unknown) => e);
    expect(refused).toMatchObject({ name: "PaceWait", waitMs: 120_000 });
    // Within the limit it waits; and a throttle someone else meets meanwhile is counted too.
    const start = clock.now;
    await p.turn(1, never, 120_000);
    expect(clock.now - start).toBeGreaterThanOrEqual(120_000);
    await spend(p, clock, 100);
    const waiting = p.turn(50, never, 30_000).catch((e: unknown) => e);
    p.throttled(300_000);
    expect(await waiting).toMatchObject({ name: "PaceWait" });
  });

  it("halves its rate while Graph warns that most of the limit is used", async () => {
    const { p, clock } = paced(600);
    await spend(p, clock, 100);
    p.answered({ share: 0.5, resetMs: 30_000 });
    expect(await spend(p, clock, 100)).toBeCloseTo(10, 0);
    p.answered({ share: 0.1, resetMs: 30_000 });
    // Half as fast for the 30 s the warning lasts, then as before.
    expect(await spend(p, clock, 150)).toBeCloseTo(30, 0);
    expect(await spend(p, clock, 100)).toBeCloseTo(10, 0);
  });

  it("serves callers in the order they came, and lets go of one whose signal aborts", async () => {
    const { p, clock } = paced(60); // one a second, ten at once
    await spend(p, clock, 10);
    const order: string[] = [];
    const stop = new AbortController();
    const a = p.turn(1, never).then(() => order.push("a"));
    const gone = p.turn(1, stop.signal).then(
      () => order.push("gone"),
      () => order.push("aborted"),
    );
    const b = p.turn(1, never).then(() => order.push("b"));
    stop.abort(new Error("stop"));
    await Promise.all([a, gone, b]);
    // The one that left did so at once, without waiting for those ahead; the rest kept order.
    expect(order).toEqual(["aborted", "a", "b"]);
  });

  it("is one for an app in a tenant, whoever asks for it", () => {
    const one = sharedPacer("https://graph.test|contoso|app-1", { unitsPerMinute: 60 });
    expect(sharedPacer("https://graph.test|contoso|app-1", { unitsPerMinute: 6000 })).toBe(one);
    expect(sharedPacer("https://graph.test|contoso|app-2")).not.toBe(one);
  });
});

describe("what a request costs", () => {
  it("is Graph's: five for permissions, two for a list, one for an item", () => {
    const g = "https://graph.test/v1.0";
    expect(costOf(`${g}/drives/d/items/i/permissions`)).toBe(5);
    expect(costOf(`${g}/drives/d/items/i/permissions?$skiptoken=x`)).toBe(5);
    expect(costOf(`${g}/drives/d/items/i/children?$top=200`)).toBe(2);
    expect(costOf(`${g}/sites/s/drives?$select=id`)).toBe(2);
    expect(costOf(`${g}/drives/d/root/delta?$top=200`)).toBe(2);
    expect(costOf(`${g}/drives/d/root/delta?token=abc`)).toBe(1);
    // Graph's own ways of writing a link to go on from: never more than a list.
    expect(costOf(`${g}/drives/d/root/delta(token='abc')`)).toBe(1);
    expect(costOf(`${g}/drives/d/root/delta?$skiptoken=abc`)).toBe(2);
    expect(costOf(`${g}/drives/d/items/i?$select=id`)).toBe(1);
    expect(costOf(`${g}/drives/d/items/i/content`)).toBe(1);
    expect(costOf("/v1.0/drives/d/items/i/permissions")).toBe(5);
    expect(costOf("http://[")).toBe(1);
  });
});
