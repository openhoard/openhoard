import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceSchema } from "./config.js";
import {
  createDebouncer,
  defaultWatchFactory,
  isWatchNoise,
  recursiveWatch,
  watchSources,
  type WatchFactory,
  type WatchedSource,
} from "./watch.js";

/* T-1203: a folder's change requests a sync of its source soon, debounced, never crashing. */

const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() });
const src = (more: Partial<WatchedSource> = {}): WatchedSource => ({
  id: "fs-docs",
  tenantId: "ten_0000000000000000000000000a",
  root: "/nowhere",
  connector: "fs",
  watch: true,
  ...more,
});

/** A watch factory the test drives: `emit` an event, `error` a failure. */
function fakeWatcher() {
  const live: {
    onEvent: (p: string | null) => void;
    onError: (e: unknown) => void;
    closed: boolean;
  }[] = [];
  let failNext: unknown = undefined;
  const factory: WatchFactory = (_root, onEvent, onError) => {
    if (failNext !== undefined) {
      const err = failNext;
      failNext = undefined;
      throw err;
    }
    const w = { onEvent, onError, closed: false };
    live.push(w);
    return { close: () => void (w.closed = true) };
  };
  return {
    factory,
    live,
    emit: (p: string | null = "a.txt") => live.at(-1)?.onEvent(p),
    error: (e: unknown) => live.at(-1)?.onError(e),
    failNextStart: (e: unknown) => void (failNext = e),
  };
}

describe("isWatchNoise", () => {
  it.each([
    "~$report.docx",
    "sub/~$Budget.xlsx",
    "sub\\~$Budget.xlsx",
    "download.tmp",
    "a/B.TMP",
    ".~lock.notes.odt#",
    ".DS_Store",
    "x/.DS_Store",
    "Thumbs.db",
    "pics/thumbs.db",
    "desktop.ini",
    "Desktop.ini",
  ])("ignores %s", (p) => expect(isWatchNoise(p)).toBe(true));
  it.each([
    "report.docx",
    "~report.docx",
    "notes/.hidden.md",
    ".git/config",
    "a.tmp/real.txt",
    ".~lock.notes.odt",
    "tmp",
  ])("keeps %s", (p) => expect(isWatchNoise(p)).toBe(false));
});

describe("createDebouncer", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("fires once after the quiet time", async () => {
    const fire = vi.fn(async () => {});
    const d = createDebouncer({ fire, debounceMs: 2_000, maxWaitMs: 10_000 });
    d.poke();
    await vi.advanceTimersByTimeAsync(1_000);
    d.poke();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fire).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("fires no later than the max wait while events keep coming", async () => {
    const fire = vi.fn(async () => {});
    const d = createDebouncer({ fire, debounceMs: 2_000, maxWaitMs: 10_000 });
    for (let t = 0; t < 25_000; t += 500) {
      d.poke();
      await vi.advanceTimersByTimeAsync(500);
    }
    // At 10 s and 20 s from each burst's first event.
    expect(fire).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fire).toHaveBeenCalledTimes(3);
  });

  it("never has two in flight: one due meanwhile follows the first", async () => {
    let resolve!: () => void;
    const fire = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const d = createDebouncer({ fire, debounceMs: 100, maxWaitMs: 1_000 });
    d.poke();
    await vi.advanceTimersByTimeAsync(100);
    expect(fire).toHaveBeenCalledTimes(1);
    d.poke();
    await vi.advanceTimersByTimeAsync(100);
    d.poke();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fire).toHaveBeenCalledTimes(1);
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(fire).toHaveBeenCalledTimes(2);
    resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("survives a rejecting fire and stops after close()", async () => {
    const fire = vi.fn(() => Promise.reject(new Error("boom")));
    const d = createDebouncer({ fire, debounceMs: 100, maxWaitMs: 1_000 });
    d.poke();
    await vi.advanceTimersByTimeAsync(100);
    d.poke();
    await vi.advanceTimersByTimeAsync(100);
    expect(fire).toHaveBeenCalledTimes(2);
    d.poke();
    d.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fire).toHaveBeenCalledTimes(2);
  });
});

