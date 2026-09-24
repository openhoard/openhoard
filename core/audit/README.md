# core/audit

Part of the OpenHoard trusted core. See [../README.md](../README.md) and
[docs/architecture.md](../../docs/architecture.md).

Every access decision and every AI read leaves an event in its tenant's **hash chain**
(`audit.events`, defined in [core/db](../db/README.md)).

- [`chain.ts`](src/chain.ts): the chain itself. Each event's SHA-256 covers its canonical
  JSON, including the previous event's hash and the tenant. So any edit, deletion, insertion,
  reordering or move between tenants breaks verification.
- [`store.ts`](src/store.ts): the chain in the database.
  - `appendAudit(tx, tenantId, record)` appends inside the caller's transaction, so an action
    and its audit record commit together.
    - Appends to one tenant are serialized with an advisory lock, held until the transaction
      ends, so keep those transactions short and append last (see the lock order below).
    - The transaction must be read-write, and READ COMMITTED (the default) or SERIALIZABLE.
      Under SERIALIZABLE the snapshot predates the lock, so an append that raced another fails
      with SQLSTATE 40001, like any serialization failure: run the transaction again
      (`isRetryable()` from core/db). The chain never forks. REPEATABLE READ is refused: the
      same race would surface as a unique violation.
    - The record is checked at run time: the actor is a principal (`user:…`), the action a
      lower-case name, the decision `allow` or `deny`, client, object and version non-empty
      text, and the detail an object of strings, finite numbers and booleans. Text the
      database would store differently from the hashed JSON is refused: lone surrogates and
      NUL, and times outside 1970–9999.
  - `verifyAudit(db, tenantId)` walks the whole chain in pages. It checks every hash and link,
    and that the query columns agree with the hashed event. A chain of 1,000,000 events
    verifies in about 16 s on 2 vCPUs.

- [`export.ts`](src/export.ts): `exportAudit(db, tenantId, filter, "ndjson" | "csv", sink)`
  streams one tenant's events, filtered by actor, action, decision, client, object and time
  (T-703).
  - NDJSON lines are the events exactly as hashed, plus their hash, so each line checks out
    on its own.
  - CSV follows RFC 4180. Text a spreadsheet would run as a formula gets a leading
    apostrophe (CSV injection), so use NDJSON when the bytes must match the log.

Verify and export read the chain as it was when they started (up to its last seq then), a page
at a time, each page in its own short read-only transaction, and do their work (checking,
writing to the sink) outside any transaction. The chain is append-only, so that gives the same
result as one snapshot, without a slow sink pinning a pooled connection, or on PGlite, blocking
every other tenant.

## Advisory lock order

Transaction-scoped advisory locks are taken in one order across packages, so two transactions
never each hold a lock the other waits for:

| Order | Key  | Lock             | Package      |
| ----- | ---- | ---------------- | ------------ |
| 1     | 7423 | source item      | core/catalog |
| 2     | 7425 | vocabulary value | core/catalog |
| 3     | 7422 | object           | core/catalog |
| 4     | 7421 | audit append     | core/audit   |

The audit lock is last: append the audit record at the end of the transaction, after the
action it records. (7420 is core/db's migration lock, held on its own.)

## Audited reads

A read-only transaction can't append. A read made in a read-only snapshot (core/catalog's
`VIEW_TRANSACTION`) records its audit event in its own transaction, after the read returns:

```ts
const rows = await db.withTenant(tenant, (tx) => viewObjects(tx /* … */), VIEW_TRANSACTION);
await db.withTenant(tenant, (tx) => appendAudit(tx, tenant, { action: "search" /* … */ }));
```

Never nest the second inside the first: on PGlite, which is one connection, the inner
transaction waits for the outer and the outer for the inner, forever.

## Append-only

The table is append-only: tenants can read and insert, and nothing can change or remove a
row (row-level security plus triggers). A trigger also checks that every insert is a
verifiable link: the next sequence number, linked to the head's hash; a hash that is the
SHA-256 of the stored event text; and an event whose fields (seq, link, tenant, actor, action,
decision, client, object, version, time) say what the columns say. So nothing inserted can make
the chain unverifiable from that row on. The trigger can't check that the text is in canonical
form; `verifyAudit` does.

A hash chain is tamper-_evident_, not tamper-proof. Someone who can run arbitrary SQL as the
owner could rewrite the whole chain consistently. The planned defence is anchoring the head
hash (`verifyAudit().head`) in WORM storage periodically.
