# Spike S4: Graph crawl, delta and permission import

- Task: T-023
- Time box: 2 days
- Result: **partial**. The crawler and the ACL mapping are proven offline against the fake Graph. **The real-tenant run is still to do** (see the run book below).
- Confirms / changes: the Dev Plan's connector design

## Question

Can a connector crawl 100,000 SharePoint/OneDrive items through Microsoft Graph in under 2 hours, follow changes with delta within 5 minutes, and import permissions correctly?

## Pass criteria

- 100k items crawled in under 2 hours, permissions included.
- Delta lag under 5 minutes.
- Every item's imported readers match the source.

## Method

- Code: [`spikes/s4-graph-crawl/run.ts`](../../spikes/s4-graph-crawl/run.ts). It is a connector-shaped crawler: sites → drives → `root/delta` with `$top=200` → one `permissions` call per item. It runs with bounded concurrency (8), backs off on 429/503/504 using `Retry-After`, and ends with an incremental delta round.
- Offline: `pnpm --filter @openhoard/spike-s4-graph-crawl spike -- --fake --items 20000 --latency 40`. It runs against the testkit's fake Graph (T-015), with 40 ms of simulated round trip per request. The fake tenant's `AccessModel` gives the ground truth for every item's readers.

## Results (offline)

| Measure                                          | Result                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Items                                            | 20,000 (17,993 files) in 13 drives                                                                           |
| Delta crawl                                      | 4.7 s                                                                                                        |
| Permission import (1 call per item, 8 in flight) | 101.6 s. This is 95% of the total.                                                                           |
| Projected for 100k items                         | **8.9 min**                                                                                                  |
| ACLs checked against ground truth                | 20,000 items, **0 wrong**. Group expansion, guests via invitations, and links granting nobody all check out. |
| Delta after 50 renames                           | 50 items in one round across 13 drives, 87 ms                                                                |

The offline run proves that the crawler logic, paging, delta bookkeeping and permission mapping are correct, and that **permissions dominate the cost**. It does not prove real-world throughput. That depends on SharePoint throttling (resource units per app and per tenant), which only a real tenant shows.

## What the real run must answer

1. Real throttling for delta pages and for `permissions` calls at concurrency 4, 8 and 16.
2. Whether `$batch` (20 requests per call) helps once throttling is the limit.
3. Whether the delta preference headers (`Prefer: hierarchicalsharing, deltashowsharingchanges`) let the connector fetch permissions only for items whose sharing changed or that have unique permissions. If they do, the 1-call-per-item cost disappears on incremental syncs, which is where it matters. _To verify: we have not tested this against a real tenant._
4. Real delta lag with change notifications (webhook), against polling.

## Run book for the real tenant

1. **Tenant:** a Microsoft 365 developer or test tenant. Never production.
2. **App registration** (Entra ID → App registrations): add application permission **`Sites.Read.All`** with admin consent. Create a client secret.
3. **Seed data:** at least 100k items, with some unique permissions and sharing links. A follow-up can recreate a testkit tenant there (the uploader is not built yet).
4. **Token:**
   ```bash
   curl -s -X POST "https://login.microsoftonline.com/$TENANT_ID/oauth2/v2.0/token" \
     -d "client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET&grant_type=client_credentials" \
     -d "scope=https://graph.microsoft.com/.default" | jq -r .access_token
   ```
5. **Run** `GRAPH_TOKEN=… pnpm --filter @openhoard/spike-s4-graph-crawl spike -- --concurrency 8`. Record the totals, `throttled` and `retries`, then repeat at 4 and 16.
6. **ACL spot check:** compare 20 items with unique permissions against the SharePoint UI ("Manage access").

## Decision (so far)

Keep the design: a delta-driven crawl, a permissions import per item, backoff on `Retry-After`, and bounded concurrency. The permission import is the part to optimise: use sharing-change hints and `$batch`, and fetch unique permissions only. Mark T-023 done after the real-tenant run.
