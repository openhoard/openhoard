import { test } from "node:test";
import assert from "node:assert/strict";
import { validateManifest } from "../lib/index.js";

const base = {
  manifest_version: 1,
  name: "enricher-invoice",
  version: "1.2.0",
  type: "enricher",
  accepts: ["application/pdf"],
  capabilities: ["read:content", "write:fields", "propose:tags"],
  network: [],
  max_exposure: "commercial-only",
};

test("valid enricher manifest passes", () => {
  assert.equal(validateManifest(base).ok, true);
});

test("core-only capabilities are rejected", () => {
  for (const cap of ["grant", "share", "policy:write", "audit:write"]) {
    const r = validateManifest({ ...base, capabilities: [cap] });
    assert.equal(r.ok, false, `${cap} should be rejected`);
  }
});

test("enricher must declare accepts", () => {
  const { accepts, ...noAccepts } = base;
  assert.equal(validateManifest(noAccepts).ok, false);
});

test("packs cannot request capabilities or network", () => {
  const pack = { manifest_version: 1, name: "pack-legal", version: "0.1.0", type: "pack", capabilities: [], network: [] };
  assert.equal(validateManifest(pack).ok, true);
  assert.equal(validateManifest({ ...pack, capabilities: ["read:content"] }).ok, false);
  assert.equal(validateManifest({ ...pack, network: ["example.com"] }).ok, false);
});

test("unknown fields are rejected", () => {
  assert.equal(validateManifest({ ...base, sneaky: true }).ok, false);
});
