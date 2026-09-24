# core/catalog

Part of the OpenHoard trusted core. See [../README.md](../README.md) and
[docs/architecture.md](../../docs/architecture.md).

- [`hash.ts`](src/hash.ts): content hashes (BLAKE3, `b3:`) and tenant-scoped blob ids
  (`b3t:`, ADR-0013).
- [`ingest.ts`](src/ingest.ts): recording source items, their versions and blobs (T-204).
- [`rank.ts`](src/rank.ts): reciprocal rank fusion for hybrid search.
- [`tagging.ts`](src/tagging.ts): applying tags and the review inbox (T-406).
- [`visibility.ts`](src/visibility.ts): visibility levels, display titles and what non-readers
  see (T-603).
- [`explain.ts`](src/explain.ts): "why can X see this?" (T-606).
- [`packs.ts`](src/packs.ts): declarative packs, planned as a reviewed diff and applied only if
  their tests pass (T-607); see [packs/](../../packs/README.md).
- [`rules.ts`](src/rules.ts): the rule tagger (T-403), deterministic tags from path, site,
  file type and a client dictionary, applied before any model sees a file.

## Ingest

`ingest()` records that an item exists in a source, with some content:

```text
one source item (source, external id) → one object → versions 1, 2, 3… → one blob each
```

- **One blob per content.** Identical bytes in a tenant are one blob, however many objects and
  versions point at it.
- **No empty versions.** An item seen again with the same content and media type adds no
  version. Only its source reference (eTag, URL, sync time) and its title are refreshed.
- **Deletes are soft.** `removeFromSource()` marks the object deleted and keeps its rows.
  Ingesting the item again restores it.
- **Zone and owner stay.** A crawl can't move an object to another zone or give it to someone
  else.
- **Skip unchanged items.** `sourceItemState()` returns the eTag and the current version's
  source marker, so a connector can skip an item before downloading it.

In M1 every zone is index-only: the caller hashes the bytes with `blobIdOf()` and OpenHoard keeps
no copy. Managed zones store the bytes first with core/storage and pass their location.

Every input is checked before anything is written. A refused item throws `IngestError` with a
`code` (`invalid`, `unknown-zone`, `zone-mismatch`, `needs-location`, `blob-mismatch`), so a
connector can report it and go on. Connectors should:

- ingest one item per transaction, and retry on deadlock (`40P01`) or serialization failure
  (`40001`);
- apply one item's events in the source's order. A stale update processed late would become the
  current version, or bring back a deleted item.

Ingests of one source item are serialized with an advisory lock, so an item that arrives twice
at once still becomes one object.

## Visibility

What someone who can't read a file learns about it:

| Visibility   | A non-reader gets                                                     |
| ------------ | --------------------------------------------------------------------- |
| hidden       | nothing: the file doesn't appear to exist                             |
| discoverable | a title-only card: display title, type, owner, public tags, "request" |
| readable     | the card, never the content                                           |

`levelsFor()` resolves an object's levels:

- **Trusted tags decide.** Tags from rules, packs, people and reviewed model tags, on approved
  values, resolve most-restrictive-wins. With none, the tenant default applies, which is
  `hidden` and `metadata-only` until an admin or a pack changes it.
- **Everything else can only tighten.** Unreviewed model tags, model tags waiting in review and
  unapproved values count only when they are stricter. A model saying a file is sensitive hides
  it at once. A model saying it is public changes nothing until a person agrees.
- **Unprocessed objects are hidden.** Until enrichment finishes the current version
  (`markProcessed()`), an object is `hidden` and `metadata-only`. A new version or a rename
  starts it over.

`viewObjects()` returns what a caller may see of a list of objects, in order, leaving out
hidden, deleted and unknown ones alike. Only active tenant members discover files. Guests and
deprovisioned users see what they can read and nothing else. Run it in one snapshot:
`db.withTenant(tenant, work, VIEW_TRANSACTION)`.

**Display titles.** A title can be sensitive on its own ("Termination – J. Smith.docx"). A model
proposes a neutral display title with `proposeDisplayTitle()`, and the owner confirms, edits or
clears it with `setDisplayTitle()`. Non-readers see:

- the owner's display title, or the real title if the owner cleared it;
- `Document` while a model's proposal waits, because model output never reaches non-readers
  unconfirmed;
- the real title when nobody has flagged it.

A rename lets models propose again, even over the owner's earlier decision.

## Why can X see this?

`explainAccess()` replays one decision the way the product makes it, using the same principal
resolution, grants, `authorize()` and levels. It returns what decided the outcome:

- **For an allow:** the permitting policies, plus the grants behind them (direct or through a
  group, with expiry) or ownership. Tests check on every fixture that the listed grants alone
  still allow the action, and that nothing else does.
- **For a deny:** every blocker, most fundamental first. A blocker is one of:
  - a deleted file;
  - an account stop (retired, locked, deactivated by the provider);
  - a pack's forbid;
  - a policy error;
  - no grant.

  It also lists grants that would apply once a person reviews a model's tag.

- **The object's levels:** which tags set them, why an untrusted tag only tightens, and the
  tenant default.
- **What the user sees in a listing,** and why the listing shows nothing when it doesn't.

It also returns a one- to three-sentence summary, for example:

> Ana can read "Q3 plan.docx": through group Sales's read grant on client:acme, until
> 2026-12-01.

It answers for now. Questions about the past need the history of memberships, tags and stops,
which lives in the audit log.

It is for admins and owners only: it shows real titles, every tag, grant ids and who locked an
account. Run it in one snapshot: `db.withTenant(tenant, work, VIEW_TRANSACTION)`.

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

## Rules

Packs and admins give rules as data. Check them with `validateRules()`:

```json
[
  { "id": "finance-folder", "tag": "department:finance", "when": { "path": "Finance/**" } },
  { "id": "spreadsheets", "tag": "kind:spreadsheet", "when": { "extension": ["xlsx", "csv"] } },
  { "id": "clients", "facet": "client", "dictionary": { "acme": ["Acme", "Acme Corp"] } }
]
```

- **Conditions:** a rule can test the path (a glob), the site, the file extension and the media
  type. All of a rule's conditions must hold.
- **Dictionaries:** a term matches as whole words in the title or in any one path segment, ignoring
  case, over Unicode letters and digits.
- **Speed:** matching never builds a regular expression from rule text, so a rule can't make
  tagging slow.
- **Applying:** `applyRuleTags()` applies the matches with source `rule`. Values that aren't in
  the approved vocabulary go to review like anyone else's.
