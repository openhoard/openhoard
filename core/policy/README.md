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
const shape = decideRead({ canRead: allow, visibility, exposure, clientTrust, wantsContent: true });
```

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
- The Cedar schema ([`cedar.ts`](src/cedar.ts)) has users in groups, objects in tags, and the
  client with its trust label (`context.client.trust`). Rules see only the caller, the object
  and the client; there is no owner entity to reach through, by design.
- An object's tags come two ways, for the two kinds of rule:
  - `resource in OpenHoard::Tag::"x"` sees the trusted tags only (rules, packs, people and
    reviewed model tags). Use it in a `permit`: a model's guess must never widen access.
  - `resource.allTags.contains("x")` sees every tag, unreviewed model guesses included. Use it
    in a `forbid`: a guess that a file is sensitive should restrict it at once.
- Every decision has a `kind`: `allow`, `forbid`, `no-permit` or `error`.

A decision takes about 0.2 ms.

## Fails closed

- A malformed request is denied before any rule runs.
- An engine that throws produces a deny; the error goes to `onError`, not to the caller.
- Cedar skips a policy that errors while it evaluates (an overflow, say). For a `forbid` that
  would turn a deny into an allow, so any evaluation error denies the request.
- Policies are validated strictly against the schema when the engine is built, and validation
  warnings are refused too ("policy is impossible" is a forbid that can never fire). A typo in
  a pack fails at load time, not on the first request that reaches it.
