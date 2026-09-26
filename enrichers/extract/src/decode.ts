import { ExtractError } from "./errors.ts";
import type { Input } from "./input.ts";
import type { TextEncoding } from "./types.ts";

/** Bytes looked at to choose the encoding and to tell text from binary. */
const PROBE_BYTES = 64 * 1024;

/**
 * Decodes text content as it streams: UTF-8 (a BOM or none), UTF-16 with a BOM, or, when the
 * start isn't valid UTF-8, Windows-1252 (what legacy exports usually are). Content with NUL
 * bytes or mostly control characters in its first 64 KiB isn't text: `binary`.
 */
export async function decodeText(
  input: Input,
): Promise<{ encoding: TextEncoding; chunks: AsyncGenerator<string> }> {
  const head = await input.peek(PROBE_BYTES);
  let encoding: TextEncoding = "utf-8";
  if (head[0] === 0xff && head[1] === 0xfe) encoding = "utf-16le";
  else if (head[0] === 0xfe && head[1] === 0xff) encoding = "utf-16be";
  else {
    if (looksBinary(head)) throw new ExtractError("binary");
    if (!validUtf8Start(head)) encoding = "windows-1252";
  }
  // The BOM, if any, is dropped by the decoder.
  const decoder = new TextDecoder(encoding);
  async function* chunks(): AsyncGenerator<string> {
    for await (const chunk of input.chunks()) {
      const s = decoder.decode(chunk, { stream: true });
      if (s !== "") yield s;
    }
    const rest = decoder.decode();
    if (rest !== "") yield rest;
  }
  return { encoding, chunks: chunks() };
}

/** NUL bytes, or more than one in ten bytes a control character other than whitespace. */
function looksBinary(head: Uint8Array): boolean {
  let controls = 0;
  for (const b of head) {
    if (b === 0) return true;
    if (b < 0x20 && b !== 9 && b !== 10 && b !== 12 && b !== 13 && b !== 0x1b) controls++;
  }
  return controls * 10 > head.byteLength;
}

/** Whether the bytes are valid UTF-8, allowing a character cut off at the end. */
function validUtf8Start(head: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
}
