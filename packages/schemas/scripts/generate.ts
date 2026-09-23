// Regenerates TypeScript types from the canonical JSON Schemas. CI fails if output drifts.
import { readFileSync, writeFileSync } from "node:fs";
import { compile, type JSONSchema } from "json-schema-to-typescript";

const schemas = [
  ["plugin-manifest.v1.schema.json", "plugin-manifest.ts", "PluginManifest"],
] as const;

for (const [src, out, name] of schemas) {
  const schema = JSON.parse(readFileSync(`src/${src}`, "utf8")) as JSONSchema;
  // allOf holds conditional rules (enforced by the validator); dropping it keeps the type exact.
  const { allOf: _allOf, ...shape } = schema;
  const ts = await compile({ ...shape, title: name }, name, {
    bannerComment: `/* Generated from ${src} by scripts/generate.ts. Do not edit. */`,
    additionalProperties: false,
    format: false,
  });
  writeFileSync(`src/generated/${out}`, ts);
}
