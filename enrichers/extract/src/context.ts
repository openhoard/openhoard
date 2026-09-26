import type { Input } from "./input.ts";
import type { Signals, TextSink } from "./text.ts";
import type { ExtractionMetadata, ExtractLimits, WarningCode } from "./types.ts";

/** What an extractor works with: the content, the limits, and where its findings go. */
export interface ExtractContext {
  readonly input: Input;
  readonly limits: ExtractLimits;
  readonly sink: TextSink;
  readonly signals: Signals;
  readonly metadata: ExtractionMetadata;
  readonly warnings: Set<WarningCode>;
  /**
   * Throws `memory-limit` when the process is over its memory budget. Extractors call it as
   * they go (per chunk, per page), so a file that makes a parser keep too much is stopped
   * while the process can still answer. In-process (tests) it checks nothing.
   */
  checkMemory(): void;
}

/** One extractor: reads `input`, writes text to `sink`, and records what it found. */
export type Extractor = (context: ExtractContext) => Promise<void>;
