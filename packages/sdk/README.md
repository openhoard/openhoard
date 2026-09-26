# @openhoard/sdk

The plugin SDK: the interfaces plugins implement and the checks the core applies to what they
return. See [docs/architecture.md](../../docs/architecture.md) for where plugins fit.

- [`connector.ts`](src/connector.ts): the connector interface, **version 1**
  (`CONNECTOR_API_VERSION`).
- [`errors.ts`](src/errors.ts): `ConnectorError` and its codes.
- [`validate.ts`](src/validate.ts): the checks the sync runner makes on every event, ACL and URL
  (`checkEvent`, `checkAcl`, `checkRedirect`, `normalizeAcl`…), and the limits (`LIMITS`).
- [`enricher.ts`](src/enricher.ts): the enricher interface and `readUpTo`.
- `@openhoard/sdk/testing`: the connector contract kit, and `memorySource()`, a reference
  connector over an in-memory tree.

## Connectors (interface v1)

A connector reaches files where they live and answers five questions; the core does the rest
(recording items, access, audit). It is untrusted plugin code: the core checks all it returns.

| Method        | Returns                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `describe()`  | id (its manifest's name), version, zone kinds it serves, capabilities, whether ids are stable  |
| `crawl()`     | every item, parents first, with `checkpoint` tokens to resume after a kill, ending with `done` |
| `delta()`     | the changes since a cursor, in order (optional, `capabilities.delta`)                          |
| `read()`      | exactly the bytes of the version a crawl reported, or `changed`: never newer bytes             |
| `aclImport()` | the item's permissions, normalized, by the source's own ids (optional)                         |
| `redirect()`  | a URL that opens the item in its own app: `https:` or a declared scheme (optional)             |
| `identity()`  | what the source is (a folder's inode and birth time): the runner refuses another (optional)    |

**Items** (`SourceItem`): external id (stable across renames when `stableIds`), kind (file or
folder), parent id, path (names, never joined), title, media type, size, modified time and
author, `etag` (changes when anything reported changes, the path included: moving a folder
changes everything in it) and `contentVersion` (changes when the bytes do; what `read()` is
asked for). An item's `url`, like what `redirect()` returns, is `https:` or a declared scheme,
never `javascript:`, `data:`, `vbscript:` or `blob:`, never with credentials, and a `file:` URL
can only mean a local path: no host, no path starting with `//`, no backslash, no `%5C` or `%2F`,
no query or fragment (nor `?` or `%3F` starting the path: `file:///?/UNC/…`), and a first path
segment that is a drive (`/C:/`) or plain ASCII (not a look-alike slash such as U+2215 or U+FF0F).
Opening `file://server/…`, or any spelling a browser or the Windows shell reads as one, makes
Windows authenticate to that server. What is kept is `canonicalUrl()`'s text, the parser's,
never the connector's; `acceptRedirect()` checks what `redirect()` returned and gives that text
(the open-in-native-app path, FR-20 and T-802, must hand out only its result).

**Events** (`SyncEvent`), in the source's order: `item`, `deleted` (every item of a deleted
folder too), `checkpoint` (everything before it may be considered applied once the token is
saved), `done` (last; its cursor covers every change made after the crawl or delta began
looking), `warning` (a code, and the item when there is one: `unreadable` says part of the
source couldn't be seen, which the runner must not take as deleted; others are reported only).
Tokens are at most 64 KiB: a connector that needs more state keeps it itself (the fs connector
keeps snapshots in its own folder).

**Errors** are `ConnectorError`s with a code: `retryable`, `throttled` (with `retryAfterMs`),
`auth`, `permanent`, `not-found`, `changed`, `resync` (a token that can't be used any more: the
runner crawls again). Anything else a connector throws counts as `retryable`. A connector whose
signal aborts rejects with the signal's reason. Messages go to logs: never put tokens or paths
in them.

**ACLs** (`ItemAcl`): entries for users and groups by the source's ids, guests by email, sharing
links (by id and scope) and the whole organization, each with a role (read, write, owner),
`inherited` and an optional expiry, normalized by `normalizeAcl()`; `basis` says whether they
are the source's own, a configured default (sources without portable permissions), or none
(`owner-only`). T-305 maps them to grants; until then a permission grants nothing.

**Versioning.** `CONNECTOR_API_VERSION` changes when the interface changes in a way an existing
connector or runner would get wrong. Additions that can be ignored (an optional method or field)
keep it. A runner refuses a connector of a version it doesn't know.

## The contract kit

```ts
import { connectorContract } from "@openhoard/sdk/testing";

connectorContract("my-source", {
  checkpointEvery: 5, // what the connector is configured with for the test
  manifest, // its openhoard.plugin.json, checked against describe()
  open: async () => fixture(), // a fresh, empty source per test, and the connector over it
});
```

The fixture changes its source as a person would (`mkdir`, `write`, `move`, `remove`, and
optionally `expectedAcl` and `fault`). The kit seeds a tree (nesting, an empty folder and file,
a 200 KB file, non-ASCII names, several checkpoints' worth of files) and checks: the description
and manifest; crawl completeness, parents first, paths that agree with parents, checkpoints at
least every `checkpointEvery` items; determinism; resuming from a checkpoint after the consumer
stops and after the signal aborts, with a cursor that covers the whole crawl; delta (creates,
updates, renames, moves, deletes, a create-then-delete) applied in order giving what a fresh
crawl sees, stable ids, a change to an item the crawl had already yielded, nothing when nothing
changed; `read()` returning exactly the crawled bytes and refusing changed, deleted, unknown and
unversioned items and folders; normalized ACLs; well-formed, stable redirect URLs; error codes
(and faults, when the fixture can inject them); cancellation of crawl, delta, read and a read's
body. vitest is a peer dependency of the kit only.
