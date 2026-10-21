import { openTestDatabase, seedTenant } from "@openhoard/core-db/testing";
import { createModelClient, createModelRouter, dailyTokenBudget } from "@openhoard/ai-models";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolContext } from "./context.js";
import { queryVectors } from "./find.js";

/* `find` embeds the query only by the provider kinds `models.queryKinds` allows. */

let db: Awaited<ReturnType<typeof openTestDatabase>>;
let tenantId: string;
beforeAll(async () => {
  db = await openTestDatabase();
  tenantId = (await seedTenant(db, 1)).tenantId;
}, 60_000);
afterAll(() => db?.close());

describe("find's query embeddings", () => {
  it("go to a commercial provider only when models.queryKinds says so", async () => {
    let calls = 0;
    const model = createModelClient({
      id: "azure",
      kind: "commercial",
      adapter: "stub",
      chatModel: "stub",
      embedModel: "words",
      embedDimensions: 8,
    });
    const embed = model.embed?.bind(model);
    const counted = Object.assign(Object.create(model) as typeof model, {
      embed: async (...args: Parameters<NonNullable<typeof model.embed>>) => {
        calls++;
        return (embed as NonNullable<typeof model.embed>)(...args);
      },
    });
    const ctx = (queryKinds?: ("local" | "commercial")[]) =>
      ({
        db,
        bearer: { tenantId },
        signal: new AbortController().signal,
        embed: {
          router: createModelRouter([counted]),
          budget: dailyTokenBudget(1_000_000),
          ...(queryKinds ? { queryKinds } : {}),
        },
      }) as unknown as ToolContext;

    expect(await queryVectors(ctx(), "salary review")).toEqual([]);
    expect(calls).toBe(0);
    const vectors = await queryVectors(ctx(["local", "commercial"]), "salary review");
    expect(vectors.map((v) => v.model)).toEqual(["azure/words"]);
    expect(calls).toBe(1);
  });
});
