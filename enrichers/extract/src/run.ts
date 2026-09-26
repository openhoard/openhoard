import type { ExtractContext } from "./context.ts";
import { extractCsv } from "./csv.ts";
import { declaredKind, isOoxml, isTextual, sniff, SNIFF_BYTES } from "./detect.ts";
import { ExtractError } from "./errors.ts";
import { Input } from "./input.ts";
import { extractMarkdown, extractPlain } from "./plain.ts";
import { Signals, TextSink } from "./text.ts";
import type {
  ExtractHint,
  Extraction,
  ExtractionKind,
  ExtractionMetadata,
  ExtractLimits,
  WarningCode,
} from "./types.ts";

/**
 * Extracts one file: looks at its first bytes, picks the extractor, and runs it. Throws
 * {@link ExtractError} for a typed failure. This is what the child process runs (child.ts); tests
 * also call it in-process. It never touches the network, the file system beyond its own
 * package's modules, or anything but `source`.
 */
export async function runExtraction(
  source: AsyncIterable<Uint8Array>,
  hint: ExtractHint,
  limits: ExtractLimits,
  checkMemory: () => void = () => {},
): Promise<{ extraction: Extraction; bytesRead: number }> {
  const input = new Input(source, checkMemory);
  const metadata: ExtractionMetadata = {};
  const warnings = new Set<WarningCode>();
  const context: ExtractContext = {
    input,
    limits,
    sink: new TextSink(limits.maxTextBytes),
    signals: new Signals(),
    metadata,
    warnings,
    checkMemory,
  };
  try {
    const kind = await dispatch(context, hint);
    context.signals.add("invisible-characters", undefined, context.sink.sanitizer.invisible);
    return {
      extraction: {
        kind,
        text: context.sink.text(),
        truncated: context.sink.truncated,
        metadata,
        signals: context.signals.list(),
        warnings: [...warnings].sort(),
      },
      bytesRead: input.bytesRead,
    };
  } finally {
    await input.close();
  }
}

async function dispatch(context: ExtractContext, hint: ExtractHint): Promise<ExtractionKind> {
  const declared = declaredKind(hint);
  const magic = sniff(await context.input.peek(SNIFF_BYTES));
  const mismatch = (kind: ExtractionKind) => {
    if (declared !== null && declared !== kind) context.warnings.add("type-mismatch");
  };
  switch (magic) {
    case "pdf": {
      mismatch("pdf");
      const { extractPdf } = await import("./pdf.ts");
      await extractPdf(context);
      return "pdf";
    }
    case "zip": {
      const { extractOoxml } = await import("./ooxml.ts");
      const kind = await extractOoxml(context, isOoxml(declared) ? declared : null);
      mismatch(kind);
      return kind;
    }
    case "cfb":
      // What a password-protected Office file is (an encrypted package in an OLE container);
      // anything else in one is a legacy format this extractor doesn't read.
      throw new ExtractError(isOoxml(declared) ? "encrypted" : "unsupported");
  }
  if (!isTextual(declared)) {
    // Bytes that are neither a PDF nor an archive: a declared PDF or Office file is broken,
    // and untyped bytes are never guessed to be text.
    throw new ExtractError(declared === null ? "unsupported" : "malformed");
  }
  if (declared === "csv") await extractCsv(context, isTabSeparated(hint));
  else if (declared === "markdown") await extractMarkdown(context);
  else await extractPlain(context);
  return declared;
}

function isTabSeparated(hint: ExtractHint): boolean {
  return (
    hint.mime.toLowerCase().startsWith("text/tab-separated-values") ||
    (hint.name ?? "").toLowerCase().endsWith(".tsv")
  );
}
