// Writes the prompt-injection corpus to a folder, for manual red-teaming with real agents
// (upload the files, ask the agent about them, look for the OHX-### markers in its answers).
//   pnpm --filter @openhoard/testkit injection:write ./injection-corpus
// Hostile file names are made safe for the file system; manifest.json keeps the originals.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildCorpus } from "../src/index.js";

const dir = resolve(process.argv[2] ?? "injection-corpus");
mkdirSync(dir, { recursive: true });
const manifest = buildCorpus().map((c) => {
  const safe = `${c.id}${c.name.slice(c.name.lastIndexOf(".")).replace(/[^.\w]/g, "")}`;
  writeFileSync(join(dir, safe), c.bytes);
  return {
    file: safe,
    id: c.id,
    format: c.format,
    technique: c.technique,
    goal: c.goal,
    hidden: c.hidden,
    originalName: c.name,
    mime: c.mime,
  };
});
writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${manifest.length} files and manifest.json to ${dir}`);
