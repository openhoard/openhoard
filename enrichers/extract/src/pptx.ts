import type { ExtractContext } from "./context.ts";
import { commentSignal, parsePart, relationships, type OoxmlPackage } from "./ooxml.ts";
import { TextSink } from "./text.ts";

/*
 * PowerPoint: each slide in presentation order, its text a paragraph per line, then its
 * speaker notes (what the presenter reads; the notes' slide-number and date fields are not).
 *
 * - Slides marked not to show (`show="0"`) are left out: signal `hidden-slide`.
 * - White (`FFFFFF`) and 1-point-or-smaller runs stay in and are signalled: `white-text`,
 *   `tiny-text`.
 * - Comments are left out: `comment`.
 */

/** Hundredths of a point: `sz` of 100 or less is 1 point or smaller. */
const TINY_SIZE = 100;

export async function extractPptx(context: ExtractContext, pkg: OoxmlPackage): Promise<void> {
  const { archive, main } = pkg;
  const { sink, signals, limits } = context;
  const order: string[] = [];
  await parsePart(context, archive, main, {
    open(name, a) {
      if (name === "sldId" && a["r:id"] !== undefined) order.push(a["r:id"]);
    },
    close() {},
    text() {},
  });
  context.metadata.slides = order.length;
  const rels = await relationships(context, archive, main);
  for (const id of order) {
    const slide = rels.find((r) => r.id === id && r.type.endsWith("/slide"));
    if (slide === undefined) continue;
    const slideRels = await relationships(context, archive, slide.target);
    for (const c of slideRels.filter((r) => r.type.endsWith("/comments"))) {
      await commentSignal(context, archive, c.target, "cm", "text");
    }
    if (sink.truncated) continue;
    // A slide's text is collected on its own first: a hidden slide's goes to the signal only.
    const own = new TextSink(limits.maxTextBytes, sink.sanitizer);
    const reader = new SlideReader(context, own);
    await parsePart(context, archive, slide.target, reader, () => own.truncated);
    if (reader.hidden) {
      signals.add("hidden-slide", own.text());
      continue;
    }
    sink.write(`${own.text()}\n`);
    for (const notes of slideRels.filter((r) => r.type.endsWith("/notesSlide"))) {
      const text = new TextSink(limits.maxTextBytes, sink.sanitizer);
      await parsePart(
        context,
        archive,
        notes.target,
        new SlideReader(context, text),
        () => text.truncated,
      );
      sink.write(`${text.text()}\n`);
    }
    sink.write("\n");
  }
}

/** Reads the text of one slide or notes page: runs, their formatting, paragraphs. */
class SlideReader {
  /** Whether the slide is marked not to show. */
  hidden = false;
  private readonly context: ExtractContext;
  private readonly out: TextSink;
  private readonly run: string[] = [];
  private inRun = false;
  private inText = false;
  /** Inside a field (`a:fld`: slide number, date), whose text is left out. */
  private field = 0;
  /** Inside the run's properties, and its fill. */
  private props = false;
  private fill = false;
  private white = false;
  private tiny = false;

  constructor(context: ExtractContext, out: TextSink) {
    this.context = context;
    this.out = out;
  }

  open(name: string, a: Readonly<Record<string, string>>): void {
    switch (name) {
      case "sld":
        this.hidden = a.show === "0" || a.show === "false";
        return;
      case "fld":
        this.field++;
        return;
      case "r":
        this.inRun = true;
        this.white = this.tiny = false;
        this.run.length = 0;
        return;
      case "rPr": {
        if (!this.inRun) return;
        this.props = true;
        const size = Number(a.sz);
        this.tiny = a.sz !== undefined && Number.isFinite(size) && size <= TINY_SIZE;
        return;
      }
      case "solidFill":
        if (this.props) this.fill = true;
        return;
      case "srgbClr":
        if (this.fill) this.white = (a.val ?? "").toUpperCase() === "FFFFFF";
        return;
      case "t":
        this.inText = true;
        return;
      case "br":
        this.out.write("\n");
        return;
    }
  }

  close(name: string): void {
    switch (name) {
      case "fld":
        this.field--;
        return;
      case "rPr":
        this.props = false;
        return;
      case "solidFill":
        this.fill = false;
        return;
      case "t":
        this.inText = false;
        return;
      case "r":
        this.endRun();
        return;
      case "p":
        this.out.write("\n");
        return;
    }
  }

  text(t: string): void {
    if (this.inText && this.field === 0) {
      if (this.inRun) this.run.push(t);
      else this.out.write(t);
    }
  }

  private endRun(): void {
    this.inRun = false;
    const text = this.run.join("");
    this.run.length = 0;
    if (text === "") return;
    this.out.write(text);
    // Signals for a hidden slide's runs are still worth having: the slide is hidden anyway.
    if (this.white) this.context.signals.add("white-text", text);
    if (this.tiny) this.context.signals.add("tiny-text", text);
  }
}
