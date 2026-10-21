#!/usr/bin/env node
import { main } from "./cli.js";
import { runOperator } from "./operator.js";

const args = process.argv.slice(2);
const ran = await runOperator(args);
if (ran === null) process.exitCode = main(args);
else if (ran !== "serving") process.exit(ran);
