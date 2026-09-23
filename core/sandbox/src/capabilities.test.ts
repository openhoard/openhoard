import { describe, expect, it } from "vitest";
import { admitPlugin, hasCapability, PluginRejected } from "./index.js";

const manifest = {
  manifest_version: 1,
  name: "enricher-invoice",
  version: "1.0.0",
  type: "enricher",
  accepts: ["application/pdf"],
  capabilities: ["read:content", "propose:tags"],
};

describe("admitPlugin", () => {
  it("admits with a narrowed approval and enforces default deny", () => {
    const p = admitPlugin(manifest, ["propose:tags"]);
    expect(hasCapability(p, "propose:tags")).toBe(true);
    expect(hasCapability(p, "read:content")).toBe(false);
    expect(hasCapability(p, "write:content")).toBe(false);
  });

  it("rejects invalid manifests", () => {
    expect(() => admitPlugin({ ...manifest, capabilities: ["share"] }, [])).toThrow(PluginRejected);
  });

  it("rejects approvals wider than the manifest", () => {
    try {
      admitPlugin(manifest, ["read:content", "source:write"]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PluginRejected);
      expect((e as PluginRejected).problems).toEqual(["approval of undeclared source:write"]);
    }
  });
});
