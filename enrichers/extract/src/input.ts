import { ExtractError } from "./errors.ts";

/**
 * The content, as a stream an extractor reads once. It lets the dispatcher look at the first
 * bytes (to tell what the content is) and hand them on, counts what was read, and checks the
 * memory budget as chunks arrive, so a parser that keeps what it reads is stopped early.
 */
export class Input {
  bytesRead = 0;
  private readonly iterator: AsyncIterator<Uint8Array>;
  private readonly pending: Uint8Array[] = [];
  private ended = false;
  private readonly checkMemory: () => void;

  constructor(source: AsyncIterable<Uint8Array>, checkMemory: () => void = () => {}) {
    this.iterator = source[Symbol.asyncIterator]();
    this.checkMemory = checkMemory;
  }

  private async next(): Promise<Uint8Array | null> {
    if (this.ended) return null;
    const { done, value } = await this.iterator.next();
    if (done) {
      this.ended = true;
      return null;
    }
    // A plain Uint8Array view, never a Buffer: some parsers (pdf.js) refuse Buffers.
    const bytes = value as Uint8Array | ArrayBuffer;
    const chunk =
      bytes instanceof Uint8Array
        ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : new Uint8Array(bytes);
    this.bytesRead += chunk.byteLength;
    this.checkMemory();
    return chunk;
  }

  /** Up to the first `n` bytes, without consuming them. Shorter only at the end of the content. */
  async peek(n: number): Promise<Uint8Array> {
    let have = this.pending.reduce((sum, c) => sum + c.byteLength, 0);
    while (have < n) {
      const chunk = await this.next();
      if (chunk === null) break;
      this.pending.push(chunk);
      have += chunk.byteLength;
    }
    return concat(this.pending, n);
  }

  /** The content from where reading stands, chunk by chunk. */
  async *chunks(): AsyncGenerator<Uint8Array> {
    while (this.pending.length > 0) yield this.pending.shift() as Uint8Array;
    for (;;) {
      const chunk = await this.next();
      if (chunk === null) return;
      yield chunk;
    }
  }

  /** All of the content, for parsers that need it whole; `too-large` past `maxBytes`. */
  async readAll(maxBytes: number): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of this.chunks()) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new ExtractError("too-large");
      parts.push(chunk);
    }
    return concat(parts, size);
  }

  /** Stops reading: the rest of the content isn't needed. */
  async close(): Promise<void> {
    this.pending.length = 0;
    if (this.ended) return;
    this.ended = true;
    await this.iterator.return?.();
  }
}

/** The first `n` bytes of the chunks, as one array. */
function concat(chunks: readonly Uint8Array[], n: number): Uint8Array {
  if (chunks.length === 1 && (chunks[0] as Uint8Array).byteLength <= n) {
    return chunks[0] as Uint8Array;
  }
  const total = Math.min(
    n,
    chunks.reduce((sum, c) => sum + c.byteLength, 0),
  );
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    if (at >= total) break;
    const take = Math.min(c.byteLength, total - at);
    out.set(take === c.byteLength ? c : c.subarray(0, take), at);
    at += take;
  }
  return out;
}
