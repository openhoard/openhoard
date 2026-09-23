import { arch, cpus, platform } from "node:os";

/*
 * Benchmark harness (T-019). Small on purpose: measure latency percentiles or throughput,
 * repeat in rounds and keep the median round (shared CI runners are noisy), track peak memory,
 * and compare against a previous run with a relative threshold plus an absolute noise floor.
 */

export type Better = "lower" | "higher";

export interface Metric {
  /** Stable key, e.g. `search.p95`. Baselines are matched on it. */
  name: string;
  value: number;
  unit: string;
  better: Better;
  /** Changes smaller than this (in `unit`) are never regressions, however large in %. */
  noiseFloor?: number;
}

export interface BenchCase {
  name: string;
  /** Returns this case's metrics for one round. */
  run(): Promise<Metric[]>;
}

export interface BenchResults {
  version: 1;
  date: string;
  node: string;
  platform: string;
  cpu: string;
  rounds: number;
  metrics: Metric[];
  /** Peak resident set size during the whole run, in MiB. */
  peakRssMiB: number;
}

export interface Regression {
  name: string;
  baseline: number;
  current: number;
  /** Relative change in the "worse" direction, e.g. 0.31 = 31% worse. */
  change: number;
  unit: string;
}

export interface LatencyStats {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

/** Times `fn` `iterations` times (after `warmup` untimed calls) and returns percentiles in ms. */
export async function measureLatency(
  fn: (i: number) => unknown,
  { iterations = 500, warmup = 50 }: { iterations?: number; warmup?: number } = {},
): Promise<LatencyStats> {
  for (let i = 0; i < warmup; i++) await fn(i);
  const samples = new Float64Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn(i);
    samples[i] = performance.now() - start;
  }
  samples.sort();
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    n: iterations,
    mean: sum / iterations,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
  };
}

/** Runs `fn` repeatedly for at least `ms` and returns units per second (fn returns units done). */
export async function measureThroughput(
  fn: () => Promise<number> | number,
  { ms = 1000 } = {},
): Promise<number> {
  let units = 0;
  const start = performance.now();
  let elapsed = 0;
  do {
    units += await fn();
    elapsed = performance.now() - start;
  } while (elapsed < ms);
  return (units / elapsed) * 1000;
}

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[rank] as number;
}

/**
 * Runs every case `rounds` times and keeps, per metric, the median across rounds. Peak RSS is
 * sampled every 10 ms throughout.
 */
export async function runSuite(
  cases: readonly BenchCase[],
  { rounds = 5 } = {},
): Promise<BenchResults> {
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 10);
  try {
    const metrics: Metric[] = [];
    for (const c of cases) {
      const byName = new Map<string, Metric[]>();
      for (let r = 0; r < rounds; r++) {
        for (const m of await c.run()) byName.set(m.name, [...(byName.get(m.name) ?? []), m]);
      }
      for (const runs of byName.values()) {
        const sorted = [...runs].sort((a, b) => a.value - b.value);
        metrics.push(sorted[Math.floor((sorted.length - 1) / 2)] as Metric);
      }
    }
    peak = Math.max(peak, process.memoryUsage().rss);
    return {
      version: 1,
      date: new Date().toISOString(),
      node: process.version,
      platform: `${platform()}-${arch()}`,
      cpu: cpus()[0]?.model ?? "unknown",
      rounds,
      metrics,
      peakRssMiB: round(peak / 1024 / 1024, 1),
    };
  } finally {
    clearInterval(timer);
  }
}

/**
 * Metrics worse than the baseline by more than `threshold` (default 20%) AND by more than their
 * noise floor. Metrics missing from either side are ignored (new or retired benchmarks).
 */
export function compareResults(
  current: BenchResults,
  baseline: BenchResults,
  threshold = 0.2,
): Regression[] {
  const base = new Map(baseline.metrics.map((m) => [m.name, m]));
  const out: Regression[] = [];
  for (const m of current.metrics) {
    const b = base.get(m.name);
    if (!b || b.unit !== m.unit || !(b.value > 0)) continue;
    const worse = m.better === "lower" ? m.value - b.value : b.value - m.value;
    const change = worse / b.value;
    if (change > threshold && worse > (m.noiseFloor ?? 0)) {
      out.push({ name: m.name, baseline: b.value, current: m.value, change, unit: m.unit });
    }
  }
  return out;
}

export function formatBench(
  results: BenchResults,
  baseline?: BenchResults,
  regressions: readonly Regression[] = [],
): string {
  const base = new Map((baseline?.metrics ?? []).map((m) => [m.name, m]));
  const flagged = new Set(regressions.map((r) => r.name));
  const rows = results.metrics.map((m) => {
    const b = base.get(m.name);
    const delta =
      b && b.value > 0
        ? `${m.value >= b.value ? "+" : ""}${round(((m.value - b.value) / b.value) * 100, 1)}%`
        : "n/a";
    return `| ${m.name} | ${fmt(m.value)} ${m.unit} | ${m.better} | ${b ? `${fmt(b.value)} ${b.unit}` : "n/a"} | ${delta} | ${flagged.has(m.name) ? "**regressed**" : "ok"} |`;
  });
  return [
    "## Benchmarks",
    "",
    `${results.platform}, Node ${results.node}, ${results.cpu}. Median of ${results.rounds} rounds. Peak RSS ${results.peakRssMiB} MiB.`,
    regressions.length
      ? `\n**${regressions.length} regression(s) over 20%.**`
      : baseline
        ? "\nNo regressions over 20% against the previous nightly run."
        : "\nNo baseline yet: this run becomes the baseline.",
    "",
    "| Metric | Value | Better | Baseline | Change | Status |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

function fmt(v: number): string {
  return v >= 100 ? String(Math.round(v)) : v >= 1 ? v.toFixed(2) : v.toFixed(4);
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
