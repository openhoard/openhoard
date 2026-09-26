import type { ExtractContext } from "./context.ts";
import { extractDocx } from "./docx.ts";
import { ExtractError } from "./errors.ts";
import { extractPptx } from "./pptx.ts";
import { PROPERTY_CHARS, sampleOf } from "./text.ts";
import { extractXlsx } from "./xlsx.ts";
import { parseXml, type XmlHandlers } from "./xml.ts";
import { Archive } from "./zip.ts";

/*
 * The Office formats (docx, xlsx, pptx): a ZIP (zip.ts) of XML parts (xml.ts), tied together by
 * relationship parts. The main part is found through the package's own relationships, and the
 * rest from the main part's, never by guessing names; a relationship that points outside the
 * package, or out of it with `..`, is ignored.
 */

/** What an Office extractor gets: the archive and where its main part is. */
export interface OoxmlPackage {
  archive: Archive;
  /** The main part: `word/document.xml`, `xl/workbook.xml`, `ppt/presentation.xml`. */
  main: string;
}

/**
 * Opens the archive and reads the Office document it holds, whichever of the three it is.
 * `declared` is what the caller said it was; a different one is read anyway, with a warning.
 */
export async function extractOoxml(
  context: ExtractContext,
  declared: "docx" | "xlsx" | "pptx" | null,
): Promise<"docx" | "xlsx" | "pptx"> {
  const bytes = await context.input.readAll(context.limits.maxInputBytes);
  const archive = await Archive.open(bytes, context.limits);
  try {
    const main = await mainPart(context, archive);
    const kind = main === null ? null : kindOf(main);
    if (kind === null || main === null)
      throw new ExtractError("unsupported", "not an Office document");
    if (declared !== null && declared !== kind) context.warnings.add("type-mismatch");
    const pkg: OoxmlPackage = { archive, main };
    const embedded = archive.names().filter((n) => n.includes("/embeddings/")).length;
    context.signals.add("embedded-object", undefined, embedded);
    await coreProperties(context, archive);
    if (kind === "docx") await extractDocx(context, pkg);
    else if (kind === "xlsx") await extractXlsx(context, pkg);
    else await extractPptx(context, pkg);
    return kind;
  } finally {
    archive.close();
  }
}

function kindOf(main: string): "docx" | "xlsx" | "pptx" | null {
  if (main.startsWith("word/")) return "docx";
  if (main.startsWith("xl/")) return "xlsx";
  if (main.startsWith("ppt/")) return "pptx";
  return null;
}

/** The main part, from the package relationships; the usual name when they don't say. */
async function mainPart(context: ExtractContext, archive: Archive): Promise<string | null> {
  const rels = await relationships(context, archive, "");
  const main = rels.find((r) => r.type.endsWith("/officeDocument"));
  if (main && archive.has(main.target)) return main.target;
  for (const name of ["word/document.xml", "xl/workbook.xml", "ppt/presentation.xml"]) {
    if (archive.has(name)) return name;
  }
  return null;
}

export interface Relationship {
  id: string;
  type: string;
  /** The target part, resolved from the source part's folder, lower case. */
  target: string;
}

/**
 * The relationships of a part (`""` for the package's own): internal targets only, resolved.
 * A missing relationships part means none.
 */
export async function relationships(
  context: ExtractContext,
  archive: Archive,
  part: string,
): Promise<Relationship[]> {
  const slash = part.lastIndexOf("/");
  const folder = part.slice(0, slash + 1);
  const relsPart = `${folder}_rels/${part.slice(slash + 1)}.rels`;
  const found: Relationship[] = [];
  await parsePart(context, archive, relsPart, {
    open(name, a) {
      if (name !== "Relationship" || a.TargetMode === "External") return;
      const { Id: id, Type: type, Target: target } = a;
      if (id === undefined || type === undefined || target === undefined) return;
      const resolved = resolveTarget(folder, target);
      if (resolved !== null) found.push({ id, type, target: resolved });
    },
    close() {},
    text() {},
  });
  return found;
}

