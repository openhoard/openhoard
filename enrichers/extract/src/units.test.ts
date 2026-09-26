import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { chooseDelimiter, valueType } from "./csv.ts";
import { declaredKind, mayExtract, sniff } from "./detect.ts";
import { failureOf, ExtractError } from "./errors.ts";
import { DEFAULT_LIMITS, resolveLimits } from "./limits.ts";
import { isRefusedBuiltin } from "./lockdown.ts";
import { resolveTarget } from "./ooxml.ts";
import { CommentStripper } from "./plain.ts";
import { maxAnswerBytes, parseAnswer } from "./schema.ts";
import { Sanitizer, sampleOf, Signals, TextSink, utf8Prefix } from "./text.ts";

const cp = (n: number) => String.fromCodePoint(n);

describe("the sanitizer", () => {
  it("keeps tabs and newlines, turns other line breaks into newlines, drops controls", () => {
    const s = new Sanitizer();
    expect(s.clean(`a\tb\r\nc\rd\ve\ff${cp(0)}g${cp(0x1b)}h${cp(0x7f)}i${cp(0x9f)}j`)).toBe(
      "a\tb\nc\nd\ne\nfghij",
    );
  });

  it("joins a CR and an LF split between pieces", () => {
    const s = new Sanitizer();
    expect(s.clean("a\r") + s.clean("\nb")).toBe("a\nb");
  });

  it("removes and counts invisible characters, keeping the joiners scripts need", () => {
    const s = new Sanitizer();
    const hidden = [0x200b, 0x202e, 0x2066, 0x2060, 0xfeff, 0xad, 0x3164, 0xe0041, 0xe0100];
    const kept = [0x200c, 0x200d, 0x200e, 0x200f, 0xfe0f];
    const text = [...hidden, ...kept].map(cp).join("x");
    expect(s.clean(text)).toBe(`${"x".repeat(hidden.length)}${kept.map(cp).join("x")}`);
    expect(s.invisible).toBe(hidden.length);
  });

  it("makes lone surrogates well formed", () => {
    expect(new Sanitizer().clean(`a${String.fromCharCode(0xd800)}b`)).toBe(`a${cp(0xfffd)}b`);
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (s) => {
        const once = new Sanitizer().clean(s);
        expect(new Sanitizer().clean(once)).toBe(once);
      }),
    );
  });
});

describe("the text sink", () => {
  it("cuts at a character boundary and marks the text truncated", () => {
    const sink = new TextSink(5);
    expect(sink.write("ab")).toBe(true);
    expect(sink.write(`c${cp(0x1f600)}d`)).toBe(false);
    expect(sink.text()).toBe("abc");
    expect(sink.truncated).toBe(true);
    expect(sink.write("more")).toBe(false);
  });

  it("isn't truncated by whitespace-free nothing after it is exactly full", () => {
    const sink = new TextSink(3);
    sink.write("abc");
    sink.write("");
    sink.write(cp(0x200b));
    expect(sink.truncated).toBe(false);
  });

  it("collapses blank lines and trims", () => {
    const sink = new TextSink(100);
    sink.write("\n a\n\n\n \t\nb\n \nc  \n");
    expect(sink.text()).toBe("a\n\nb\n\nc");
  });

  it("never exceeds its byte limit", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ unit: "grapheme" })),
        fc.integer({ min: 0, max: 64 }),
        (pieces, max) => {
          const sink = new TextSink(max);
          for (const p of pieces) sink.write(p);
          expect(Buffer.byteLength(sink.text())).toBeLessThanOrEqual(max);
        },
      ),
    );
  });

  it("finds UTF-8 prefixes", () => {
    expect(utf8Prefix(`a${cp(0xe9)}${cp(0x1f600)}`, 2)).toBe("a");
    expect(utf8Prefix(`a${cp(0xe9)}${cp(0x1f600)}`, 3)).toBe(`a${cp(0xe9)}`);
    expect(utf8Prefix(`a${cp(0xe9)}${cp(0x1f600)}`, 7)).toBe(`a${cp(0xe9)}${cp(0x1f600)}`);
  });
});

describe("signals and samples", () => {
  it("counts per kind, keeps the first non-empty sample, and lists in a fixed order", () => {
    const s = new Signals();
    s.add("white-text", "   ");
    s.add("hidden-text", "first");
    s.add("white-text", "later sample");
    s.add("hidden-text", "second");
    s.add("comment", undefined, 0);
    expect(s.list()).toEqual([
      { kind: "hidden-text", count: 2, sample: "first" },
      { kind: "white-text", count: 2, sample: "later sample" },
    ]);
  });

  it("shortens and flattens samples", () => {
    expect(sampleOf(`  a\n\tb${cp(0x202e)}c  `)).toBe("a bc");
    expect(sampleOf("x".repeat(500))).toHaveLength(200);
    expect(sampleOf("abc", 2)).toBe("ab");
  });
});

