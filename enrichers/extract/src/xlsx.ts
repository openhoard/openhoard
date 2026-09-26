import type { ExtractContext } from "./context.ts";
import {
  commentSignal,
  parsePart,
  relationships,
  TextCollector,
  type OoxmlPackage,
} from "./ooxml.ts";
import { PROPERTY_CHARS, sampleOf } from "./text.ts";
import { MAX_SHEETS, type SheetState } from "./types.ts";

/*
 * Excel: each visible sheet in workbook order, a line per row, cells separated by tabs, and
 * the sheet's name on a line before it. Cells give their values, shared strings resolved;
 * formulas give their last computed value (the formula itself is a signal).
 *
 * - Hidden and very hidden sheets are listed in the metadata but their cells are left out:
 *   signals `hidden-sheet`, `very-hidden-sheet`, with the sheet's name as sample.
 * - Defined names (named formulas and constants) are left out: `defined-name`.
 * - Comments are left out: `comment`.
 * - Shared strings are kept up to `maxSharedStringChars`; cells after that come out empty
 *   (warning `strings-truncated`).
 */

export async function extractXlsx(context: ExtractContext, pkg: OoxmlPackage): Promise<void> {
  const { archive, main } = pkg;
  const { signals, sink } = context;

  // The workbook: its sheets (name, state, relationship) and defined names.
  const sheets: { name: string; state: SheetState; rel: string | undefined }[] = [];
  const definedName = new TextCollector("definedName");
  let names = 0;
  await parsePart(context, archive, main, {
    open(name, a) {
      definedName.open(name);
      if (name === "definedName") {
        names++;
        if (names === 1) definedName.add(`${a.name ?? ""} = `);
      } else if (name === "sheet") {
        sheets.push({
          name: sampleOf(a.name ?? "", PROPERTY_CHARS),
          state:
            a.state === "hidden" ? "hidden" : a.state === "veryHidden" ? "very-hidden" : "visible",
          rel: a["r:id"],
        });
      }
    },
    close: (name) => definedName.close(name),
    text: (t) => definedName.add(t),
  });
  context.metadata.sheets = sheets.slice(0, MAX_SHEETS).map(({ name, state }) => ({ name, state }));
  signals.add("defined-name", definedName.text, names);

  const rels = await relationships(context, archive, main);
  const target = (id: string | undefined) => rels.find((r) => r.id === id);
  const shared = new SharedStrings();
  for (const r of rels.filter((r) => r.type.endsWith("/sharedStrings"))) {
    await shared.read(context, pkg, r.target);
  }
  if (shared.truncated) context.warnings.add("strings-truncated");

  const stop = () => sink.truncated;
  for (const sheet of sheets) {
    if (sheet.state !== "visible") {
      signals.add(sheet.state === "hidden" ? "hidden-sheet" : "very-hidden-sheet", sheet.name);
      continue;
    }
    const rel = target(sheet.rel);
    if (stop() || rel === undefined || !rel.type.endsWith("/worksheet")) continue;
    sink.write(`${sheet.name}\n`);
    await parsePart(context, archive, rel.target, new SheetReader(context, shared), stop);
    sink.write("\n");
    // Comments on this sheet.
    for (const c of await relationships(context, archive, rel.target)) {
      if (c.type.endsWith("/comments")) await commentSignal(context, archive, c.target, "comment");
    }
  }
}

/** The workbook's shared strings: an index of texts cells point at. */
class SharedStrings {
  truncated = false;
  private readonly strings: string[] = [];
  private chars = 0;

  get(index: number): string {
    return this.strings[index] ?? "";
  }

  async read(context: ExtractContext, pkg: OoxmlPackage, part: string): Promise<void> {
    const max = context.limits.maxSharedStringChars;
    let item: string[] | null = null;
    let inText = false;
    /** Inside `rPh` (phonetic hints for East Asian text), which isn't the cell's text. */
    let phonetic = 0;
    await parsePart(
      context,
      pkg.archive,
      part,
      {
        open(name) {
          if (name === "si") item = [];
          else if (name === "rPh") phonetic++;
          else if (name === "t") inText = true;
        },
        close: (name) => {
          if (name === "t") inText = false;
          else if (name === "rPh") phonetic--;
          else if (name === "si" && item !== null) {
            const s = item.join("");
            item = null;
            if (this.chars + s.length > max) {
              this.truncated = true;
              return;
            }
            this.chars += s.length;
            this.strings.push(s);
          }
        },
        text(t) {
          if (inText && phonetic === 0 && item !== null) item.push(t);
        },
      },
      () => this.truncated,
    );
  }
}

/** Reads one worksheet's rows into the text. */
class SheetReader {
  private readonly context: ExtractContext;
  private readonly shared: SharedStrings;
  private readonly row: string[] = [];
  /** The current cell: its type (`t`), value (`v`), inline string (`is`), formula (`f`). */
  private type: string | undefined;
  private value = "";
  private inline = "";
  private into: "v" | "is" | "f" | null = null;
  private formula = "";

  constructor(context: ExtractContext, shared: SharedStrings) {
    this.context = context;
    this.shared = shared;
  }

  open(name: string, a: Readonly<Record<string, string>>): void {
    if (name === "c") {
      this.type = a.t;
      this.value = this.inline = this.formula = "";
    } else if (name === "v" || name === "f") {
      this.into = name;
    } else if (name === "is") {
      this.into = "is";
    }
  }

  close(name: string): void {
    if (name === "v" || name === "is") this.into = null;
    else if (name === "f") {
      this.into = null;
      this.context.signals.add("formula", this.formula);
    } else if (name === "c") this.row.push(this.cellText());
    else if (name === "row") {
      while (this.row.length > 0 && this.row[this.row.length - 1] === "") this.row.pop();
      if (this.row.length > 0) this.context.sink.write(`${this.row.join("\t")}\n`);
      this.row.length = 0;
    }
  }

  text(t: string): void {
    // Bounded: a cell's value is kept only up to a page of text.
    if (this.into === "v" && this.value.length < 32_768) this.value += t;
    else if (this.into === "is" && this.inline.length < 32_768) this.inline += t;
    else if (this.into === "f" && this.formula.length < 1024) this.formula += t;
  }

  private cellText(): string {
    switch (this.type) {
      case "s": {
        const index = Number(this.value);
        return Number.isSafeInteger(index) && index >= 0 ? this.shared.get(index) : "";
      }
      case "inlineStr":
        return this.inline;
      case "b":
        return this.value === "1" ? "TRUE" : this.value === "0" ? "FALSE" : this.value;
      default:
        return this.value;
    }
  }
}
