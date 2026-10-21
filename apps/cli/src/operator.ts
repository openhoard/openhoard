import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/*
 * The server and its operator commands (T-1407): one `openhoard` binary.
 *
 *   openhoard [--data-dir <dir>] serve        the server (@openhoard/server's main.js)
 *   openhoard [--data-dir <dir>] admin …      admin commands (apps/server admin.ts)
 *   openhoard [--data-dir <dir>] init --solo  a one-person setup (solo.ts)
 *   openhoard [--data-dir <dir>] connect …    an AI client's config (connect.ts)
 *   openhoard [--data-dir <dir>] tunnel       the server behind a Cloudflare tunnel (tunnel.ts)
 *
 * The command is the first argument that isn't an option (`--data-dir x admin …` is admin too).
 * The server's package is loaded only for these, so `manifest` stays light.
 */

const COMMANDS = new Set(["serve", "admin", "init", "connect", "tunnel"]);

/**
 * The command `args` name, and where: the first argument that isn't an option, when it is one
 * of the server's; null otherwise (`--data-dir admin` is a directory named admin).
 */
export function operatorCommand(args: readonly string[]): { value: string; index: number } | null {
  const first = parseArgs({
    args: [...args],
    options: { "data-dir": { type: "string" } },
    strict: false,
    allowPositionals: true,
    tokens: true,
  }).tokens.find((t) => t.kind === "positional");
  return first?.kind === "positional" && COMMANDS.has(first.value)
    ? { value: first.value, index: first.index }
    : null;
}

/** The server's entry point, which `serve` runs and `tunnel` starts again as its own process. */
const serverMain = () => fileURLToPath(import.meta.resolve("@openhoard/server/main"));

/**
 * Runs `serve` or an operator command named in `args`: the exit code, "serving" while the
 * server runs, or null when `args` names none of them.
 */
export async function runOperator(args: readonly string[]): Promise<number | "serving" | null> {
  const first = operatorCommand(args);
  if (first === null) return null;
  if (first.value === "serve") {
    // The server reads its options from process.argv: the same ones, without the word (`args`
    // is process.argv from its third entry on).
    process.argv.splice(first.index + 2, 1);
    await import(serverMain());
    return "serving";
  }
  const { runAdmin, runConnect, runInit, runTunnel } = await import("@openhoard/server");
  const rest = [...args.slice(0, first.index), ...args.slice(first.index + 1)];
  // A reader that goes away (`… | head`) or a full disk fails the write. A command that waits
  // for its writes (io.write) handles that itself; for the rest it is remembered, so that what
  // was to be printed (a one-time token) and wasn't is not reported as success.
  let lost: Error | undefined;
  process.stdout.on("error", (e: Error) => (lost ??= e));
  const io = {
    out: (s: string) => void process.stdout.write(s),
    write: (s: string) =>
      new Promise<void>((done, fail) => {
        process.stdout.write(s, (err) => (err ? fail(err) : done()));
      }),
    err: (s: string) => void process.stderr.write(s),
    // How to run this again, for the next commands printed.
    command: `node "${process.argv[1] ?? "openhoard"}"`,
  };
  const code =
    first.value === "admin"
      ? await runAdmin(rest, io)
      : first.value === "connect"
        ? await runConnect(rest, io)
        : first.value === "tunnel"
          ? await runTunnel(rest, { ...io, self: serverMain() })
          : await runInit(rest, io);
  // Let what was written (the one-time token) reach a pipe before exiting: on Windows pipes
  // are asynchronous, and exit() would cut it off.
  await Promise.all(
    [process.stdout, process.stderr].map((s) => new Promise((done) => s.write("", done))),
  );
  if (code === 0 && lost !== undefined) {
    process.stderr.write(`standard output could not be written: ${lost.message}\n`);
    return 1;
  }
  return code;
}
