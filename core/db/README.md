# @openhoard/core-db

The database layer: the Drizzle schema, SQL migrations, tenant row-level security, and drivers
for embedded [PGlite](https://pglite.dev) and native PostgreSQL ([ADR-0004](../../docs/adr/0004-database.md)).
The same migrations and queries run on both; [spike S2](../../docs/spikes/s2-pglite-parity.md)
checked that, and the rules it set are enforced here.

```ts
import { newId, objects, openDatabase } from "@openhoard/core-db";

const db = await openDatabase({ url: "pglite", dataDir: ".openhoard" }); // or postgres://…
const rows = await db.withTenant(tenantId, (tx) => tx.select().from(objects));
```

## Tenant isolation

Every table carries `tenant_id` and has **forced row-level security**. `withTenant()` is the only
way in: it opens a transaction and sets `app.tenant_id` transaction-locally, so every statement
inside sees and writes one tenant's rows. Outside it nothing is visible, so a forgotten tenant
fails closed instead of leaking. Primary and foreign keys include `tenant_id` too, so a row can
never reference another tenant's.

The `tx` handle works only while the callback runs. Once it settles, every use of the handle
throws `TransactionEndedError`, so a handle that escaped (kept in a variable, or used by a
promise nobody awaited) can't run on a pooled connection that is by then inside another
tenant's transaction. A query builder or `tx.query` saved inside the callback and awaited after
it fails the same way, once the transaction has committed or rolled back. Await every query
inside the callback.

Errors keep the server's SQLSTATE: `sqlState(e)` reads it however the driver wrapped it, and
`isRetryable(e)` says whether the transaction may succeed if run again (serialization failure
40001, deadlock 40P01). Retry by running a new `withTenant()`; the failed one is gone.

Nothing cascades from a tenant, a zone or a blob. Deleting an object removes its versions and
source references; removing a whole tenant is a deliberate, ordered process.

What this protects against, and what it doesn't:

- It holds against application queries that forget a tenant filter or use another tenant's
  ids, and against other roles on the same cluster (the tables grant nothing to anyone).
- It does not hold against arbitrary SQL. The application connects as the tables' owner, so
  raw SQL could change `app.tenant_id` or the policies themselves. Use the query builder and
  parameters, never `sql.raw()` with input. A separate runtime role with only DML rights is a
  planned hardening step.

Transactions don't nest. A `withTenant()` (or `tenantIds()`) started inside another's callback
would wait for it forever: on PGlite, because everything shares one connection, and on
PostgreSQL because it runs on another connection, outside the first, and can wait on a lock the
first holds. So it rejects with `NestedWorkError`. `insideWithTenant()` tells whether code runs
in a callback whose transaction is still open; work the callback started that runs after the
commit (a timer) is outside again.

Two narrow doors besides `withTenant()`, both for core/jobs:

- **`tenantIds({ after, limit })`** lists every tenant's id, in order and a page at a time, for
  scheduled maintenance that visits each tenant. `tenants` is under forced row-level security
  like every table; the `tenant_directory` policy (migration 0031) lets a transaction with no
  tenant set, that sets `app.tenant_directory` to `on`, select its rows, and nothing else: no
  insert, update or delete, and every other table stays closed. Inside a tenant's transaction
  the setting changes nothing, even set for a whole session. Only `tenantIds()` sets it, in a
  read-only transaction of its own that returns ids.
- **`queueConnectionOf(db)`**, from the internal entry point `@openhoard/core-db/queue`, is how
  pg-boss (ADR-0008) reaches the database for its queue, which lives in its own `pgboss` schema,
  outside row-level security. It is not on `Database`: only core/jobs imports it.
  - On PostgreSQL it is the URL the database was opened with and the pool's session settings
    (UTC, the statement and idle-in-transaction timeouts), so pg-boss connects as the same role
    (the database's owner, which may create the schema).
  - On PGlite it runs statements on the same instance, one at a time, between the
    application's transactions. A block of pg-boss's that fails half way rolls back before
    anything else runs. Statements that plainly change the shared session (an `app.*` setting,
    `set_config()`, the role or session authorization, `RESET ALL`) trip an error, since pg-boss
    issues none: a check against mistakes, not a boundary (quoting gets past it). What holds is
    below. It refuses to run inside a `withTenant()` callback too.

A new tenant is made with **`createTenant(tx, id, { name })`**, in a `withTenant()` transaction for
the new id (`newId("tenant")`): the `tenants` row, with the fail-closed defaults (hidden,
metadata-only), and its `principal_epochs` row, so the principal cache serves it from the first
request. Nothing else: zones, vocabulary, packs and people are added deliberately afterwards.
`getTenant(tx, id)` reads the tenant's own row. `openhoard admin tenant create` (apps/server) uses
both.

PGlite's session starts as a superuser and switches to the `openhoard` role, and a superuser
skips row-level security. So on PGlite every `withTenant()` and `tenantIds()` checks, in the same
statement that sets its context, that it runs as `openhoard`, and throws `SessionRoleError`
otherwise, before anything else runs: if anything ever switched the session back, every
transaction after fails closed. A session-level `app.tenant_directory` can't widen a tenant's
transaction either (migration 0031).

## Grants

Access is granted as data (spike S3): a row in `grants` gives a user or a group read or write
access to every object carrying a tag, or to one object. Grants expire after 90 days unless the
caller sets another date, or asks for a permanent one explicitly. `loadGrants()` returns only
live grants for a caller's principals (at a given moment), in the shape core/policy's
`authorize()` takes, so an expired or revoked grant stops working at once, with no job to run.
Revoking keeps the row for history.

Grant times come from the database's clock (`now()`, the transaction's start): creation, the
default expiry, revocation (never before creation) and "live now". core/identity revokes with
the same clock, so a skewed application clock can't date a revocation before its grant. The
functions still take an explicit `now` or `at`, for tests and for asking about another moment.

Every change to what a principal holds (a grant, a group membership, a user's kind or stops)
bumps the tenant's row in `principal_epochs`, by trigger, in the same transaction (once per
statement for grants and memberships): core/identity's principal cache is invalidated by it.
That row lock queues concurrent principal changes in one tenant behind each other until commit;
take it first with `lockPrincipals()`, as `addGrant()` and `revokeGrant()` do, before any other
row lock, and before the audit append. Never delete a tenant's row while the tenant lives.

## Server requirements

`openDatabase()` refuses to start unless:

- PostgreSQL is 17 or later (18 recommended), with pgvector 0.8 or later: the version created
  in the database, or until it is created, the one the server would install;
- the connecting user is an ordinary role: not a superuser and without `BYPASSRLS`, both of
  which skip row-level security;
- the database is UTF-8 and sorts by code point, like PGlite.

A DBA sets it up once:

```sql
CREATE ROLE openhoard LOGIN PASSWORD '…';
CREATE DATABASE openhoard OWNER openhoard TEMPLATE template0 ENCODING 'UTF8'
  LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8';
\c openhoard
CREATE EXTENSION vector;  -- pgvector is not a trusted extension
```

OpenHoard then connects as `openhoard`, runs the migrations (so it owns the tables) and every
query. Each connection runs in UTC, with limits that `openDatabase({ postgres: … })` can change
(0 turns a timeout off):

| Option                           | Default | What                                                                 |
| -------------------------------- | ------- | -------------------------------------------------------------------- |
| `max`                            | 10      | connections in the pool                                              |
| `connectionTimeoutMillis`        | 10 s    | wait for a connection before failing                                 |
| `statementTimeoutMillis`         | 60 s    | `statement_timeout` (migrations run without one)                     |
| `idleInTransactionTimeoutMillis` | 60 s    | `idle_in_transaction_session_timeout`: an abandoned transaction ends |

The embedded default (`pglite`) keeps its files in `<dataDir>/pgdata`. PGlite always connects
as a superuser, so the driver hands the database to an ordinary `openhoard` role and switches
the session to it. Only one process may open a data directory at a time; `<dataDir>/pgdata.lock`
enforces that. It holds the owner's pid and a random nonce. A lock whose process is gone is
stale and taken over, and so is one naming this process's own pid that this process doesn't
hold (after a crash in a container, the restarted process usually has the same pid). A takeover
renames the stale lock aside and checks it is still the one judged stale, so two processes
can't both take it over.

## Types

- Ids are generated in the application ([`ids.ts`](src/ids.ts)): `<prefix>_<ULID>`, checked
  by the database per table (`obj_…`, `ver_…`).
- Timestamps are `timestamptz`, read as `Date`.
- Drizzle maps `bigint` columns by their `mode`. Raw SQL returns `int8` as a **string** on both
  drivers; cast in the query (`count(*)::int`) when a number is wanted. Use `queryRows()` for
  raw SQL inside `withTenant()`.
- Never compare non-ASCII text after `upper()`/`lower()` in SQL: case mapping differs between
  engines. Normalize in the application.

## Changing the schema

1. Edit [`src/schema.ts`](src/schema.ts).
2. Run `pnpm --filter @openhoard/core-db db:generate` and commit the new file in `migrations/`.
   CI regenerates and fails if the schema and the migrations disagree.
3. **Adding a table:** add it to `tables` in `schema.ts`, give it `tenant_id` as the first
   column of its primary key and of every foreign key, and write a custom migration
   (`pnpm --filter @openhoard/core-db exec drizzle-kit generate --custom --name=<name>`) with
   the same three statements as [`0001_tenant_rls.sql`](migrations/0001_tenant_rls.sql):
   enable and force row-level security, and create the `tenant_isolation` policy.
   `rls.test.ts` fails for a table without them.

Migrations are never edited after they merge.

## Tests

```sh
pnpm --filter @openhoard/core-db test
```

Each test gets a fresh, migrated database from `@openhoard/core-db/testing` (`openTestDatabase`,
`seedTenant`). By default that is an in-memory PGlite. To run the same tests on native
PostgreSQL, point `OPENHOARD_TEST_POSTGRES_URL` at a server as an ordinary user with `CREATEDB`
and with pgvector installed; each test then creates and drops its own database:

```sh
OPENHOARD_TEST_POSTGRES_URL=postgres://owner:secret@localhost:5432/postgres pnpm --filter @openhoard/core-db test
```

CI does both: PGlite on every OS, and PostgreSQL 18 on Linux.
