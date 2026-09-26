import type { ExtractContext } from "./context.ts";
import { decodeText } from "./decode.ts";

/**
 * Plain text: decoded as it streams, and reading stops once the text limit is reached (the rest
 * can't change what is kept).
 */
export async function extractPlain(context: ExtractContext): Promise<void> {
  const { encoding, chunks } = await decodeText(context.input);
  context.metadata.encoding = encoding;
  for await (const s of chunks) {
    context.checkMemory();
    if (!context.sink.write(s)) break;
  }
}

/**
 * Markdown: plain text without its HTML comments, which a renderer never shows and so can hide
 * instructions (signal `html-comment`). The Markdown itself is kept as written: its markup is
 * readable, and search matches on the words either way.
 */
export async function extractMarkdown(context: ExtractContext): Promise<void> {
  const { encoding, chunks } = await decodeText(context.input);
  context.metadata.encoding = encoding;
  const comments = new CommentStripper();
  for await (const s of chunks) {
    context.checkMemory();
    if (!context.sink.write(comments.visible(s))) break;
  }
  context.sink.write(comments.end());
  context.signals.add("html-comment", comments.sample, comments.count);
}

const OPEN = "<!--";
const CLOSE = "-->";
/** The most of a comment kept as the signal's sample, before it is shortened. */
const SAMPLE_KEEP = 1024;

/**
 * Removes `<!-- … -->` from text that arrives in pieces: a marker split between two pieces is
 * held back until the next one. One pass with indexOf, so linear in the input.
 */
export class CommentStripper {
  count = 0;
  sample: string | undefined;
  private inside = false;
  private carry = "";
  private current = "";

  /** The visible part of the next piece of text. */
  visible(piece: string): string {
    const text = this.carry + piece;
    this.carry = "";
    const out: string[] = [];
    let at = 0;
    while (at < text.length) {
      if (!this.inside) {
        const open = text.indexOf(OPEN, at);
        if (open === -1) {
          const keep = partialTail(text, OPEN, at);
          out.push(text.slice(at, text.length - keep));
          this.carry = text.slice(text.length - keep);
          break;
        }
        out.push(text.slice(at, open));
        this.inside = true;
        this.count++;
        this.current = "";
        at = open + OPEN.length;
      } else {
        const close = text.indexOf(CLOSE, at);
        if (close === -1) {
          const keep = partialTail(text, CLOSE, at);
          this.hidden(text.slice(at, text.length - keep));
          this.carry = text.slice(text.length - keep);
          break;
        }
        this.hidden(text.slice(at, close));
        this.closed();
        this.inside = false;
        at = close + CLOSE.length;
      }
    }
    return out.join("");
  }

  /** What is left at the end: a held-back partial marker outside a comment is text. */
  end(): string {
    if (this.inside) this.closed();
    const rest = this.inside ? "" : this.carry;
    this.carry = "";
    return rest;
  }

  /** Keeps the start of the first comment that says anything, for the sample. */
  private hidden(s: string): void {
    if (this.sample !== undefined || this.current.length >= SAMPLE_KEEP) return;
    this.current += s.slice(0, SAMPLE_KEEP - this.current.length);
  }

  private closed(): void {
    if (this.sample === undefined && this.current.trim() !== "") this.sample = this.current;
    this.current = "";
  }
}

/** How many characters at the end of `text` (from `from` on) could start `marker`. */
function partialTail(text: string, marker: string, from: number): number {
  for (let n = Math.min(marker.length - 1, text.length - from); n > 0; n--) {
    if (text.endsWith(marker.slice(0, n))) return n;
  }
  return 0;
}
