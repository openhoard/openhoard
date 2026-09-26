import { modelUsage } from "@openhoard/core-db";
import { openTestDatabase, seedTenant } from "@openhoard/core-db/testing";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { dailyTokenBudget } from "./budget.js";
import {
  checkProviderConfig,
  createModelClient,
  embeddingModelId,
  stubEmbedding,
} from "./clients.js";
import { ModelError } from "./errors.js";
import { embedQuery } from "./query.js";
import { createModelRouter } from "./router.js";
import type { ModelClient } from "./types.js";

/* T-503: a query's embeddings, one per model, local providers only by default. */

const stub = (id: string, kind: ModelClient["kind"], more: { embedModel?: string } = {}) =>
  createModelClient({
    id,
    kind,
    adapter: "stub",
    chatModel: "stub",
    embedDimensions: 16,
    ...more,
  });
const signal = () => AbortSignal.timeout(5_000);
const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

describe("the stub's embeddings", () => {
  it("hash words, so texts sharing words are near, and are unit length", () => {
    const a = stubEmbedding("zebra giraffe savanna", 64);
    const b = stubEmbedding("Zebra, giraffe!", 64);
    const c = stubEmbedding("invoice amount due", 64);
    expect(Math.hypot(...a)).toBeCloseTo(1, 9);
    expect(cosine(a, b)).toBeGreaterThan(0.6);
    expect(cosine(a, c)).toBeLessThan(0.4);
    expect(stubEmbedding("", 4)).toEqual([1, 0, 0, 0]);
    expect(stubEmbedding("東京 タワー", 8)).toHaveLength(8);
  });

  it("names a model <provider>/<model>, and only where there are embeddings", () => {
    expect(embeddingModelId(stub("ollama", "local", { embedModel: "nomic-embed-text" }))).toBe(
      "ollama/nomic-embed-text",
    );
    expect(embeddingModelId(stub("ollama", "local"))).toBeNull();
    expect(stub("o", "local", { embedModel: "m" }).embedModel).toBe("m");
    expect(
      checkProviderConfig({
        id: "x",
        kind: "local",
        adapter: "ollama",
        chatModel: "m",
        baseUrl: "http://localhost:11434",
        embedDimensions: 8,
      }).join(),
    ).toContain("stub only");
    expect(
      checkProviderConfig({
        id: "x",
        kind: "local",
        adapter: "stub",
        chatModel: "m",
        embedDimensions: 1,
      }).join(),
    ).toContain("embedDimensions");
  });
});

describe("embedQuery", () => {
  it("embeds the query once per local embeddings model, named as the stored vectors are", async () => {
    const router = createModelRouter([
      stub("ollama", "local", { embedModel: "a" }),
      stub("lmstudio", "local", { embedModel: "b" }),
      stub("azure", "commercial", { embedModel: "c" }),
      stub("chat", "local"),
    ]);
    const out = await embedQuery(router, "  zebra giraffe  ", { signal: signal() });
    expect(out.map((q) => q.model)).toEqual(["ollama/a", "lmstudio/b"]);
    expect(out[0]?.vector).toEqual(stubEmbedding("zebra giraffe", 16));
    const wider = await embedQuery(router, "zebra", {
      signal: signal(),
      kinds: ["local", "commercial"],
    });
    expect(wider.map((q) => q.model)).toEqual(["ollama/a", "lmstudio/b", "azure/c"]);
    expect(await embedQuery(router, "   ", { signal: signal() })).toEqual([]);
    expect(await embedQuery(createModelRouter([]), "zebra", { signal: signal() })).toEqual([]);
  });

  it("leaves out a model that fails, and logs its code, never the query", async () => {
    const good = stub("ollama", "local", { embedModel: "a" });
    const bad: ModelClient = {
      ...stub("broken", "local", { embedModel: "b" }),
      embed: () => Promise.reject(new ModelError("server", "broken", { status: 503 })),
    };
    const lines: string[] = [];
    const out = await embedQuery(createModelRouter([bad, good]), "secret words", {
      signal: signal(),
      log: { warn: (fields, message) => void lines.push(JSON.stringify(fields) + message) },
    });
    expect(out.map((q) => q.model)).toEqual(["ollama/a"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("server");
    expect(lines[0]).not.toContain("secret");
    // A stop is not a failure to work around.
    const stopped = new AbortController();
    stopped.abort();
    const slow: ModelClient = {
      ...bad,
      embed: () => Promise.reject(new Error("aborted")),
    };
    await expect(
      embedQuery(createModelRouter([slow]), "q", { signal: stopped.signal }),
    ).rejects.toThrow("aborted");
  });
});

describe("embedQuery and the budget", () => {
  it("counts every query embedding in the tenant's budget, local ones too, and stops when it is spent", async () => {
    const db = await openTestDatabase();
    try {
      const t = await seedTenant(db, 1);
      const router = createModelRouter([stub("ollama", "local", { embedModel: "a" })]);
      const usage = () =>
        db.withTenant(t.tenantId, (tx) =>
          tx.select().from(modelUsage).where(eq(modelUsage.tenantId, t.tenantId)),
        );
      const account = { db, tenantId: t.tenantId, budget: dailyTokenBudget(1_000) };
      const out = await embedQuery(router, "zebra giraffe", { signal: signal(), budget: account });
      expect(out).toHaveLength(1);
      const [row] = await usage();
      expect(row?.calls).toBe(1);
      expect(Number(row?.tokens)).toBeGreaterThan(0);
      const warned: string[] = [];
      const spent = await embedQuery(router, "zebra", {
        signal: signal(),
        budget: { ...account, budget: dailyTokenBudget(0) },
        log: { warn: (_fields, message) => void warned.push(message) },
      });
      expect(spent).toEqual([]);
      expect(warned[0]).toMatch(/budget spent/);
      expect((await usage())[0]?.calls).toBe(1);
    } finally {
      await db.close();
    }
  });
});
