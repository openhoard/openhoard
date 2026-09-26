import {
  ingest,
  readExtract,
  type ContentRef,
  type ContentSource,
  type IngestResult,
} from "@openhoard/core-catalog";
import { newId, versionExtracts, versions, zones, type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import {
  EXTRACTOR_VERSION,
  type extract,
  type ExtractLimits,
  type ExtractResult,
} from "@openhoard/enricher-extract";
import { docx, MIME } from "@openhoard/testkit";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultEnrichSteps, enrichVersion, ruleTagStep, type EnrichStep } from "./enrich.js";
import { extractStep, type ExtractStepOptions } from "./extract.js";
import { startJobs, type Jobs } from "./jobs.js";

/*
 * T-402 in the pipeline: the extract step reads a version's bytes through a ContentSource,
 * extracts them in a child process, and stores one row per version through the guarded write.
 * The seeded tenant's default exposure is metadata-only: extraction runs anyway (it sends the
 * content nowhere), which every test here relies on. Files go to a managed zone unless a test
 * says otherwise: the seeded zone is indexed, whose content is extracted only on opt-in.
 */

let db: Database;
let t: SeededTenant;
let managed: string;
let localOnly: string;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  managed = newId("zone");
  localOnly = newId("zone");
  await db.withTenant(t.tenantId, (tx) =>
    tx.insert(zones).values([
      { tenantId: t.tenantId, id: managed, kind: "managed", name: "Managed" },
      { tenantId: t.tenantId, id: localOnly, kind: "local-only", name: "Laptop" },
    ]),
  );
});
const started: Jobs[] = [];
afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop({ timeoutMs: 1_000 });
  await db?.close();
});

const enc = new TextEncoder();
const REPORT = docx({
  paragraphs: [[{ text: "Quarterly numbers are up." }], [{ text: "hidden ask", hidden: true }]],
  core: { title: "Q3", creator: "Ann" },
});

/** Every file's bytes by blob id, as the tests' content sources serve them. */
let bytesOf: Map<string, Uint8Array>;
beforeEach(() => {
  bytesOf = new Map();
});

/** A content source over `bytesOf`; it records what it was asked for, and with which signal. */
function memorySource() {
  const opened: { ref: ContentRef; signal: AbortSignal }[] = [];
  const source: ContentSource = {
    async open(ref, signal) {
      opened.push({ ref, signal });
      const b = bytesOf.get(ref.blobId);
      if (b === undefined) return null;
      return (async function* () {
        yield b;
      })();
    },
  };
  return { source, opened };
}

let items = 0;
/** Ingests a file with these bytes (their real size) into the managed zone, or `zone`. */
async function ingestFile(
  title: string,
  mime: string,
  bytes: Uint8Array | undefined,
  options: { externalId?: string; zone?: "managed" | "indexed" | "local-only" } = {},
): Promise<IngestResult & { blobId: string }> {
  const n = ++items;
  const blobId = `b3t:${n.toString(16).padStart(64, "c")}`;
  if (bytes) bytesOf.set(blobId, bytes);
  const zone = options.zone ?? "managed";
  const result = await db.withTenant(t.tenantId, (tx) =>
    ingest(tx, t.tenantId, {
      source: "test",
      externalId: options.externalId ?? `file-${n}`,
      zoneId: zone === "managed" ? managed : zone === "local-only" ? localOnly : t.zoneId,
      title,
      ownerId: `user:${t.userId}`,
      content: {
        blobId,
        size: bytes?.byteLength ?? 100,
        ...(zone === "managed" ? { location: "stored" } : {}),
      },
      mime,
    }),
  );
  return { ...result, blobId };
}

const run = (steps: readonly EnrichStep[], versionId: string) =>
  enrichVersion(
    db,
    steps,
    { tenantId: t.tenantId, versionId },
    {
      signal: new AbortController().signal,
      requeue: async () => {},
    },
  );

