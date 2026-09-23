// Ship the raw JSON Schemas next to the compiled JS so non-TS consumers can load them.
import { cpSync, readdirSync } from "node:fs";

for (const f of readdirSync("src")) {
  if (f.endsWith(".schema.json")) cpSync(`src/${f}`, `dist/${f}`);
}
