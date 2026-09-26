import { skippedVersions, type CardSkipReason } from "@openhoard/core-catalog";
import { insideWithTenant, NestedWorkError, type Database } from "@openhoard/core-db";
import type { Jobs } from "./jobs.js";

/*
 * Summarizing again what couldn't be summarized (T-405): an admin, after fixing a provider's key
 * or raising the budget, re-enqueues the tenant's current versions skipped for a reason another
 * try can cure. The summarize step runs again for them (a skipped card is not a finished one);
 * the other steps change nothing on a re-run. Who may ask is the API's question (an admin), and
 * it audits the request.
 */

/** Skip reasons another try can cure: a provider that refused or failed, or a spent budget. */
export const RESUMMARIZABLE: readonly CardSkipReason[] = ["refused", "unavailable", "budget"];

/**
 * Enqueues the tenant's current versions skipped for `reasons` (a subset of
 * {@link RESUMMARIZABLE}; others are refused with a TypeError), a page at a time, at most
 * `limit` in all (default 10,000). Returns how many were enqueued. Never inside withTenant().
 */
export async function resummarize(
  db: Database,
  jobs: Pick<Jobs, "enqueueVersion">,
  tenantId: string,
  reasons: readonly CardSkipReason[] = RESUMMARIZABLE,
  options: { limit?: number } = {},
): Promise<number> {
  if (insideWithTenant()) throw new NestedWorkError("resummarize()");
  for (const r of reasons) {
    if (!RESUMMARIZABLE.includes(r)) {
      throw new TypeError(`resummarize: ${r} is not a reason another try can cure`);
    }
  }
  const limit = options.limit ?? 10_000;
  let after: string | undefined;
  let count = 0;
  while (count < limit) {
    const want = Math.min(500, limit - count);
    const page = await db.withTenant(
      tenantId,
      (tx) =>
        skippedVersions(tx, tenantId, reasons, {
          ...(after === undefined ? {} : { after }),
          limit: want,
        }),
      { accessMode: "read only" },
    );
    for (const versionId of page) {
      await jobs.enqueueVersion(tenantId, versionId);
      count++;
    }
    if (page.length < want) break;
    after = page[page.length - 1];
  }
  return count;
}
