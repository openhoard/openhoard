import type { ExtractContext } from "./context.ts";
import { commentSignal, parsePart, relationships, type OoxmlPackage } from "./ooxml.ts";

/*
 * Word: the body, then headers, footers, footnotes and endnotes, a paragraph per line.
 *
 * - Runs marked hidden (`w:vanish`, `w:specVanish`) are left out: signal `hidden-text`.
 * - Deleted text in tracked changes (`w:delText`) is left out: `tracked-deletion`.
 * - White (`FFFFFF`) and 1-point-or-smaller runs stay in (a dark background, a spacer can be
 *   real) and are signalled: `white-text`, `tiny-text`.
 * - Field instructions (`w:instrText`) are left out; the fields' results are ordinary runs.
 * - Of `mc:AlternateContent`, only the first choice is read: the fallback repeats it (a text
 *   box in DrawingML and again in VML).
 * - Comments are left out and signalled: `comment`.
 *
 * Hidden character styles (a style with `w:vanish`) aren't resolved: their runs are kept.
 */

/** Half-points: `w:sz` of 2 or less is 1 point or smaller. */
const TINY_HALF_POINTS = 2;

export async function extractDocx(context: ExtractContext, pkg: OoxmlPackage): Promise<void> {
  const { archive, main } = pkg;
  const rels = await relationships(context, archive, main);
  const ofType = (suffix: string) =>
    rels.filter((r) => r.type.endsWith(suffix)).map((r) => r.target);
  const parts = [
    main,
    ...ofType("/header"),
    ...ofType("/footer"),
    ...ofType("/footnotes"),
    ...ofType("/endnotes"),
  ];
  const stop = () => context.sink.truncated;
  for (const part of new Set(parts)) {
    if (stop()) break;
    await parsePart(context, archive, part, new WordReader(context), stop);
    context.sink.write("\n\n");
  }
  for (const part of new Set(ofType("/comments"))) {
    await commentSignal(context, archive, part, "comment");
  }
}

/** Reads one part of a Word document: runs, their formatting, paragraphs. */
class WordReader {
  private readonly context: ExtractContext;
  /** Inside a `w:r`, and inside its `w:rPr`. */
  private run = false;
  private props = false;
  private hidden = false;
  private white = false;
  private tiny = false;
  /** The run's text is deleted text of a tracked change (`w:delText`). */
  private deleted = false;
  private readonly pieces: string[] = [];
  /** Inside a `w:t` or `w:delText`: text goes to the run. */
  private into = false;
  /** Depth inside elements whose content is skipped (`mc:Fallback`, `w:instrText`). */
  private skip = 0;

  constructor(context: ExtractContext) {
    this.context = context;
  }

  open(name: string, a: Readonly<Record<string, string>>): void {
    if (this.skip > 0 || name === "Fallback" || name === "instrText") {
      this.skip++;
      return;
    }
    switch (name) {
      case "r":
        this.run = true;
        this.hidden = this.white = this.tiny = this.deleted = false;
        this.pieces.length = 0;
        return;
      case "rPr":
        if (this.run) this.props = true;
        return;
      case "t":
      case "delText":
        if (this.run) this.into = true;
        if (name === "delText") this.deleted = true;
        return;
      case "tab":
        if (this.run && !this.props) this.pieces.push("\t");
        return;
      case "br":
      case "cr":
        if (this.run && !this.props) this.pieces.push("\n");
        return;
    }
    if (!this.props) return;
    if (name === "vanish" || name === "specVanish") this.hidden = on(a.val);
    else if (name === "color") this.white = (a.val ?? "").toUpperCase() === "FFFFFF";
    else if (name === "sz") {
      const size = Number(a.val);
      this.tiny = Number.isFinite(size) && size <= TINY_HALF_POINTS;
    }
  }

  close(name: string): void {
    if (this.skip > 0) {
      this.skip--;
      return;
    }
    if (name === "t" || name === "delText") this.into = false;
    else if (name === "rPr") this.props = false;
    else if (name === "r") this.endRun();
    else if (name === "p") this.context.sink.write("\n");
  }

  text(t: string): void {
    if (this.skip === 0 && this.into) this.pieces.push(t);
  }

  private endRun(): void {
    this.run = false;
    const text = this.pieces.join("");
    this.pieces.length = 0;
    if (text === "") return;
    const { sink, signals } = this.context;
    if (this.deleted) {
      signals.add("tracked-deletion", text);
      return;
    }
    if (this.hidden) {
      signals.add("hidden-text", text);
      return;
    }
    sink.write(text);
    if (this.white) signals.add("white-text", text);
    if (this.tiny) signals.add("tiny-text", text);
  }
}

/** A Word on/off property: on unless its value says off. */
function on(value: string | undefined): boolean {
  return value !== "0" && value !== "false" && value !== "off";
}
