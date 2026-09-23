import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import manifestSchema from "./plugin-manifest.v1.schema.json" with { type: "json" };
import type { PluginManifest } from "./generated/plugin-manifest.js";

const ajv = new Ajv2020({ allErrors: true, strict: false });
// ajv-formats is CJS; under NodeNext its plugin function is the `.default` export.
addFormats.default(ajv);
const compiled = ajv.compile<PluginManifest>(manifestSchema);

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Validate a plugin manifest against schema v1. Never throws. */
export function validatePluginManifest(value: unknown): ValidationResult {
  const ok = compiled(value);
  /* v8 ignore next -- ajv always sets `errors` when validation fails */
  return { ok, errors: ok ? [] : (compiled.errors ?? []).map(formatError) };
}

/** Type guard form of {@link validatePluginManifest}. */
export function isPluginManifest(value: unknown): value is PluginManifest {
  return compiled(value);
}

function formatError(e: ErrorObject): string {
  const where = e.instancePath || "(root)";
  const allowed = (e.params as { allowedValues?: unknown[] }).allowedValues;
  const extra = allowed ? ` (allowed: ${allowed.join(", ")})` : "";
  /* v8 ignore next -- ajv always sets `message` with the default options */
  return `${where}: ${e.message ?? "invalid"}${extra}`;
}

export { manifestSchema as pluginManifestSchema };
