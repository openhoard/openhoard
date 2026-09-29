import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/*
 * Pinning a folder where Save dialogs show it (T-1204): what `init --solo` does for each folder
 * it sets up, so saving into OpenHoard is one click from any app's Save As.
 *
 * - Windows: pinned to Quick Access (Explorer's "Pin to Quick access"), which every common
 *   Save dialog lists. Done through the Shell's own verb in PowerShell, as a person would, so
 *   it is undone the same way (right-click, "Unpin from Quick access"). A folder already pinned
 *   is left alone: the verb isn't a toggle, but the check keeps it from being asked twice.
 * - Linux: a GTK bookmark (GNOME Files and every GTK file chooser read
 *   `$XDG_CONFIG_HOME/gtk-3.0/bookmarks`), added once.
 * - macOS: Finder's sidebar has no supported interface left (LSSharedFileList is gone), so the
 *   person is told how to drag it there.
 *
 * Pinning is a convenience: a failure is reported and never fails the setup.
 */

export interface PinResult {
  pinned: boolean;
  /** One line for the person: what was done, or what to do by hand. */
  note: string;
}

/** Runs a program, resolving with its exit code (tests replace it). */
export type Run = (file: string, args: readonly string[]) => Promise<number>;

const runProgram: Run = (file, args) =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: 20_000, windowsHide: true }, (err) => {
      if (err === null) return resolve(0);
      const code = (err as { code?: unknown }).code;
      resolve(typeof code === "number" ? code : 1);
    });
  });

/** A PowerShell single-quoted string: quotes doubled, nothing else is special in one. */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** The PowerShell that pins `folder` to Quick Access unless it is there: exit 0 done, 3 there. */
export function quickAccessScript(folder: string): string {
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$path = ${psQuote(folder)}`,
    `$shell = New-Object -ComObject Shell.Application`,
    // Quick Access ("Home" on Windows 11): its items are the pinned and frequent folders.
    // ($home is PowerShell's own, read-only: hence $qa.)
    `$qa = $shell.Namespace('shell:::{679f85cb-0220-4080-b29b-5540cc05aab6}')`,
    `if ($qa -and ($qa.Items() | Where-Object { $_.Path -eq $path })) { exit 3 }`,
    `$folder = $shell.Namespace($path)`,
    `if (-not $folder) { exit 2 }`,
    `$folder.Self.InvokeVerb('pintohome')`,
  ].join("; ");
}

export async function pinFolder(
  folder: string,
  options: {
    platform: NodeJS.Platform;
    home: string;
    env: NodeJS.ProcessEnv;
    run?: Run;
  },
): Promise<PinResult> {
  const run = options.run ?? runProgram;
  switch (options.platform) {
    case "win32": {
      const code = await run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        quickAccessScript(folder),
      ]).catch(() => 1);
      if (code === 0) return { pinned: true, note: `pinned ${folder} to Quick Access` };
      if (code === 3) return { pinned: true, note: `${folder} is in Quick Access already` };
      return {
        pinned: false,
        note: `couldn't pin ${folder} to Quick Access: right-click it in Explorer, "Pin to Quick access"`,
      };
    }
    case "linux": {
      const config = options.env.XDG_CONFIG_HOME || join(options.home, ".config");
      const file = join(config, "gtk-3.0", "bookmarks");
      const uri = pathToFileURL(folder).href;
      try {
        let lines: string[] = [];
        try {
          lines = readFileSync(file, "utf8").split("\n");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        // A bookmark is `<uri>[ <label>]`: the same folder under any label is already there.
        if (lines.some((l) => l === uri || l.startsWith(`${uri} `))) {
          return { pinned: true, note: `${folder} is bookmarked already` };
        }
        mkdirSync(join(config, "gtk-3.0"), { recursive: true });
        const last = lines.at(-1);
        const sep = lines.length > 0 && last !== undefined && last !== "" ? "\n" : "";
        appendFileSync(file, `${sep}${uri} OpenHoard\n`);
        return { pinned: true, note: `bookmarked ${folder} for GTK file dialogs` };
      } catch (e) {
        return {
          pinned: false,
          note: `couldn't bookmark ${folder} (${(e as NodeJS.ErrnoException).code ?? "error"}): add it to your file manager's sidebar by hand`,
        };
      }
    }
    case "darwin":
      return {
        pinned: false,
        note: `to see ${folder} in every Save dialog, drag it into Finder's sidebar (Favorites)`,
      };
    default:
      return { pinned: false, note: `add ${folder} to your file manager's favourites by hand` };
  }
}
