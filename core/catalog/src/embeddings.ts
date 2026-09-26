import {
  EMBEDDING_PARTS,
  isId,
  MAX_EMBEDDING_DIMENSIONS,
  PROVIDER_KINDS,
  queryRows,
  versionEmbeddings,
  type Tx,
} from "@openhoard/core-db";
import { and, eq, sql } from "drizzle-orm";

/*
 * Embeddings of versions (T-407): the vectors of a version's summary and of chunks of its
 * extracted text, per embedding model, in `version_embeddings`. Written by enrichment's embed
 * step (core/jobs) through its guarded write, read by search (search.ts), which uses them only
 * where a caller may have the content (a reader whose card isn't metadata-only, T-604).
 *
 * The vectors are content in other words, as the text is: nothing here checks who may see them.
 */

export type EmbeddingPart = (typeof EMBEDDING_PARTS)[number];

/** One vector of a version: its summary (seq 0), or chunk `seq` of its extracted text. */
export interface EmbeddingItem {
  part: EmbeddingPart;
  seq: number;
  /** SHA-256 (hex) of the text embedded, so a re-run can tell what changed. */
  textHash: string;
  embedding: readonly number[];
}

/** `<provider id>/<model>` (core/models embeddingModelId()). */
const MODEL = /^[a-z0-9][a-z0-9-]{0,62}\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const HASH = /^[0-9a-f]{64}$/;
/** The most vectors one version keeps under one model. */
export const MAX_EMBEDDINGS_PER_VERSION = 64;

/** Whether `model` is a stored model's name: `<provider id>/<model>`. */
export function isEmbeddingModel(model: unknown): model is string {
  return typeof model === "string" && MODEL.test(model);
}

/**
 * Makes a version's vectors under `model` exactly `items`: rows not among them go, the rest are
 * written (replacing a row of the same part and seq). Call it through enrichment's guarded
 * write. Throws TypeError for malformed input before writing: an unknown part, a seq out of
 * range or repeated, vectors of different sizes, a size past pgvector's, a value that isn't a
 * finite number.
 */
export async function saveEmbeddings(
  tx: Tx,
  tenantId: string,
  input: {
    objectId: string;
    versionId: string;
    model: string;
    providerKind: (typeof PROVIDER_KINDS)[number];
    items: readonly EmbeddingItem[];
  },
): Promise<void> {
  const bad = (what: string): never => {
    throw new TypeError(`invalid embeddings: ${what}`);
  };
  if (!isId("object", input.objectId) || !isId("version", input.versionId)) bad("ids");
  if (!isEmbeddingModel(input.model)) bad("model");
  if (!(PROVIDER_KINDS as readonly string[]).includes(input.providerKind)) bad("providerKind");
  if (input.items.length > MAX_EMBEDDINGS_PER_VERSION) bad("too many vectors");
  const keys = new Set<string>();
  let dimensions: number | undefined;
  for (const item of input.items) {
    if (!(EMBEDDING_PARTS as readonly string[]).includes(item.part)) bad("part");
    if (!Number.isSafeInteger(item.seq) || item.seq < 0 || item.seq > 1_000) bad("seq");
    if (item.part === "summary" && item.seq !== 0) bad("a summary is seq 0");
    const key = `${item.part}:${item.seq}`;
    if (keys.has(key)) bad("a part and seq twice");
    keys.add(key);
    if (typeof item.textHash !== "string" || !HASH.test(item.textHash)) bad("textHash");
    const v = item.embedding;
    if (!Array.isArray(v) || v.length < 1 || v.length > MAX_EMBEDDING_DIMENSIONS) bad("size");
    if (!v.every((x) => typeof x === "number" && Number.isFinite(x))) bad("values");
    // A zero vector has no direction: cosine distance to it is undefined.
    if (v.every((x) => x === 0)) bad("a zero vector");
    dimensions ??= v.length;
    if (v.length !== dimensions) bad("vectors of different sizes");
  }
  const version = and(
    eq(versionEmbeddings.tenantId, tenantId),
    eq(versionEmbeddings.versionId, input.versionId),
    eq(versionEmbeddings.model, input.model),
  );
  await tx.delete(versionEmbeddings).where(version);
  if (input.items.length === 0) return;
  await tx.insert(versionEmbeddings).values(
    input.items.map((item) => ({
      tenantId,
      versionId: input.versionId,
      objectId: input.objectId,
      model: input.model,
      part: item.part,
      seq: item.seq,
      dimensions: item.embedding.length,
      providerKind: input.providerKind,
      textHash: item.textHash,
      embedding: [...item.embedding],
    })),
  );
}

