# Spike S3: Cedar in Node 24

- Task: T-022
- Time box: 1 day
- Result: **partial**. Cedar works in Node 24 and answers correctly, but 1,000 policies in one set miss the 1 ms bar. With tag grants kept as data and Cedar evaluating only the rules, decisions take **0.26 ms at p95**.
- Confirms / changes: [ADR-0007](../adr/0007-policy-engine.md), confirmed with an amendment on how grants are modelled

## Question

Can `@cedar-policy/cedar-wasm` be imported as ESM in Node 24, and can it decide a request against 1,000 policies in under 1 ms? If not, we switch to OpenFGA (per the Dev Plan).

## Pass criteria

- ESM import works in Node 24 with no flags.
- p95 decision latency < 1 ms with 1,000 policies.
- Decisions match a reference evaluator on every request.
- Malformed requests fail closed.

## Method

- Code: [`spikes/s3-cedar/run.ts`](../../spikes/s3-cedar/run.ts). Run it with `pnpm --filter @openhoard/spike-s3-cedar spike`.
- Machine: Cedar 4.13.0, Node 24.21.0, linux-x64 on a 2-vCPU Intel Xeon at 2.10 GHz.
- Data:
  - Users, groups and files come from a 10,000-item fake tenant (`@openhoard/testkit`).
  - Each file also has one of 150 project tags, so there are 176 tags in total.
- Policies, 1,000 in total, shaped like OpenHoard's rules:
  - 994 tag grants of the form `permit(principal in Group::"g", action in [read, search], resource) when { resource.tags.contains("t") }`;
  - an owner rule;
  - three `forbid` rules: no guest shares, no shares of restricted files, and no restricted content to consumer AI clients;
  - two conditional share permits.
- Schema: strict, validated.
- Requests: 5,000 random (user, action, file, client) tuples. Each request carries only the entities it needs: the caller, the caller's groups, the file and the file's owner.
- Correctness: every decision was compared with the same rules written in plain TypeScript.

## Results

| Approach                                                                       | p50         | p95         | p99         | Mismatches |
| ------------------------------------------------------------------------------ | ----------- | ----------- | ----------- | ---------- |
| One preparsed set of 1,000 policies, request validated                         | 2.77 ms     | 3.57 ms     | 4.48 ms     | 0          |
| Same, without request validation                                               | 2.66 ms     | 3.40 ms     | 4.31 ms     | 0          |
| `isAuthorized` (re-parses the policies on every call)                          | 98.8 ms     | 126 ms      |             | 0          |
| Split into one preparsed set per tag, plus a global set (5.1 sets per request) | 0.94 ms     | 1.35 ms     | 1.84 ms     | 0          |
| **Tag grants as data (set intersection), plus a Cedar set of the 6 rules**     | **0.19 ms** | **0.26 ms** | **0.40 ms** | **0**      |

- **ESM:** `import "@cedar-policy/cedar-wasm"` works in Node 24 with no flags, but it prints `ExperimentalWarning: Importing WebAssembly module instances`, because the root export uses WASM ESM integration. `import "@cedar-policy/cedar-wasm/nodejs"` works from ESM with no warning. Use that one.
- **Parsing:** preparsing the schema and 1,000 policies takes about 250 ms, and strict validation about 180 ms. Both happen once per policy change, not per request.
- **Why one set is slow:** Cedar evaluates every policy for every request; there is no index. At about 2.7 µs per policy, cost grows linearly, so 1,000 policies take about 2.7 ms.
- **Splitting:** splitting by tag is exact, because Cedar is deny-overrides with default deny. The combination rule is: any `forbid` means deny, otherwise any `permit` means allow. But it pays about 0.2 ms of call and serialization overhead for each set.
- **Fail closed:** a request with an ill-typed entity (`tags: 42`) returns `failure`, and the adapter treats that as deny.

## Decision

**Keep Cedar (ADR-0007) and do not switch to OpenFGA. Change how grants are modelled.**

1. **Grants are data, not policies.** "Group G may read tag T" is a row in a grant table. It is checked by intersecting the caller's principal set with the file's tags, which is the same principal set the search filter already uses inside the query (ADR-0005). This is effectively relationship-based access, OpenFGA's model, kept in our own table.
2. **Cedar evaluates the rules.** That means admin- and pack-authored conditions: ownership, `forbid`s (guest shares, restricted files, client trust), and conditional permits. These are tens of policies, not thousands, and evaluation stays well under 1 ms.
3. **The adapter** imports `@cedar-policy/cedar-wasm/nodejs`. It preparses the schema and policy set once per change (`preparsePolicySet`), calls `statefulIsAuthorized`, passes only the entities a request needs, and treats any `failure` as deny.
4. **Follow-up:** once the adapter exists, add a decision-latency case to the nightly benchmarks (T-019), so a growing rule set is caught before it passes 1 ms.

Follow-ups: amend ADR-0007 with points 1–3 (done in this change), and add the grant table to the data model (E3).