describe("HTML comments in Markdown", () => {
  const strip = (pieces: string[]) => {
    const c = new CommentStripper();
    return {
      text: pieces.map((p) => c.visible(p)).join("") + c.end(),
      count: c.count,
      sample: c.sample,
    };
  };

  it("strips comments whatever way the text is cut", () => {
    const text = "a<!-- one -->b<!---->c<!-- two --->d<!-- open";
    fc.assert(
      fc.property(fc.array(fc.nat({ max: text.length }), { maxLength: 8 }), (cuts) => {
        const points = [...new Set(cuts)].sort((x, y) => x - y);
        const pieces = [0, ...points].map((from, i) => text.slice(from, points[i] ?? text.length));
        expect(strip(pieces)).toEqual({ text: "abcd", count: 4, sample: " one " });
      }),
    );
  });

  it("keeps a lone marker start at the end as text", () => {
    expect(strip(["a <!", "-"]).text).toBe("a <!-");
  });
});

describe("types, names and targets", () => {
  it("knows types by media type, then by extension", () => {
    expect(declaredKind({ mime: "text/csv; charset=utf-8" })).toBe("csv");
    expect(declaredKind({ mime: "application/octet-stream", name: "C:\\docs\\Report.DOCX" })).toBe(
      "docx",
    );
    expect(declaredKind({ mime: "application/octet-stream", name: ".profile" })).toBe(null);
    expect(declaredKind({ mime: "image/png", name: "x.png" })).toBe(null);
    expect(mayExtract({ mime: "application/octet-stream" })).toBe(true);
    expect(mayExtract({ mime: "video/mp4", name: "a.mp4" })).toBe(false);
  });

  it("sniffs PDFs anywhere in the first KiB, ZIPs and OLE files at the start", () => {
    const enc = new TextEncoder();
    expect(sniff(enc.encode("junk %PDF-1.7"))).toBe("pdf");
    expect(sniff(enc.encode("PK\x03\x04"))).toBe("zip");
    expect(sniff(enc.encode("PK"))).toBe(null);
    expect(sniff(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe("cfb");
  });

  it("resolves relationship targets inside the package only", () => {
    expect(resolveTarget("word/", "header1.xml")).toBe("word/header1.xml");
    expect(resolveTarget("ppt/slides/", "../notesSlides/n%201.xml")).toBe(
      "ppt/notesslides/n 1.xml",
    );
    expect(resolveTarget("word/", "/word/./Footer.xml")).toBe("word/footer.xml");
    expect(resolveTarget("word/", "../../etc/passwd")).toBe(null);
    expect(resolveTarget("", "%zz.xml")).toBe("%zz.xml");
    expect(resolveTarget("word/", "..")).toBe(null);
  });

  it("guesses CSV value types with character checks", () => {
    const cases: [string, string][] = [
      ["42", "integer"],
      ["-7", "integer"],
      ["3.5", "number"],
      [".5", "number"],
      ["1e-3", "number"],
      ["1e", "string"],
      ["+", "string"],
      ["TRUE", "boolean"],
      ["2026-02-29", "string"],
      ["2024-02-29", "date"],
      ["2024-02-29T10:00", "datetime"],
      ["2024-02-29 10:00:00+02:00", "datetime"],
      ["2024-02-29T1:00", "string"],
      ["2024-02-29Tzz", "string"],
      ["1".repeat(80), "string"],
    ];
    for (const [value, type] of cases) expect(valueType(value), value).toBe(type);
  });

  it("chooses the delimiter by consistency, with ties to the comma", () => {
    expect(chooseDelimiter("a|b|c\n1|2|3\n")).toBe("|");
    expect(chooseDelimiter('"a;b",c\n"1;2",3\n')).toBe(",");
    expect(chooseDelimiter("single")).toBe(",");
    expect(chooseDelimiter("a\tb\n")).toBe("\t");
  });

  it("refuses every built-in but the allowlist, by any name", () => {
    for (const m of ["net", "node:net", "https", "node:dns/promises", "child_process", "vm"]) {
      expect(isRefusedBuiltin(m), m).toBe(true);
    }
    for (const m of ["_http_client", "_tls_wrap", "node:sqlite", "module", "repl", "wasi", "v8"]) {
      expect(isRefusedBuiltin(m), m).toBe(true);
    }
    for (const m of ["fs", "node:zlib", "stream", "node:stream/promises", "netmask", "./x.js"]) {
      expect(isRefusedBuiltin(m), m).toBe(false);
    }
  });

  it("maps errors to failures", () => {
    expect(failureOf(new ExtractError("encrypted"))).toBe("encrypted");
    expect(failureOf(new RangeError("Maximum call stack size exceeded"))).toBe("malformed");
    expect(failureOf(new RangeError("Array buffer allocation failed"))).toBe("memory-limit");
  });
});

describe("limits", () => {
  it("grows the default time with the size, up to ten minutes", () => {
    expect(resolveLimits().timeoutMs).toBe(DEFAULT_LIMITS.timeoutMs);
    expect(resolveLimits({}, 1024 * 1024 * 1024).timeoutMs).toBe(30_000 + 102_400);
    expect(resolveLimits({}, 1e12).timeoutMs).toBe(600_000);
    expect(resolveLimits({ timeoutMs: 5_000 }, 1e12).timeoutMs).toBe(5_000);
  });

  it("refuses unknown limits, values out of range and a heap as large as the memory", () => {
    expect(() => resolveLimits({ nope: 1 } as never)).toThrow(TypeError);
    expect(() => resolveLimits({ maxTextBytes: 5 * 1024 * 1024 })).toThrow(RangeError);
    expect(() => resolveLimits({ timeoutMs: 1.5 })).toThrow(RangeError);
    expect(() => resolveLimits({ heapMb: 800 })).toThrow(RangeError);
    expect(resolveLimits({ timeoutMs: undefined } as never).timeoutMs).toBe(30_000);
  });
});

describe("the child's answer", () => {
  const limits = resolveLimits({ maxTextBytes: 20, maxColumns: 2 });
  const stats = { bytesRead: 1, peakRssBytes: 2 };
  const good = {
    kind: "csv",
    text: "a\tb\n1\t2",
    truncated: false,
    metadata: {
      title: "T",
      author: "A",
      pages: 1,
      slides: 0,
      encoding: "utf-8",
      sheets: [{ name: "S", state: "hidden" }],
      csv: { delimiter: ",", header: true, columns: [{ name: "a", type: "integer" }], rows: 1 },
    },
    signals: [{ kind: "formula", count: 1, sample: "=1" }],
    warnings: ["type-mismatch"],
  };
  const answer = (extraction: unknown, extra = {}) =>
    JSON.stringify({ v: 1, ok: true, extraction, stats, ...extra });

  it("takes a well-formed answer", () => {
    expect(parseAnswer(answer(good), limits)).toEqual({ ok: true, extraction: good, stats });
  });

  it.each([
    ["an unknown top-level key", answer(good, { debug: 1 })],
    ["another version", JSON.stringify({ v: 2, ok: true, extraction: good, stats })],
    [
      "both answer kinds",
      JSON.stringify({ v: 1, ok: true, extraction: good, failure: "malformed", stats }),
    ],
    ["too much text", answer({ ...good, text: "x".repeat(21) })],
    ["unclean text", answer({ ...good, text: `a${cp(0)}` })],
    ["an unknown kind", answer({ ...good, kind: "exe" })],
    ["a negative count", answer({ ...good, signals: [{ kind: "formula", count: -1 }] })],
    ["a zero count", answer({ ...good, signals: [{ kind: "formula", count: 0 }] })],
    [
      "a repeated signal",
      answer({
        ...good,
        signals: [
          { kind: "formula", count: 1 },
          { kind: "formula", count: 2 },
        ],
      }),
    ],
    [
      "a sample with a newline",
      answer({ ...good, signals: [{ kind: "formula", count: 1, sample: "a\nb" }] }),
    ],
    [
      "a long sample",
      answer({ ...good, signals: [{ kind: "formula", count: 1, sample: "x".repeat(201) }] }),
    ],
    ["an unknown warning", answer({ ...good, warnings: ["hmm"] })],
    ["a repeated warning", answer({ ...good, warnings: ["type-mismatch", "type-mismatch"] })],
    ["an unknown metadata key", answer({ ...good, metadata: { owner: "x" } })],
    [
      "too many columns",
      answer({
        ...good,
        metadata: {
          csv: {
            ...good.metadata.csv,
            columns: [1, 2, 3].map((i) => ({ name: `c${i}`, type: "empty" })),
          },
        },
      }),
    ],
    [
      "a bad delimiter",
      answer({ ...good, metadata: { csv: { ...good.metadata.csv, delimiter: "x" } } }),
    ],
    ["a fractional page count", answer({ ...good, metadata: { pages: 1.5 } })],
    ["an array for metadata", answer({ ...good, metadata: [] })],
    ["a transient failure", JSON.stringify({ v: 1, ok: false, failure: "input-failed", stats })],
    ["no stats", JSON.stringify({ v: 1, ok: false, failure: "malformed" })],
    ["not JSON", "{"],
  ])("refuses %s", (_, line) => {
    expect(parseAnswer(line, limits)).toBe(null);
  });

  it("bounds the answer's size by the limits", () => {
    expect(maxAnswerBytes(DEFAULT_LIMITS)).toBeGreaterThan(2 * DEFAULT_LIMITS.maxTextBytes);
  });
});
