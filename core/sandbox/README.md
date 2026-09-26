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
- `mayReceiveContent(plugin, exposure)` is the gate for content (T-604): `read:content` approved,
  the file no more sensitive than the manifest's `max_exposure` (`metadata-only`, the default,
  means no content), and, as for AI clients, `local-only` content only for a plugin with no
  network (one with any network host counts as a commercial service). Whatever hands a plugin
  content (the runtime to come, T-9xx: an enricher's `extract`, a connector's `write`) must ask it
  for every file, with the file's resolved exposure, and send metadata only when it says no.

Running plugins (WASM through Extism/Wasmtime, or isolated OS processes, with resource and
network limits; no containers) and package signing are not implemented yet. Design discussion
welcome via RFC issues.
