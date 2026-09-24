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
      ends, so keep those transactions short.
    - The transaction must be READ COMMITTED (the default); a REPEATABLE READ or SERIALIZABLE
      snapshot would predate the lock.
    - Text the database would store differently from the hashed JSON is refused: lone
      surrogates and NUL, and times outside 1970–9999.
  - `verifyAudit(db, tenantId)` walks the whole chain from one snapshot in pages. It checks
    every hash and link, and that the query columns agree with the hashed event. A chain of
    1,000,000 events verifies in about 16 s on 2 vCPUs.

- [`export.ts`](src/export.ts): `exportAudit(db, tenantId, filter, "ndjson" | "csv", sink)`
  streams one tenant's events, filtered by actor, action, decision, client, object and time,
  from one snapshot (T-703).
  - NDJSON lines are the events exactly as hashed, plus their hash, so each line checks out
    on its own.
  - CSV follows RFC 4180. Text a spreadsheet would run as a formula gets a leading
    apostrophe (CSV injection), so use NDJSON when the bytes must match the log.

The table is append-only: tenants can read and insert, and nothing can change or remove a
row (row-level security plus triggers). A trigger also checks that every insert extends the
chain: the next sequence number, linked to the head's hash.

A hash chain is tamper-_evident_, not tamper-proof. Someone who can run arbitrary SQL as the
owner could rewrite the whole chain consistently. The planned defence is anchoring the head
hash (`verifyAudit().head`) in WORM storage periodically.
