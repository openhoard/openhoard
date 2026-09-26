# core/policy

Part of the OpenHoard trusted core: who may do what to which object, and how much of it they
see. See [../README.md](../README.md), [docs/architecture.md](../../docs/architecture.md), [ADR-0007](../../docs/adr/0007-policy-engine.md) and
[spike S3](../../docs/spikes/s3-cedar.md).

## Two questions, two steps

1. **May this caller act on this object?** `Authorizer.authorize()` answers, and every access
   decision goes through it.
2. **How much of the object do they get?** `decideRead()` applies the object's visibility and
   exposure levels on top of that answer: nothing, a title, a card, or the content.

```ts
import { Authorizer, createCedarEngine, decideRead } from "@openhoard/core-policy";

const authz = new Authorizer(createCedarEngine(packPolicies), { onError: (e) => log.error(e) });
const { allow, reason } = authz.authorize({ principal, action: "open", resource, client });
const shape = decideRead({
  canRead: allow,
  visibility,
  exposure,
  clientTrust: client.trust,
  wantsContent: true,
});
```

`clientTrust` is required: `first-party` (OpenHoard's own app, which gets a reader the content
whatever the exposure) or an AI client's trust label, which exposure then limits. Only
`canRead === true` counts as a reader.

## Exposure (T-604)

Exposure is what AI clients, model providers and plugins may have of a file's content. The
object's level is resolved like visibility (core/catalog: trusted tags decide, most restrictive
wins, else the tenant default; untrusted tags only tighten; unprocessed is `metadata-only`).

| exposure          | `local`  | `commercial` | `consumer` |
| ----------------- | -------- | ------------ | ---------- |
| `full`            | content  | content      | content    |
| `commercial-only` | content  | content      | metadata   |
| `local-only`      | content  | metadata     | metadata   |
| `metadata-only`   | metadata | metadata     | metadata   |

- **AI clients** (`decideRead()`): where the exposure doesn't reach the client's trust, the card
  is `metadataOnly` (nothing derived from the content: no summary, extracted fields or excerpts)
  and there is no content. A non-reader's card of a readable file follows the same rule.
  OpenHoard's own apps (`first-party`) aren't limited by exposure.
- **Enrichment** (`mayProcess(exposure, providerKind)`): the same table, for the model provider a
  step sends content to (core/jobs).
- **Plugins**: core/sandbox `mayReceiveContent()` adds the manifest's `max_exposure`.
- Anything unknown (a trust label, a provider kind, an exposure) gets metadata only.

## Administration (T-106)

`mayAdminister(principal, client)` is the check for administration endpoints (tenant settings,
AI clients, admins): an active member whose principal says `admin` (core/identity), through
OpenHoard's own app, with no narrower credential (an API key's or an AI client's scope). It is
separate from `authorize()` on purpose: `authorize()` never reads `admin`, and the Cedar schema
has no such attribute (a rule naming it is refused when the engine is built), so no core or pack
rule can turn administration into file access.

## How authorize() decides

Following spike S3, **grants are data and rules are Cedar**:

- A grant ("group G may read tag T", or "user U may write object O") is a row, not a policy
  (core/db `grants`; `loadGrants()` collects a caller's live ones, and expired grants simply
  stop being returned). `authorize()` checks whether any of the object's tags is among the
  caller's read grants (`tagGrants`) or write grants (`tagWriteGrants`, which imply read),
  whether the object itself is granted (`objectGrants`, `objectWriteGrants`), and whether the
  caller owns the object. Cedar gets the answers as `context.readGranted`,
  `context.writeGranted` and `context.owner`.
- Cedar applies the rules. The core rules permit search, read and open with a read grant,
  tagging with a write grant, anything to the owner, and forbid deprovisioned users. Packs
  (T-607) add their own. A `forbid` always wins.
- A credential can be narrower than its principal: `principal.scope` (a service account's API
  key, T-111) names the actions and zone kinds it may reach, and the core rule `core/scope`
  forbids anything outside them (`context.inScope`), owner or not. A scope never grants. Rules
  can tell service accounts apart with `principal.service`.
- The Cedar schema ([`cedar.ts`](src/cedar.ts)) has users in groups, objects in tags, and the
  client with its trust label (`context.client.trust`). Rules see only the caller, the object
  and the client; there is no owner entity to reach through, by design.
- An object's tags come two ways, for the two kinds of rule:
  - `resource in OpenHoard::Tag::"x"` sees the trusted tags only (rules, packs, people and
    reviewed model tags). Use it in a `permit`: a model's guess must never widen access.
  - `resource.allTags.contains("x")` sees every tag, unreviewed model guesses included. Use it
    in a `forbid`: a guess that a file is sensitive should restrict it at once. The engine
    refuses any other use when it is built: in a permit, an `unless`, under `!`, in an `if`
    condition, compared with `==`, or read from anything but `resource` itself (an entity
    literal, or a record such as `{allTags: resource.allTags}.allTags`).
- Every decision has a `kind`: `allow`, `forbid`, `no-permit` or `error`.
- Cedar gets only the caller's groups that some policy names (`OpenHoard::Group::"x"`, in a
  scope or a condition); the others cannot change a decision. With the core rules alone, none
  are sent. This keeps a decision under a millisecond for a caller in a thousand groups.

A decision takes well under a millisecond.

## Engines are cached

`createCedarEngine(policies)` returns the same engine for the same policy set (the same ids
and texts, in any order), validating it once. Cedar keeps each parsed set in a process-wide
cache that cannot be freed, so every distinct set stays in memory until the process exits.
Build an engine when the rules change and share it; don't build one per request. A set that
fails to build is not cached and throws every time.

## Fails closed

- A malformed request is denied before any rule runs.
- An engine that throws produces a deny; the error goes to `onError`, not to the caller.
- Cedar skips a policy that errors while it evaluates (an overflow, say). For a `forbid` that
  would turn a deny into an allow, so any evaluation error denies the request.
- Policies are validated strictly against the schema when the engine is built, and validation
  warnings are refused too ("policy is impossible" is a forbid that can never fire). A typo in
  a pack fails at load time, not on the first request that reaches it.
