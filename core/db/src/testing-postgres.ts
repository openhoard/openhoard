import { randomBytes } from "node:crypto";
import pg from "pg";
import { openDriver, type Driver } from "./database.js";

/**
 * Creates a fresh database on `serverUrl` with the required locale, and returns a driver for it
 * whose close() also drops it. Covered by the native Postgres CI job, not the PGlite run.
 */
export async function createPostgresDatabase(serverUrl: string): Promise<Driver & { url: string }> {
  const name = `openhoard_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    await admin.query(
      `create database ${name} template template0 encoding 'UTF8' ` +
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
