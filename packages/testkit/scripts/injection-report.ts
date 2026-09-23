// Runs the prompt-injection corpus through the v0 baseline pipeline and prints a per-file
// report. In CI the report is also appended to the job summary. Exits 1 if any file made the
// pipeline act or loosen access: those must never happen, even in the baseline.
import { appendFileSync } from "node:fs";
import { baselinePipeline, formatInjectionReport, runInjectionHarness } from "../src/index.js";

const report = await runInjectionHarness(baselinePipeline);
const markdown = formatInjectionReport(report, "Prompt-injection corpus v0: baseline pipeline");
process.stdout.write(markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
if (report.counts.acted + report.counts.loosened + report.counts.error > 0) process.exit(1);
