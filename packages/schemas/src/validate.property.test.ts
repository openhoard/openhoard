import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CORE_ONLY_CAPABILITIES, isPluginManifest, validatePluginManifest } from "./index.js";

const valid = {
  manifest_version: 1,
  name: "enricher-invoice",
  version: "1.2.0",
  type: "enricher",
  runtime: "wasm",
  accepts: ["application/pdf"],
  capabilities: ["read:content"],
  network: [],
  max_exposure: "commercial-only",
};

describe("validatePluginManifest (properties)", () => {
  it("never throws, whatever it is given, and agrees with isPluginManifest", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const r = validatePluginManifest(value);
        expect(r.ok).toBe(isPluginManifest(value));
        expect(r.ok ? r.errors.length === 0 : r.errors.length > 0).toBe(true);
      }),
    );
  });

  it("rejects any manifest holding a core-only capability, alongside anything else", () => {
    fc.assert(
      fc.property(fc.constantFrom(...CORE_ONLY_CAPABILITIES), fc.boolean(), (cap, withOthers) => {
        const capabilities = withOthers ? ["read:content", cap] : [cap];
        expect(validatePluginManifest({ ...valid, capabilities }).ok).toBe(false);
      }),
    );
  });

  it("rejects any unknown top-level key", () => {
    const known = new Set(Object.keys(valid));
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((k) => !known.has(k) && k !== "__proto__"),
        fc.jsonValue(),
        (key, value) => {
          expect(validatePluginManifest({ ...valid, [key]: value }).ok).toBe(false);
        },
      ),
    );
  });
});