const stored = (versionId: string) =>
  db.withTenant(t.tenantId, (tx) => readExtract(tx, t.tenantId, versionId));

const step = (more: Partial<ExtractStepOptions> = {}) => {
  const { source, opened } = memorySource();
  return { step: extractStep({ content: source, ...more }), opened };
};

describe("the extract step", () => {
  it("extracts a version's text and stores it; a re-run skips it, a newer extractor redoes it", async () => {
    const file = await ingestFile("Q3 report.docx", MIME.docx, REPORT);
    const { step: s, opened } = step();
    const steps = [ruleTagStep, s];
    expect(await run(steps, file.versionId)).toBe("processed");
    const first = await stored(file.versionId);
    expect(first).toMatchObject({
      status: "extracted",
      kind: "docx",
      text: "Quarterly numbers are up.",
      truncated: false,
      metadata: { title: "Q3", author: "Ann" },
      signals: [{ kind: "hidden-text", count: 1, sample: "hidden ask" }],
      warnings: [],
      failure: null,
      extractor: EXTRACTOR_VERSION,
    });
    // A job run again (a later step failed, say): this extractor's final answer stands.
    expect(await run(steps, file.versionId)).toBe("already-processed");
    expect(opened).toHaveLength(1);
    // Stored by an older extractor: done again, into the same row.
    await db.withTenant(t.tenantId, (tx) =>
      tx
        .update(versionExtracts)
        .set({ extractor: "openhoard-extract/0" })
        .where(eq(versionExtracts.versionId, file.versionId)),
    );
    expect(await run(steps, file.versionId)).toBe("already-processed");
    expect(opened).toHaveLength(2);
    const rows = await db.withTenant(t.tenantId, (tx) =>
      tx.select().from(versionExtracts).where(eq(versionExtracts.versionId, file.versionId)),
    );
    expect(rows).toHaveLength(1);
    expect(await stored(file.versionId)).toMatchObject({
      text: first?.text,
      extractor: EXTRACTOR_VERSION,
    });
  });

  it("records a hostile or broken file as failed, and the version is still processed", async () => {
    const pdf = await ingestFile("Invoice.pdf", MIME.pdf, enc.encode("%PDF-1.7 not really"));
    const csv = await ingestFile("Export.csv", MIME.csv, enc.encode(`${"x,".repeat(10_000)}x`));
    const steps = [step({ limits: { maxRecordBytes: 1024 } }).step];
    expect(await run(steps, pdf.versionId)).toBe("processed");
    expect(await run(steps, csv.versionId)).toBe("processed");
    expect(await stored(pdf.versionId)).toMatchObject({
      status: "failed",
      failure: "malformed",
      text: "",
    });
    expect(await stored(csv.versionId)).toMatchObject({
      status: "failed",
      failure: "record-too-large",
    });
  });

  it("stores unsupported types without reading them, and unreachable bytes as unavailable", async () => {
    const image = await ingestFile("Photo.png", "image/png", enc.encode("png"));
    const missing = await ingestFile("Notes.txt", MIME.txt, undefined);
    const { step: s, opened } = step();
    expect(await run([s], image.versionId)).toBe("processed");
    expect(await run([s], missing.versionId)).toBe("processed");
    expect(opened.map((o) => o.ref.versionId)).toEqual([missing.versionId]);
    expect(await stored(image.versionId)).toMatchObject({ status: "unsupported", kind: null });
    expect(await stored(missing.versionId)).toMatchObject({ status: "unavailable", text: "" });
    // Unavailable isn't final: a later run tries the source again.
    await run([s], missing.versionId);
    expect(opened.map((o) => o.ref.versionId)).toEqual([missing.versionId, missing.versionId]);
  });

  it("stores nothing when the source's bytes fail its check after an early answer", async () => {
    // 64 MiB of text: the child answers from the first MiB; the source fails at its very end,
    // as blobContentSource() does for bytes that don't hash to the version's blob.
    const chunk = enc.encode("word ".repeat((1024 * 1024) / 5));
    const size = 64 * chunk.byteLength;
    const big = await ingestFile("Big.txt", MIME.txt, new Uint8Array(size));
    const mismatched: ContentSource = {
      async open() {
        return (async function* () {
          for (let i = 0; i < 64; i++) yield chunk;
          throw new Error("the stored bytes don't match the version's blob (hash)");
        })();
      },
    };
    await expect(run([extractStep({ content: mismatched })], big.versionId)).rejects.toThrow(
      "enrichment step extract-text failed",
    );
    expect(await stored(big.versionId)).toBe(null);
  });

  it("reads managed zones, indexed zones only on opt-in, local-only zones never", async () => {
    const indexed = await ingestFile("Indexed.txt", MIME.txt, enc.encode("indexed words"), {
      zone: "indexed",
    });
    const local = await ingestFile("Local.txt", MIME.txt, enc.encode("local words"), {
      zone: "local-only",
    });
    const off = step();
    expect(await run([off.step], indexed.versionId)).toBe("processed");
    expect(await run([off.step], local.versionId)).toBe("processed");
    expect(off.opened).toEqual([]);
    expect(await stored(indexed.versionId)).toBe(null);
    expect(await stored(local.versionId)).toBe(null);

    const on = step({ indexedZones: true });
    const again = await ingestFile("Indexed 2.txt", MIME.txt, enc.encode("indexed words"), {
      zone: "indexed",
    });
    const local2 = await ingestFile("Local 2.txt", MIME.txt, enc.encode("local"), {
      zone: "local-only",
    });
    await run([on.step], again.versionId);
    await run([on.step], local2.versionId);
    expect(on.opened.map((o) => o.ref.zoneKind)).toEqual(["indexed"]);
    expect(await stored(again.versionId)).toMatchObject({ text: "indexed words" });
    expect(await stored(local2.versionId)).toBe(null);
  });

  it("fails the job, storing nothing, when the bytes can't be read now: it will be retried", async () => {
    const file = await ingestFile("Notes.txt", MIME.txt, enc.encode("partial and more"));
    const failing: ContentSource = {
      async open() {
        return (async function* () {
          yield enc.encode("partial");
          throw new Error("store unreachable");
        })();
      },
    };
    const short: ContentSource = {
      async open() {
        return (async function* () {
          yield enc.encode("partial");
        })();
      },
    };
    for (const content of [failing, short]) {
      await expect(run([extractStep({ content })], file.versionId)).rejects.toThrow(
        "enrichment step extract-text failed",
      );
    }
    expect(await stored(file.versionId)).toBe(null);
    const [row] = await db.withTenant(t.tenantId, (tx) =>
      tx
        .select({ processedAt: versions.processedAt })
        .from(versions)
        .where(eq(versions.id, file.versionId)),
    );
    expect(row?.processedAt).toBe(null);
  });

  it("stores nothing for a version a newer one replaced while it was extracting", async () => {
    const file = await ingestFile("Notes.txt", MIME.txt, enc.encode("old words"), {
      externalId: "notes",
    });
    let newer: IngestResult | undefined;
    const racing: ContentSource = {
      async open() {
        newer = await ingestFile("Notes.txt", MIME.txt, enc.encode("new words!"), {
          externalId: "notes",
        });
        return (async function* () {
          yield enc.encode("old words");
        })();
      },
    };
    expect(await run([extractStep({ content: racing })], file.versionId)).toBe("superseded");
    expect(newer?.created.version).toBe(true);
    expect(await stored(file.versionId)).toBe(null);
  });

  it("runs from startJobs' default steps when the server gives a content source", async () => {
    expect(defaultEnrichSteps().map((s) => s.name)).toEqual(["injection-flag", "rule-tags"]);
    const file = await ingestFile("Notes.md", MIME.md, enc.encode("# Hi\n<!-- psst -->\nthere"));
    const { source } = memorySource();
    expect(defaultEnrichSteps({ content: source }).map((s) => [s.name, s.provider])).toEqual([
      ["extract-text", undefined],
      ["injection-flag", undefined],
      ["rule-tags", undefined],
    ]);
    const jobs = await startJobs(db, {
      content: source,
      extract: { limits: { maxTextBytes: 1024 } },
      pollingIntervalSeconds: 0.5,
      maintenance: false,
    });
    started.push(jobs);
    await jobs.enqueueAfterIngest(t.tenantId, file);
    const deadline = Date.now() + 25_000;
    let extract = await stored(file.versionId);
    while (extract === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      extract = await stored(file.versionId);
    }
    expect(extract).toMatchObject({
      status: "extracted",
      kind: "markdown",
      text: "# Hi\n\nthere",
      signals: [{ kind: "html-comment", count: 1, sample: "psst" }],
    });
  });
});

