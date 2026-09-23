export type { PluginManifest } from "./generated/plugin-manifest.js";
export {
  validatePluginManifest,
  isPluginManifest,
  pluginManifestSchema,
  type ValidationResult,
} from "./validate.js";

/** Capabilities only the trusted core may hold. The schema already rejects them; exported for docs and tests. */
export const CORE_ONLY_CAPABILITIES = ["grant", "share", "policy:write", "audit:write"] as const;
