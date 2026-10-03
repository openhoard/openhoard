import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { folderState, newStateId, type Kept, type LogLine } from "./state.js";

let base: string;
let dir: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "oh-sp-kept-"));
  dir = join(base, "tenant", "source");
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true, maxRetries: 5 });
});

const kept = (): Kept => ({
  folders: new Map([
    [
      "d1",
      new Map([
        ["root", { parent: null, name: "Documents" }],
        ["f1", { parent: "root", name: "Plans" }],
      ]),
    ],
    // An id that is a property of every object: kept as any other.
    ["__proto__", new Map([["r2", { parent: null, name: "Odd" }]])],
  ]),
  relist: new Map([["d1", new Set(["f1"])]]),
  deleted: new Map([["__proto__", new Set(["x9"])]]),
});

describe("a generation", () => {
  it("is read back as it was written, in a directory and a file of the server's alone", () => {
    const state = folderState(dir);
    const gen = newStateId();
    state.writeGeneration(gen, kept());
    expect(state.readGeneration(gen)).toEqual(kept());
    expect(readdirSync(dir)).toEqual([`folders.${gen}.json`]);
    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, `folders.${gen}.json`)).mode & 0o777).toBe(0o600);
    }
  });

  it("makes a directory that was there before its own, where it can", () => {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    folderState(dir).writeGeneration(newStateId(), kept());
    if (process.platform !== "win32") expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("that is missing, damaged, or not named as one is undefined, never guessed at", () => {
    const state = folderState(dir);
    expect(state.readGeneration(newStateId())).toBeUndefined();
    expect(state.readGeneration("../../etc/passwd")).toBeUndefined();
    expect(() => state.writeGeneration("../x", kept())).toThrow(RangeError);
    mkdirSync(dir, { recursive: true });
    const put = (text: string) => {
      const gen = newStateId();
      writeFileSync(join(dir, `folders.${gen}.json`), text);
      return state.readGeneration(gen);
    };
    expect(put("")).toBeUndefined();
    expect(put('{"v":1,"drives":{"d":[["a","b"')).toBeUndefined();
    expect(put('{"v":2,"drives":{}}')).toBeUndefined();
    expect(put('{"v":1,"drives":[]}')).toBeUndefined();
    expect(put('{"v":1,"drives":{}}')).toEqual({
      folders: new Map(),
      relist: new Map(),
      deleted: new Map(),
    });
    expect(put('{"v":1,"drives":{"d":"all"}}')).toBeUndefined();
    expect(put('{"v":1,"drives":{"d":[["id",7,"name"]]}}')).toBeUndefined();
    expect(put('{"v":1,"drives":{},"relist":{"d":[1]}}')).toBeUndefined();
    expect(put('{"v":1,"drives":{},"deleted":["x"]}')).toBeUndefined();
    // One written before these were kept: nothing left to do.
    expect(put('{"v":1,"drives":{"d":[["id",null,"Top"]]}}')?.relist.size).toBe(0);
  });

  it("leaves no part of itself behind when it can't be written", () => {
    const state = folderState(dir);
    const gen = newStateId();
    // Something is in the way of the name it would take.
    mkdirSync(join(dir, `folders.${gen}.json`), { recursive: true });
    writeFileSync(join(dir, `folders.${gen}.json`, "x"), "");
    expect(() => state.writeGeneration(gen, kept())).toThrow();
    expect(readdirSync(dir)).toEqual([`folders.${gen}.json`]);
  });

  it("is the only thing left when it is the one kept", () => {
    const state = folderState(dir);
    const [a, b] = [newStateId(), newStateId()];
    state.writeGeneration(a, kept());
    state.writeGeneration(b, kept());
    state.appendLog(newStateId(), [["d1", "f1", "root", "Plans"]]);
    writeFileSync(join(dir, ".folders.left.tmp"), "half");
    writeFileSync(join(dir, "not ours.txt"), "kept");
    state.keepOnly(b);
    expect(readdirSync(dir).sort()).toEqual([`folders.${b}.json`, "not ours.txt"].sort());
    // A directory that isn't there is nothing to tidy.
    folderState(join(base, "nowhere")).keepOnly(a);
    folderState(join(base, "nowhere")).keepOnlyLog(null);
  });
});