describe("the extract step's second try", () => {
  const OK: ExtractResult = {
    ok: true,
    extraction: {
      kind: "text",
      text: "at last",
      truncated: false,
      metadata: {},
      signals: [],
      warnings: [],
    },
    stats: { bytesRead: 5, peakRssBytes: 1 },
  };
  const TIMEOUT: ExtractResult = { ok: false, failure: "timeout", permanent: true };
  const KILLED: ExtractResult = { ok: false, failure: "killed", permanent: false };

  /** An extractor that answers `answers` in turn, recording each call's time limit. */
  function scripted(answers: ExtractResult[]) {
    const limits: (number | undefined)[] = [];
    const extractor = (async (stream, _hint, options) => {
      for await (const _ of stream) void _;
      limits.push(options?.limits?.timeoutMs);
      return answers.shift() as ExtractResult;
    }) as typeof extract;
    return { extractor, limits };
  }

  async function runWith(answers: ExtractResult[], more: Partial<ExtractStepOptions> = {}) {
    const file = await ingestFile("Notes.txt", MIME.txt, enc.encode("hello"));
    const { extractor, limits } = scripted(answers);
    const { step: s, opened } = step({ extractor, ...more });
    expect(await run([s], file.versionId)).toBe("processed");
    return { limits, opened, extract: await stored(file.versionId) };
  }

  it("tries a timeout once more with twice the time, reading the content again", async () => {
    const { limits, opened, extract } = await runWith([TIMEOUT, OK], {
      limits: { timeoutMs: 1_000 } satisfies Partial<ExtractLimits>,
    });
    expect(limits).toEqual([1_000, 2_000]);
    expect(opened).toHaveLength(2);
    expect(extract).toMatchObject({ status: "extracted", text: "at last" });
  });

  it("stores the second timeout as failed", async () => {
    const { limits, extract } = await runWith([TIMEOUT, TIMEOUT]);
    expect(limits).toHaveLength(2);
    expect(extract).toMatchObject({ status: "failed", failure: "timeout" });
  });

  it("doesn't try again when twice the time doesn't fit the step's budget", async () => {
    const { limits, extract } = await runWith([TIMEOUT, OK], { budgetMs: 1 });
    expect(limits).toHaveLength(1);
    expect(extract).toMatchObject({ status: "failed", failure: "timeout" });
  });

  it("tries a process killed by a signal nobody sent once more, then takes it as the file's", async () => {
    const once = await runWith([KILLED, OK]);
    expect(once.extract).toMatchObject({ status: "extracted" });
    expect(once.limits[0]).toBe(once.limits[1]);
    const twice = await runWith([KILLED, KILLED]);
    expect(twice.extract).toMatchObject({ status: "failed", failure: "killed" });
  });

  it("aborts each attempt's signal to the source when the attempt ends", async () => {
    const { opened } = await runWith([TIMEOUT, OK]);
    expect(opened.map((o) => o.signal.aborted)).toEqual([true, true]);
  });
});
