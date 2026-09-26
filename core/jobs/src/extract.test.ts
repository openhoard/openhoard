import {
  ingest,
  readExtract,
  type ContentRef,
  type ContentSource,
  type IngestResult,
} from "@openhoard/core-catalog";
import { versionExtracts, versions, type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { EXTRACTOR_VERSION } from "@openhoard/enricher-extract";
import { docx, MIME } from "@openhoard/testkit";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultEnrichSteps, enrichVersion, ruleTagStep, type EnrichStep } from "./enrich.js";
import { extractStep } from "./extract.js";
import { startJobs, type Jobs } from "./jobs.js";

/*
 * T-402 in the pipeline: the extract step reads a version's bytes through a ContentSource,
 * extracts them in a child process, and stores one row per version through the guarded write.
 * The seeded tenant's default exposure is metadata-only: extraction runs anyway (it sends the
 * content nowhere), which every test here relies on.
 */

let db: Database;
let t: SeededTenant;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
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

/** A content source over bytes by blob id; it records what it was asked for. */
function memorySource(bytes: Map<string, Uint8Array>) {
  const opened: ContentRef[] = [];
  const source: ContentSource = {
    async open(ref) {
      opened.push(ref);
      const b = bytes.get(ref.blobId);
      if (b === undefined) return null;
      return (async function* () {
        yield b;
      })();
    },
  };
  return { source, opened };
}

let items = 0;
async function ingestFile(
  title: string,
  mime: string,
  options: { externalId?: string } = {},
): Promise<IngestResult & { blobId: string }> {
  const n = ++items;
  const blobId = `b3t:${n.toString(16).padStart(64, "c")}`;
  const result = await db.withTenant(t.tenantId, (tx) =>
    ingest(tx, t.tenantId, {
      source: "test",
      externalId: options.externalId ?? `file-${n}`,
      zoneId: t.zoneId,
      title,
      ownerId: `user:${t.userId}`,
      content: { blobId, size: 100 },
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

describe("the extract step", () => {
  it("extracts a version's text and stores it, and a re-run rewrites the same row", async () => {
    const file = await ingestFile("Q3 report.docx", MIME.docx);
    const { source } = memorySource(new Map([[file.blobId, REPORT]]));
    const steps = [ruleTagStep, extractStep({ content: source })];
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
    expect(await run(steps, file.versionId)).toBe("already-processed");
    const rows = await db.withTenant(t.tenantId, (tx) =>
      tx.select().from(versionExtracts).where(eq(versionExtracts.versionId, file.versionId)),
    );
    expect(rows).toHaveLength(1);
    expect(await stored(file.versionId)).toMatchObject({ text: first?.text });
  });

  it("records a hostile or broken file as failed, and the version is still processed", async () => {
    const pdf = await ingestFile("Invoice.pdf", MIME.pdf);
    const csv = await ingestFile("Export.csv", MIME.csv);
    const { source } = memorySource(
      new Map([
        [pdf.blobId, enc.encode("%PDF-1.7 not really")],
        [csv.blobId, enc.encode(`${"x,".repeat(10_000)}x`)],
      ]),
    );
    const steps = [extractStep({ content: source, limits: { maxRecordBytes: 1024 } })];
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
    const image = await ingestFile("Photo.png", "image/png");
    const missing = await ingestFile("Notes.txt", MIME.txt);
    const { source, opened } = memorySource(new Map());
    const steps = [extractStep({ content: source })];
    expect(await run(steps, image.versionId)).toBe("processed");
    expect(await run(steps, missing.versionId)).toBe("processed");
    expect(opened.map((r) => r.versionId)).toEqual([missing.versionId]);
    expect(await stored(image.versionId)).toMatchObject({ status: "unsupported", kind: null });
    expect(await stored(missing.versionId)).toMatchObject({ status: "unavailable", text: "" });
  });

  it("fails the job, storing nothing, when the bytes can't be read now: it will be retried", async () => {
    const file = await ingestFile("Notes.txt", MIME.txt);
    const failing: ContentSource = {
      async open() {
        return (async function* () {
          yield enc.encode("partial");
          throw new Error("store unreachable");
        })();
      },
    };
    await expect(run([extractStep({ content: failing })], file.versionId)).rejects.toThrow(
      "enrichment step extract-text failed",
    );
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
    const file = await ingestFile("Notes.txt", MIME.txt, { externalId: "notes" });
    let newer: IngestResult | undefined;
    const racing: ContentSource = {
      async open() {
        newer = await ingestFile("Notes.txt", MIME.txt, { externalId: "notes" });
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
    expect(defaultEnrichSteps().map((s) => s.name)).toEqual(["rule-tags"]);
    const file = await ingestFile("Notes.md", MIME.md);
    const { source } = memorySource(
      new Map([[file.blobId, enc.encode("# Hi\n<!-- psst -->\nthere")]]),
    );
    expect(defaultEnrichSteps({ content: source }).map((s) => [s.name, s.provider])).toEqual([
      ["rule-tags", undefined],
      ["extract-text", undefined],
    ]);
    const jobs = await startJobs(db, {
      content: source,
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
