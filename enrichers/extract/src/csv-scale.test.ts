import { describe, expect, it } from "vitest";
import { extract } from "./sandbox.ts";
import { generatedCsv } from "./test.fixtures.ts";

/*
 * T-402's done-when: a 1 GB CSV streams through without running out of memory, with an exact
 * row count. The CSV is generated as it is read, never stored; the child reports its peak
 * resident memory, which must stay far below the file's size.
 *
 * The 1 GiB run takes about a minute on a Linux runner (the parent generates the text and
 * both sides stream it), several on Windows and macOS runners, so it is a slow test:
 * `pnpm --filter @openhoard/enricher-extract test:slow` (or OPENHOARD_TEST_SLOW=1), which CI
 * runs in its Linux PostgreSQL job. Every run does the same at 32 MiB (8 MiB on Windows).
 */

const MiB = 1024 * 1024;
/** Bytes per generated row, about: see generatedCsv(). */
const ROW_BYTES = 34;

async function streamCsv(rows: number) {
  let sent = 0;
  async function* counted(): AsyncGenerator<Uint8Array> {
    for await (const chunk of generatedCsv(rows)) {
      sent += chunk.byteLength;
      yield chunk;
    }
  }
  const result = await extract(
    counted(),
    { mime: "text/csv", name: "big.csv" },
    {
      limits: { timeoutMs: 15 * 60_000 },
    },
  );
  return { result, sent };
}

async function expectStreamed(targetBytes: number) {
  const rows = Math.ceil(targetBytes / ROW_BYTES);
  const { result, sent } = await streamCsv(rows);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(sent).toBeGreaterThanOrEqual(targetBytes * 0.9);
  expect(result.stats.bytesRead).toBe(sent);
  expect(result.extraction.metadata.csv).toEqual({
    delimiter: ",",
    header: true,
    columns: [
      { name: "id", type: "integer" },
      { name: "name", type: "string" },
      { name: "amount", type: "number" },
      { name: "day", type: "date" },
    ],
    rows,
  });
  expect(result.extraction.truncated).toBe(true);
  // Flat memory: the child's peak is bounded however large the file.
  expect(result.stats.peakRssBytes).toBeLessThan(256 * MiB);
}

describe("streaming a large CSV", () => {
  // Windows runners stream through pipes several times slower: 8 MiB there keeps the test
  // well inside its time; the 1 GiB run (Linux) is the real measure.
  const everyRun = process.platform === "win32" ? 8 : 32;
  it(`counts every row of ${everyRun} MiB with flat memory`, async () => {
    await expectStreamed(everyRun * MiB);
  }, 180_000);

  it.runIf(
    process.env.OPENHOARD_TEST_SLOW === "1" || process.env.npm_lifecycle_event === "test:slow",
  )(
    "counts every row of 1 GiB with flat memory",
    async () => {
      await expectStreamed(1024 * MiB);
    },
    20 * 60_000,
  );
});
