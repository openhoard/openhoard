import { modelUsage, type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dailyTokenBudget,
  DEFAULT_DAILY_TOKENS,
  reserveTokens,
  settleTokens,
  tokensToday,
} from "./budget.js";

/*
 * T-404: the cost guard. A reservation never takes a tenant past its daily budget, however many
 * run at once; settling replaces it with what was spent. PGlite by default, PostgreSQL in CI.
 */

let db: Database;
let a: SeededTenant;
let b: SeededTenant;
beforeEach(async () => {
  db = await openTestDatabase();
  a = await seedTenant(db, 1);
  b = await seedTenant(db, 2);
});
afterEach(() => db?.close());

const reserve = (t: SeededTenant, tokens: number, limit: number) =>
  db.withTenant(t.tenantId, (tx) => reserveTokens(tx, t.tenantId, tokens, limit));
const today = (t: SeededTenant) => db.withTenant(t.tenantId, (tx) => tokensToday(tx, t.tenantId));

describe("the daily token budget", () => {
  it("reserves within the budget and refuses past it, per tenant", async () => {
    const r1 = await reserve(a, 600, 1_000);
    expect(r1?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r1?.tokens).toBe(600);
    expect(await reserve(a, 500, 1_000)).toBe(null);
    expect(await reserve(a, 400, 1_000)).not.toBe(null);
    expect(await reserve(a, 1, 1_000)).toBe(null);
    expect(await today(a)).toBe(1_000);
    // Another tenant's budget is its own.
    expect(await reserve(b, 1_000, 1_000)).not.toBe(null);
    // More than the whole budget is refused before touching the row.
    expect(await reserve(b, 2_000, 1_000)).toBe(null);
    expect(await reserve(b, 0, 1_000)).not.toBe(null);
    await expect(reserve(b, -1, 10)).rejects.toThrow(RangeError);
  });

  it("settles to what was spent, never below zero", async () => {
    const r = await reserve(a, 800, 1_000);
    if (!r) throw new Error("expected a reservation");
    await db.withTenant(a.tenantId, (tx) => settleTokens(tx, a.tenantId, r, 150));
    expect(await today(a)).toBe(150);
    // Settling the same amount changes nothing; a failed call gives everything back.
    await db.withTenant(a.tenantId, (tx) =>
      settleTokens(tx, a.tenantId, { ...r, tokens: 150 }, 150),
    );
    await db.withTenant(a.tenantId, (tx) => settleTokens(tx, a.tenantId, { ...r, tokens: 150 }, 0));
    expect(await today(a)).toBe(0);
    await db.withTenant(a.tenantId, (tx) => settleTokens(tx, a.tenantId, { ...r, tokens: 500 }, 0));
    expect(await today(a)).toBe(0);
  });

  it("never lets concurrent reservations spend past the budget together", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => reserve(a, 100, 1_000)));
    expect(results.filter((r) => r !== null)).toHaveLength(10);
    expect(await today(a)).toBe(1_000);
  });

  it("sees only the tenant's own usage", async () => {
    await reserve(a, 300, 1_000);
    expect(await today(b)).toBe(0);
    const rows = await db.withTenant(b.tenantId, (tx) => tx.select().from(modelUsage));
    expect(rows).toEqual([]);
  });

  it("gives every tenant the default, or its own", () => {
    const budget = dailyTokenBudget(1_000, { [b.tenantId]: 5 });
    expect(budget.limitFor(a.tenantId)).toBe(1_000);
    expect(budget.limitFor(b.tenantId)).toBe(5);
    expect(dailyTokenBudget().limitFor(a.tenantId)).toBe(DEFAULT_DAILY_TOKENS);
    expect(() => dailyTokenBudget(-1)).toThrow(RangeError);
    expect(() => dailyTokenBudget(10, { x: 1.5 })).toThrow("the budget of x");
  });
});
