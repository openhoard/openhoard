import { randomBytes } from "node:crypto";
import pg from "pg";
import { openDriver, type Driver } from "./database.js";

/**
 * The template test databases are copied from when the server has it: made once by a superuser
 * with the required locale and pgvector created in it, and marked a template, so an ordinary
 * role with CREATEDB (as the tests connect) can copy it, extension included:
 *
 *   CREATE DATABASE openhoard_test_template TEMPLATE template0 ENCODING 'UTF8'
 *     LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8';
 *   ALTER DATABASE openhoard_test_template IS_TEMPLATE true;
 *   \c openhoard_test_template
 *   CREATE EXTENSION vector;
 *
 * pgvector isn't a trusted extension, so an ordinary role can't create it in a database of its
 * own; copying a template that has it is how a test database gets it without a superuser
 * connection in the tests. CI's postgres job runs the above; so must a developer's server.
 */
export const TEST_TEMPLATE = "openhoard_test_template";

/**
 * Creates a fresh database on `serverUrl` with the required locale (and pgvector, from
 * {@link TEST_TEMPLATE}), and returns a driver for it whose close() also drops it. Without the
 * template the database is made from template0 and the migrations stop at 0051 with the
 * instruction to create the extension. Covered by the native Postgres CI job, not the PGlite
 * run.
 */
export async function createPostgresDatabase(
  serverUrl: string,
  options: { withoutTemplate?: boolean } = {},
): Promise<Driver & { url: string }> {
  const name = `openhoard_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ ok: boolean }>(
      "select true as ok from pg_database where datname = $1 and datistemplate",
      [TEST_TEMPLATE],
    );
    // The template has the locale already; template0 needs it spelled out.
    await admin.query(
      rows.length > 0 && options.withoutTemplate !== true
        ? `create database ${name} template ${TEST_TEMPLATE}`
        : `create database ${name} template template0 encoding 'UTF8' ` +
            `locale_provider builtin builtin_locale 'C.UTF-8'`,
    );
  } finally {
    await admin.end();
  }
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const driver = await openDriver({ url: url.toString() });
  return {
    ...driver,
    url: url.toString(),
    async close() {
      await driver.close();
      const dropper = new pg.Client({ connectionString: serverUrl });
      await dropper.connect();
      try {
        // Not WITH (FORCE): that must terminate every other backend, and an ordinary user may not
        // terminate an autovacuum worker. A plain DROP stops autovacuum itself and waits up to
        // 5 s for other sessions, which is enough for the pool's backends to exit.
        await dropper.query(`drop database if exists ${name}`);
      } finally {
        await dropper.end();
      }
    },
  };
}
