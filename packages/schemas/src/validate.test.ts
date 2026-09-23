import { describe, expect, it } from "vitest";
import { CORE_ONLY_CAPABILITIES, isPluginManifest, validatePluginManifest } from "./index.js";

const enricher = {
  manifest_version: 1,
  name: "enricher-invoice",
  version: "1.2.0",
  type: "enricher",
  accepts: ["application/pdf"],
  capabilities: ["read:content", "write:fields", "propose:tags"],
  network: [],
  max_exposure: "commercial-only",
};

describe("validatePluginManifest", () => {
  it("accepts a valid enricher", () => {
    expect(validatePluginManifest(enricher)).toEqual({ ok: true, errors: [] });
    expect(isPluginManifest(enricher)).toBe(true);
  });

  it.each(CORE_ONLY_CAPABILITIES)("rejects core-only capability %s", (cap) => {
    const r = validatePluginManifest({ ...enricher, capabilities: [cap] });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/allowed:/);
  });

  it("requires accepts for enrichers", () => {
    const { accepts: _accepts, ...rest } = enricher;
    expect(validatePluginManifest(rest).ok).toBe(false);
  });

  it("forbids capabilities and network on packs", () => {
    const pack = {
      manifest_version: 1,
      name: "pack-legal",
      version: "0.1.0",
      type: "pack",
      capabilities: [],
    };
    expect(validatePluginManifest(pack).ok).toBe(true);
    expect(validatePluginManifest({ ...pack, capabilities: ["read:content"] }).ok).toBe(false);
    expect(validatePluginManifest({ ...pack, network: ["example.com"] }).ok).toBe(false);
  });

  it("rejects unknown fields and bad names", () => {
    expect(validatePluginManifest({ ...enricher, sneaky: true }).ok).toBe(false);
    expect(validatePluginManifest({ ...enricher, name: "Bad Name" }).ok).toBe(false);
  });

  it("reports root-level errors", () => {
    expect(validatePluginManifest("nope").errors[0]).toMatch(/^\(root\)/);
  });
});
