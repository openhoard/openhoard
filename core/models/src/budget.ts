import { modelUsage, queryRows, type Tx } from "@openhoard/core-db";
import { and, eq, sql } from "drizzle-orm";

/*
 * The cost guard (T-404): a daily token budget per tenant, all providers together.
 *
 * A call reserves the most it can spend (its input estimate, plus the answer's cap, times the
 * attempts it may make) before anything is sent, in one statement that adds to the tenant's row
 * for the UTC day only if the total stays within the budget. Two jobs racing for the last
 * tokens, in one process or several, can't both win: the row lock serializes them. After the
 * call, settle() replaces the reservation with what the provider reported.
 *
 * When the budget is spent, reserve() says no, and the caller doesn't call: the summarize step
 * records the version as `skipped` for `budget` (the file is still processed and visible by its
 * tags; it just has no summary), logs a warning once per job, and a later run (a new version, a
 * rename, or an operator's re-enrichment) tries again. The day rolls over at 00:00 UTC.
 *
 * Local providers count too: they cost no money but do cost the tenant's machines time, and a
 * runaway loop is a runaway loop. Set the budget high (or per tenant) if that is a problem.
 */

/** The default daily budget per tenant, in tokens: about 2,000 summaries of a long document. */
export const DEFAULT_DAILY_TOKENS = 5_000_000;

export interface TokenBudget {
  /** The tenant's daily budget, in tokens. */
  limitFor(tenantId: string): number;
}

/** A budget of `daily` tokens for every tenant, or the tenant's own from `perTenant`. */
export function dailyTokenBudget(
  daily = DEFAULT_DAILY_TOKENS,
  perTenant: Readonly<Record<string, number>> = {},
): TokenBudget {
  const check = (n: number, what: string) => {
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new RangeError(`${what} must be a whole number of tokens, 0 or more`);
    }
  };
  check(daily, "the daily token budget");
  for (const [tenant, n] of Object.entries(perTenant)) check(n, `the budget of ${tenant}`);
  return { limitFor: (tenantId) => perTenant[tenantId] ?? daily };
}

/** A reservation: settle it with what was spent. */
export interface Reservation {
  day: string;
  tokens: number;
}

/**
 * Reserves `tokens` of the tenant's budget for today (UTC), or returns null, reserving nothing,
 * when that would go past `limit`. Run it in the tenant's transaction (db.withTenant()).
 */
export async function reserveTokens(
  tx: Tx,
  tenantId: string,
  tokens: number,
  limit: number,
): Promise<Reservation | null> {
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new RangeError("tokens must be >= 0");
  if (tokens > limit) return null;
  const rows = await queryRows<{ day: string }>(
    tx,
    sql`insert into model_usage as u (tenant_id, day, tokens, calls)
        values (${tenantId}, to_char(now() at time zone 'utc', 'YYYY-MM-DD'), ${tokens}, 1)
        on conflict (tenant_id, day) do update
          set tokens = u.tokens + excluded.tokens, calls = u.calls + 1, updated_at = now()
          where u.tokens + excluded.tokens <= ${limit}
        returning u.day`,
  );
  const day = rows[0]?.day;
  return day === undefined ? null : { day, tokens };
}

/**
 * Replaces a reservation with what was actually spent (never below zero for the day). A call
 * that failed before sending anything settles with 0.
 */
export async function settleTokens(
  tx: Tx,
  tenantId: string,
  reservation: Reservation,
  used: number,
): Promise<void> {
  const delta = Math.max(0, Math.floor(used)) - reservation.tokens;
  if (delta === 0) return;
  await tx
    .update(modelUsage)
    .set({ tokens: sql`greatest(0, ${modelUsage.tokens} + ${delta})`, updatedAt: sql`now()` })
    .where(and(eq(modelUsage.tenantId, tenantId), eq(modelUsage.day, reservation.day)));
}

/** Tokens the tenant has spent today (UTC). */
export async function tokensToday(tx: Tx, tenantId: string): Promise<number> {
  const rows = await queryRows<{ tokens: string | number }>(
    tx,
    sql`select tokens from model_usage
        where tenant_id = ${tenantId} and day = to_char(now() at time zone 'utc', 'YYYY-MM-DD')`,
  );
  return Number(rows[0]?.tokens ?? 0);
}
