import type { ExtractLimits } from "./types.ts";

const MiB = 1024 * 1024;

/** The catalog's ceiling on extracted text (core/db MAX_EXTRACT_TEXT_BYTES). */
export const MAX_TEXT_BYTES = 4 * MiB;

/** Limits used when the caller sets none; `timeoutMs` grows with the content's size. */
export const DEFAULT_LIMITS: Readonly<ExtractLimits> = Object.freeze({
  timeoutMs: 30_000,
  memoryMb: 768,
  heapMb: 512,
  maxInputBytes: 256 * MiB,
  maxTextBytes: 1 * MiB,
  maxPages: 5_000,
  maxEntries: 10_000,
  maxUncompressedBytes: 512 * MiB,
  maxCompressionRatio: 500,
  maxXmlDepth: 256,
  maxSharedStringChars: 16 * MiB,
  maxRecordBytes: 1 * MiB,
  maxColumns: 1_000,
  sampleRows: 1_000,
});

/** How far each limit may be set: a typo can't turn one off or make it absurd. */
const RANGES: Record<keyof ExtractLimits, readonly [number, number]> = {
  timeoutMs: [10, 60 * 60_000],
  memoryMb: [16, 16 * 1024],
  heapMb: [8, 16 * 1024],
  maxInputBytes: [1, 4 * 1024 * MiB],
  maxTextBytes: [1, MAX_TEXT_BYTES],
  maxPages: [1, 1_000_000],
  maxEntries: [1, 1_000_000],
  maxUncompressedBytes: [1, 16 * 1024 * MiB],
  maxCompressionRatio: [1, 100_000],
  maxXmlDepth: [8, 10_000],
  maxSharedStringChars: [0, 1024 * MiB],
  maxRecordBytes: [64, 256 * MiB],
  maxColumns: [1, 100_000],
  sampleRows: [1, 1_000_000],
};

/** Base time plus this much per MiB of content, when the caller doesn't set `timeoutMs`. */
const MS_PER_MiB = 100;
const MAX_DEFAULT_TIMEOUT_MS = 10 * 60_000;

/**
 * The limits for one extraction: the defaults, with the caller's changes checked. Without a
 * `timeoutMs`, the time allowed grows with `sizeBytes` (a 1 GiB CSV must stream through), up to
 * ten minutes, which stays under an enrichment job's fifteen-minute lease.
 */
export function resolveLimits(
  overrides: Partial<ExtractLimits> = {},
  sizeBytes?: number,
): ExtractLimits {
  const limits: ExtractLimits = { ...DEFAULT_LIMITS };
  if (sizeBytes !== undefined && Number.isFinite(sizeBytes) && sizeBytes > 0) {
    limits.timeoutMs = Math.min(
      MAX_DEFAULT_TIMEOUT_MS,
      DEFAULT_LIMITS.timeoutMs + Math.ceil((sizeBytes / MiB) * MS_PER_MiB),
    );
  }
  for (const [key, value] of Object.entries(overrides)) {
    const range = RANGES[key as keyof ExtractLimits];
    if (range === undefined) throw new TypeError(`unknown extraction limit ${key}`);
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < range[0] || value > range[1]) {
      throw new RangeError(`extraction limit ${key} must be a whole number in [${range}]`);
    }
    limits[key as keyof ExtractLimits] = value;
  }
  if (limits.heapMb >= limits.memoryMb) {
    throw new RangeError("extraction limit heapMb must be below memoryMb");
  }
  return limits;
}
