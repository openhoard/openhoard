import { EXPOSURE, exposureAllowsContent, type Exposure } from "@openhoard/core-policy";
import { validatePluginManifest, type PluginManifest } from "@openhoard/schemas";

export type Capability = PluginManifest["capabilities"][number];

export interface InstalledPlugin {
  manifest: PluginManifest;
  /** Capabilities an admin approved at install. Always a subset of the manifest's. */
  approved: ReadonlySet<Capability>;
}

export class PluginRejected extends Error {
  constructor(public readonly problems: string[]) {
    super(`plugin manifest rejected: ${problems.join("; ")}`);
    this.name = "PluginRejected";
  }
}

/**
 * Admits a plugin: the manifest must validate, and the admin's approval can only narrow
 * what the manifest declares, never widen it.
 *
 * The manifest is copied first (a JSON round trip, which drops getters, prototypes and anything
 * JSON can't carry), and that copy is what is validated and returned, deeply frozen, so neither
 * the caller mutating its object later nor a getter answering differently the second time can
 * change what was admitted.
 */
export function admitPlugin(manifest: unknown, approved: readonly string[]): InstalledPlugin {
  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(manifest)) as unknown;
  } catch {
    throw new PluginRejected(["a manifest must be plain JSON"]);
  }
  const { ok, errors } = validatePluginManifest(copy);
  if (!ok) throw new PluginRejected(errors);
  const m = deepFreeze(copy as PluginManifest);
  const declared = new Set<string>(m.capabilities);
  const extra = approved.filter((c) => !declared.has(c));
  if (extra.length) throw new PluginRejected(extra.map((c) => `approval of undeclared ${c}`));
  const plugin = Object.freeze({ manifest: m, approved: readOnlySet(approved as Capability[]) });
  // What hasCapability() reads: a copy nothing outside this module can reach, so neither
  // Set.prototype.add.call(plugin.approved, …) nor an object built to look admitted widens it.
  admitted.set(plugin, new Set(approved as Capability[]));
  return plugin;
}

const admitted = new WeakMap<InstalledPlugin, ReadonlySet<Capability>>();

/** A Set whose mutators throw, for callers to read what was approved. */
function readOnlySet<T>(items: readonly T[]): ReadonlySet<T> {
  const set = new Set(items);
  const refuse = () => {
    throw new TypeError("an admitted plugin's approvals can't change");
  };
  for (const name of ["add", "delete", "clear"]) {
    Object.defineProperty(set, name, { value: refuse });
  }
  return Object.freeze(set);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * Runtime gate the core calls before handing anything to a plugin. Default deny, including for
 * anything admitPlugin() didn't return.
 */
export function hasCapability(plugin: InstalledPlugin, cap: Capability): boolean {
  return admitted.get(plugin)?.has(cap) ?? false;
}

/**
 * The gate for content (T-604): whether the core may hand a plugin the content of a file at this
 * exposure (the file's resolved exposure: core/catalog levels, or enrichmentExposure() while it
 * is enriched). All of:
 *
 * - it was admitted with `read:content` approved (hasCapability());
 * - the file is no more sensitive than its manifest's `max_exposure` (the most sensitive level
 *   it may receive; `metadata-only`, the default, means no content at all);
 * - the exposure lets the plugin have it as the AI-client rule would: a plugin with no network
 *   is local, so `local-only` content reaches only a plugin that can't send it anywhere; one
 *   with any network host counts as a commercial service, never local.
 *
 * Plugins don't run yet (ADR-0012). Whatever hands a plugin content (the plugin runtime, T-9xx:
 * an enricher's `extract`, a connector's `write`) must ask this first, for every file, and send
 * only metadata when it says no. Default deny: anything else is false.
 */
export function mayReceiveContent(plugin: InstalledPlugin, exposure: Exposure): boolean {
  if (!hasCapability(plugin, "read:content")) return false;
  const rank = (level: string) => EXPOSURE.indexOf(level as Exposure);
  const ceiling = plugin.manifest.max_exposure ?? "metadata-only";
  if (ceiling === "metadata-only" || rank(ceiling) === -1 || rank(exposure) === -1) return false;
  // EXPOSURE runs from most to least sensitive: the file mustn't be more sensitive than allowed.
  if (rank(exposure) < rank(ceiling)) return false;
  const local = (plugin.manifest.network ?? []).length === 0;
  return exposureAllowsContent(exposure, local ? "local" : "commercial");
}
