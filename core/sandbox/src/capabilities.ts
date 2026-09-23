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
 */
export function admitPlugin(manifest: unknown, approved: readonly string[]): InstalledPlugin {
  const { ok, errors } = validatePluginManifest(manifest);
  if (!ok) throw new PluginRejected(errors);
  const m = manifest as PluginManifest;
  const declared = new Set<string>(m.capabilities);
  const extra = approved.filter((c) => !declared.has(c));
  if (extra.length) throw new PluginRejected(extra.map((c) => `approval of undeclared ${c}`));
  return { manifest: m, approved: new Set(approved as Capability[]) };
}

/** Runtime gate the core calls before handing anything to a plugin. Default deny. */
export function hasCapability(plugin: InstalledPlugin, cap: Capability): boolean {
  return plugin.approved.has(cap);
}
