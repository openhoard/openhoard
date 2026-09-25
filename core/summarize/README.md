# core/summarize

Part of the OpenHoard trusted core. See [../README.md](../README.md) and
[docs/architecture.md](../../docs/architecture.md). Model routing is not implemented yet; the
enrichment pipeline that will run it is in [core/jobs](../jobs/README.md). Design discussion
welcome via RFC issues.

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
Cleaning removes what hides text, not what the text says, so a client renders it as quoted
data with its provenance and never follows it as instructions (see
[docs/threat-model.md](../../docs/threat-model.md)).
