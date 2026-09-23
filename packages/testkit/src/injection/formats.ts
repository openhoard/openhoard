import { zip } from "./zip.js";

/*
 * Minimal, deterministic writers for the file formats in the injection corpus. Each produces a
 * valid file that Office/LibreOffice/PDF readers open, with a hook to hide text the way real
 * attacks do. Output bytes are stable across runs (no timestamps, no randomness).
 */

export const MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
} as const;

export const xml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] as string,
  );

// ── DOCX ─────────────────────────────────────────────────────────────────────────────────

/** A run of text in a DOCX paragraph, with the formatting tricks attackers use to hide it. */
export interface DocxRun {
  text: string;
  /** Hex colour, e.g. `FFFFFF` for white-on-white. */
  color?: string;
  /** Size in half-points (1 = 0.5 pt, unreadable). */
  size?: number;
  /** `w:vanish`: hidden text, invisible unless "show hidden text" is on. */
  hidden?: boolean;
}

export interface DocxOptions {
  paragraphs: DocxRun[][];
  /** Document properties (File → Info): title, subject, keywords, description. */
  core?: {
    title?: string;
    subject?: string;
    keywords?: string;
    description?: string;
    creator?: string;
  };
  /** A reviewer comment anchored to the first paragraph. */
  comment?: string;
  /** Header text on every page. */
  header?: string;
}

