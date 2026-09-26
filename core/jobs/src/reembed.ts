import { isEmbeddingModel, versionsWithoutEmbeddings } from "@openhoard/core-catalog";
import { insideWithTenant, NestedWorkError, type Database } from "@openhoard/core-db";
import type { Jobs } from "./jobs.js";

/*
 * Embedding again after the embeddings model changed (T-407): an admin who switched
 * `embedModel` (or put another provider first for `embed`) re-enqueues the tenant's current
 * versions that have text or a summary but no vectors under the new model's name
 * (`<provider id>/<model>`, core/models embeddingModelId()). The embed step then embeds them;
 * the other steps change nothing on a re-run. Until it is done, searches go on using the old
 * model's vectors; afterwards core/catalog pruneEmbeddings() drops them. Who may ask is the
 * API's question (an admin), and it audits the request.
 */

/**
 * Enqueues the tenant's current versions without vectors under `model`, a page at a time, at
 * most `limit` in all (default 10,000). Returns how many were enqueued. Never inside
 * withTenant().
 */
export async function reembed(
  db: Database,
  jobs: Pick<Jobs, "enqueueVersion">,
  tenantId: string,
  model: string,
  options: { limit?: number } = {},
): Promise<number> {
  if (insideWithTenant()) throw new NestedWorkError("reembed()");
  if (!isEmbeddingModel(model)) throw new TypeError("reembed: model is <provider id>/<model>");
  const limit = options.limit ?? 10_000;
  let after: string | undefined;
  let count = 0;
  while (count < limit) {
    const want = Math.min(500, limit - count);
    const page = await db.withTenant(
      tenantId,
      (tx) =>
        versionsWithoutEmbeddings(tx, tenantId, model, {
          ...(after === undefined ? {} : { after }),
          limit: want,
        }),
      { accessMode: "read only" },
    );
    for (const versionId of page) {
      await jobs.enqueueVersion(tenantId, versionId);
      count++;
    }
    if (page.length < want) break;
    after = page[page.length - 1];
  }
  return count;
}
