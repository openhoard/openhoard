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
import { insideWithTenant, NestedWorkError, type Driver } from "./database.js";
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
    queue: () => ({ kind: "pglite", executeSql: (text, values) => queueSql(pglite, text, values) }),
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
 * Runs one of pg-boss's statements on the embedded instance (core-db/queue queueConnectionOf()).
 *
 * PGlite is one session, shared with the application, and runs each query or transaction whole
 * before the next (its transaction lock, which drizzle's transactions hold too). pg-boss expects
 * a pool, where a failed statement can't touch anyone else's. Here it could: a block of its own
 * (`BEGIN; …; COMMIT`) failing half way would leave the session in an aborted transaction that
 * the next application transaction would fall into. So a block without parameters runs inside a
 * PGlite transaction, which rolls back on failure before anyone else runs. pg-boss's own BEGIN
 * and COMMIT in it are harmless (Postgres warns and carries on). A parameterized statement is
 * one statement in autocommit, and building, dropping or rebuilding an index CONCURRENTLY can't
 * run in a transaction at all: both run on their own, followed by a ROLLBACK after a failure, in
 * case the session was left in one (as pg-boss's own PGlite adapter does).
 *
 * The session is the application's, so a statement could change what the application's next
 * transactions are: a session-level `app.*` setting, or the session's role (PGlite connects as a
 * superuser and only switches to the owner role, core-db pglite.ts). pg-boss issues neither, so
 * any statement touching them is refused ({@link UNSAFE_QUEUE_SQL}).
 *
 * Called inside a withTenant() callback it would wait for the transaction lock the callback
 * holds, forever: it throws instead.
 */
export async function queueSql(
  pglite: PGlite,
  text: string,
  values?: unknown[],
): Promise<{ rows: unknown[] }> {
  if (insideWithTenant()) throw new NestedWorkError("a job queue call (pg-boss)");
  const params = values ?? [];
  if (
    UNSAFE_QUEUE_SQL.test(text) ||
    params.some((v) => typeof v === "string" && /^\s*app\s*\./i.test(v))
  ) {
    throw new Error("the job queue connection refuses statements that change session settings");
  }
  const alone = async <T>(run: () => Promise<T>) => {
    try {
      return await run();
    } catch (e) {
      await pglite.query("ROLLBACK").catch(() => {});
      throw e;
    }
  };
  if (params.length > 0) {
    return alone(async () => ({ rows: (await pglite.query(text, params)).rows }));
  }
  if (CONCURRENT_DDL.test(text)) {
    return alone(async () => ({ rows: (await pglite.exec(text)).flatMap((r) => r.rows) }));
  }
  // exec() returns one result per statement: keep every row, so a RETURNING before the COMMIT
  // isn't lost (node-postgres returns them all too).
  return pglite.transaction(async (tx) => ({
    rows: (await tx.exec(text)).flatMap((r) => r.rows),
  }));
}

/** A statement that must run outside a transaction block: index DDL done CONCURRENTLY. */
const CONCURRENT_DDL =
  /^\s*(?:create\s+(?:unique\s+)?index|drop\s+index|reindex\s+(?:\(\s*[\w\s,]*\)\s*)?\w+)\s+concurrently\b/i;

/**
 * What the queue connection refuses: `app.*` settings (the tenant and the tenant directory),
 * set_config() (which can name them through a parameter), and changes of role or session
 * authorization, or a reset of every setting.
 */
export const UNSAFE_QUEUE_SQL =
  /\bapp\s*\.|\bset_config\s*\(|\bsession\s+authorization\b|\b(?:set|reset)\s+role\b|\breset\s+all\b|\bset\s+session\b/i;

/**
 * Data directories this module instance has open (lock path → the content of its lock file).
 * Another instance in this process (a worker thread, a second copy of this package) has its own.
 */
const openHere = new Map<string, string>();

/**
 * When this process started, the same in every thread: on Linux the kernel's start time in clock
 * ticks since boot (`l…`), elsewhere an estimate in milliseconds (`t…`). A lock naming this
 * process's pid but another start was left by an earlier process that had the same pid: in a
 * container, a restarted node process usually gets the pid its crashed predecessor had.
 */
export function processStart(): string {
  started ??= readProcessStart();
  return started;
}

let started: string | undefined;

function readProcessStart(): string {
  try {
    // Field 22 of /proc/self/stat; the command name before it may hold spaces and parentheses.
    const stat = readFileSync("/proc/self/stat", "utf8");
    const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (ticks !== undefined && /^\d+$/.test(ticks)) return `l${ticks}`;
  } catch {
    // not Linux
  }
  return `t${Math.round(Date.now() - process.uptime() * 1000)}`;
}

/** Whether a lock's recorded start (see {@link processStart}) is this process's. */
function sameStart(recorded: string, mine: string): boolean {
  if (recorded.startsWith("l") || mine.startsWith("l")) return recorded === mine;
  // Two estimates of one start differ by the clock's jitter, well under a second.
  const a = Number(recorded.slice(1));
  const b = Number(mine.slice(1));
  return recorded.startsWith("t") && Number.isFinite(a) && Math.abs(a - b) < 2_000;
}

/**
 * PGlite does not lock its data directory, and two instances writing one directory lose data
 * silently. This takes `<dataDir>.lock`, holding the owner's pid, when that process started and
 * a random nonce, or throws if a live holder, this process included, has it. A lock whose
 * process is gone, or that names this pid with another start, is stale and taken over.
 */
export function lockDataDir(dataDir: string): () => void {
  const path = resolve(`${dataDir}.lock`);
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    const content = `${process.pid} ${processStart()} ${randomBytes(16).toString("hex")}`;
    // Written aside and linked into place, so the lock never exists without its content: two
    // processes can't both judge one empty lock stale and both end up holding it.
    const draft = `${path}.new-${randomBytes(8).toString("hex")}`;
    const fd = openSync(draft, "wx");
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(draft, path); // unlike rename, fails if the lock exists
    } catch (e) {
      rmSync(draft, { force: true });
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
    rmSync(draft, { force: true });
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
    const [first, start] = content.split(" ");
    const pid = Number.parseInt(first ?? "", 10);
    if (Number.isSafeInteger(pid) && pid > 0) {
      if (pid !== process.pid) return { pid, live: isAlive(pid), content };
      // This pid: live if this process wrote it (any thread or copy of this module). A lock in
      // the older format, without a start, is live only if this module instance holds it.
      const live =
        start !== undefined && /^[lt]\d+$/.test(start)
          ? sameStart(start, processStart())
          : openHere.get(resolve(path)) === content;
      return { pid, live, content };
    }
    // No pid: an older version created the file an instant ago and is still writing it.
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
