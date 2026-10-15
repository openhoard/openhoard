import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { folderState, newStateId, type LogLine, type SiteFolders } from "./state.js";

let base: string;
let dir: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "oh-sp-kept-"));
  dir = join(base, "tenant", "source");
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true, maxRetries: 5 });
});

const kept = (): SiteFolders =>
  new Map([
    [
      "d1",
      new Map([
        ["root", { parent: null, name: "Documents" }],
        ["f1", { parent: "root", name: "Plans" }],
      ]),
    ],
    // An id that is a property of every object: kept as any other.
    ["__proto__", new Map([["r2", { parent: null, name: "Odd" }]])],
  ]);

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

  it("that is missing, damaged, or not named as one is undefined, never repaired", () => {
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
    expect(put('{"v":1,"drives":{"d":[["a","b"')).toBeUndefined();
    expect(put('{"v":2,"drives":{}}')).toBeUndefined();
    expect(put('{"v":1,"drives":{"d":[["id",7,"name"]]}}')).toBeUndefined();
    expect(put('{"v":1,"drives":{}}')).toEqual(new Map());
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
  });
});

describe("a crawl's log", () => {
  const lines: LogLine[] = [
    ["d1", "root", null, "Documents"],
    ["d1", "f1", "root", "Plans"],
    ["d1", "f2", "f1", "2026"],
  ];

  it("comes to the last word on each folder", () => {
    const state = folderState(dir);
    const log = newStateId();
    state.appendLog(log, lines);
    state.appendLog(log, [
      ["d1", "f2", "root", "2026"], // met again, moved
      ["d2", "r", null, "Archive"],
    ]);
    const read = state.readLog(log) as SiteFolders;
    expect(read.get("d1")?.get("f2")).toEqual({ parent: "root", name: "2026" });
    expect(read.get("d1")?.size).toBe(3);
    expect(read.get("d2")?.size).toBe(1);
  });

  it("that is damaged or missing is undefined", () => {
    const state = folderState(dir);
    expect(state.readLog(newStateId())).toBeUndefined();
    expect(state.readLog("../x")).toBeUndefined();
    expect(() => state.appendLog("../x", [])).toThrow(RangeError);
    mkdirSync(dir, { recursive: true });
    const log = newStateId();
    writeFileSync(join(dir, `crawl.${log}.jsonl`), '["d1","f1","root","Plans"]\n["d1","f');
    expect(state.readLog(log)).toBeUndefined();
  });

  it("is the only log left when a crawl starts or resumes, generations untouched", () => {
    const state = folderState(dir);
    const [mine, other, gen] = [newStateId(), newStateId(), newStateId()];
    state.appendLog(mine, lines);
    state.appendLog(other, lines);
    state.writeGeneration(gen, kept());
    state.keepOnlyLog(mine);
    expect(readdirSync(dir).sort()).toEqual([`crawl.${mine}.jsonl`, `folders.${gen}.json`].sort());
  });
});
