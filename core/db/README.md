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

Nothing cascades from a tenant, a zone or a blob. Deleting an object removes its versions and
source references; removing a whole tenant is a deliberate, ordered process.

What this protects against, and what it doesn't:

- It holds against application queries that forget a tenant filter or use another tenant's
  ids, and against other roles on the same cluster (the tables grant nothing to anyone).
- It does not hold against arbitrary SQL. The application connects as the tables' owner, so
  raw SQL could change `app.tenant_id` or the policies themselves. Use the query builder and
  parameters, never `sql.raw()` with input. A separate runtime role with only DML rights is a
  planned hardening step.

## Grants

Access is granted as data (spike S3): a row in `grants` gives a user or a group read or write
access to every object carrying a tag, or to one object. Grants expire after 90 days unless the
caller sets another date, or asks for a permanent one explicitly. `loadGrants()` returns only
live grants for a caller's principals (at a given moment), in the shape core/policy's
`authorize()` takes, so an expired or revoked grant stops working at once, with no job to run.
Revoking keeps the row for history.

## Server requirements

`openDatabase()` refuses to start unless:

- PostgreSQL is 17 or later (18 recommended), with pgvector 0.8 or later available;
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
query. Each connection runs in UTC.

The embedded default (`pglite`) keeps its files in `<dataDir>/pgdata`. PGlite always connects
as a superuser, so the driver hands the database to an ordinary `openhoard` role and switches
the session to it. Only one process may open a data directory at a time; `<dataDir>/pgdata.lock`
enforces that.

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
