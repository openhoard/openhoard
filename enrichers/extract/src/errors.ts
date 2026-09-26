import type { PermanentFailure } from "./types.ts";

/**
 * An extractor's typed refusal: the file is malformed, encrypted, over a limit… The child
 * process reports only the code; the message stays in the child, so no detail of a parser's
 * internals (or of the file) travels further than the code says.
 */
export class ExtractError extends Error {
  readonly code: PermanentFailure;

  constructor(code: PermanentFailure, message: string = code, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExtractError";
    this.code = code;
  }
}

/** The code for any error an extractor threw: its own, or `malformed` for a parser's. */
export function failureOf(e: unknown): PermanentFailure {
  if (e instanceof ExtractError) return e.code;
  // A buffer the process couldn't allocate: out of memory, whatever the watchdog saw.
  if (e instanceof RangeError && e.message.includes("allocation failed")) return "memory-limit";
  // A parser that recursed too deep, or choked on hostile input some other way.
  return "malformed";
}
