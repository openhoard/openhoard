import { describe, expect, it } from "vitest";
import { admitPlugin, hasCapability, PluginRejected } from "./index.js";

const manifest = {
  manifest_version: 1,
  name: "enricher-invoice",
  version: "1.0.0",
  type: "enricher",
  runtime: "wasm",
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

  it("returns a frozen copy: later mutation of the input changes nothing", () => {
    const input = structuredClone(manifest);
    const p = admitPlugin(input, ["read:content"]);
    input.capabilities.push("write:content");
    input.name = "enricher-evil";
    expect(p.manifest.capabilities).toEqual(["read:content", "propose:tags"]);
    expect(p.manifest.name).toBe("enricher-invoice");
    expect(Object.isFrozen(p.manifest)).toBe(true);
    expect(Object.isFrozen(p.manifest.capabilities)).toBe(true);
    expect(() => (p.manifest.capabilities as string[]).push("write:content")).toThrow(TypeError);
  });

  it("keeps approvals fixed after admission, and denies look-alikes", () => {
    const p = admitPlugin(manifest, ["propose:tags"]);
    const approved = p.approved as Set<string>;
    expect(() => approved.add("read:content")).toThrow(TypeError);
    expect(() => approved.clear()).toThrow(TypeError);
    // Around the read-only view: the gate reads its own copy.
    Set.prototype.add.call(approved, "read:content");
    expect(hasCapability(p, "read:content")).toBe(false);
    expect(hasCapability(p, "propose:tags")).toBe(true);
    const forged = { manifest: p.manifest, approved: new Set(["write:content" as const]) };
    expect(hasCapability(forged, "write:content")).toBe(false);
  });

  it("validates what it returns: a getter can't answer differently later", () => {
    let reads = 0;
    const tricky = {
      ...manifest,
      get capabilities() {
        reads++;
        return reads === 1 ? ["read:content"] : ["read:content", "write:content"];
      },
    };
    const p = admitPlugin(tricky, ["read:content"]);
    expect(p.manifest.capabilities).toEqual(["read:content"]);
    expect(Object.getOwnPropertyDescriptor(p.manifest, "capabilities")?.get).toBeUndefined();
    expect(() => admitPlugin({ ...manifest, n: 1n }, [])).toThrow(PluginRejected);
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
