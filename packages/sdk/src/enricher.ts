import type { Exposure } from "@openhoard/core-policy";
import type { PluginManifest } from "@openhoard/schemas";

/**
 * Input handed to an enricher.
 *
 * STREAMING CONTRACT (security review #2): content arrives as a stream, never as one buffer, so
 * multi-GB files (guest uploads, data extracts) never have to fit in memory. `maxBytes` is the
 * core's budget for this enricher: read at most that much (use {@link readUpTo}) and summarise
 * from the prefix plus structure (e.g. CSV header + row count), as the Dev Plan's token budget
 * requires.
 */
export interface EnrichInput {
  mime: string;
  tags: readonly string[];
  exposure: Exposure;
  /** Total size in bytes, when the source knows it. */
  size?: number;
  maxBytes: number;
  /** Content is untrusted: never turn it into instructions or actions. */
  content: ReadableStream<Uint8Array>;
}

/** Enrichers only ever propose; the core validates against the vocabulary and exposure rules. */
export interface EnrichProposal {
  text?: string;
  fields?: Record<string, string | number | boolean>;
  proposedTags?: { tag: string; confidence: number }[];
  summaryHints?: string[];
}

export interface Enricher {
  manifest: PluginManifest;
  accepts(mime: string, tags: readonly string[]): boolean;
  enrich(input: EnrichInput): Promise<EnrichProposal>;
}

export function defineEnricher(enricher: Enricher): Enricher {
  return enricher;
}

/**
 * Reads at most `maxBytes` from a stream and cancels the rest, so an enricher can never be made
 * to buffer an entire large file. `truncated` tells the caller whether more data existed.
 */
export async function readUpTo(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.byteLength, maxBytes - total);
      chunks.push(value.subarray(0, take));
      total += take;
      if (take < value.byteLength) truncated = true;
    }
    if (!truncated && total >= maxBytes) truncated = !(await reader.read()).done;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes, truncated };
}
