import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lockDataDir, readLock } from "./pglite.js";

describe("lockDataDir", () => {
  let dir: string;
  let data: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openhoard-lock-"));
    data = join(dir, "pgdata");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes this process's pid and removes the lock on release", () => {
    const release = lockDataDir(data);
    expect(readFileSync(`${data}.lock`, "utf8")).toBe(String(process.pid));
    expect(() => lockDataDir(data)).toThrow(`already open in process ${process.pid}`);
    release();
    expect(existsSync(`${data}.lock`)).toBe(false);
    lockDataDir(data)();
  });

  it("takes over a lock whose process is gone", () => {
    // Pids are below 2^22 on Linux and far below this everywhere else.
    writeFileSync(`${data}.lock`, "2147483646");
    const release = lockDataDir(data);
    expect(readFileSync(`${data}.lock`, "utf8")).toBe(String(process.pid));
    release();
  });

  it("reports a lock that is already gone as free", () => {
    expect(readLock(`${data}.lock`)).toBeUndefined();
  });

  it("waits out a lock that is still being written, then treats an old empty one as stale", () => {
    writeFileSync(`${data}.lock`, "");
    expect(() => lockDataDir(data)).toThrow(/already open; only one process/);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${data}.lock`, old, old);
    lockDataDir(data)();
  });
});
