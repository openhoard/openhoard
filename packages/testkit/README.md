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

The harness probes as a deterministic sample of active users, always including a guest. It searches every canary token, runs broad queries and asks for autocomplete. Each canary is unique to one restricted file, so any hit for a forbidden canary, or any trace of its token in a result, card or suggestion, is a leak by construction.

Totals and facet counts for a forbidden canary are compared with a never-planted control token of the same shape. A forbidden file may not add to what the engine returns for a random token, which keeps the check fair to loose matching such as OR or vector search.

The harness also counts canaries the caller _can_ read that the engine didn't return. `assertNoLeaks` fails when the engine found none of them, because an engine that returns nothing can't leak, but it isn't working either.

Probing as someone who has left is refused. `checkPair(tenant, target, ownerId, otherId)` pins a regression for one pair of accounts.

`InMemorySearch` is a small, correct reference engine that filters before matching, counting, faceting and suggesting. The tests prove the harness catches an engine that leaks through each surface.

## Fake Microsoft Graph (T-015)

```ts
import { FakeGraph, generateTenant } from "@openhoard/testkit";

const graph = new FakeGraph(generateTenant(), {
  pageSize: 50,
  throttle: { limit: 100, windowMs: 1000 },
});
await graph.fetch("/v1.0/sites", { headers: { authorization: "Bearer fake-graph-token" } }); // in-process
const { url, close } = await graph.listen(); // or real HTTP on 127.0.0.1
graph.store.update(itemId, { name: "Renamed.docx" }); // changes show up in the next delta
graph.failNext(503, 2, 3); // two 503s with Retry-After: 3
```

It covers what a SharePoint/OneDrive connector uses:

- Bearer auth.
- `sites`, `drives`, `root`, `items`, `children` with `$top` and absolute `@odata.nextLink`.
- `content`: a 302 to a signed, pre-authenticated download URL. `Range` follows RFC 9110: 206 for a satisfiable range, 416 for an unsatisfiable one, and anything unsupported is ignored (200). `cTag` changes only when the bytes do, and `eTag` on every change.
- `permissions`, including inherited, link, group and guest entries.
- `root/delta`: opaque tokens, `token=latest`, tombstones, id-ordered pages that never skip items deleted mid-round, and 410 `resyncRequired` after `requireResync()`.
- `subscriptions`, with the validation handshake, the 42,300-minute expiry cap, renewal and notifications on change.
- Rate limiting (429 + Retry-After) and injected faults. Both also apply to downloads, so retry and resume can be tested.
- `graph.store` mutations: `update` (rename or new content), `addFile`, recursive `delete`, and `setAcl`. `setAcl` breaks inheritance and re-derives what inheriting descendants get, so permission sync can be tested through delta.

Response shapes follow the Graph v1.0 documentation for the fields connectors read. The source tenant is never modified: `graph.store` holds a mutable copy.

## Dev OIDC provider and SCIM seed (T-016)

```ts
import { DEV_CLIENT, scimSeed, startDevOidc } from "@openhoard/testkit";

const idp = await startDevOidc({ tenant }); // http://127.0.0.1:<port>, discovery included
// Sign in as any active seeded user. The ID token carries email, name, groups (ids) and guest.
await idp.close();

const { users, groups } = scimSeed(tenant); // RFC 7643 resources; scimList() pages them
```

Built on [`oidc-provider`](https://github.com/panva/node-oidc-provider), a certified OpenID Connect implementation. It supports authorization code with required PKCE, refresh tokens (always issued to dev clients), and public (`openhoard-dev`) or confidential (`client_secret_basic`) clients. The login page lists active seeded users and asks for no password. People who have left can't sign in. Registered clients are first-party: consent, including `prompt=consent` and new scopes, is granted automatically. The login page's CSP allows the redirect back to registered clients. It binds to 127.0.0.1 only and makes fresh keys on every start. **Development only.**

## Prompt-injection corpus v0 (T-017)

```ts
import {
  baselinePipeline,
  buildCorpus,
  formatInjectionReport,
  runInjectionHarness,
} from "@openhoard/testkit";

const report = await runInjectionHarness(myEnrichmentPipeline); // or baselinePipeline
console.log(formatInjectionReport(report)); // one row per file
```

There are 50 attack files, generated deterministically in memory, so no binaries live in the repo. The files are real PDFs, DOCX and XLSX (they pass `qpdf --check` and open in LibreOffice), plus CSV, Markdown, HTML, text and hostile file names. Techniques include white or tiny text, off-page, invisible and covered PDF text, `w:vanish`, comments, headers, document properties, hidden and very hidden sheets, defined names, HYPERLINK and DDE formulas, CSV formula prefixes, HTML comments, base64, fake tool calls, bidi overrides, zero-width characters, path traversal and newlines in names. Content cases have neutral file names. Every payload carries its case id (`OHX-001`…) as a marker, so wherever it resurfaces can be traced to one file.

Each file gets one outcome, worst first: `acted`, `loosened`, `error`, `leaked` (the marker reached the card), `flagged` (`risk:injection`), or `clean`. CI runs the naive `baselinePipeline` on every push and writes the table to the job summary. It fails if anything acts, loosens access or crashes. To red-team a real agent, write the files to disk with `pnpm --filter @openhoard/testkit injection:write ./corpus`, upload them, and look for `OHX-` markers in the agent's answers.

## Benchmarks (T-019)

```bash
pnpm --filter @openhoard/testkit bench --out bench.json --baseline previous.json
```

The standard cases run on a seeded 10,000-item tenant: search latency p50, p95 and p99 over the reference engine (as random users), ingest throughput (streaming content, BLAKE3 hashing, card building), tenant generation, audit-chain appends and RRF fusion. Each case runs five rounds and keeps the median, and peak RSS is sampled throughout. `compareResults` flags any metric more than 20% worse than the baseline, and also beyond its absolute noise floor, so tiny timings don't flap. Runs on a different CPU model than the baseline are reported but not compared, because hosted runners change hardware.

The `bench` workflow runs nightly. It compares against the last successful night, writes the table to the job summary, uploads `bench.json` for 90 days, and fails (which alerts) on a regression. Run it by hand with **accept-baseline** to record an intended slowdown as the new baseline.
