import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { mayExtract } from "./detect.ts";
import { resolveLimits } from "./limits.ts";
import { childEntry, readableFolders } from "./paths.ts";
import { maxAnswerBytes, parseAnswer } from "./schema.ts";
import type { ExtractHint, ExtractLimits, ExtractResult, PermanentFailure } from "./types.ts";

/*
 * Runs one extraction in a child process, so that a file that crashes, hangs or bloats a parser
 * costs that process and nothing else: the worker that asked gets a typed failure and goes on.
 *
 * The child is `node` itself (process.execPath) with:
 *
 * | Limit       | How                                                                        |
 * | ----------- | -------------------------------------------------------------------------- |
 * | time        | the parent kills it (SIGKILL) at `timeoutMs`, wall clock                   |
 * | memory      | V8 heap cap (`--max-old-space-size`), the child's own watchdog on its      |
 * |             | resident size (every 50 ms and as parsers read), and on Linux the parent   |
 * |             | reading /proc/<pid>/status every 250 ms and killing it past `memoryMb`     |
 * | output      | the parent reads at most maxAnswerBytes() of stdout, kills past that, and  |
 * |             | checks the answer field by field (schema.ts)                               |
 * | files       | `--permission` with `--allow-fs-read` for its own code and libraries only: |
 * |             | no other reads, no writes                                                  |
 * | processes   | `--permission`: no child processes, worker threads, addons, WASI,          |
 * |             | inspector; `--no-addons`                                                   |
 * | network     | Node 24 has no permission for it: the child's lockdown (lockdown.ts)       |
 * |             | blocks the networking modules and removes fetch/WebSocket (best effort)    |
 * | code        | `--disallow-code-generation-from-strings` (no eval), `--disable-proto`     |
 * | environment | only its settings: none of the server's variables (no secrets)            |
 *
 * The content goes in on stdin, streamed with backpressure, so a 1 GiB CSV never sits in
 * memory on either side; the answer is one line of JSON on stdout.
 */

/** Exit codes of child.ts. */
const EXIT_MEMORY = 70;
/**
 * A timeout counts as the source's (`input-failed`, retried) when the child was waiting on it
 * and it had sent nothing for this long (or half the time limit, if shorter).
 */
const STALL_MS = 30_000;

export interface ExtractOptions {
  /** Changes to the default limits (DEFAULT_LIMITS). */
  limits?: Partial<ExtractLimits>;
  /** The content's size in bytes, if known: the default time limit grows with it. */
  size?: number;
  /** Stops the extraction: the child is killed and the call rejects with the signal's reason. */
  signal?: AbortSignal;
}

/**
 * Extracts text and metadata from `content` in a limited child process. Resolves with a typed
 * result for everything the file can cause (see {@link ExtractResult}); rejects only when
 * `signal` aborts or the limits given are invalid. Content whose type has no extractor (an
 * image, a video) resolves `unsupported` without starting a process or reading a byte.
 */
