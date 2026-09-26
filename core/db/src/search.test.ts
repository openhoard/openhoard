import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromDriver, type Database, type Driver } from "./database.js";
import { sqlState } from "./errors.js";
import { newId } from "./ids.js";
import { INDEXED_DIMENSIONS } from "./schema.js";
import { openTestDriver, seedTenant, TEST_POSTGRES_ENV, type SeededTenant } from "./testing.js";

/*
 * Search storage (T-501, T-502, T-407): the documents the triggers keep, the indexes search
 * relies on, the embeddings' checks, and pgvector as a requirement.
 */

let driver: Driver;
let db: Database;
let t: SeededTenant;
beforeAll(async () => {
  driver = await openTestDriver();
  db = fromDriver(driver);
  t = await seedTenant(db, 1);
});
afterAll(() => db?.close());

const doc = () =>
  db.withTenant(t.tenantId, async (tx) => {
    const { rows } = (await tx.execute(
      `select version_id, title_tsv::text as title, tags_tsv::text as tags,
              trusted_tags_tsv::text as trusted, public_tags_tsv::text as public,
              summary_tsv::text as summary, summary_provider_kind as kind, body_tsv::text as body
         from search_documents where object_id = '${t.objectId}'`,
    )) as unknown as { rows: Record<string, unknown>[] };
    return rows[0];
  });
const run = (text: string) => db.withTenant(t.tenantId, (tx) => tx.execute(text));

describe("search documents", () => {
  it("are kept by triggers: title, tags, the current version's text and summary", async () => {
    expect(await doc()).toMatchObject({
      version_id: t.versionId,
      title: "'1':2A 'docx':3A 'report':1A",
      tags: "'-1':2B 'acme':1B",
      trusted: "'-1':2B 'acme':1B",
      public: "",
      summary: "",
      kind: null,
      body: "",
    });
    await run(`insert into version_extracts (tenant_id, version_id, object_id, status, kind, text, extractor)
      values ('${t.tenantId}', '${t.versionId}', '${t.objectId}', 'extracted', 'text', 'Hello q3_forecast.xlsx', 'x/1')`);
    await run(`insert into version_cards (tenant_id, version_id, object_id, status, summary, provider_id,
        provider_kind, model, prompt_version)
      values ('${t.tenantId}', '${t.versionId}', '${t.objectId}', 'summarized', 'Short gist', 'p',
        'local', 'm', 'v1')`);
    expect(await doc()).toMatchObject({
      summary: "'gist':2C 'short':1C",
      kind: "local",
      body: "'forecast':3 'hello':1 'q3':2 'xlsx':4",
    });
    await run(`update objects set title = 'Renamed' where id = '${t.objectId}'`);
    await run(`update facets set public = true where key = 'client'`);
    expect(await doc()).toMatchObject({ title: "'renamed':1A", public: "'-1':2B 'acme':1B" });
    // A new version empties the content until its own text and summary arrive.
    const next = newId("version");
    await run(`insert into versions (tenant_id, id, object_id, seq, blob_id, mime)
      values ('${t.tenantId}', '${next}', '${t.objectId}', 2, '${t.blobId}', 'text/plain')`);
    expect(await doc()).toMatchObject({ version_id: next, summary: "", kind: null, body: "" });
    await run(`delete from object_tags where object_id = '${t.objectId}'`);
    expect(await doc()).toMatchObject({ tags: "", trusted: "", public: "" });
  });

  it("have the GIN and per-size HNSW indexes search's queries are written for", async () => {
    const rows = await driver.query(
      `select indexname, indexdef from pg_indexes
        where tablename in ('search_documents', 'version_embeddings') order by indexname`,
    );
    const defs = new Map(rows.map((r) => [String(r.indexname), String(r.indexdef)]));
    expect(defs.get("search_documents_reader_gin")).toMatch(
      /gin \(\(\(\(\(title_tsv \|\| tags_tsv\) \|\| summary_tsv\) \|\| body_tsv\)\)/,
    );
    expect(defs.get("search_documents_other_gin")).toMatch(/other_title_tsv \|\| public_tags_tsv/);
    for (const n of INDEXED_DIMENSIONS) {
      expect(defs.get(`version_embeddings_hnsw_${n}`)).toMatch(
        new RegExp(
          `hnsw \\(\\(\\(embedding\\)::vector\\(${n}\\)\\) vector_cosine_ops\\) WHERE \\(dimensions = ${n}\\)`,
        ),
      );
    }
  });

  it("refuse an embedding whose size isn't the one recorded", async () => {
    const insert = (dimensions: number, vector: string) =>
      run(`insert into version_embeddings (tenant_id, version_id, object_id, model, part, seq,
          dimensions, provider_kind, text_hash, embedding)
        values ('${t.tenantId}', '${t.versionId}', '${t.objectId}', 'p/m', 'chunk', ${dimensions},
          ${dimensions}, 'local', '${"0".repeat(64)}', '${vector}')`);
    await insert(2, "[1,0]");
    const e = await insert(3, "[1,0]").catch((err: unknown) => err);
    expect(sqlState(e)).toBe("23514");
  });
});

describe.runIf(process.env[TEST_POSTGRES_ENV])("pgvector on PostgreSQL", () => {
  it("stops the migrations with the instruction when the extension isn't there", async () => {
    const { createPostgresDatabase } = await import("./testing-postgres.js");
    const bare = await createPostgresDatabase(process.env[TEST_POSTGRES_ENV] ?? "", {
      withoutTemplate: true,
    });
    try {
      const e = await bare.migrate().catch((err: unknown) => err);
      const cause = (e as { cause?: { message?: string; hint?: string } }).cause ?? e;
      expect(String((cause as Error).message)).toMatch(/pgvector is not installed in database/);
      expect((cause as { hint?: string }).hint).toMatch(/CREATE EXTENSION vector/);
    } finally {
      await bare.close();
    }
  });
});
