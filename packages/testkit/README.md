# @openhoard/testkit

Offline test infrastructure for OpenHoard. Nothing here needs Docker, a cloud account or the network.

## Fake tenant (T-014)

```ts
import { AccessModel, contentStream, generateTenant } from "@openhoard/testkit";

const tenant = generateTenant({ seed: "bug-1234", items: 10_000 });
const access = new AccessModel(tenant);
access.readersOf(tenant.items[42]); // ground truth: who may read this item
contentStream(tenant, tenant.items[42]); // deterministic bytes, streamed lazily
```

- **Deterministic.** The same seed and options produce a byte-identical tenant on every platform. A test pins the fingerprint, so any change to the generator is deliberate.
- **Realistic shape.** Users (including guests and people who have left), groups, a site per department and per client, folder trees, and files with plausible names, types, sizes, dates and labels (`client:`, `type:`, `sensitivity:`, `department:`).
- **Permissions like a source reports them.** Site groups are inherited down the tree. Some folders and files break inheritance. Some files carry sharing links or guest shares. `AccessModel` computes who can really read each item. A sharing link grants no search visibility, and people who have left read nothing.
- **Known problems.** `tenant.problems` lists every instance, by definition, of: anyone links, external guests, orphaned owners, duplicates, stale files, broken inheritance, sensitive files in open sites, injection file names, huge files and over-long paths. A detector can be scored for precision and recall against it.
- **Canaries.** Some restricted files carry a unique `canary-…` token in their name and content. The leak harness searches for these tokens as every user.
- All names are invented and all domains use reserved TLDs (`.test`, `.example`).

## Permission-leak harness (T-018)

```ts
import { assertNoLeaks, runLeakHarness } from "@openhoard/testkit";

const report = await runLeakHarness({ tenant, target: mySearchEngine });
assertNoLeaks(report); // throws, listing each leak's surface, user, probe and item
```

The harness probes as a deterministic sample of active users (always including a guest). It searches every canary token, runs broad queries and asks for autocomplete. Because each canary is unique to one restricted file, any sign of a forbidden token is a leak by construction: a hit, a non-zero total, a facet count, a suggestion, or the token in any card text. No knowledge of the engine's ranking is needed. `checkPair(tenant, target, ownerId, otherId)` pins a regression for one pair of accounts.

`InMemorySearch` is a small, correct reference engine that filters before matching, counting, faceting and suggesting. The tests prove the harness catches an engine that leaks through each surface.
