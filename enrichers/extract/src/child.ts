import { format } from "node:util";
import { getHeapStatistics } from "node:v8";
import { resolveLimits } from "./limits.ts";
import { lockDown } from "./lockdown.ts";
import type { ExtractHint, ExtractLimits } from "./types.ts";

/*
 * The extractor's child process (see sandbox.ts for how it is started). It reads the content on
 * stdin and its settings from the environment, writes one line of JSON on stdout, and exits:
 *
 *   { "v": 1, "ok": true, "extraction": {…}, "stats": {…} }
 *   { "v": 1, "ok": false, "failure": "<code>", "stats": {…} }
 *
 * Nothing else reaches stdout: console output from a parser goes to stderr, which the parent
 * reads only to tell a crash from running out of memory.
 *
 * A watchdog samples the process's memory every 50 ms, and parsers check it as they read; past
 * the limit the process exits with EXIT_MEMORY straight away, before the parent's own checks or
 * V8's heap limit (the backstops) have to act.
 */

/** Exit code: the child stopped itself over its memory limit. */
export const EXIT_MEMORY = 70;
/** Exit code: started without its settings or without the permission model. */
export const EXIT_USAGE = 64;
/**
 * Exit code: an error nothing caught. Never 1: on Windows a process terminated from outside
 * (the host running out of memory, an operator) exits with 1, and the parent tells the two
 * apart by it.
 */
export const EXIT_FATAL = 71;
process.on("uncaughtException", () => process.exit(EXIT_FATAL));
process.on("unhandledRejection", () => process.exit(EXIT_FATAL));

// Before any parser loads.
lockDown();
for (const method of ["log", "info", "debug", "warn", "error", "trace"] as const) {
  console[method] = (...args: unknown[]) => void process.stderr.write(`${format(...args)}\n`);
}

const settings = readSettings();
if (settings === null || process.permission === undefined) process.exit(EXIT_USAGE);
const { hint, limits } = settings;

const memoryLimit = limits.memoryMb * 1024 * 1024;
let peak = 0;
function sample(): boolean {
  const rss = process.memoryUsage.rss();
  if (rss > peak) peak = rss;
  const heap = getHeapStatistics();
  return rss <= memoryLimit && heap.used_heap_size <= heap.heap_size_limit * 0.9;
}
setInterval(() => {
  if (!sample()) process.exit(EXIT_MEMORY);
}, 50).unref();

const { runExtraction } = await import("./run.ts");
const { ExtractError, failureOf } = await import("./errors.ts");
let bytesRead = 0;
let answer: object;
try {
  const result = await runExtraction(counted(process.stdin), hint, limits, () => {
    if (!sample()) throw new ExtractError("memory-limit");
  });
  answer = { ok: true, extraction: result.extraction };
} catch (e) {
  answer = { ok: false, failure: failureOf(e) };
}
sample();
const line = JSON.stringify({ v: 1, ...answer, stats: { bytesRead, peakRssBytes: peak } });
process.stdout.write(`${line}\n`, () => process.exit(0));

async function* counted(stream: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  for await (const chunk of stream) {
    bytesRead += chunk.byteLength;
    yield chunk;
  }
}

/** The settings the parent put in the environment, checked again; null when unusable. */
function readSettings(): { hint: ExtractHint; limits: ExtractLimits } | null {
  try {
    const parsed = JSON.parse(process.env.OPENHOARD_EXTRACT ?? "") as {
      hint?: { mime?: unknown; name?: unknown };
      limits?: Partial<ExtractLimits>;
    };
    const mime = parsed.hint?.mime;
    const name = parsed.hint?.name;
    if (typeof mime !== "string" || (name !== undefined && typeof name !== "string")) return null;
    return {
      hint: name === undefined ? { mime } : { mime, name },
      limits: resolveLimits(parsed.limits ?? {}),
    };
  } catch {
    return null;
  }
}
