import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pinFolder, quickAccessScript, type Run } from "./pin.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "oh-pin-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("pinFolder on Windows", () => {
  const folder = "C:\\Users\\O'Brien\\OpenHoard";
  const ran: (readonly string[])[] = [];
  const run =
    (code: number): Run =>
    async (file, args) => {
      ran.push([file, ...args]);
      return code;
    };
  const pin = (r: Run) => pinFolder(folder, { platform: "win32", home, env: {}, run: r });

  it("pins through the Shell's verb, quoting the path for PowerShell", async () => {
    expect(await pin(run(0))).toMatchObject({ pinned: true });
    const [file, ...args] = ran.at(-1) as string[];
    expect(file).toBe("powershell.exe");
    expect(args).toContain("-NoProfile");
    const script = args.at(-1) as string;
    expect(script).toContain(`$path = 'C:\\Users\\O''Brien\\OpenHoard'`);
    expect(script).toContain("InvokeVerb('pintohome')");
    // $home is PowerShell's own read-only variable: assigning it would fail the script.
    expect(script).not.toMatch(/\$home\s*=/i);
  });

  it("leaves a folder already in Quick Access alone, and says so", async () => {
    expect(await pin(run(3))).toEqual({
      pinned: true,
      note: `${folder} is in Quick Access already`,
    });
  });

  it("says how to pin by hand when PowerShell fails or can't run", async () => {
    expect((await pin(run(1))).pinned).toBe(false);
    const failing: Run = () => Promise.reject(new Error("spawn powershell.exe ENOENT"));
    const result = await pin(failing);
    expect(result.pinned).toBe(false);
    expect(result.note).toContain("Pin to Quick access");
  });

  it("builds one script with no way out of its quotes", () => {
    const script = quickAccessScript("C:\\a'; Remove-Item -Recurse C:\\ ; '");
    expect(script).toContain(`$path = 'C:\\a''; Remove-Item -Recurse C:\\ ; '''`);
  });
});

describe("pinFolder on Linux", () => {
  const bookmarks = () => join(home, ".config", "gtk-3.0", "bookmarks");
  const pin = (folder: string, env: NodeJS.ProcessEnv = {}) =>
    pinFolder(folder, { platform: "linux", home, env });

  it("adds a GTK bookmark once", async () => {
    const folder = join(home, "Open Hoard");
    expect(await pin(folder)).toMatchObject({ pinned: true });
    expect(await pin(folder)).toMatchObject({
      pinned: true,
      note: expect.stringContaining("already"),
    });
    expect(readFileSync(bookmarks(), "utf8")).toBe(`${pathToFileURL(folder).href} OpenHoard\n`);
  });

  it("keeps the bookmarks already there, and a folder bookmarked under another label", async () => {
    mkdirSync(join(home, ".config", "gtk-3.0"), { recursive: true });
    const other = join(home, "Music");
    const folder = join(home, "OpenHoard");
    writeFileSync(bookmarks(), `${pathToFileURL(other).href} Tunes`);
    await pin(folder);
    expect(readFileSync(bookmarks(), "utf8")).toBe(
      `${pathToFileURL(other).href} Tunes\n${pathToFileURL(folder).href} OpenHoard\n`,
    );
    writeFileSync(bookmarks(), `${pathToFileURL(folder).href} Mine\n`);
    await pin(folder);
    expect(readFileSync(bookmarks(), "utf8")).toBe(`${pathToFileURL(folder).href} Mine\n`);
  });

  it("follows XDG_CONFIG_HOME", async () => {
    const config = join(home, "cfg");
    await pin(join(home, "OpenHoard"), { XDG_CONFIG_HOME: config });
    expect(readFileSync(join(config, "gtk-3.0", "bookmarks"), "utf8")).toContain("OpenHoard");
  });

  it("reports a bookmark it can't write, without throwing", async () => {
    writeFileSync(join(home, ".config"), "not a folder");
    const result = await pin(join(home, "OpenHoard"));
    expect(result.pinned).toBe(false);
    expect(result.note).toContain("by hand");
  });
});

describe("pinFolder on macOS", () => {
  it("says how to add it to Finder's sidebar", async () => {
    const result = await pinFolder("/Users/o/OpenHoard", { platform: "darwin", home, env: {} });
    expect(result).toMatchObject({ pinned: false, note: expect.stringContaining("Finder") });
  });
});