/**
 * What a version has under `model`: `part:seq` → the text hash (and the vector, for reuse). For
 * the embed step, which keeps the vectors of texts that didn't change.
 */
export async function readEmbeddings(
  tx: Tx,
  tenantId: string,
  versionId: string,
  model: string,
): Promise<Map<string, { textHash: string; embedding: number[] }>> {
  if (!isId("version", versionId) || !isEmbeddingModel(model)) return new Map();
  const rows = await tx
    .select({
      part: versionEmbeddings.part,
      seq: versionEmbeddings.seq,
      textHash: versionEmbeddings.textHash,
      embedding: versionEmbeddings.embedding,
    })
    .from(versionEmbeddings)
    .where(
      and(
        eq(versionEmbeddings.tenantId, tenantId),
        eq(versionEmbeddings.versionId, versionId),
        eq(versionEmbeddings.model, model),
      ),
    );
  return new Map(
    rows.map((r) => [`${r.part}:${r.seq}`, { textHash: r.textHash, embedding: r.embedding }]),
  );
}

/**
 * The tenant's current versions with extracted text or a summary but no vectors under `model`,
 * in version id order after `after`, at most `limit` (1 to 1,000): what core/jobs reembed()
 * enqueues after the embeddings model changed.
 */
export async function versionsWithoutEmbeddings(
  tx: Tx,
  tenantId: string,
  model: string,
  options: { after?: string; limit?: number } = {},
): Promise<string[]> {
  if (!isEmbeddingModel(model)) throw new TypeError("versionsWithoutEmbeddings: bad model");
  const limit = options.limit ?? 500;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("versionsWithoutEmbeddings: limit is 1 to 1000");
  }
  if (options.after !== undefined && !isId("version", options.after)) {
    throw new TypeError("versionsWithoutEmbeddings: after is not a version id");
  }
  const rows = await queryRows<{ id: string }>(
    tx,
    sql`select v.id from versions v
         where v.tenant_id = ${tenantId} and v.id > ${options.after ?? ""}
           and not exists (select 1 from versions w
             where w.tenant_id = v.tenant_id and w.object_id = v.object_id and w.seq > v.seq)
           and (exists (select 1 from version_extracts x
                 where x.tenant_id = v.tenant_id and x.version_id = v.id
                   and x.status = 'extracted' and x.text <> '')
             or exists (select 1 from version_cards c
                 where c.tenant_id = v.tenant_id and c.version_id = v.id
                   and c.status = 'summarized' and c.summary <> ''))
           and not exists (select 1 from version_embeddings e
                 where e.tenant_id = v.tenant_id and e.version_id = v.id and e.model = ${model})
         order by v.id
         limit ${limit}`,
  );
  return rows.map((r) => r.id);
}

/**
 * Deletes the tenant's vectors of models not in `keep`, at most `limit` rows (1 to 10,000) per
 * call; returns how many went. For after a model change, once a re-embed has done the tenant:
 * until then the old model's vectors still serve searches.
 */
export async function pruneEmbeddings(
  tx: Tx,
  tenantId: string,
  keep: readonly string[],
  options: { limit?: number } = {},
): Promise<number> {
  const limit = options.limit ?? 5_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new RangeError("pruneEmbeddings: limit is 1 to 10000");
  }
  if (!keep.every(isEmbeddingModel)) throw new TypeError("pruneEmbeddings: bad model");
  const kept =
    keep.length === 0
      ? sql`true`
      : sql`e.model not in (${sql.join(
          keep.map((m) => sql`${m}`),
          sql`, `,
        )})`;
  const rows = await queryRows<{ n: number }>(
    tx,
    sql`with gone as (
          delete from version_embeddings d using (
            select e.tenant_id, e.version_id, e.model, e.part, e.seq from version_embeddings e
             where e.tenant_id = ${tenantId} and ${kept}
             limit ${limit}) x
           where d.tenant_id = x.tenant_id and d.version_id = x.version_id and d.model = x.model
             and d.part = x.part and d.seq = x.seq
          returning 1)
        select count(*)::int as n from gone`,
  );
  return Number(rows[0]?.n ?? 0);
}
