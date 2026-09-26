import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveLimits } from "./limits.ts";
import { readablePaths } from "./paths.ts";
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

  it("never answers for content shorter or longer than its size", async () => {
    const bytes = enc.encode("a,b\n1,2\n3,4\n");
    const short = await extract(chunked(bytes), { mime: "text/csv" }, { size: bytes.length + 5 });
    const long = await extract(chunked(bytes, 4), { mime: "text/csv" }, { size: 6 });
    const exact = await extract(chunked(bytes), { mime: "text/csv" }, { size: bytes.length });
    expect(short).toEqual({ ok: false, failure: "input-failed", permanent: false });
    expect(long).toEqual({ ok: false, failure: "input-failed", permanent: false });
    expect(exact.ok && exact.extraction.metadata.csv?.rows).toBe(2);
  });

  it("destroys a stalled stream when time runs out", async () => {
    const stalled = new Readable({ read() {} });
    stalled.push(enc.encode("a,b\n"));
    const result = await extract(stalled, { mime: "text/csv" }, { limits: { timeoutMs: 1_000 } });
    expect(result).toEqual({ ok: false, failure: "input-failed", permanent: false });
    expect(stalled.destroyed).toBe(true);
  });

  it("reads a source to its end after an early answer, so its checks still decide", async () => {
    const MiB = 1024 * 1024;
    const chunk = enc.encode("word ".repeat(MiB / 5));
    async function* text(fail: "hash" | "stall" | null): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < 64; i++) yield chunk;
      // What blobContentSource() throws at the end of bytes that aren't the version's.
      if (fail === "hash")
        throw new Error("the stored bytes don't match the version's blob (hash)");
      if (fail === "stall") await new Promise(() => {});
    }
    const size = 64 * chunk.byteLength;
    const hint = { mime: "text/plain" };
    // Plain text stops at 1 MiB of text: the child answers long before the 64 MiB end.
    const wrong = await extract(text("hash"), hint, { size });
    expect(wrong).toEqual({ ok: false, failure: "input-failed", permanent: false });
    const stalled = await extract(text("stall"), hint, { size, limits: { timeoutMs: 3_000 } });
    expect(stalled).toEqual({ ok: false, failure: "input-failed", permanent: false });
    const fine = await extract(text(null), hint, { size });
    expect(fine.ok && fine.extraction.truncated).toBe(true);
    expect(fine.ok && fine.stats.bytesRead).toBeLessThan(size);
  });

  it("closes a stream the child stopped reading early", async () => {
    const big = Readable.from(generatedCsv(1_000_000));
    // Plain text stops at the text limit; the rest of the stream is never read.
    const result = await extract(big, { mime: "text/plain" }, { limits: { maxTextBytes: 1000 } });
    expect(result.ok && result.extraction.truncated).toBe(true);
    expect(big.destroyed).toBe(true);
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

/**
 * The variables libuv puts in every Windows child's environment, from the parent's when the
 * environment given lacks them (uv_spawn's required variables).
 */
const WINDOWS_REQUIRED_ENV = [
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "PATH",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
];

describe("the child's confinement", () => {
  const dir = mkdtempSync(join(tmpdir(), "openhoard-extract-"));
  const secret = join(dir, "secret.txt");
  writeFileSync(secret, "do not read");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("can't read outside its code, write, load refused built-ins, bind, open the network or eval", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const probe = join(here, "probe-child.fixtures.ts");
    // A variable of the server's (a secret, say) that must not reach the child.
    process.env.OPENHOARD_TEST_PARENT_SECRET = "hunter2";
    const child = spawn(process.execPath, childArguments(resolveLimits(), probe), {
      env: childEnvironment({
        PROBE_SECRET: secret,
        // A workspace package linked into this package's node_modules, and a file beside src/.
        PROBE_SIBLING: join(here, "..", "node_modules", "@openhoard", "testkit", "package.json"),
        PROBE_PACKAGE_FILE: join(here, "..", "tsconfig.json"),
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    await new Promise((resolve) => child.on("close", resolve));
    delete process.env.OPENHOARD_TEST_PARENT_SECRET;
    const outcome = JSON.parse(out) as Record<string, string>;
    // Only the probe's own variables, and what the platform adds to every process it starts:
    // macOS, CoreFoundation's text encoding; Windows, libuv's required system variables
    // (copied from the parent when missing; names, paths and the user, no application secrets).
    const envKeys = (outcome["env-keys"] ?? "").split(",").filter((k) => k !== "");
    delete outcome["env-keys"];
    const platformKeys: Record<string, readonly string[]> = {
      darwin: ["__CF_USER_TEXT_ENCODING"],
      win32: WINDOWS_REQUIRED_ENV,
    };
    const allowed = new Set(
      [
        "PROBE_SECRET",
        "PROBE_SIBLING",
        "PROBE_PACKAGE_FILE",
        ...(platformKeys[process.platform] ?? []),
      ].map((k) => k.toUpperCase()),
    );
    expect(envKeys.filter((k) => !allowed.has(k.toUpperCase()))).toEqual([]);
    expect(envKeys).toContain("PROBE_SECRET");
    const cjsRefused = [
      "cjs-require-vm",
      "cjs-require-http-client",
      "cjs-require-net",
      "cjs-load-vm",
      "cjs-load-tls-wrap",
    ];
    const refused = Object.entries(outcome).filter(
      ([k]) => /^(import|require|builtin):/.test(k) || cjsRefused.includes(k),
    );
    expect(refused).toHaveLength(21 * 3 + cjsRefused.length);
    for (const [name, result] of refused) expect(result, name).toBe("BlockedModuleError");
    expect(outcome).toMatchObject({
      "read-outside": "ERR_ACCESS_DENIED",
      "read-sibling-package": "ERR_ACCESS_DENIED",
      "read-package-root": "ERR_ACCESS_DENIED",
      write: "ERR_ACCESS_DENIED",
      "allowed:zlib": "allowed",
      "allowed:require-stream": "allowed",
      fetch: "TypeError",
      binding: "BlockedModuleError",
      "linked-binding": "BlockedModuleError",
      dlopen: "BlockedModuleError",
      eval: "EvalError",
      "cjs-register-hooks": "BlockedModuleError",
      "cjs-register": "BlockedModuleError",
      "cjs-require-fs": "allowed",
      "import-data-url": "BlockedModuleError",
      wasm: "TypeError",
    });
    expect(outcome["import-http-url"]).not.toBe("allowed");
    expect(existsSync(`${secret}.written`)).toBe(false);
  });

  it("may read only its code, its package.json and its libraries' folders", () => {
    const paths = readablePaths();
    const here = dirname(fileURLToPath(import.meta.url));
    expect(paths).toContain(realpathSync(here));
    expect(paths).toContain(realpathSync(join(here, "..", "package.json")));
    expect(paths).not.toContain(realpathSync(join(here, "..")));
    for (const path of paths) {
      expect(path.endsWith("node_modules"), path).toBe(false);
      expect(path.includes(`${sep}@openhoard${sep}`), path).toBe(false);
    }
    expect(paths).not.toContain(tmpdir());
  });
});