describe("watchSources (fake watcher)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oh-watch-"));
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("requests one sync per burst, ignores noise and sources with watch off", async () => {
    const w = fakeWatcher();
    const request = vi.fn(async () => null);
    const log = logger();
    const watching = watchSources(
      [src({ root: dir }), src({ id: "off", root: dir, watch: false })],
      { request, log, watcher: w.factory, debounceMs: 2_000, maxWaitMs: 10_000 },
    );
    expect(w.live).toHaveLength(1);
    expect(log.info).toHaveBeenCalledWith(
      { source: "fs-docs", tenantId: src().tenantId },
      "watching the folder",
    );
    w.emit("~$a.docx");
    w.emit(".DS_Store");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).not.toHaveBeenCalled();
    w.emit("a.docx");
    w.emit("b.docx");
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledWith(src().tenantId, "fs-docs");
    // Names only at debug.
    for (const call of [...log.info.mock.calls, ...log.warn.mock.calls])
      expect(JSON.stringify(call)).not.toContain("a.docx");
    await watching.close();
    expect(w.live[0]?.closed).toBe(true);
    w.emit("c.docx");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("logs a failed request and keeps watching", async () => {
    const w = fakeWatcher();
    const request = vi.fn(() => Promise.reject(new Error("queue down")));
    const log = logger();
    const watching = watchSources([src({ root: dir })], {
      request,
      log,
      watcher: w.factory,
      debounceMs: 100,
    });
    w.emit();
    await vi.advanceTimersByTimeAsync(100);
    // fire() stats the folder first: real I/O, so wait for it.
    await vi.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ source: "fs-docs" }),
        "could not request a sync after a change",
      ),
    );
    w.emit();
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await watching.close();
  });

  it("falls back to the schedule on a watch error, warns once, and re-arms later", async () => {
    const w = fakeWatcher();
    const request = vi.fn(async () => null);
    const log = logger();
    const watching = watchSources([src({ root: dir })], {
      request,
      log,
      watcher: w.factory,
      debounceMs: 100,
      retryMs: 60_000,
    });
    w.error(Object.assign(new Error("inotify"), { code: "ENOSPC" }));
    expect(w.live[0]?.closed).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toMatchObject({ source: "fs-docs", code: "ENOSPC" });
    // Still failing on the retry: no second warning.
    w.failNextStart(Object.assign(new Error("inotify"), { code: "ENOSPC" }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log.warn).toHaveBeenCalledTimes(1);
    // Then it works: watching again, and a sync for what changed meanwhile.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.live).toHaveLength(2);
    expect(log.info).toHaveBeenLastCalledWith(expect.anything(), "watching the folder again");
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await watching.close();
  });

  it("stops watching a folder that is gone instead of requesting its sync", async () => {
    const w = fakeWatcher();
    const request = vi.fn(async () => null);
    const log = logger();
    const watching = watchSources([src({ root: dir })], {
      request,
      log,
      watcher: w.factory,
      debounceMs: 100,
    });
    rmSync(dir, { recursive: true, force: true });
    w.emit(null);
    await vi.advanceTimersByTimeAsync(100);
    // stat() is real I/O: let it settle.
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalled());
    expect(request).not.toHaveBeenCalled();
    expect(log.warn.mock.calls[0]?.[0]).toMatchObject({ code: "ENOENT" });
    await watching.close();
  });

  it("a watcher that can't start doesn't throw", async () => {
    const log = logger();
    const watching = watchSources([src({ root: join(dir, "missing") })], {
      request: vi.fn(async () => null),
      log,
    });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "ENOENT" }),
      expect.stringContaining("cannot watch"),
    );
    await watching.close();
  });
});

// Real file system: the platform's watcher, as the server runs it. The Windows runner is slow.
const slow = process.platform === "win32" ? 60_000 : 15_000;
describe("watchSources (real folders)", { timeout: slow * 2 }, () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "oh-watch-real-"));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true, maxRetries: 5 }));

  const cases: [string, WatchFactory][] = [["default", defaultWatchFactory]];
  // Node's own recursive watch too, where it is native.
  if (process.platform !== "linux") cases.push(["recursive", recursiveWatch]);

  it.each(cases)("%s: a saved file requests a sync; a removed folder only warns", async (_n, f) => {
    const root = join(base, "Docs");
    mkdirSync(join(root, "a", "b"), { recursive: true });
    const request = vi.fn(async () => null);
    const log = logger();
    const watching = watchSources([src({ root })], {
      request,
      log,
      watcher: f,
      debounceMs: 200,
      maxWaitMs: 1_000,
    });
    try {
      // Let the tree's subfolders be watched (asynchronous on Linux).
      await new Promise((r) => setTimeout(r, 300));
      writeFileSync(join(root, "a", "b", "new.txt"), "hello");
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith(src().tenantId, "fs-docs"), {
        timeout: slow,
        interval: 50,
      });
      // A folder made later is watched too.
      const calls = request.mock.calls.length;
      mkdirSync(join(root, "later"));
      await new Promise((r) => setTimeout(r, 500));
      writeFileSync(join(root, "later", "x.txt"), "x");
      await vi.waitFor(() => expect(request.mock.calls.length).toBeGreaterThan(calls), {
        timeout: slow,
        interval: 50,
      });

      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
      await vi.waitFor(
        () =>
          expect(log.warn).toHaveBeenCalledWith(
            expect.objectContaining({ source: "fs-docs" }),
            expect.stringContaining("cannot watch"),
          ),
        { timeout: slow, interval: 50 },
      );
    } finally {
      await watching.close();
    }
  });
});

describe("config", () => {
  it("watches by default, and can be turned off", () => {
    const base = {
      id: "fs-docs",
      connector: "fs",
      tenantId: src().tenantId,
      root: process.platform === "win32" ? "C:\\Docs" : "/docs",
      zone: "Docs",
      owner: "steve@example.com",
    };
    expect(SourceSchema.parse(base).watch).toBe(true);
    expect(SourceSchema.parse({ ...base, watch: false }).watch).toBe(false);
    expect(SourceSchema.safeParse({ ...base, watch: "yes" }).success).toBe(false);
  });
});
