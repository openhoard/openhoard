import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { admitPlugin, hasCapability, PluginRejected, type Capability } from "./capabilities.js";

const ALL: Capability[] = ["read:metadata", "read:content", "propose:tags", "write:fields"];
const manifest = (capabilities: string[]) => ({
  manifest_version: 1,
  name: "enricher-any",
  version: "1.0.0",
  type: "enricher",
  runtime: "wasm",
  accepts: ["application/pdf"],
  capabilities,
});

describe("admitPlugin (properties)", () => {
  it("an approval can only narrow what the manifest declares", () => {
    fc.assert(
      fc.property(fc.subarray(ALL), fc.subarray(ALL), (declared, approved) => {
        const widening = approved.some((c) => !declared.includes(c));
        if (widening) {
          expect(() => admitPlugin(manifest(declared), approved)).toThrow(PluginRejected);
          return;
        }
        const p = admitPlugin(manifest(declared), approved);
        for (const c of ALL) expect(hasCapability(p, c)).toBe(approved.includes(c));
      }),
    );
  });
});
