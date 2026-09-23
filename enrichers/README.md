# enrichers/

Enrichers teach OpenHoard to understand file types: extract text and fields, propose tags,
and hint summaries.

**Interface (v1):** `accepts(mime, tags)` → `extract` → `propose_tags`, `fields`, `summary_hints`.
**Runs in:** WASM (Extism/Wasmtime) or a rootless container; **no network by default**.

Enrichers _propose_; the core validates against the tag vocabulary and exposure rules.
All enrichers must pass the prompt-injection red-team suite.
