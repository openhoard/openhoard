import { SaxesParser, type SaxesTagNS } from "saxes";
import { ExtractError } from "./errors.ts";

/*
 * XML parts of Office files, read as a stream of events (saxes: a non-validating parser that
 * never fetches anything and expands only XML's five predefined entities and character
 * references). On top of that:
 *
 * - any DOCTYPE fails the part (`xml-limits`): Office never writes one, and it is where entity
 *   definitions ("billion laughs") and external references live;
 * - elements nested deeper than `maxDepth` fail it too, before the parser's own stack grows;
 * - names are matched by local name, whatever prefix a writer chose (transitional and strict
 *   Office namespaces alike); an attribute in the relationships namespace is keyed `r:<name>`.
 */

/** What a part's reader does with its events, in document order. */
export interface XmlHandlers {
  open(name: string, attributes: Readonly<Record<string, string>>): void;
  close(name: string): void;
  text(text: string): void;
}

/**
 * Parses one part from its bytes. `stop()` is asked after each chunk: once it says true, the
 * rest of the part is left unread.
 */
export async function parseXml(
  chunks: AsyncIterable<Uint8Array>,
  handlers: XmlHandlers,
  options: { maxDepth: number; stop?: () => boolean; checkMemory?: () => void },
): Promise<void> {
  const parser = new SaxesParser({ xmlns: true, position: false });
  let depth = 0;
  parser.on("doctype", () => {
    throw new ExtractError("xml-limits", "DOCTYPE in an Office part");
  });
  parser.on("opentag", (tag: SaxesTagNS) => {
    if (++depth > options.maxDepth) throw new ExtractError("xml-limits", "XML nested too deep");
    handlers.open(tag.local, attributesOf(tag));
  });
  parser.on("closetag", (tag: SaxesTagNS) => {
    depth--;
    handlers.close(tag.local);
  });
  parser.on("text", (text: string) => handlers.text(text));
  parser.on("cdata", (text: string) => handlers.text(text));
  parser.on("error", (e: Error) => {
    throw new ExtractError("malformed", "malformed XML", { cause: e });
  });

  let decoder: InstanceType<typeof TextDecoder> | undefined;
  for await (const chunk of chunks) {
    // Office writes UTF-8; UTF-16 announces itself with a byte order mark.
    decoder ??= new TextDecoder(
      chunk[0] === 0xff && chunk[1] === 0xfe
        ? "utf-16le"
        : chunk[0] === 0xfe && chunk[1] === 0xff
          ? "utf-16be"
          : "utf-8",
    );
    parser.write(decoder.decode(chunk, { stream: true }));
    options.checkMemory?.();
    if (options.stop?.()) return;
  }
  if (decoder) parser.write(decoder.decode());
  parser.close();
}

const RELATIONSHIPS = "/relationships";

function attributesOf(tag: SaxesTagNS): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const a of Object.values(tag.attributes)) {
    const key = a.uri.endsWith(RELATIONSHIPS) ? `r:${a.local}` : a.local;
    if (!(key in out)) out[key] = a.value;
  }
  return out;
}
