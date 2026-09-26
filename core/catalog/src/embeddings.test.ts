import { versionEmbeddings, type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isEmbeddingModel,
  MAX_EMBEDDINGS_PER_VERSION,
  pruneEmbeddings,
  readEmbeddings,
  saveEmbeddings,
  versionsWithoutEmbeddings,
  type EmbeddingItem,
} from "./embeddings.js";
import { addDoc, hashedEmbedding, sha256 } from "./search.fixtures.js";

/* T-407: vectors stored per version and model, the model recorded. */

let db: Database;
let t: SeededTenant;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
});
afterEach(() => db?.close());

const item = (text: string, seq = 0, part: EmbeddingItem["part"] = "chunk"): EmbeddingItem => ({
  part,
  seq,
  textHash: sha256(text),
  embedding: hashedEmbedding(text, 8),
});
const save = (items: readonly EmbeddingItem[], model = "ollama/nomic-embed-text", more = {}) =>
  db.withTenant(t.tenantId, (tx) =>
    saveEmbeddings(tx, t.tenantId, {
      objectId: t.objectId,
      versionId: t.versionId,
      model,
      providerKind: "local",
      items,
      ...more,
    }),
  );
const read = (model = "ollama/nomic-embed-text") =>
  db.withTenant(t.tenantId, (tx) => readEmbeddings(tx, t.tenantId, t.versionId, model));

describe("saveEmbeddings / readEmbeddings", () => {
  it("stores a version's vectors per model, with the size and provider kind, replacing the set", async () => {
    await save([item("summary", 0, "summary"), item("one", 0), item("two", 1)]);
    await save([item("other")], "openai/text-embedding-3-small");
    const stored = await read();
    expect([...stored.keys()].sort()).toEqual(["chunk:0", "chunk:1", "summary:0"]);
    expect(stored.get("chunk:1")?.textHash).toBe(sha256("two"));
    expect(stored.get("chunk:1")?.embedding).toHaveLength(8);
    expect(stored.get("chunk:1")?.embedding[0]).toBeCloseTo(hashedEmbedding("two", 8)[0] ?? 0, 5);
    const rows = await db.withTenant(t.tenantId, (tx) =>
      tx.select().from(versionEmbeddings).where(eq(versionEmbeddings.versionId, t.versionId)),
    );
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.dimensions === 8 && r.providerKind === "local")).toBe(true);
    // The set is replaced: a chunk that is gone goes, the other model's rows stay.
    await save([item("one", 0)]);
    expect([...(await read()).keys()]).toEqual(["chunk:0"]);
    expect((await read("openai/text-embedding-3-small")).size).toBe(1);
    await save([]);
    expect((await read()).size).toBe(0);
    expect((await read("not a model")).size).toBe(0);
  });

  it("refuses malformed input before writing", async () => {
    const cases: [string, Parameters<typeof save>][] = [
      ["model", [[item("a")], "no-slash"]],
      ["providerKind", [[item("a")], undefined, { providerKind: "cloud" }]],
      ["ids", [[item("a")], undefined, { objectId: "x" }]],
      ["part", [[{ ...item("a"), part: "title" as never }]]],
      ["seq", [[item("a", -1)]]],
      ["summary is seq 0", [[item("a", 1, "summary")]]],
      ["twice", [[item("a"), item("b")]]],
      ["textHash", [[{ ...item("a"), textHash: "x" }]]],
      ["size", [[{ ...item("a"), embedding: [] }]]],
      ["values", [[{ ...item("a"), embedding: [1, Number.NaN] }]]],
      ["zero", [[{ ...item("a"), embedding: [0, 0] }]]],
      ["different sizes", [[item("a"), { ...item("b", 1), embedding: [1, 0] }]]],
      [
        "too many",
        [Array.from({ length: MAX_EMBEDDINGS_PER_VERSION + 1 }, (_, i) => item(`x${i}`, i))],
      ],
    ];
    for (const [what, args] of cases) {
      await expect(save(...args), what).rejects.toThrow(TypeError);
    }
    expect((await read()).size).toBe(0);
    expect(isEmbeddingModel("ollama/nomic-embed-text:latest")).toBe(true);
    expect(isEmbeddingModel("Ollama/x")).toBe(false);
    expect(isEmbeddingModel(42)).toBe(false);
  });
});

describe("versionsWithoutEmbeddings / pruneEmbeddings", () => {
  it("lists current versions with text or a summary but no vectors under a model, a page at a time", async () => {
    const a = await addDoc(db, t, { title: "A", text: "alpha" });
    const b = await addDoc(db, t, { title: "B", summary: { text: "beta", kind: "local" } });
    await addDoc(db, t, { title: "C" }); // nothing to embed
    const d = await addDoc(db, t, { title: "D", text: "delta", embed: { model: "fixture/m" } });
    const list = (model: string, options = {}) =>
      db.withTenant(t.tenantId, (tx) => versionsWithoutEmbeddings(tx, t.tenantId, model, options));
    expect(await list("fixture/m")).toEqual([a.versionId, b.versionId].sort());
    expect(await list("fixture/other")).toEqual([a.versionId, b.versionId, d.versionId].sort());
    const [first] = [a.versionId, b.versionId].sort();
    expect(await list("fixture/m", { limit: 1 })).toEqual([first]);
    expect(await list("fixture/m", { after: first })).toEqual(
      [a.versionId, b.versionId].sort().slice(1),
    );
    await expect(list("bad")).rejects.toThrow(TypeError);
    await expect(list("fixture/m", { limit: 0 })).rejects.toThrow(RangeError);
    await expect(list("fixture/m", { after: "x" })).rejects.toThrow(TypeError);
  });

  it("prunes other models' vectors in bounded batches", async () => {
    await addDoc(db, t, { title: "A", text: "alpha", embed: { model: "fixture/old" } });
    await addDoc(db, t, { title: "B", text: "beta", embed: { model: "fixture/old" } });
    await addDoc(db, t, { title: "C", text: "gamma", embed: { model: "fixture/new" } });
    const prune = (keep: string[], options = {}) =>
      db.withTenant(t.tenantId, (tx) => pruneEmbeddings(tx, t.tenantId, keep, options));
    expect(await prune(["fixture/new"], { limit: 1 })).toBe(1);
    expect(await prune(["fixture/new"])).toBe(1);
    expect(await prune(["fixture/new"])).toBe(0);
    expect(await prune([])).toBe(1);
    await expect(prune(["bad"])).rejects.toThrow(TypeError);
    await expect(prune([], { limit: 0 })).rejects.toThrow(RangeError);
  });
});
