import { describe, expect, it } from "vitest";
import {
  compareResults,
  formatBench,
  measureLatency,
  measureThroughput,
  percentile,
  runSuite,
  standardCases,
  type BenchResults,
  type Metric,
} from "../index.js";

const results = (metrics: Metric[]): BenchResults => ({
  version: 1,
  date: "2026-09-01T00:00:00.000Z",
  node: "v24",
  platform: "test",
  cpu: "test",
  rounds: 1,
  metrics,
  peakRssMiB: 1,
});

describe("percentile", () => {
  it("uses the nearest-rank method", () => {
    const xs = Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(percentile(xs, 0.5)).toBe(5);
    expect(percentile(xs, 0.95)).toBe(10);
    expect(percentile(xs, 0)).toBe(1);
    expect(percentile([], 0.5)).toBeNaN();
  });
});

describe("measurements", () => {
  it("returns ordered latency percentiles", async () => {
    const s = await measureLatency(() => undefined, { iterations: 50, warmup: 5 });
    expect(s.n).toBe(50);
    expect(s.p50).toBeLessThanOrEqual(s.p95);
    expect(s.p95).toBeLessThanOrEqual(s.p99);
  });

  it("returns a positive throughput", async () => {
    expect(await measureThroughput(() => 10, { ms: 20 })).toBeGreaterThan(0);
  });
});

describe("runSuite", () => {
  it("keeps the median round for each metric", async () => {
    let round = 0;
    const values = [5, 1, 9, 3, 7];
    const r = await runSuite(
      [
        {
          name: "x",
          run: () =>
            Promise.resolve([
              { name: "x", value: values[round++] ?? 0, unit: "ms", better: "lower" },
            ]),
        },
      ],
      { rounds: 5 },
    );
    expect(r.metrics).toEqual([{ name: "x", value: 5, unit: "ms", better: "lower" }]);
    expect(r.peakRssMiB).toBeGreaterThan(0);
  });

  it("runs the standard cases end to end", async () => {
    const r = await runSuite(standardCases({ items: 300 }), { rounds: 1 });
    const names = r.metrics.map((m) => m.name);
    for (const n of [
      "search.p95",
      "ingest.throughput",
      "audit.append",
      "rank.rrf.3x1000",
      "tenant.generate.300",
    ]) {
      expect(names).toContain(n);
    }
    for (const m of r.metrics) expect(Number.isFinite(m.value) && m.value >= 0).toBe(true);
  }, 60_000);
});

describe("compareResults", () => {
  const base = results([
    { name: "lat", value: 10, unit: "ms", better: "lower" },
    { name: "tput", value: 100, unit: "MiB/s", better: "higher" },
    { name: "tiny", value: 0.01, unit: "ms", better: "lower", noiseFloor: 0.05 },
    { name: "gone", value: 1, unit: "ms", better: "lower" },
  ]);

  it("flags changes worse than the threshold in the right direction", () => {
    const current = results([
      { name: "lat", value: 12.5, unit: "ms", better: "lower" },
      { name: "tput", value: 70, unit: "MiB/s", better: "higher" },
      { name: "tiny", value: 0.04, unit: "ms", better: "lower", noiseFloor: 0.05 },
      { name: "new", value: 1, unit: "ms", better: "lower" },
    ]);
    const regressions = compareResults(current, base);
    expect(regressions.map((r) => r.name)).toEqual(["lat", "tput"]);
    expect(regressions[0]?.change).toBeCloseTo(0.25);
  });

  it("ignores improvements, small changes and unit changes", () => {
    const current = results([
      { name: "lat", value: 5, unit: "ms", better: "lower" },
      { name: "tput", value: 90, unit: "MiB/s", better: "higher" },
      { name: "gone", value: 99, unit: "s", better: "lower" },
    ]);
    expect(compareResults(current, base)).toEqual([]);
  });
});

describe("formatBench", () => {
  it("shows values, baselines, change and status", () => {
    const current = results([{ name: "lat", value: 12.5, unit: "ms", better: "lower" }]);
    const baseline = results([{ name: "lat", value: 10, unit: "ms", better: "lower" }]);
    const md = formatBench(current, baseline, compareResults(current, baseline));
    expect(md).toContain("| lat | 12.50 ms | lower | 10.00 ms | +25% | **regressed** |");
    expect(md).toContain("1 regression(s)");
    expect(formatBench(current)).toContain("No baseline to compare against");
    expect(formatBench(current, current)).toContain("No regressions over 20%");
    expect(formatBench(current, current, [], { threshold: 0.3, note: "Different CPU." })).toMatch(
      /No regressions over 30%[^]*Different CPU\./,
    );
  });
});