/**
 * A relationship's target as a part name: absolute (`/xl/…`) or relative to `folder`, with `.`
 * and `..` resolved and percent-escapes decoded. Null when it climbs out of the package.
 */
export function resolveTarget(folder: string, target: string): string | null {
  const joined = target.startsWith("/") ? target.slice(1) : folder + target;
  const out: string[] = [];
  for (const raw of joined.split("/")) {
    let segment = raw;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      // Not an escape sequence: the name as written.
    }
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return out.length === 0 ? null : out.join("/").toLowerCase();
}

/** Parses one part, if the archive has it, with the context's limits. */
export async function parsePart(
  context: ExtractContext,
  archive: Archive,
  part: string,
  handlers: XmlHandlers,
  stop?: () => boolean,
): Promise<void> {
  if (!archive.has(part)) return;
  await parseXml(archive.read(part), handlers, {
    maxDepth: context.limits.maxXmlDepth,
    checkMemory: context.checkMemory,
    ...(stop ? { stop } : {}),
  });
}

/**
 * Collects the text of a part's elements named `name` (`t` in a comment, say) until `max`
 * characters: what signals use as a sample.
 */
export class TextCollector {
  text = "";
  private depth = 0;
  private readonly name: string;
  private readonly max: number;

  constructor(name: string, max = 1024) {
    this.name = name;
    this.max = max;
  }

  open(name: string): void {
    if (name === this.name) this.depth++;
  }

  close(name: string): void {
    if (name === this.name && this.depth > 0) this.depth--;
  }

  add(text: string): void {
    if (this.depth > 0 && this.text.length < this.max) {
      this.text += text.slice(0, this.max - this.text.length);
    }
  }
}

/**
 * Counts the comments (`element`) in a comments part: signal `comment`, the text of the first
 * (in `textElement`s) as sample.
 */
export async function commentSignal(
  context: ExtractContext,
  archive: Archive,
  part: string,
  element: string,
  textElement = "t",
): Promise<void> {
  const text = new TextCollector(textElement);
  let count = 0;
  await parsePart(context, archive, part, {
    open(name) {
      text.open(name);
      if (name === element) count++;
    },
    close: (name) => text.close(name),
    text: (t) => text.add(t),
  });
  context.signals.add("comment", text.text, count);
}

/**
 * Document properties (`docProps/core.xml`): title and author go to the metadata; subject,
 * keywords and description are a signal (they are where the injection corpus hid payloads,
 * and no one reads them). Custom properties (`docProps/custom.xml`) count as that signal too.
 */
async function coreProperties(context: ExtractContext, archive: Archive): Promise<void> {
  // Only the properties used are kept, each up to 4 KiB: element names are the file's.
  const wanted = ["title", "creator", "subject", "keywords", "description"];
  const values = new Map<string, string>();
  let current: string | null = null;
  await parsePart(context, archive, "docProps/core.xml", {
    open(name) {
      current = wanted.includes(name) ? name : null;
    },
    close() {
      current = null;
    },
    text(text) {
      if (current === null) return;
      const value = values.get(current) ?? "";
      if (value.length < 4096) values.set(current, value + text.slice(0, 4096));
    },
  });
  const title = sampleOf(values.get("title") ?? "", PROPERTY_CHARS);
  const author = sampleOf(values.get("creator") ?? "", PROPERTY_CHARS);
  if (title !== "") context.metadata.title = title;
  if (author !== "") context.metadata.author = author;
  for (const name of ["subject", "keywords", "description"]) {
    const value = values.get(name) ?? "";
    if (value.trim() !== "") context.signals.add("document-properties", `${name}: ${value}`);
  }
  const custom = new TextCollector("property");
  let properties = 0;
  await parsePart(context, archive, "docProps/custom.xml", {
    open(name) {
      custom.open(name);
      if (name === "property") properties++;
    },
    close: (name) => custom.close(name),
    text: (text) => custom.add(text),
  });
  context.signals.add("document-properties", custom.text, properties);
}
