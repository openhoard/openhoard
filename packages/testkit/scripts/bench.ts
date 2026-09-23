// Runs the standard benchmarks and compares them with a previous run.
//   pnpm --filter @openhoard/testkit bench --out bench.json [--baseline prev.json]
//     [--rounds 5] [--items 10000] [--threshold 0.2]
// Prints a Markdown table (also appended to the GitHub job summary) and exits 1 if any metric
// regressed by more than the threshold, so the nightly job fails and alerts. Runs on a
// different CPU model than the baseline are reported but not compared: hosted runners change
// hardware, and a slower machine is not a regression.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  compareResults,
  formatBench,
  runSuite,
  standardCases,
  type BenchResults,
} from "../src/index.js";

const { values } = parseArgs({
  // pnpm forwards a literal "--" separator; ignore it rather than treating it as a positional.
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    out: { type: "string" },
    baseline: { type: "string" },
    rounds: { type: "string", default: "5" },
    items: { type: "string", default: "10000" },
    threshold: { type: "string", default: "0.2" },
  },
});

const threshold = Number(values.threshold);
const results = await runSuite(standardCases({ items: Number(values.items) }), {
  rounds: Number(values.rounds),
});
const baseline =
  values.baseline && existsSync(values.baseline)
    ? (JSON.parse(readFileSync(values.baseline, "utf8")) as BenchResults)
    : undefined;
const comparable = baseline !== undefined && baseline.cpu === results.cpu;
const regressions = comparable ? compareResults(results, baseline, threshold) : [];
const note =
  baseline && !comparable
    ? `Baseline ran on "${baseline.cpu}"; this run is on "${results.cpu}", so it is not compared. It becomes the next baseline.`
    : undefined;
const markdown = formatBench(results, comparable ? baseline : undefined, regressions, {
  threshold,
  ...(note ? { note } : {}),
});

if (values.out) writeFileSync(values.out, `${JSON.stringify(results, null, 2)}\n`);
process.stdout.write(markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
if (regressions.length) process.exit(1);
