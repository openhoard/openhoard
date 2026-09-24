/*
 * Server requirements (spike S2, ADR-0004). openDatabase() refuses to start when any fails,
 * because each one changes query results rather than just performance:
 *
 * 1. PostgreSQL 17 or later: the same major line as PGlite, and the builtin locale provider.
 * 2. pgvector 0.8 or later available: iterative index scans for filtered vector search (S1).
 * 3. Session time zone UTC.
 * 4. A code-point collation (builtin C.UTF-8, or libc C) and UTF-8 encoding, so ORDER BY
 *    matches PGlite. Language-aware sorting uses an explicit COLLATE in the query instead.
 * 5. Not a superuser and no BYPASSRLS: either skips row-level security, which would silently
 *    turn off tenant isolation.
 */

/** Runs one query as the connecting user and returns its rows. */
export type QueryRows = (sql: string) => Promise<Record<string, unknown>[]>;

export const MIN_SERVER_VERSION_NUM = 170000;
export const MIN_PGVECTOR = "0.8.0";

export async function checkServer(query: QueryRows): Promise<string[]> {
  const problems: string[] = [];

  const [server] = await query(
    `select current_setting('server_version_num')::int as num,
            current_setting('server_version') as version,
            current_setting('TimeZone') as tz`,
  );
  const num = Number(server?.num);
  if (!(num >= MIN_SERVER_VERSION_NUM)) {
    problems.push(
      `PostgreSQL ${String(server?.version)} is too old: OpenHoard needs 17 or later (18 recommended).`,
    );
    // The locale columns below only exist from 17 on.
    return problems;
  }
  if (server?.tz !== "UTC") {
    problems.push(`the session time zone is ${String(server?.tz)}, not UTC.`);
  }

  const [role] = await query(
    `select rolname as name, rolsuper as super, rolbypassrls as bypass
       from pg_roles where rolname = current_user`,
  );
  if (role?.super !== false || role.bypass !== false) {
    problems.push(
      `the database user ${String(role?.name)} is a superuser or has BYPASSRLS, which skips ` +
        `row-level security; connect as an ordinary role that owns the database.`,
    );
  }

  // The version that counts is the one created in this database; until it is created, the one
  // CREATE EXTENSION would install.
  const [vector] = await query(
    `select installed_version as installed, default_version as available
       from pg_available_extensions where name = 'vector'`,
  );
  if (!vector) {
    problems.push(
      `the pgvector extension is not installed on the server: its files are missing ` +
        `(pgvector ${MIN_PGVECTOR} or later is needed).`,
    );
  } else {
    const installed = typeof vector.installed === "string" ? vector.installed : undefined;
    const version = installed ?? String(vector.available);
    if (compareVersions(version, MIN_PGVECTOR) < 0) {
      problems.push(
        `pgvector ${version} is too old: ${MIN_PGVECTOR} or later is needed ` +
          (installed === undefined
            ? `(the version this server would install).`
            : `(the version installed in this database: install a newer pgvector on the ` +
              `server, then run ALTER EXTENSION vector UPDATE).`),
      );
    }
  }

  const [db] = await query(
    `select datlocprovider as provider, datcollate as collate, datlocale as locale,
            pg_encoding_to_char(encoding) as encoding
       from pg_database where datname = current_database()`,
  );
  if (db?.encoding !== "UTF8") {
    problems.push(`the database encoding is ${String(db?.encoding)}, not UTF8.`);
  }
  if (!isCodePointCollation(db)) {
    problems.push(
      `the database collation (${describeCollation(db)}) does not sort by code point. Create the ` +
        `database with: CREATE DATABASE … TEMPLATE template0 ENCODING 'UTF8' ` +
        `LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8'`,
    );
  }
  return problems;
}

function isCodePointCollation(db: Record<string, unknown> | undefined): boolean {
  if (!db) return false;
  if (db.provider === "b") return db.locale === "C" || db.locale === "C.UTF-8";
  if (db.provider === "c") return db.collate === "C" || db.collate === "POSIX";
  return false; // ICU, or unknown
}

function describeCollation(db: Record<string, unknown> | undefined): string {
  if (!db) return "unknown";
  const provider =
    { b: "builtin", c: "libc", i: "icu" }[String(db.provider)] ?? String(db.provider);
  return `${provider} ${String(db.provider === "c" ? db.collate : db.locale)}`;
}

/** Compares dotted numeric versions: "0.10.0" > "0.8.1". Non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split(".").map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

export class DatabaseCheckError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`the database does not meet OpenHoard's requirements:\n  - ${problems.join("\n  - ")}`);
    this.name = "DatabaseCheckError";
  }
}