export function docx(options: DocxOptions): Uint8Array {
  const W =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const run = (r: DocxRun) => {
    const props = [
      r.color ? `<w:color w:val="${r.color}"/>` : "",
      r.size ? `<w:sz w:val="${r.size}"/><w:szCs w:val="${r.size}"/>` : "",
      r.hidden ? "<w:vanish/>" : "",
    ].join("");
    return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${xml(r.text)}</w:t></w:r>`;
  };
  const paragraphs = options.paragraphs.map((p, i) => {
    const anchored = i === 0 && options.comment;
    const body = p.map(run).join("");
    return anchored
      ? `<w:p><w:commentRangeStart w:id="0"/>${body}<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>`
      : `<w:p>${body}</w:p>`;
  });
  const sect = options.header
    ? `<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/></w:sectPr>`
    : "";
  const files: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${options.comment ? '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>' : ""}${options.header ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ""}${options.core ? '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' : ""}</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>${options.core ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' : ""}</Relationships>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${options.comment ? '<Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>' : ""}${options.header ? '<Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' : ""}</Relationships>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>${paragraphs.join("")}${sect}</w:body></w:document>`,
  };
  if (options.comment) {
    files["word/comments.xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments ${W}><w:comment w:id="0" w:author="Reviewer" w:initials="R"><w:p><w:r><w:t xml:space="preserve">${xml(options.comment)}</w:t></w:r></w:p></w:comment></w:comments>`;
  }
  if (options.header) {
    files["word/header1.xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${W}><w:p><w:r><w:t xml:space="preserve">${xml(options.header)}</w:t></w:r></w:p></w:hdr>`;
  }
  if (options.core) files["docProps/core.xml"] = coreProps(options.core);
  return zip(files);
}

function coreProps(core: NonNullable<DocxOptions["core"]>): string {
  const el = (tag: string, value: string | undefined) =>
    value === undefined ? "" : `<${tag}>${xml(value)}</${tag}>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">${el("dc:title", core.title)}${el("dc:subject", core.subject)}${el("cp:keywords", core.keywords)}${el("dc:description", core.description)}${el("dc:creator", core.creator)}</cp:coreProperties>`;
}

// ── XLSX ─────────────────────────────────────────────────────────────────────────────────

export interface XlsxSheet {
  name: string;
  rows: (string | number)[][];
  /** `hidden` shows up under Unhide; `veryHidden` only through the VBA editor. */
  state?: "visible" | "hidden" | "veryHidden";
  /** Formulas by cell reference, e.g. `{ C2: 'HYPERLINK("https://…","open")' }`. */
  formulas?: Record<string, string>;
}

export interface XlsxOptions {
  sheets: XlsxSheet[];
  core?: DocxOptions["core"];
  /** Workbook-level defined names (Name Manager), e.g. `{ Notes: '"…"' }`. */
  definedNames?: Record<string, string>;
}

export function xlsx(options: XlsxOptions): Uint8Array {
  const col = (i: number) => {
    let s = "";
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26))
      s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  };
  const sheetXml = (sheet: XlsxSheet) => {
    const rows = sheet.rows.map((row, r) => {
      const cells = row.map((v, c) => {
        const ref = `${col(c)}${r + 1}`;
        const formula = sheet.formulas?.[ref];
        if (formula !== undefined) return `<c r="${ref}"><f>${xml(formula)}</f></c>`;
        return typeof v === "number"
          ? `<c r="${ref}"><v>${v}</v></c>`
          : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
      });
      return `<row r="${r + 1}">${cells.join("")}</row>`;
    });
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join("")}</sheetData></worksheet>`;
  };
  const files: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${options.sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}${options.core ? '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' : ""}</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>${options.core ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' : ""}</Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${options.sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}"${s.state && s.state !== "visible" ? ` state="${s.state}"` : ""} r:id="rId${i + 1}"/>`).join("")}</sheets>${
      options.definedNames
        ? `<definedNames>${Object.entries(options.definedNames)
            .map(([n, v]) => `<definedName name="${xml(n)}">${xml(v)}</definedName>`)
            .join("")}</definedNames>`
        : ""
    }</workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${options.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`,
  };
  options.sheets.forEach((s, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s)));
  if (options.core) files["docProps/core.xml"] = coreProps(options.core);
  return zip(files);
}

// ── PDF ──────────────────────────────────────────────────────────────────────────────────

/** A text object on the page. The fields map to PDF operators used to hide text. */
export interface PdfText {
  text: string;
  x?: number;
  y?: number;
  /** Font size in points (0.5 is unreadable). */
  size?: number;
  /** RGB 0–1; `[1, 1, 1]` is white on white. */
  color?: [number, number, number];
  /** Text render mode 3 draws nothing but is still extracted. */
  invisible?: boolean;
}

export interface PdfOptions {
  texts: PdfText[];
  /** Document information dictionary. */
  info?: { Title?: string; Subject?: string; Keywords?: string; Author?: string };
  /** A sticky-note annotation (/Annot /Text) with this content. */
  note?: string;
  /** Draw a white rectangle over this area after the text (text hidden under a shape). */
  cover?: [number, number, number, number];
}

/** A one-page PDF 1.4 with uncompressed streams and a correct cross-reference table. */
export function pdf(options: PdfOptions): Uint8Array {
  const str = (s: string) =>
    `(${s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, "?")})`;
  const ops = options.texts.map((t) => {
    const [r, g, b] = t.color ?? [0, 0, 0];
    return `BT /F1 ${t.size ?? 12} Tf ${t.invisible ? "3 Tr " : ""}${r} ${g} ${b} rg ${t.x ?? 72} ${t.y ?? 720} Td ${str(t.text)} Tj ET`;
  });
  if (options.cover) ops.push(`q 1 1 1 rg ${options.cover.join(" ")} re f Q`);
  const content = ops.join("\n");
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R${options.note ? " /Annots [6 0 R]" : ""} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];
  if (options.note)
    objects.push(
      `<< /Type /Annot /Subtype /Text /Rect [72 72 92 92] /Contents ${str(options.note)} >>`,
    );
  let infoRef = "";
  if (options.info) {
    const entries = Object.entries(options.info).map(([k, v]) => `/${k} ${str(v)}`);
    objects.push(`<< ${entries.join(" ")} >>`);
    infoRef = ` /Info ${objects.length} 0 R`;
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${infoRef} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}
