import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readUpTo } from "./enricher.js";

const chunks = fc.array(fc.uint8Array({ maxLength: 64 }), { maxLength: 20 });
const streamOf = (parts: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
};

describe("readUpTo (properties)", () => {
  it("returns exactly the stream's prefix of min(total, budget) bytes, however it is chunked", async () => {
    await fc.assert(
      fc.asyncProperty(chunks, fc.nat({ max: 1500 }), async (parts, maxBytes) => {
        const all = concat(parts);
        const r = await readUpTo(streamOf(parts), maxBytes);
        expect(r.bytes).toEqual(all.subarray(0, Math.min(all.byteLength, maxBytes)));
        expect(r.truncated).toBe(all.byteLength > maxBytes);
      }),
    );
  });
});
