#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { main } from "./cli.js";
import { operatorCommand } from "./operator.js";

// Process wiring only (stdio, argv, exit), like the server's main.ts: not counted in coverage.
// What it decides, which command `args` names, is operatorCommand in operator.ts.

/** The server's entry point, which `serve` runs and `tunnel` starts again as its own process. */
const serverMain = () => fileURLToPath(import.meta.resolve("@openhoard/server/main"));

/**
 * Runs `serve` or an operator command named in `args`: the exit code, "serving" while the
 * server runs, or null when `args` names none of them.
 */
async function runOperator(args: readonly string[]): Promise<number | "serving" | null> {
  const first = operatorCommand(args);
  if (first === null) return null;
  if (first.value === "serve") {
    // The server reads its options from process.argv: the same ones, without the word (`args`
    // is process.argv from its third entry on).
    process.argv.splice(first.index + 2, 1);
    // A URL, which Node's import() needs for an absolute path on Windows.
    await import(import.meta.resolve("@openhoard/server/main"));
    return "serving";
  }
  const { runAdmin, runConnect, runInit, runService, runTunnel } =
    await import("@openhoard/server");
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
          : first.value === "service"
            ? await runService(rest, io)
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

const args = process.argv.slice(2);
const ran = await runOperator(args);
if (ran === null) process.exitCode = main(args);
else if (ran !== "serving") process.exit(ran);
