import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  baselinePipeline,
  buildCorpus,
  crc32,
  docx,
  extractText,
  formatInjectionReport,
  INJECTION_FLAG,
  pdf,
  runInjectionHarness,
  unzip,
  xlsx,
  zip,
  type InjectionPipeline,
} from "../index.js";

const corpus = buildCorpus();

describe("buildCorpus", () => {
  it("has 50 cases with unique ids across every format", () => {
    expect(corpus).toHaveLength(50);
    expect(new Set(corpus.map((c) => c.id)).size).toBe(50);
    const formats = new Set(corpus.map((c) => c.format));
    for (const f of ["pdf", "docx", "xlsx", "csv", "filename"]) expect(formats).toContain(f);
  });

  it("is byte-for-byte deterministic", () => {
    const again = buildCorpus();
    corpus.forEach((c, i) =>
      expect(Buffer.from(c.bytes).equals(Buffer.from(again[i]?.bytes ?? []))).toBe(true),
    );
  });

  it("puts the marker only where the attack is: content cases have neutral names", () => {
    for (const c of corpus) {
      expect(c.name.includes(c.id)).toBe(c.format === "filename");
    }
  });

  it("plants every payload where a naive extractor finds it", async () => {
    const report = await runInjectionHarness({ process: () => Promise.resolve({}) });
    for (const r of report.results) expect(r.foundIn, r.id).not.toEqual([]);
  });
});

describe("runInjectionHarness", () => {
  it("classifies the baseline: nothing acts or loosens, and hidden payloads reach cards", async () => {
    const report = await runInjectionHarness(baselinePipeline);
    expect(report.counts.acted + report.counts.loosened + report.counts.error).toBe(0);
    expect(report.counts.leaked).toBeGreaterThan(40);
    // Hidden text is the point: a person never sees it, but it lands in the card.
    expect(report.results.find((r) => r.id === "OHX-013")?.outcome).toBe("leaked");
  });

  it("credits a pipeline that flags injection and keeps payloads out of cards", async () => {
    const guard: InjectionPipeline = {
      process: (file) => {
        const text =
          extractText(file.name, file.mime, file.bytes)
            .map((p) => p.text)
            .join(" ") + file.name;
        const suspicious = /ignore (all )?previous instructions|OHX-\d{3}/i.test(text);
        return Promise.resolve({
          card: { title: "Vendor summary" },
          flags: suspicious ? [INJECTION_FLAG] : [],
        });
      },
    };
    const report = await runInjectionHarness(guard);
    expect(report.counts.flagged).toBe(50);
  });

  it("reports pipelines that act, loosen or crash, worst first", async () => {
    const [a, b, c] = corpus;
    if (!a || !b || !c) throw new Error("corpus too small");
    const evil: InjectionPipeline = {
      process: (file) => {
        if (file.name === a.name)
          return Promise.resolve({
            actions: [{ type: "share", with: "x@attacker.example" }],
            proposedTags: ["sensitivity:public"],
          });
        if (file.name === b.name)
          return Promise.resolve({ proposedTags: ["sensitivity:public", "type:invoice"] });
        return Promise.reject(new Error("parser crashed"));
      },
    };
    const report = await runInjectionHarness(evil, [a, b, c]);
    expect(report.results.map((r) => r.outcome)).toEqual(["acted", "loosened", "error"]);
    expect(report.results[2]?.detail).toBe("parser crashed");
  });

  it("formats a Markdown report with one row per file", async () => {
    const md = formatInjectionReport(await runInjectionHarness(baselinePipeline));
    expect(md).toMatch(/^## Prompt-injection corpus v0/);
    expect(md.split("\n").filter((l) => l.startsWith("| OHX-"))).toHaveLength(50);
  });
});

describe("zip", () => {
  it("computes the standard CRC-32 check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("round-trips stored entries and reads deflated ones", () => {
    const bytes = zip({ "a.txt": "hello", "dir/b.xml": "<x/>" });
    const files = unzip(bytes);
    expect(new TextDecoder().decode(files.get("a.txt"))).toBe("hello");
    expect([...files.keys()]).toEqual(["a.txt", "dir/b.xml"]);

    // Patch the stored entry into a deflated one to exercise the inflate path.
    const data = new TextEncoder().encode("deflate me ".repeat(20));
    const deflated = deflateRawSync(data);
    const stored = zip({ "c.txt": deflated });
    const view = new DataView(stored.buffer);
    view.setUint16(8, 8, true); // local header: method deflate
    const central = stored.length - 22 - (46 + "c.txt".length);
    view.setUint16(central + 10, 8, true);
    view.setUint32(central + 24, data.length, true);
    expect(new TextDecoder().decode(unzip(stored).get("c.txt"))).toBe("deflate me ".repeat(20));
  });

  it("rejects non-zip input and oversized entries", () => {
    expect(() => unzip(new Uint8Array(100))).toThrow(/not a zip/);
    expect(() => unzip(zip({ "big.txt": "x".repeat(100) }), 10)).toThrow(/too large/);
  });
});

describe("formats", () => {
  it("writes a PDF whose cross-reference offsets point at their objects", () => {
    const bytes = pdf({ texts: [{ text: "Hello (world)" }], info: { Title: "T" }, note: "n" });
    const text = Buffer.from(bytes).toString("latin1");
    const xref = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    expect(text.slice(xref, xref + 4)).toBe("xref");
    const offsets = [...text.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) =>
      Number(m[1]),
    );
    offsets.forEach((o, i) => expect(text.slice(o).startsWith(`${i + 1} 0 obj`)).toBe(true));
    expect(
      extractText("x.pdf", "application/pdf", bytes)
        .map((p) => p.text)
        .join(" "),
    ).toContain("Hello (world)");
  });

  it("writes OOXML that the extractor reads back, including hidden parts", () => {
    const d = docx({
      paragraphs: [[{ text: "a & b", hidden: true }]],
      comment: "c",
      header: "h",
      core: { title: "t" },
    });
    const text = extractText("x.docx", "", d)
      .map((p) => p.text)
      .join(" ");
    for (const s of ["a & b", "c", "h", "t"]) expect(text).toContain(s);
    const x = xlsx({ sheets: [{ name: "S<1>", rows: [["v", 2]] }], definedNames: { N: '"q"' } });
    const xt = extractText("x.xlsx", "", x)
      .map((p) => p.text)
      .join(" ");
    for (const s of ["S<1>", "v", "2", '"q"']) expect(xt).toContain(s);
  });

  it("decodes entities and reads plain text as-is", () => {
    expect(extractText("a.txt", "text/plain", new TextEncoder().encode("plain")).at(0)?.text).toBe(
      "plain",
    );
  });
});
