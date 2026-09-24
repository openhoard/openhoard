import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lockDataDir, processStart, readLock, removeStaleLock } from "./pglite.js";

describe("lockDataDir", () => {
  let dir: string;
  let data: string;
  let lock: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openhoard-lock-"));
    data = join(dir, "pgdata");
    lock = `${data}.lock`;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes this process's pid, start and a nonce, and removes the lock on release", () => {
    const release = lockDataDir(data);
    // The start: exact on Linux, elsewhere an estimate that another thread may read a
    // millisecond off, which a lock check tolerates.
    expect(readFileSync(lock, "utf8")).toMatch(
      new RegExp(`^${process.pid} [lt]\\d+ [0-9a-f]{32}$`),
    );
    expect(() => lockDataDir(data)).toThrow(`already open in process ${process.pid}`);
    release();
    expect(existsSync(lock)).toBe(false);
    release(); // twice is harmless
    lockDataDir(data)();
  });

  it("takes over a lock whose process is gone", () => {
    // Pids are below 2^22 on Linux and far below this everywhere else.
    writeFileSync(lock, "2147483646 0123456789abcdef0123456789abcdef");
    const release = lockDataDir(data);
    expect(readFileSync(lock, "utf8")).toMatch(new RegExp(`^${process.pid} `));
    release();
  });

  it("takes over a lock with this process's pid but another start", () => {
    // A container restart: the crashed node had the pid this one has now. Also the older
    // formats, with no start, that this module instance doesn't hold.
    const other = processStart().startsWith("l") ? "l1" : "t1";
    for (const stale of [
      `${process.pid} ${other} 0123456789abcdef0123456789abcdef`,
      `${process.pid} 0123456789abcdef0123456789abcdef`,
      `${process.pid}`,
    ]) {
      writeFileSync(lock, stale);
      expect(readLock(lock)).toMatchObject({ pid: process.pid, live: false });
      const release = lockDataDir(data);
      expect(readFileSync(lock, "utf8")).not.toBe(stale);
      expect(readLock(lock)).toMatchObject({ pid: process.pid, live: true });
      release();
    }
    // Nothing left aside.
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a lock this process holds through another thread or copy of this module", () => {
    // Same pid and start, but not in this module instance's own list: a worker thread has it.
    const theirs = `${process.pid} ${processStart()} 0123456789abcdef0123456789abcdef`;
    writeFileSync(lock, theirs);
    expect(readLock(lock)).toMatchObject({ pid: process.pid, live: true });
    expect(() => lockDataDir(data)).toThrow(`already open in process ${process.pid}`);
    expect(readFileSync(lock, "utf8")).toBe(theirs);
    expect(readdirSync(dir)).toEqual(["pgdata.lock"]); // no draft left behind
  });

  it("does not remove a lock another process took over after judging ours stale", () => {
    const release = lockDataDir(data);
    const fresh = "2147483646 ffffffffffffffffffffffffffffffff";
    writeFileSync(lock, fresh);
    release();
    expect(readFileSync(lock, "utf8")).toBe(fresh);
  });

  it("reports a lock that is already gone as free", () => {
    expect(readLock(lock)).toBeUndefined();
  });

  it("waits out a lock that is still being written, then treats an old empty one as stale", () => {
    writeFileSync(lock, "");
    expect(() => lockDataDir(data)).toThrow(/already open; only one process/);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    lockDataDir(data)();
  });
});

describe("removeStaleLock", () => {
  let dir: string;
  let lock: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openhoard-lock-"));
    lock = join(dir, "pgdata.lock");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("removes the lock it judged stale", () => {
    writeFileSync(lock, "2147483646 aa");
    expect(removeStaleLock(lock, "2147483646 aa")).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("puts back a lock that changed since it was judged, and reports failure", () => {
    // Another process replaced the stale lock with its own between our read and our rename.
    writeFileSync(lock, "2147483645 bb");
    expect(removeStaleLock(lock, "2147483646 aa")).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe("2147483645 bb");
    expect(readdirSync(dir)).toEqual(["pgdata.lock"]);
  });

  it("treats a lock that is gone as removed", () => {
    expect(removeStaleLock(lock, "2147483646 aa")).toBe(true);
  });
});
