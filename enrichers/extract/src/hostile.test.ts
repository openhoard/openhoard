import { describe, expect, it } from "vitest";
import { ExtractError } from "./errors.ts";
import { resolveLimits } from "./limits.ts";
import { runExtraction } from "./run.ts";
import {
  chunked,
  docxWith,
  richDocx,
  richPdf,
  wordDocument,
  zipOf,
  type ZipEntry,
} from "./test.fixtures.ts";
import type { ExtractHint, ExtractLimits, PermanentFailure } from "./types.ts";

/*
 * Hostile and broken files, in-process: each must end in a typed failure (ExtractError with the
 * right code) within its limits, or in an extraction, never in anything else. The sandbox tests
 * run the resource-exhausting ones through the child process.
 */

const enc = new TextEncoder();
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MiB = 1024 * 1024;

async function failure(
  bytes: Uint8Array,
  hint: ExtractHint,
  limits: Partial<ExtractLimits> = {},
): Promise<PermanentFailure> {
  try {
    await runExtraction(chunked(bytes), hint, resolveLimits(limits));
  } catch (e) {
    expect(e).toBeInstanceOf(ExtractError);
    return (e as ExtractError).code;
  }
  throw new Error("extraction succeeded");
}

const run = (bytes: Uint8Array, hint: ExtractHint, limits: Partial<ExtractLimits> = {}) =>
  runExtraction(chunked(bytes), hint, resolveLimits(limits)).then((r) => r.extraction);

describe("Office archives", () => {
  it("refuses a part that claims too high a compression ratio (a zip bomb)", async () => {
    const bomb = wordDocument(`<w:p><w:r><w:t>${" ".repeat(20 * MiB)}</w:t></w:r></w:p>`);
    expect(await failure(docxWith(bomb), { mime: DOCX })).toBe("archive-limits");
  });

  it("refuses a part that inflates past the size it declared", async () => {
    const doc = wordDocument(`<w:p><w:r><w:t>${"x".repeat(10_000)}</w:t></w:r></w:p>`);
    const lying = zipOf([
      { name: "_rels/.rels", data: rootRels() },
      { name: "word/document.xml", data: doc, deflate: true, claimSize: 100 },
    ]);
    expect(await failure(lying, { mime: DOCX })).toBe("malformed");
  });

  it("refuses an archive that expands past the total limit", async () => {
    expect(await failure(richDocx(), { mime: DOCX }, { maxUncompressedBytes: 500 })).toBe(
      "archive-limits",
    );
  });

  it("refuses an archive with too many entries", async () => {
    const entries: ZipEntry[] = Array.from({ length: 60 }, (_, i) => ({
      name: `junk/${i}.xml`,
      data: "<a/>",
    }));
    expect(
      await failure(docxWith(wordDocument(""), entries), { mime: DOCX }, { maxEntries: 50 }),
    ).toBe("archive-limits");
  });

  it("refuses encrypted entries", async () => {
    const encrypted = zipOf([
      { name: "_rels/.rels", data: rootRels() },
      { name: "word/document.xml", data: wordDocument(""), deflate: true, encrypted: true },
    ]);
    expect(await failure(encrypted, { mime: DOCX })).toBe("encrypted");
  });

  it("refuses a DOCTYPE, so entity expansion (billion laughs) never starts", async () => {
    const laughs = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">',
      '<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]>',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&lol3;</w:t></w:r></w:p></w:body></w:document>',
    ].join("");
    expect(await failure(docxWith(laughs), { mime: DOCX })).toBe("xml-limits");
    const external = `<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><d>&x;</d>`;
    expect(await failure(docxWith(external), { mime: DOCX })).toBe("xml-limits");
  });

  it("refuses an undefined entity without expanding anything", async () => {
    const doc = wordDocument("<w:p><w:r><w:t>&lol;</w:t></w:r></w:p>");
    expect(await failure(docxWith(doc), { mime: DOCX })).toBe("malformed");
  });

  it("refuses XML nested deeper than the limit", async () => {
    const deep = wordDocument(`${"<w:p>".repeat(100_000)}${"</w:p>".repeat(100_000)}`);
    // Stored: deflated, its compression ratio alone would refuse it first.
    expect(await failure(docxWith(deep, [], false), { mime: DOCX })).toBe("xml-limits");
  });

  it("refuses malformed XML and broken archives", async () => {
    expect(await failure(docxWith(wordDocument("<w:p><w:r>")), { mime: DOCX })).toBe("malformed");
    expect(await failure(docxWith("<w:document"), { mime: DOCX })).toBe("malformed");
    const cut = richDocx().subarray(0, 900);
    expect(await failure(cut, { mime: DOCX })).toBe("malformed");
  });

  it("says unsupported for an archive that holds no Office document", async () => {
    const plain = zipOf([{ name: "readme.txt", data: "hello" }]);
    expect(await failure(plain, { mime: "application/zip", name: "a.docx" })).toBe("unsupported");
  });

  it("ignores relationships that leave the package, and reads parts whatever their prefix", async () => {
    const doc = wordDocument("<x:p><x:r><x:t>prefixed</x:t></x:r></x:p>", "x");
    const extraction = await run(docxWith(doc), { mime: DOCX });
    expect(extraction.text).toBe("prefixed");
  });

  it("stops at the text limit and says so", async () => {
    const paragraphs = Array.from(
      { length: 200 },
      (_, i) => `<w:p><w:r><w:t>paragraph ${i}</w:t></w:r></w:p>`,
    );
    const extraction = await run(
      docxWith(wordDocument(paragraphs.join(""))),
      { mime: DOCX },
      {
        maxTextBytes: 100,
      },
    );
    expect(extraction.truncated).toBe(true);
    expect(Buffer.byteLength(extraction.text)).toBeLessThanOrEqual(100);
    expect(extraction.text.startsWith("paragraph 0\nparagraph 1\n")).toBe(true);
  });
});

