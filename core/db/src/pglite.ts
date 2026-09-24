import { randomBytes } from "node:crypto";
import {
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
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
 * Data directories this process has open (lock path → the content of its lock file). A lock
 * naming this process's pid but absent here was left by an earlier process that had the same
 * pid: in a container, a restarted node process usually gets the pid its crashed predecessor had.
 */
const openHere = new Map<string, string>();

/**
 * PGlite does not lock its data directory, and two instances writing one directory lose data
 * silently. This takes `<dataDir>.lock`, holding the owner's pid and a random nonce, or throws
 * if a live holder, this process included, has it. A lock whose process is gone, or that names
 * this process without being one this process holds, is stale and taken over.
 */
export function lockDataDir(dataDir: string): () => void {
  const path = resolve(`${dataDir}.lock`);
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
      if (!removeStaleLock(path, holder.content)) {
        throw new Error(
          `the embedded database in ${dataDir} was locked by another process while this one ` +
            `was taking over a stale lock; only one process may open it at a time`,
          { cause: e },
        );
      }
      continue;
    }
    const content = `${process.pid} ${randomBytes(16).toString("hex")}`;
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }
    openHere.set(path, content);
    return () => {
      if (openHere.get(path) !== content) return; // released already
      openHere.delete(path);
      // Only our own lock, never one another process wrote after taking ours over.
      if (readLock(path)?.content === content) rmSync(path, { force: true });
    };
  }
  throw new Error(`could not lock the embedded database in ${dataDir}`);
}

/**
 * Removes a lock judged stale, if it is still the one judged (`content`). It is renamed aside
 * first, atomically, so two processes taking over one stale lock can't both win, and neither
 * can delete a fresh lock the other wrote meanwhile: if the renamed file isn't the one judged,
 * it goes back (without replacing anything newer) and this returns false.
 */
export function removeStaleLock(path: string, content: string): boolean {
  const aside = `${path}.stale-${randomBytes(8).toString("hex")}`;
  try {
    renameSync(path, aside);
  } catch (e) {
    // Gone already (its holder released it, or another process took it over): try again.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw e;
  }
  let moved: string;
  try {
    moved = readFileSync(aside, "utf8");
  } catch (e) {
    restoreLock(aside, path);
    throw e;
  }
  if (moved === content) {
    rmSync(aside, { force: true });
    return true;
  }
  restoreLock(aside, path);
  return false;
}

/** Puts a lock that was renamed aside back, unless a newer one took its place. */
function restoreLock(aside: string, path: string): void {
  try {
    linkSync(aside, path); // unlike rename, never replaces an existing file
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  } finally {
    rmSync(aside, { force: true });
  }
}

/**
 * Reads an existing lock through one file descriptor, so the content and the age belong to the
 * same file. Undefined when the lock is gone by the time we look. `content` is the file as read,
 * which a takeover checks against.
 */
export function readLock(
  path: string,
): { pid?: number; live: boolean; content: string } | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  try {
    const content = readFileSync(fd, "utf8");
    const pid = Number.parseInt(content, 10);
    if (Number.isSafeInteger(pid) && pid > 0) {
      // This process's pid is live only in a lock this process holds.
      const live = pid === process.pid ? openHere.get(resolve(path)) === content : isAlive(pid);
      return { pid, live, content };
    }
    // No pid yet: another process created the file an instant ago and is still writing it.
    return { live: Date.now() - fstatSync(fd).mtimeMs < 5_000, content };
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
