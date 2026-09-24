# core/sandbox

Part of the OpenHoard trusted core. See [../README.md](../README.md) and
[docs/architecture.md](../../docs/architecture.md) and
[ADR-0012](../../docs/adr/0012-plugin-sandbox.md).

- `admitPlugin(manifest, approved)` validates a plugin manifest and the admin's approval, which
  can only narrow the declared capabilities. It validates and returns a deeply frozen copy of
  the manifest, so later changes to the caller's object, or getters, can't alter what was
  admitted.
- `hasCapability(plugin, capability)` is the default-deny gate the core calls before handing a
  plugin anything.

Running plugins (WASM through Extism/Wasmtime, or isolated OS processes, with resource and
network limits; no containers) and package signing are not implemented yet. Design discussion
welcome via RFC issues.