describe("PDF", () => {
  it("refuses a PDF that doesn't parse", async () => {
    expect(
      await failure(enc.encode("%PDF-1.7\n this is not a pdf"), { mime: "application/pdf" }),
    ).toBe("malformed");
  });

  it("refuses bytes declared as PDF that aren't one", async () => {
    expect(await failure(enc.encode("hello"), { mime: "application/pdf" })).toBe("malformed");
  });

  it("refuses a PDF over the input limit before parsing it", async () => {
    expect(await failure(richPdf(), { mime: "application/pdf" }, { maxInputBytes: 100 })).toBe(
      "too-large",
    );
  });

  it("reads what it can of a cut-off PDF, or fails typed", async () => {
    const whole = richPdf();
    try {
      const extraction = await run(whole.subarray(0, Math.floor(whole.byteLength * 0.8)), {
        mime: "application/pdf",
      });
      expect(extraction.kind).toBe("pdf");
    } catch (e) {
      expect(e).toBeInstanceOf(ExtractError);
    }
  });

  it("counts every page but reads text from at most maxPages", async () => {
    const extraction = await run(richPdf(), { mime: "application/pdf" }, { maxPages: 1 });
    expect(extraction.metadata.pages).toBe(1);
    expect(extraction.warnings).toEqual([]);
  });
});

