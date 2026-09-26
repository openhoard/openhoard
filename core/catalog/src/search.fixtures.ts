import { createHash } from "node:crypto";
import {
  facets,
  facetValues,
  newId,
  objects,
  objectTags,
  versions,
  type Database,
} from "@openhoard/core-db";
import { and, eq, sql } from "drizzle-orm";
import { saveCard } from "./cards.js";
import { saveEmbeddings, type EmbeddingItem } from "./embeddings.js";
import { saveExtract } from "./extracts.js";

/*
 * Test fixtures for search (T-501..T-503): files with a title, tags, extracted text, a summary
 * and vectors, written the way enrichment writes them, so the search documents' triggers see
 * what they would in production.
 */

/** Hashed words, as core/models' stub embeds (clients.ts stubEmbedding()): similar texts point alike. */
export function hashedEmbedding(text: string, dimensions = 64): number[] {
  const v = new Array<number>(dimensions).fill(0);
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word === "") continue;
    let h = 0x811c9dc5;
    for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 0x01000193);
    const bucket = (h >>> 0) % dimensions;
    v[bucket] = (v[bucket] ?? 0) + (h >>> 31 === 1 ? -1 : 1);
  }
  const norm = Math.hypot(...v);
  return norm === 0 ? v.map((_, i) => (i === 0 ? 1 : 0)) : v.map((x) => x / norm);
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export interface DocInput {
  title: string;
  /** `facet:value`, applied by a rule (trusted) unless listed in `modelTags`. */
  tags?: readonly string[];
  /** Unreviewed model tags (untrusted). */
  modelTags?: readonly string[];
  text?: string;
  summary?: { text: string; kind: "local" | "commercial" | "consumer" };
  /** Vectors under this model, of the summary and the text as one chunk. */
  embed?: { model: string; dimensions?: number };
  owner?: string;
  processed?: boolean;
}

/** Adds a file to the tenant (zone and blob from the seed) and returns its id. */
export async function addDoc(
  db: Database,
  seed: { tenantId: string; zoneId: string; blobId: string },
  doc: DocInput,
): Promise<{ objectId: string; versionId: string }> {
  const { tenantId } = seed;
  const objectId = newId("object");
  const versionId = newId("version");
  await db.withTenant(tenantId, async (tx) => {
    await tx.insert(objects).values({
      tenantId,
      id: objectId,
      zoneId: seed.zoneId,
      title: doc.title,
      ownerId: doc.owner ?? "user:someone-else",
    });
    await tx.insert(versions).values({
      tenantId,
      id: versionId,
      objectId,
      seq: 1,
      blobId: seed.blobId,
      mime: "text/plain",
      ...(doc.processed === false ? {} : { processedAt: sql`now()` }),
    });
    const tags = [
      ...(doc.tags ?? []).map((tag) => ({ tag, model: false })),
      ...(doc.modelTags ?? []).map((tag) => ({ tag, model: true })),
    ];
    for (const { tag, model } of tags) {
      const [facet, value] = tag.split(":") as [string, string];
      await tx.insert(facets).values({ tenantId, key: facet, label: facet }).onConflictDoNothing();
      // Built-in vocabulary (risk:injection) refuses even a no-op insert: only add what's missing.
      const [known] = await tx
        .select({ value: facetValues.value })
        .from(facetValues)
        .where(
          and(
            eq(facetValues.tenantId, tenantId),
            eq(facetValues.facet, facet),
            eq(facetValues.value, value),
          ),
        );
      if (!known) {
        await tx
          .insert(facetValues)
          .values({ tenantId, facet, value, label: value, approved: true });
      }
      await tx.insert(objectTags).values({
        tenantId,
        objectId,
        facet,
        value,
        source: model ? "model" : "rule",
        appliedBy: model ? "model:m" : "rule:fixture",
        confidence: model ? 0.9 : 1,
      });
    }
    if (doc.text !== undefined) {
      await saveExtract(tx, tenantId, {
        objectId,
        versionId,
        status: "extracted",
        kind: "text",
        text: doc.text,
        truncated: false,
        metadata: {},
        signals: [],
        warnings: [],
        failure: null,
        extractor: "fixture/1",
      });
    }
    if (doc.summary !== undefined) {
      await saveCard(tx, tenantId, {
        objectId,
        versionId,
        status: "summarized",
        summary: doc.summary.text,
        providerId: "fixture",
        providerKind: doc.summary.kind,
        model: "fixture",
        promptVersion: "fixture-1",
        filtered: 0,
        inputTokens: 1,
        outputTokens: 1,
      });
    }
    if (doc.embed !== undefined) {
      const dims = doc.embed.dimensions ?? 64;
      const items: EmbeddingItem[] = [];
      if (doc.summary !== undefined) {
        items.push({
          part: "summary",
          seq: 0,
          textHash: sha256(doc.summary.text),
          embedding: hashedEmbedding(doc.summary.text, dims),
        });
      }
      if (doc.text !== undefined) {
        items.push({
          part: "chunk",
          seq: 0,
          textHash: sha256(doc.text),
          embedding: hashedEmbedding(doc.text, dims),
        });
      }
      await saveEmbeddings(tx, tenantId, {
        objectId,
        versionId,
        model: doc.embed.model,
        providerKind: "local",
        items,
      });
    }
  });
  return { objectId, versionId };
}
