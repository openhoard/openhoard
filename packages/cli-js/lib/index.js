// OpenHoard CLI library (pre-alpha). Today: validate plugin manifests against the v1 schema.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const here = dirname(fileURLToPath(import.meta.url));
export const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
export const schema = JSON.parse(
  readFileSync(join(here, "..", "schemas", "plugin-manifest.v1.schema.json"), "utf8"),
);

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const compiled = ajv.compile(schema);

export function validateManifest(manifest) {
  const ok = compiled(manifest);
  return { ok, errors: ok ? [] : compiled.errors.map(fmt) };
}

function fmt(e) {
  const where = e.instancePath || "(root)";
  const extra = e.params?.allowedValues ? ` (allowed: ${e.params.allowedValues.join(", ")})` : "";
  return `${where}: ${e.message}${extra}`;
}

const USAGE = () => `openhoard ${pkg.version}

Usage:
  openhoard --version
  openhoard manifest validate <file...>   Validate plugin manifest(s) against schema v1
  openhoard manifest schema               Print the v1 manifest JSON Schema
`;

export function main(argv, out = process.stdout, err = process.stderr) {
  const [cmd, sub, ...rest] = argv;
  if (!cmd || ["-h", "--help", "help"].includes(cmd)) { out.write(USAGE()); return 0; }
  if (["-v", "--version", "version"].includes(cmd)) { out.write(`${pkg.version}\n`); return 0; }
  if (cmd === "manifest" && sub === "schema") { out.write(JSON.stringify(schema, null, 2) + "\n"); return 0; }
  if (cmd === "manifest" && sub === "validate") {
    if (rest.length === 0) { err.write("error: give at least one manifest file\n"); return 2; }
    let failed = 0;
    for (const file of rest) {
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(file, "utf8"));
      } catch (e) {
        err.write(`✗ ${file}: cannot read JSON (${e.message})\n`);
        failed++;
        continue;
      }
      const { ok, errors } = validateManifest(manifest);
      if (ok) out.write(`✓ ${file}: valid ${manifest.type} "${manifest.name}"\n`);
      else { failed++; err.write(`✗ ${file}\n${errors.map((x) => `    ${x}`).join("\n")}\n`); }
    }
    return failed ? 1 : 0;
  }
  err.write(`error: unknown command\n\n${USAGE()}`);
  return 2;
}