describe("text and CSV", () => {
  it("refuses binary content declared as text", async () => {
    const garbage = new Uint8Array(4096).map((_, i) => (i * 7919) % 256);
    expect(await failure(garbage, { mime: "text/plain" })).toBe("binary");
    expect(await failure(garbage, { mime: "text/csv" })).toBe("binary");
    const controls = new Uint8Array(100).fill(1);
    expect(await failure(controls, { mime: "text/markdown" })).toBe("binary");
  });

  it("never guesses untyped bytes to be text", async () => {
    expect(await failure(enc.encode("plain words"), { mime: "application/octet-stream" })).toBe(
      "unsupported",
    );
  });

  it("refuses a CSV record over the limit (a file with no line breaks)", async () => {
    const line = enc.encode(`${"a,".repeat(50_000)}a`);
    expect(await failure(line, { mime: "text/csv" }, { maxRecordBytes: 1024 })).toBe(
      "record-too-large",
    );
  });

  it("stops reading plain text at the text limit", async () => {
    const big = enc.encode("word ".repeat(100_000));
    const { extraction, bytesRead } = await runExtraction(
      chunked(big, 1024),
      { mime: "text/plain" },
      resolveLimits({ maxTextBytes: 1000 }),
    );
    expect(extraction.truncated).toBe(true);
    expect(bytesRead).toBeLessThan(big.byteLength);
  });

  it("decodes UTF-16 with a byte order mark", async () => {
    const le = new Uint8Array([0xff, 0xfe, ...new Uint8Array(Buffer.from("hi there", "utf16le"))]);
    const extraction = await run(le, { mime: "text/plain" });
    expect(extraction.text).toBe("hi there");
    expect(extraction.metadata.encoding).toBe("utf-16le");
    const be = new Uint8Array([0xfe, 0xff, 0, 0x68, 0, 0x69]);
    expect((await run(be, { mime: "text/plain" })).text).toBe("hi");
  });

  it("keeps a limited CSV schema and counts every row", async () => {
    const wide = enc.encode(
      `${Array.from({ length: 10 }, (_, i) => `c${i}`).join(",")}\n1,2,3,4,5,6,7,8,9,10\n`,
    );
    const extraction = await run(wide, { mime: "text/csv" }, { maxColumns: 3 });
    expect(extraction.metadata.csv?.columns.map((c) => c.name)).toEqual(["c0", "c1", "c2"]);
    expect(extraction.metadata.csv?.rows).toBe(1);
    expect(extraction.warnings).toEqual(["columns-truncated"]);
  });

  it("treats a first row of values as data, and chooses the delimiter", async () => {
    const extraction = await run(enc.encode("1;2\n3;4\n"), { mime: "text/csv" });
    expect(extraction.metadata.csv).toEqual({
      delimiter: ";",
      header: false,
      columns: [
        { name: "column_1", type: "integer" },
        { name: "column_2", type: "integer" },
      ],
      rows: 2,
    });
  });

  it("reports a CSV with an unclosed quote as malformed", async () => {
    expect(await failure(enc.encode('a,b\n1,"never closed\n'), { mime: "text/csv" })).toBe(
      "malformed",
    );
  });
});

describe("what the bytes are, whatever the name says", () => {
  it("reads a PDF named .docx as a PDF, with a warning", async () => {
    const extraction = await run(richPdf(), { mime: DOCX, name: "report.docx" });
    expect(extraction.kind).toBe("pdf");
    expect(extraction.warnings).toEqual(["type-mismatch"]);
  });

  it("reads a Word file named .txt as Word, with a warning", async () => {
    const extraction = await run(richDocx(), { mime: "text/plain", name: "notes.txt" });
    expect(extraction.kind).toBe("docx");
    expect(extraction.warnings).toEqual(["type-mismatch"]);
  });

  it("reads an untyped PDF without a warning", async () => {
    const extraction = await run(richPdf(), { mime: "application/octet-stream" });
    expect(extraction.kind).toBe("pdf");
    expect(extraction.warnings).toEqual([]);
  });

  it("calls an OLE container declared as Office encrypted, and anything else in one unsupported", async () => {
    const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    expect(await failure(cfb, { mime: DOCX })).toBe("encrypted");
    expect(await failure(cfb, { mime: "application/octet-stream", name: "old.doc" })).toBe(
      "unsupported",
    );
  });

  it("handles empty content", async () => {
    expect((await run(new Uint8Array(), { mime: "text/plain" })).text).toBe("");
    expect(await failure(new Uint8Array(), { mime: "application/pdf" })).toBe("malformed");
  });
});

function rootRels(): string {
  return `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
}
