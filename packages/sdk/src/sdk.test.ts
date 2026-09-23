import { describe, expect, it } from "vitest";
import { defineConnector, defineEnricher, readUpTo } from "./index.js";

const manifest = {
  manifest_version: 1 as const,
  name: "example",
  version: "0.0.1",
  type: "connector" as const,
  runtime: "process" as const,
  capabilities: [],
};

const enc = (s: string) => new TextEncoder().encode(s);

function streamOf(...parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(enc(p));
      c.close();
    },
  });
}

describe("SDK helpers", () => {
  it("defineConnector returns the connector unchanged", async () => {
    const c = defineConnector({
      manifest,
      crawl: async () => ({ items: [] }),
      delta: async () => ({ changed: [], deleted: [], token: "t1" }),
      read: async () => streamOf(),
    });
    expect((await c.crawl()).items).toEqual([]);
    expect((await c.delta()).token).toBe("t1");
    expect(await c.read("x")).toBeInstanceOf(ReadableStream);
  });

  it("defineEnricher returns the enricher unchanged and works on streams", async () => {
    const e = defineEnricher({
      manifest: { ...manifest, type: "enricher", runtime: "wasm", accepts: ["text/plain"] },
      accepts: (mime) => mime === "text/plain",
      enrich: async ({ content, maxBytes }) => ({
        text: new TextDecoder().decode((await readUpTo(content, maxBytes)).bytes),
      }),
    });
    expect(e.accepts("text/plain", [])).toBe(true);
    const out = await e.enrich({
      mime: "text/plain",
      tags: [],
      exposure: "full",
      maxBytes: 1024,
      content: streamOf("hi"),
    });
    expect(out.text).toBe("hi");
  });
});

describe("readUpTo", () => {
  it("reads everything when under budget", async () => {
    const r = await readUpTo(streamOf("ab", "cd"), 10);
    expect(new TextDecoder().decode(r.bytes)).toBe("abcd");
    expect(r.truncated).toBe(false);
  });

  it("stops at the budget mid-chunk and reports truncation", async () => {
    const r = await readUpTo(streamOf("abc", "def"), 4);
    expect(new TextDecoder().decode(r.bytes)).toBe("abcd");
    expect(r.truncated).toBe(true);
  });

  it("detects more data after an exact chunk boundary", async () => {
    expect((await readUpTo(streamOf("ab", "cd"), 2)).truncated).toBe(true);
    expect((await readUpTo(streamOf("ab"), 2)).truncated).toBe(false);
  });

  it("cancels the source so the rest is never read", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(enc("x".repeat(100)));
      },
    });
    const r = await readUpTo(endless, 250);
    expect(r.bytes.byteLength).toBe(250);
    expect(pulled).toBeLessThan(10);
  });

  it("still returns the prefix when the source fails to cancel", async () => {
    const stubborn = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(enc("abcdef"));
      },
      cancel() {
        throw new Error("cannot cancel");
      },
    });
    const r = await readUpTo(stubborn, 3);
    expect(new TextDecoder().decode(r.bytes)).toBe("abc");
    expect(r.truncated).toBe(true);
  });
});