export async function extract(
  content: AsyncIterable<Uint8Array>,
  hint: ExtractHint,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  const limits = resolveLimits(options.limits, options.size);
  const { signal } = options;
  signal?.throwIfAborted();
  if (!mayExtract(hint)) {
    await content[Symbol.asyncIterator]().return?.();
    return { ok: false, failure: "unsupported", permanent: true };
  }

  const entry = childEntry();
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(process.execPath, childArguments(limits, entry), {
      cwd: dirname(entry),
      env: childEnvironment({
        OPENHOARD_EXTRACT: JSON.stringify({ hint: { mime: hint.mime, name: hint.name }, limits }),
      }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    await content[Symbol.asyncIterator]().return?.();
    return { ok: false, failure: "spawn-failed", permanent: false };
  }

  let killedFor: PermanentFailure | "aborted" | undefined;
  const kill = (reason: PermanentFailure | "aborted") => {
    killedFor ??= reason;
    child.kill("SIGKILL");
  };

  // Content in, with backpressure; a failing source kills the child, which must never take
  // a cut-off stream for the whole file. `waitingSince` is set while the source is asked for
  // bytes and hasn't answered: a timeout while it has been silent a while is the source's.
  let sourceFailed = false;
  let waitingSince: number | null = null;
  async function* source(): AsyncGenerator<Uint8Array> {
    const iterator = content[Symbol.asyncIterator]();
    try {
      for (;;) {
        let step: IteratorResult<Uint8Array>;
        waitingSince = Date.now();
        try {
          step = await iterator.next();
        } catch {
          sourceFailed = true;
          child.kill("SIGKILL");
          return;
        } finally {
          waitingSince = null;
        }
        if (step.done) return;
        yield step.value;
      }
    } finally {
      // The child stopped reading (it had enough, or it is gone): the source is closed too.
      await iterator.return?.();
    }
  }
  child.stdin.on("error", () => {
    // The child stopped reading (it had enough, or it died): what it answers says which.
  });
  const feeding = pipeline(Readable.from(source()), child.stdin).catch(() => {});

  // The answer out, bounded.
  const maxBytes = maxAnswerBytes(limits);
  const out: Buffer[] = [];
  let outBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    outBytes += chunk.byteLength;
    if (outBytes > maxBytes) kill("output-too-large");
    else out.push(chunk);
  });
  // The end of stderr only, to tell running out of memory from other crashes.
  let err = "";
  child.stderr.on("data", (chunk: Buffer) => {
    err = (err + chunk.toString("utf8")).slice(-8192);
  });

  let sourceStalled = false;
  const timer = setTimeout(() => {
    sourceStalled =
      waitingSince !== null &&
      Date.now() - waitingSince >= Math.min(STALL_MS, limits.timeoutMs / 2);
    kill("timeout");
  }, limits.timeoutMs);
  const onAbort = () => kill("aborted");
  signal?.addEventListener("abort", onAbort, { once: true });
  const memoryLimit = limits.memoryMb * 1024 * 1024;
  const poll =
    process.platform === "linux"
      ? setInterval(() => {
          void residentBytes(child.pid).then((rss) => {
            if (rss !== null && rss > memoryLimit) kill("memory-limit");
          });
        }, 250)
      : undefined;

  const exit = await new Promise<{ code: number | null; spawnError: boolean }>((resolve) => {
    child.on("error", () => resolve({ code: null, spawnError: true }));
    child.on("close", (code) => resolve({ code, spawnError: false }));
  });
  clearTimeout(timer);
  clearInterval(poll);
  signal?.removeEventListener("abort", onAbort);
  // Not awaited: a source that stalls may not answer for a long time, and nothing below
  // depends on it (a failure was noted before the child was killed).
  void feeding;

  if (killedFor === "aborted") throw signal?.reason ?? new Error("extraction aborted");
  // The source failed, or ran out the clock without sending anything: the moment's, not the file's.
  if (sourceFailed || sourceStalled)
    return { ok: false, failure: "input-failed", permanent: false };
  if (exit.spawnError) return { ok: false, failure: "spawn-failed", permanent: false };
  if (killedFor !== undefined) return { ok: false, failure: killedFor, permanent: true };
  if (
    exit.code === EXIT_MEMORY ||
    err.includes("heap out of memory") ||
    err.includes("Reached heap limit")
  ) {
    return { ok: false, failure: "memory-limit", permanent: true };
  }
  if (exit.code !== 0) return { ok: false, failure: "crashed", permanent: true };
  const text = Buffer.concat(out).toString("utf8");
  const newline = text.indexOf("\n");
  const answer = newline === text.length - 1 ? parseAnswer(text.slice(0, newline), limits) : null;
  if (answer === null) return { ok: false, failure: "protocol", permanent: true };
  if (answer.ok) return { ok: true, extraction: answer.extraction, stats: answer.stats };
  return { ok: false, failure: answer.failure, permanent: true, stats: answer.stats };
}

/** Node's options for the child process: its limits and the permission model (see above). */
export function childArguments(limits: ExtractLimits, entry: string): string[] {
  return [
    `--max-old-space-size=${limits.heapMb}`,
    "--max-semi-space-size=16",
    "--permission",
    ...readableFolders().map((folder) => `--allow-fs-read=${folder}`),
    "--no-addons",
    "--disallow-code-generation-from-strings",
    "--disable-proto=delete",
    "--no-warnings",
    entry,
  ];
}

/**
 * The child's whole environment: `variables`, and on Windows the system folder, without which
 * a process can't start. None of this process's variables (database URLs, keys) go along.
 */
export function childEnvironment(variables: Record<string, string>): Record<string, string> {
  const env = { ...variables };
  const systemRoot = process.env.SystemRoot;
  if (process.platform === "win32" && systemRoot !== undefined) env.SystemRoot = systemRoot;
  return env;
}

/** A process's resident set size from /proc (Linux), or null when it can't be read. */
async function residentBytes(pid: number | undefined): Promise<number | null> {
  if (pid === undefined) return null;
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const at = status.indexOf("VmRSS:");
    if (at === -1) return null;
    const kb = Number.parseInt(status.slice(at + 6, status.indexOf("\n", at)).trim(), 10);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}
