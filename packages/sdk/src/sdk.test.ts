import { describe, expect, it } from "vitest";
import {
  CONNECTOR_API_VERSION,
  defineConnector,
  defineEnricher,
  manifestCapabilities,
  readUpTo,
  type ConnectorDescription,
} from "./index.js";

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
  const description: ConnectorDescription = {
    apiVersion: CONNECTOR_API_VERSION,
    id: "example",
    version: "0.0.1",
    zoneKinds: ["indexed"],
    capabilities: { delta: false, aclImport: false, redirect: false },
    stableIds: true,
  };

  it("defineConnector returns the connector unchanged", async () => {
    const c = defineConnector({
      describe: () => description,
      async *crawl(_checkpoint: string | null, _signal: AbortSignal) {
        yield { type: "done" as const, cursor: "c1" };
      },
      read: async () => ({ contentVersion: "1", size: 0, body: (async function* () {})() }),
    });
    const events = [];
    for await (const e of c.crawl(null, new AbortController().signal)) events.push(e);
    expect(events).toEqual([{ type: "done", cursor: "c1" }]);
    expect(c.describe().id).toBe("example");
  });

  it("names the manifest capabilities a connector needs", () => {
    expect(manifestCapabilities(description)).toEqual(["source:crawl", "read:content"]);
    expect(
      manifestCapabilities({
        ...description,
        capabilities: { delta: true, aclImport: true, redirect: true },
      }),
    ).toEqual(["source:crawl", "read:content", "source:delta", "import:acl", "source:redirect"]);
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

  it("does not count empty chunks as more data", async () => {
    // Found by the readUpTo property test: an empty chunk after the budget reported truncation.
    expect((await readUpTo(streamOf("ab", "", ""), 2)).truncated).toBe(false);
    expect((await readUpTo(streamOf("", "x"), 0)).truncated).toBe(true);
  });

  it("gives up probing a source that only ever sends empty chunks", async () => {
    const hollow = new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(new Uint8Array(0)) });
    expect(await readUpTo(hollow, 0)).toEqual({ bytes: new Uint8Array(0), truncated: false });
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
