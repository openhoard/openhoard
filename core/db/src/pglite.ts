import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { PGlite, types } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Driver } from "./database.js";
import { migrationsFolder } from "./migrations.js";
import * as schema from "./schema.js";

export interface PgliteDriver extends Driver {
  /** A snapshot of the whole database, to start other instances from (tests). */
  dump(): Promise<Blob>;
}

/** The ordinary role that owns the embedded database, as the owner of a native one would. */
export const PGLITE_OWNER = "openhoard";

/**
 * PGlite (PostgreSQL compiled to WASM) in this process. `dataDir` persists it on disk; without
 * one it lives in memory, starting from the `snapshot` of another instance when given.
 */
export async function openPglite(options: {
  dataDir?: string;
  snapshot?: Blob;
}): Promise<PgliteDriver> {
  const unlock = options.dataDir === undefined ? () => {} : lockDataDir(options.dataDir);
  let client: PGlite | undefined;
  try {
    client = await PGlite.create({
      ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
      ...(options.snapshot === undefined ? {} : { loadDataDir: options.snapshot }),
      extensions: { vector },
      // Spike S2: PGlite returns int8 as number (BigInt past 2^53), node-postgres as string.
      // Strings on both, so raw queries behave the same; Drizzle columns map them by `mode`.
      parsers: { [types.INT8]: (value: string) => value },
    });
    // PGlite always connects as the superuser `postgres`, and superusers skip row-level
    // security. So the database belongs to an ordinary role and the session becomes it, as a
    // native installation connects as its owner. pgvector is not a trusted extension, so it is
    // created first, as a DBA would on a native server. The time zone is the host's otherwise
    // (spike S2); PGlite is one session, so setting these once is enough.
    await client.exec(`
      CREATE EXTENSION IF NOT EXISTS vector;
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PGLITE_OWNER}') THEN
          CREATE ROLE ${PGLITE_OWNER} NOLOGIN;
        END IF;
        EXECUTE format('ALTER DATABASE %I OWNER TO ${PGLITE_OWNER}', current_database());
      END
      $$;
      SET SESSION AUTHORIZATION ${PGLITE_OWNER};
      SET TIME ZONE 'UTC';
    `);
  } catch (e) {
    await client?.close();
    unlock();
    throw e;
  }
  const pglite = client;
  const db = drizzle(pglite, { schema });
  return {
    kind: "pglite",
    db,
    query: async (text) => (await pglite.query<Record<string, unknown>>(text)).rows,
    // PGlite is one connection in one process, and the lock keeps other processes out.
    migrate: () => migrate(db, { migrationsFolder }),
    dump: async () => (await pglite.dumpDataDir("none")) as Blob,
    async close() {
      try {
        await pglite.close();
      } finally {
        unlock();
      }
    },
  };
}

/**
 * PGlite does not lock its data directory, and two instances writing one directory lose data
 * silently. This takes `<dataDir>.lock` (holding the owner's pid) or throws if a live process,
 * this one included, holds it. A lock left by a process that died is taken over.
 */
export function lockDataDir(dataDir: string): () => void {
  const path = `${dataDir}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const holder = readLock(path);
      if (holder === undefined) continue; // released in the meantime: try again
      if (holder.live) {
        const who = holder.pid === undefined ? "" : ` in process ${holder.pid}`;
        throw new Error(
          `the embedded database in ${dataDir} is already open${who}; ` +
            `only one process may open it at a time`,
          { cause: e },
        );
      }
      rmSync(path, { force: true }); // stale: its process is gone
      continue;
    }
    try {
      writeSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    return () => rmSync(path, { force: true });
  }
  throw new Error(`could not lock the embedded database in ${dataDir}`);
}

/**
 * Reads an existing lock through one file descriptor, so the pid and the age belong to the same
 * file. Undefined when the lock is gone by the time we look.
 */
export function readLock(path: string): { pid?: number; live: boolean } | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  try {
    const pid = Number.parseInt(readFileSync(fd, "utf8"), 10);
    if (Number.isSafeInteger(pid) && pid > 0) return { pid, live: isAlive(pid) };
    // No pid yet: another process created the file an instant ago and is still writing it.
    return { live: Date.now() - fstatSync(fd).mtimeMs < 5_000 };
  } finally {
    closeSync(fd);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