describe("a crawl's log", () => {
  const lines: LogLine[] = [
    ["d1", "root", null, "Documents"],
    ["d1", "f1", "root", "Plans"],
    ["d1", "f2", "f1", "2026"],
  ];

  it("is cut back to the length a checkpoint named, and no further", () => {
    const state = folderState(dir);
    const log = newStateId();
    const at = state.appendLog(log, lines.slice(0, 2));
    expect(state.logLength(log)).toBe(at);
    const longer = state.appendLog(log, lines.slice(2));
    expect(longer).toBeGreaterThan(at);
    expect(state.readLog(log)?.folders.get("d1")?.size).toBe(3);
    expect(state.truncateLog(log, at)).toBe(true);
    expect(state.readLog(log)?.folders.get("d1")?.size).toBe(2);
    // Shorter than the checkpoint knew, or gone: not one to go on from.
    expect(state.truncateLog(log, longer)).toBe(false);
    expect(state.truncateLog(log, -1)).toBe(false);
    expect(state.truncateLog(newStateId(), 0)).toBe(false);
    expect(state.logLength("no/such")).toBeUndefined();
    // An append of nothing is still a log, of the same length.
    expect(state.appendLog(log, [])).toBe(at);
  });

  it("comes to the last word on each folder, and remembers which had two", () => {
    const state = folderState(dir);
    const log = newStateId();
    state.appendLog(log, [
      ...lines,
      ["d1", "f1", "root", "Plans"], // met again, the same: nothing to do
      ["d1", "f2", "root", "2026"], // met again, moved
      ["d2", "r", null, "Archive"],
    ]);
    const read = state.readLog(log) as Kept;
    expect(read.folders.get("d1")?.get("f2")).toEqual({ parent: "root", name: "2026" });
    expect(read.relist).toEqual(new Map([["d1", new Set(["f2"])]]));
    expect(read.deleted.size).toBe(0);
    expect(read.folders.get("d2")?.size).toBe(1);
  });

  it("takes a deleted folder out, and keeps the id to be said later, unless it is met again", () => {
    const state = folderState(dir);
    const log = newStateId();
    state.appendLog(log, [
      ...lines,
      ["d1", "f2", "root", "2026"], // moved...
      ["d1", "f2"], // ...then deleted: nothing under it to look for
      ["d1", "file-1"],
      ["d1", "f1"],
      ["d1", "f1", "root", "Plans again"], // deleted, then there after all
    ]);
    const read = state.readLog(log) as Kept;
    expect([...(read.folders.get("d1")?.keys() ?? [])]).toEqual(["root", "f1"]);
    expect(read.relist.get("d1")?.size ?? 0).toBe(0);
    expect(read.deleted).toEqual(new Map([["d1", new Set(["f2", "file-1"])]]));
  });

  it("told of the whole recycle bin keeps none of it", () => {
    const state = folderState(dir);
    const log = newStateId();
    const many: LogLine[] = Array.from({ length: 5001 }, (_, i) => ["d1", `gone-${i}`]);
    state.appendLog(log, [...many, ["d2", "one"]]);
    const read = state.readLog(log) as Kept;
    expect(read.deleted.has("d1")).toBe(false);
    expect(read.deleted.get("d2")).toEqual(new Set(["one"]));
  });

  it("that is damaged or missing is undefined", () => {
    const state = folderState(dir);
    expect(state.readLog(newStateId())).toBeUndefined();
    expect(state.readLog("../x")).toBeUndefined();
    expect(() => state.appendLog("../x", [])).toThrow(RangeError);
    const put = (text: string) => {
      const log = newStateId();
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `crawl.${log}.jsonl`), text);
      return state.readLog(log);
    };
    expect(put('["d1","f1","root","Plans"]\n["d1","f')).toBeUndefined();
    expect(put('{"d1":1}\n')).toBeUndefined();
    expect(put('["d1"]\n')).toBeUndefined();
    expect(put('["d1","f1","root"]\n')).toBeUndefined();
    expect(put('["d1","f1",7,"Plans"]\n')).toBeUndefined();
    expect(put("")?.folders.size).toBe(0);
  });

  it("is the only log left when a crawl starts or resumes, generations untouched", () => {
    const state = folderState(dir);
    const [mine, other, gen] = [newStateId(), newStateId(), newStateId()];
    state.appendLog(mine, lines);
    state.appendLog(other, lines);
    state.writeGeneration(gen, kept());
    state.keepOnlyLog(mine);
    expect(readdirSync(dir).sort()).toEqual([`crawl.${mine}.jsonl`, `folders.${gen}.json`].sort());
    state.keepOnlyLog(null);
    expect(existsSync(join(dir, `crawl.${mine}.jsonl`))).toBe(false);
    expect(existsSync(join(dir, `folders.${gen}.json`))).toBe(true);
  });
});
