import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveLimits } from "./limits.ts";
import { readableFolders } from "./paths.ts";
import { childArguments, childEnvironment, extract } from "./sandbox.ts";
import {
  chunked,
  docxWith,
  generatedCsv,
  richDocx,
  richPdf,
  wordDocument,
} from "./test.fixtures.ts";

/*
 * The sandbox as a whole: real child processes, hostile input, and the limits enforced from
 * outside. Every test ends with the parent healthy, and the last one checks the worker still
 * extracts normally after all of them.
 */

const enc = new TextEncoder();
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** A source that records whether it was read and whether it was closed. */
function tracked(source: AsyncIterable<Uint8Array>) {
  const state = { started: false, closed: false };
  async function* iterate(): AsyncGenerator<Uint8Array> {
    state.started = true;
    try {
      yield* source;
    } finally {
      state.closed = true;
    }
  }
  return { state, source: iterate() };
}

describe("extract() in a child process", () => {
  it("kills a child that runs past its time, and closes the source", async () => {
    const { state, source } = tracked(generatedCsv(50_000_000));
    const started = Date.now();
    const result = await extract(source, { mime: "text/csv" }, { limits: { timeoutMs: 1_500 } });
    expect(result).toEqual({ ok: false, failure: "timeout", permanent: true });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(state.closed).toBe(true);
  });

  it("stops a child over its memory limit", async () => {
    const result = await extract(
      chunked(richPdf()),
      { mime: "application/pdf" },
      {
        limits: { memoryMb: 48, heapMb: 24 },
      },
    );
    expect(result).toMatchObject({ ok: false, failure: "memory-limit", permanent: true });
  });

  it("refuses a huge single-line CSV at the record limit, streaming", async () => {
    async function* oneLine(): AsyncGenerator<Uint8Array> {
      const chunk = enc.encode("a,".repeat(32 * 1024));
      for (let i = 0; i < 128; i++) yield chunk; // 8 MiB, no line break
    }
    const result = await extract(oneLine(), { mime: "text/csv" });
    expect(result).toMatchObject({ ok: false, failure: "record-too-large", permanent: true });
  });

  it("refuses a zip bomb and deeply nested XML", async () => {
    const bomb = docxWith(
      wordDocument(`<w:p><w:r><w:t>${" ".repeat(50 * 1024 * 1024)}</w:t></w:r></w:p>`),
    );
    const deep = docxWith(
      wordDocument(`${"<w:p>".repeat(200_000)}${"</w:p>".repeat(200_000)}`),
      [],
      false,
    );
    const [a, b] = await Promise.all([
      extract(chunked(bomb), { mime: DOCX }),
      extract(chunked(deep), { mime: DOCX }),
    ]);
    expect(a).toMatchObject({ ok: false, failure: "archive-limits", permanent: true });
    expect(b).toMatchObject({ ok: false, failure: "xml-limits", permanent: true });
  });

  it("answers binary garbage with a typed failure", async () => {
    const garbage = new Uint8Array(1024 * 1024).map((_, i) => (i * 2654435761) % 251);
    const results = await Promise.all([
      extract(chunked(garbage), { mime: "text/plain" }),
      extract(chunked(garbage), { mime: "application/pdf" }),
      extract(chunked(garbage), { mime: DOCX }),
      extract(chunked(garbage), { mime: "application/octet-stream" }),
    ]);
    expect(results.map((r) => (r.ok ? "ok" : r.failure))).toEqual([
      "binary",
      "malformed",
      "malformed",
      "unsupported",
    ]);
  });

  it("gives up with input-failed, retryable, when the source fails part way", async () => {
    async function* failing(): AsyncGenerator<Uint8Array> {
      yield enc.encode("a,b\n1,2\n");
      throw new Error("connection reset by the store");
    }
    const result = await extract(failing(), { mime: "text/csv" });
    expect(result).toEqual({ ok: false, failure: "input-failed", permanent: false });
  });

  it("blames a source that stalls, not the file, when time runs out", async () => {
    async function* stalling(): AsyncGenerator<Uint8Array> {
      yield enc.encode("a,b\n");
      await new Promise(() => {});
    }
    const result = await extract(
      stalling(),
      { mime: "text/csv" },
      { limits: { timeoutMs: 1_000 } },
    );
    expect(result).toEqual({ ok: false, failure: "input-failed", permanent: false });
  });

  it("rejects with the signal's reason when aborted, killing the child", async () => {
    const controller = new AbortController();
    const { state, source } = tracked(generatedCsv(50_000_000));
    setTimeout(() => controller.abort(new Error("worker stopping")), 500);
    await expect(
      extract(source, { mime: "text/csv" }, { signal: controller.signal }),
    ).rejects.toThrow("worker stopping");
    expect(state.closed).toBe(true);
    await expect(
      extract(chunked(richPdf()), { mime: "application/pdf" }, { signal: controller.signal }),
    ).rejects.toThrow("worker stopping");
  });

  it("answers unsupported types without a process or a byte read", async () => {
    const { state, source } = tracked(chunked(richPdf()));
    const result = await extract(source, { mime: "image/png", name: "photo.png" });
    expect(result).toEqual({ ok: false, failure: "unsupported", permanent: true });
    expect(state.started).toBe(false);
  });

  it("refuses limits out of range before starting anything", async () => {
    await expect(
      extract(chunked(richPdf()), { mime: "application/pdf" }, { limits: { memoryMb: 1 } }),
    ).rejects.toThrow(RangeError);
  });

  it("keeps working afterwards, several at a time", async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => extract(chunked(richDocx()), { mime: DOCX })),
    );
    for (const r of results)
      expect(r.ok && r.extraction.text.startsWith("Quarterly report")).toBe(true);
  });
});

describe("the child's confinement", () => {
  const dir = mkdtempSync(join(tmpdir(), "openhoard-extract-"));
  const secret = join(dir, "secret.txt");
  writeFileSync(secret, "do not read");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("can't read or write outside its code, open the network, start processes or eval", async () => {
    const probe = join(dirname(fileURLToPath(import.meta.url)), "probe-child.fixtures.ts");
    const child = spawn(process.execPath, childArguments(resolveLimits(), probe), {
      env: childEnvironment({ PROBE_SECRET: secret }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    await new Promise((resolve) => child.on("close", resolve));
    expect(JSON.parse(out)).toEqual({
      "read-outside": "ERR_ACCESS_DENIED",
      write: "ERR_ACCESS_DENIED",
      "import-net": "BlockedModuleError",
      "import-http": "BlockedModuleError",
      "import-dns": "BlockedModuleError",
      "builtin-tls": "BlockedModuleError",
      "child-process": "BlockedModuleError",
      worker: "BlockedModuleError",
      fetch: "TypeError",
      binding: "ERR_ACCESS_DENIED",
      eval: "EvalError",
      env: "allowed",
    });
    expect(existsSync(`${secret}.written`)).toBe(false);
  });

  it("may read only its own package and its libraries' folders", () => {
    const folders = readableFolders();
    expect(folders.length).toBeGreaterThanOrEqual(2);
    for (const folder of folders) {
      expect(folder.endsWith("node_modules") || existsSync(join(folder, "package.json"))).toBe(
        true,
      );
    }
    expect(folders).not.toContain(tmpdir());
  });
});
