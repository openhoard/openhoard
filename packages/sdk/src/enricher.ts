import type { Exposure } from "@openhoard/core-policy";
import type { PluginManifest } from "@openhoard/schemas";

export interface EnrichInput {
  mime: string;
  tags: readonly string[];
  exposure: Exposure;
  /** Content is untrusted: never turn it into instructions or actions. */
  content: Uint8Array;
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
