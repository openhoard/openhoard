import { EXPOSURE, mayProcess, type Exposure, type ProviderKind } from "@openhoard/core-policy";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createModelClient } from "./clients.js";
import { createModelRouter } from "./router.js";

/*
 * T-404: routing by exposure. Done when: local-only content can only reach a local provider.
 */

const make = (id: string, kind: ProviderKind, embed = false) =>
  createModelClient({
    id,
    kind,
    adapter: "stub",
    chatModel: "stub",
    ...(embed ? { embedModel: "stub" } : {}),
  });

describe("the routing matrix", () => {
  const consumer = make("consumer-ai", "consumer");
  const commercial = make("claude", "commercial");
  const local = make("ollama", "local", true);
  const router = createModelRouter([consumer, commercial, local]);

  it.each<[Exposure, string | null]>([
    ["full", "ollama"],
    ["commercial-only", "ollama"],
    ["local-only", "ollama"],
    ["metadata-only", null],
  ])("default order, %s → %s", (exposure, id) => {
    expect(router.pick("summarize", exposure)?.id ?? null).toBe(id);
  });

  it("orders local, then commercial, then consumer by default", () => {
    expect(router.candidates("summarize").map((c) => c.id)).toEqual([
      "ollama",
      "claude",
      "consumer-ai",
    ]);
    expect(router.candidates("embed").map((c) => c.id)).toEqual(["ollama"]);
  });

  it.each<[Exposure, string | null]>([
    ["full", "consumer-ai"],
    ["commercial-only", "claude"],
    ["local-only", "ollama"],
    ["metadata-only", null],
  ])("an admin's order (consumer first), %s → %s", (exposure, id) => {
    const r = createModelRouter([consumer, commercial, local], {
      summarize: ["consumer-ai", "claude", "ollama"],
    });
    expect(r.pick("summarize", exposure)?.id ?? null).toBe(id);
  });

  it("gives local-only content to nobody when no local provider is configured", () => {
    const r = createModelRouter([consumer, commercial]);
    expect(r.pick("summarize", "local-only")).toBe(null);
    expect(r.pick("summarize", "commercial-only")?.id).toBe("claude");
  });

  it("asks a predicate in order and stops at the first yes", async () => {
    const asked: string[] = [];
    const pick = await router.pickAllowed("summarize", (c) => {
      asked.push(c.id);
      return Promise.resolve(c.kind === "commercial");
    });
    expect(pick?.id).toBe("claude");
    expect(asked).toEqual(["ollama", "claude"]);
    expect(await router.pickAllowed("summarize", () => Promise.resolve(false))).toBe(null);
  });

  it("refuses unknown, duplicate and embedding-less providers in an order", () => {
    expect(() => createModelRouter([local, local])).toThrow("configured twice");
    expect(() => createModelRouter([local], { summarize: ["nope"] })).toThrow("no provider nope");
    expect(() => createModelRouter([local], { summarize: ["ollama", "ollama"] })).toThrow("twice");
    expect(() => createModelRouter([commercial], { embed: ["claude"] })).toThrow("no embeddings");
    expect(createModelRouter([]).candidates("summarize")).toEqual([]);
  });
});

describe("local-only content only reaches a local provider", () => {
  it("holds for any providers, any order, any exposure", () => {
    const kinds: ProviderKind[] = ["local", "commercial", "consumer"];
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...kinds), { minLength: 0, maxLength: 6 }),
        fc.boolean(),
        fc.constantFrom(...EXPOSURE),
        (list, shuffle, exposure) => {
          const clients = list.map((k, i) => make(`p${i}`, k));
          const ids = clients.map((c) => c.id);
          const order = shuffle ? { summarize: [...ids].reverse() } : {};
          const picked = createModelRouter(clients, order).pick("summarize", exposure);
          if (exposure === "local-only" && picked) expect(picked.kind).toBe("local");
          if (exposure === "metadata-only") expect(picked).toBe(null);
          if (picked) expect(mayProcess(exposure, picked.kind)).toBe(true);
          // Nobody allowed is skipped over: if any provider may have it, one is picked.
          const any = clients.some((c) => mayProcess(exposure, c.kind));
          expect(picked !== null).toBe(any);
        },
      ),
      { numRuns: 500 },
    );
  });
});
