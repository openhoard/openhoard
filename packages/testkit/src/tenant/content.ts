import { Random } from "../random.js";
import type { FakeItem, FakeTenant } from "./types.js";
import { BODY_WORDS } from "./vocabulary.js";

const BLOCK_BYTES = 16 * 1024;
const CHUNK_BYTES = 64 * 1024;
/** {@link contentBytes} refuses to buffer more than this; use {@link contentStream}. */
export const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;

/**
 * Deterministic file content, optionally one inclusive byte range (for HTTP Range requests:
 * position N always holds the same byte, so resumed downloads line up). Bytes are produced lazily, so a 4 GiB "huge file" costs no
 * memory. Content depends only on the item's content key and size: seeded duplicates share
 * both, so they are byte-for-byte identical.
 *
 * The first bytes are a plain-text header with the original file's labels and (for restricted
 * files) its canary token, so full-text search over extracted text can find them. Names are
 * left out on purpose: renaming a file must not change its bytes.
 */
export function contentStream(
  tenant: FakeTenant,
  item: FakeItem,
  range?: { start: number; end: number },
): ReadableStream<Uint8Array> {
  if (item.kind !== "file") throw new TypeError(`${item.id} is a folder`);
  const start = range?.start ?? 0;
  const end = range?.end ?? item.size - 1;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end >= item.size ||
    (end < start && item.size > 0)
  ) {
    throw new RangeError(`bad byte range ${start}-${end} for ${item.size} bytes`);
  }
  const origin = itemIndex(tenant).get(item.contentKey) ?? item;
  const header = new TextEncoder().encode(headerOf(origin));
  const block = bodyBlock(item.contentKey);
  const size = item.size === 0 ? 0 : end + 1;
  let sent = start;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (sent >= size) {
          controller.close();
          return;
        }
        const n = Math.min(CHUNK_BYTES, size - sent);
        const chunk = new Uint8Array(n);
        for (let off = 0; off < n;) {
          const at = sent + off;
          const [src, from] =
            at < header.length ? [header, at] : [block, (at - header.length) % block.length];
          const take = Math.min(src.length - from, n - off);
          chunk.set(src.subarray(from, from + take), off);
          off += take;
        }
        sent += n;
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
}

/** The whole content in memory. For small files in tests; large files must be streamed. */
export async function contentBytes(tenant: FakeTenant, item: FakeItem): Promise<Uint8Array> {
  if (item.size > MAX_BUFFERED_BYTES) {
    throw new RangeError(`${item.id} is ${item.size} bytes; use contentStream`);
  }
  return new Uint8Array(await new Response(contentStream(tenant, item)).arrayBuffer());
}

const indexes = new WeakMap<FakeTenant, Map<string, FakeItem>>();
function itemIndex(tenant: FakeTenant): Map<string, FakeItem> {
  let index = indexes.get(tenant);
  if (!index) {
    index = new Map(tenant.items.map((i) => [i.id, i]));
    indexes.set(tenant, index);
  }
  return index;
}

function headerOf(origin: FakeItem): string {
  const lines = [`labels: ${origin.labels.join(" ")}`];
  if (origin.canary) lines.push(`reference: ${origin.canary}`);
  return `${lines.join("\n")}\n\n`;
}

/** A block of ASCII prose seeded by the content key, repeated to fill the file. */
function bodyBlock(contentKey: string): Uint8Array {
  const rng = new Random(`content:${contentKey}`);
  let text = "";
  while (text.length < BLOCK_BYTES) {
    const words = Array.from({ length: rng.int(6, 16) }, () => rng.pick(BODY_WORDS));
    text += `${words.join(" ")}.${rng.chance(0.2) ? "\n\n" : " "}`;
  }
  return new TextEncoder().encode(text.slice(0, BLOCK_BYTES));
}
