# core/catalog

Part of the OpenHoard trusted core. See [../README.md](../README.md) and
[docs/architecture.md](../../docs/architecture.md).

- [`hash.ts`](src/hash.ts): content hashes (BLAKE3, `b3:`) and tenant-scoped blob ids
  (`b3t:`, ADR-0013).
- [`rank.ts`](src/rank.ts): reciprocal rank fusion for hybrid search.
- [`tagging.ts`](src/tagging.ts): applying tags and the review inbox (T-406).

## Tagging

Nothing creates vocabulary, and nothing a model guesses changes who can see a file, without a
person saying yes. `proposeTag()` applies a tag straight away only when that is safe:

| The value is…                                                  | From a rule, pack or person | From a model           |
| -------------------------------------------------------------- | --------------------------- | ---------------------- |
| not in the approved vocabulary                                 | review: new-value           | review: new-value      |
| approved, and sets visibility or exposure, or has a live grant | applied                     | review: sensitive      |
| approved, and below the confidence threshold (0.75)            | applied                     | review: low-confidence |
| approved, otherwise                                            | applied                     | applied                |

A tag with an open review item waits for that item, whoever proposes it again.

The inbox is `tag_reviews` in core/db. `approveReview()`, `rejectReview()` and `mergeReview()`
decide items, and items stay as the record of who decided:

- **Approve:** the tag applies, marked reviewed. A new value joins the vocabulary.
- **Reject:** nothing applies. Rejecting a new value closes every item that proposes it.
- **Merge:** an existing approved value is applied instead.

Access decisions read tags through `tagsForDecisions()`:

- **All tags set visibility and exposure.** These resolve most-restrictive-wins, so an extra tag
  can only tighten them.
- **Grants match only trusted or reviewed tags.** This holds even when a value gains levels or a
  grant after a model has used it.
