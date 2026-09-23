import { describe, expect, it } from "vitest";
import { defineConnector, defineEnricher } from "./index.js";

const manifest = {
  manifest_version: 1 as const,
  name: "example",
  version: "0.0.1",
  type: "connector" as const,
  capabilities: [],
};

describe("SDK helpers", () => {
  it("defineConnector returns the connector unchanged", async () => {
    const c = defineConnector({
      manifest,
      crawl: async () => ({ items: [] }),
      delta: async () => ({ changed: [], deleted: [], token: "t1" }),
      read: async () => new ReadableStream<Uint8Array>(),
    });
    expect((await c.crawl()).items).toEqual([]);
    expect((await c.delta()).token).toBe("t1");
    expect(await c.read("x")).toBeInstanceOf(ReadableStream);
  });

  it("defineEnricher returns the enricher unchanged", async () => {
    const e = defineEnricher({
      manifest: { ...manifest, type: "enricher", accepts: ["text/plain"] },
      accepts: (mime) => mime === "text/plain",
      enrich: async ({ content }) => ({ text: new TextDecoder().decode(content) }),
    });
    expect(e.accepts("text/plain", [])).toBe(true);
    const out = await e.enrich({
      mime: "text/plain",
      tags: [],
      exposure: "full",
      content: new TextEncoder().encode("hi"),
    });
    expect(out.text).toBe("hi");
  });
});
