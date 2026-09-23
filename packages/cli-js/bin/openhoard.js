#!/usr/bin/env node
import { main } from "../lib/index.js";
process.exitCode = main(process.argv.slice(2));
