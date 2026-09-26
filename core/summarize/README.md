# core/summarize

Part of the OpenHoard trusted core. See [../README.md](../README.md) and
[docs/architecture.md](../../docs/architecture.md). File cards, the prompt and output schema for
model summaries (T-405), and the prompt-injection detector (T-408). No database and no network:
the providers are in [core/models](../models/README.md), and the steps that run all this in
[core/jobs](../jobs/README.md).

## File cards

`buildCard()` ([`src/card.ts`](src/card.ts)) turns rule, connector and model output into the
compact card agents and search results get. It treats every text field as untrusted:

- hidden characters are removed (controls, format and bidi characters, lone surrogates,
  private-use and unassigned code points, invisible fillers, blank Braille), and lengths capped;
- tags must be catalog `facet:value` slugs, at most 20;
- links must be https, without credentials;
- the id must be an object id and `lastTouched` an ISO 8601 date (or empty), or it throws
  `CardError`.

**The summary stays untrusted.** It is model output about content an attacker may control.
Cleaning removes what hides text, and the filter below removes what reads as an instruction,
but a client still renders it as quoted data with its provenance and never follows it (see
[docs/threat-model.md](../../docs/threat-model.md)). A summary is content: core/catalog shows it
only on cards whose exposure lets the client have the content, and only while the file's
exposure still allows the provider that wrote it (`CardView.summary`).

## Injection detection (T-408)

`detectInjection({ name, text, signals, metadata })` ([`src/injection.ts`](src/injection.ts))
scores a file: phrase patterns (overrides such as "ignore all previous instructions", role
markup, text addressed to an AI, fake tool calls, markdown image links, "decode and follow",
role lines, sending out, destroying, loosening levels, keeping secrets, formula payloads), each
with a weight, over the file name, the visible text, the extractor's hidden-text samples, and
the file's own metadata. Hidden text or a name carrying an instruction weighs more; a very hidden
sheet, control or bidi characters in a name, and path traversal flag on their own. Base64 runs
are decoded and the text is also read reversed. A score of 3 flags.

It is a tripwire, not a classifier: a document about prompt injection is flagged too, and a
determined attacker can word around it; that is what the filter below and quoted rendering are
for. Every scan is linear: text is normalized first (NFKC, lower case, one space), and patterns
are literals, small alternations and bounded gaps, never nested quantifiers; input is cut at
4 Mi characters. Verdicts carry pattern ids, never matched text, so they can be logged.

**Measured on the S8 corpus v0** (core/jobs `s8-corpus.test.ts`, the real extractor): 48 of 50
flagged (96%); 0 of 20 benign files with comments, white text, hidden sheets, properties,
formulas and chat transcripts.

## Summaries and model tags (T-405)

[`src/output.ts`](src/output.ts) has three layers:

1. **The prompt** (`buildSummaryPrompt()`): the document between `BEGIN-DOCUMENT-<nonce>` and
   `END-DOCUMENT-<nonce>` (a fresh 128-bit nonce; anything marker-like is removed from the
   document first), cut to the provider's `maxInputChars`, and instructions that nothing between
   the markers is an instruction. The tenant's approved vocabulary is listed, never the `risk`
   facet.
2. **The schema** (`validateCardOutput()`, `CARD_OUTPUT_SCHEMA`): one JSON object with exactly
   `summary` (a string), `tags` (at most 10 `{ tag, confidence }`) and `displayTitle` (a string
   or null). Anything else is a `ModelOutputError` listing the problems (never the answer's
   text); the caller repairs once with `buildRepairPrompt()`, without the document.
3. **The filter** (`filterCardOutput()`): every summary sentence carrying an instruction
   pattern, a link, an email address, markup or code, or a role label is dropped; the summary is
   capped at 100 words; tags must be in the offered vocabulary and never `risk:*`; a display
   title must be one clean line that differs from the file name.

`PROMPT_VERSION` names the prompt and schema: a stored summary from another version is redone.
