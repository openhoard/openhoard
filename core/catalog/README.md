# core/catalog

Part of the OpenHoard trusted core. See [../README.md](../README.md) and
[docs/architecture.md](../../docs/architecture.md).

- [`hash.ts`](src/hash.ts): content hashes (BLAKE3, `b3:`) and tenant-scoped blob ids
  (`b3t:`, ADR-0013).
- [`ingest.ts`](src/ingest.ts): recording source items, their versions and blobs (T-204).
- [`rank.ts`](src/rank.ts): reciprocal rank fusion for hybrid search, with per-channel ranks.
- [`search.ts`](src/search.ts): search behind policy: keyword, vector and hybrid (T-501..T-504).
- [`embeddings.ts`](src/embeddings.ts): versions' vectors per embedding model (T-407).
- [`tagging.ts`](src/tagging.ts): applying tags and the review inbox (T-406).
- [`visibility.ts`](src/visibility.ts): visibility levels, display titles and what non-readers
  see (T-603).
- [`cards.ts`](src/cards.ts): model cards per version (`version_cards`: the summary and which
  provider wrote it, or why none did) and the vocabulary a model may propose from (T-405).
- [`risk.ts`](src/risk.ts): the injection detector's `risk:injection` flag (T-408).
- [`explain.ts`](src/explain.ts): "why can X see this?" (T-606).
- [`health.ts`](src/health.ts): the File Health Report's queries (T-1001).
- [`packs.ts`](src/packs.ts): declarative packs, planned as a reviewed diff and applied only if
  their tests pass (T-607); see [packs/](../../packs/README.md).
- [`rules.ts`](src/rules.ts): the rule tagger (T-403), deterministic tags from path, site,
  file type and a client dictionary, applied before any model sees a file.
- [`activity.ts`](src/activity.ts): who viewed, opened, edited or shared which file (T-205).
- [`extracts.ts`](src/extracts.ts): where a version's bytes are (`contentRef`, the
  `ContentSource` interface that reads them) and the text extracted from them (T-402).

## Extracted text

`saveExtract()` stores a version's extraction in `version_extracts`, one row per version:
`extracted` (kind, text, truncated, metadata, signals, warnings), `failed` (a code),
`unsupported` or `unavailable`, with the extractor's version. Every run rewrites the row, never
adds one, and it goes with its version when the object is purged. Enrichment's extract step
(core/jobs) writes it through its guarded write, so only the current version under the title
the job read gets one. `readExtract()` is for pipeline steps (search T-501, summaries T-405):
the text is content, so whatever shows it to someone gates it as content first (levels,
exposure), never as metadata.

A `ContentSource` returns a version's bytes, or null when it can't reach them. core/storage's
`blobContentSource()` reads what OpenHoard holds (managed zones). Connectors provide the source
for indexed zones (core/jobs `connectorContentSource()`, T-301, which asks the connector for
the version's source marker), and it must return exactly the bytes of the version's blob:
when the item changed at the source since the crawl that made the version (eTag or version
marker differs), it refuses (throws, or returns null) rather than hand over newer bytes, which
belong to the next version and its own job. It throws when the source is unreachable for now,
so the job is retried, and it stops (closes its stream) when the signal it is given aborts.

The contract is enforced, not only stated: the extractor refuses content longer or shorter than
`ref.size` (`input-failed`, retried), and `blobContentSource()` with the tenant's blob key
hashes every byte (BLAKE3) and fails a stream whose bytes don't give `ref.blobId`. OpenHoard
keeps no tenant blob keys yet, so today only the size is checked; a connector's source should
hash the same way once they exist.

**Which zones are extracted** (`ref.zoneKind`): a managed zone's content always; an indexed
zone's only when the server opts in (core/jobs `extract.indexedZones`, default off); a
local-only zone's never on the server (its content isn't meant to reach it), nor a code zone's
yet. For those, no row is written.

**Search gates what it matches.** Extracted text is content. Search (T-501, below) matches
queries against it only for someone the file's levels let read its content (and, for an AI
client, whose trust its exposure allows): a hit on extracted text never surfaces, ranks or even
counts a file for someone who may only see its title or nothing. Summaries (T-405) and
embeddings (T-407) send it to a model only as the exposure allows.

## Embeddings

`version_embeddings` (T-407) holds a version's vectors, per model: its summary (seq 0) and
chunks of its extracted text, each with the text's SHA-256, the vector's size and the kind of
provider that made it. The model is named `<provider id>/<model>` (core/models
`embeddingModelId()`), so another model's vectors are stored beside the old ones and searches
use each only with a query embedded by the same model. `saveEmbeddings()` makes a version's set
under one model exactly what it is given (through enrichment's guarded write);
`readEmbeddings()` lets the embed step keep what didn't change; `versionsWithoutEmbeddings()`
is what core/jobs `reembed()` enqueues after a model change, and `pruneEmbeddings(keep)` drops
old models' vectors once that is done. Vectors are content: search uses them only for a caller
who may have it.

## Model cards and risk flags

`saveCard()` stores a version's model card, one row per version in `version_cards`, upserted:
`summarized` (the filtered summary, the provider's id and kind, the model, the prompt version,
token counts) or `skipped` with a reason (`no-text`, `flagged`, `budget`, `no-provider`).
Enrichment's summarize step (core/jobs) writes it through its guarded write. `viewObjects()`
puts the current version's summary on a card (`CardView.summary`) only when the card isn't
metadata only and the file's exposure still allows the provider's kind (core/policy
`mayProcess()`): a file tightened to local-only after a commercial model summarized it shows no
summary, to anyone. `modelVocabulary()` is the approved vocabulary a model may propose from,
without the `risk` facet.

`applyInjectionFlag()` puts `risk:injection` on an object, or takes the detector's own flag off,
as `rule:builtin/injection-detector` (source `rule`: trusted). `applyRuleTags()` leaves every
`rule:builtin/…` tag alone (pack rule ids can't contain `/`). The value is built-in vocabulary
(core/db `ensureBuiltInVocabulary()`, run by createTenant(), migration 0046 and before every
flag): approved, `exposure: metadata-only`, whatever packs or admins did to it. A flag a person
or a pack put on is never cleared by the detector.

`markNotInjection()` records a tenant admin's decision that an object is not an injection (never
the owner's: an insider attack would come from the owner). It is for the version, content and
name reviewed (`injection_reviews`: version, blob and title): while the object's current version
has that content and the object that name, the detector's flag comes off, the detector doesn't
flag it again, and the summarize step summarizes it; a new version with other content is judged
again, and so is a renamed file (a review from before names were recorded covers nothing). It checks the admin
(core/identity `isAdmin()`) and appends the `injection.review` audit record itself, in the same
transaction; `clearInjectionReview()` (audited as `injection.review-withdrawn`) gives the
detector back its say. The database refuses any change to `risk:injection`'s levels or its
removal, whoever tries (migration 0050); a pack that lists it differently is refused at
validation.

`cardSkipCounts()` counts the tenant's current versions without a summary by reason (for a
health view); `skippedVersions()` lists them, paged, for core/jobs `resummarize()`.

A non-reader's card of a `readable` file carries the summary as the exposure allows, unless a
policy forbids them `read` (a Cedar forbid, or an evaluation error, not merely no permit): then
the card is metadata only (core/policy `decideRead()`'s `readForbidden`).

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

- **Owners are people.** A new object's `ownerId` is `user:` and the id of an existing user who
  isn't retired. An existing object keeps its owner, even one retired since: files change hands
  through the API (offboarding), not through a crawl.

In M1 every zone is index-only: the caller hashes the bytes with `blobIdOf()` and OpenHoard keeps
no copy. Managed zones store the bytes first with core/storage and pass their location. A location
for any other zone is refused, and so is one that differs from the location already recorded for
the blob (`blob-mismatch`): storage paths derive from the blob id.

Every input is checked before anything is written: formats, lengths (`INGEST_LIMITS`) and NUL
characters, which PostgreSQL text can't hold. A refused item throws `IngestError` with a `code`
(`invalid`, `unknown-zone`, `zone-mismatch`, `needs-location`, `blob-mismatch`), so a
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
  starts it over. `markProcessed()` marks only the object's current version, under the title
  the enrichment job saw: a job for a replaced version, or an old title, changes nothing.
  `lockCurrentVersion()` makes the same check for an enrichment step about to write, and holds
  the object's lock while it writes (core/jobs). `markSuperseded()` records that enrichment gave
  up on a replaced version (`superseded_at`); it stays unprocessed, and `listVersions()` says so.
  Only the current version counts for levels, and a replaced version never becomes current
  again.

`viewObjects()` returns what a caller may see of a list of objects, in order, leaving out
hidden, deleted and unknown ones alike. Only active tenant members discover files. Guests and
deprovisioned users see what they can read and nothing else. Non-readers see public-facet tags only,
and only trusted ones: never a model's unreviewed guess.

`viewObjects()`, `levelsFor()` and `explainLevels()` read in several statements, so they run in
one snapshot, `db.withTenant(tenant, work, VIEW_TRANSACTION)`, and refuse weaker isolation. Each
takes at most `MAX_OBJECT_IDS` (10,000) distinct ids and throws a `RangeError` beyond: page your
ids.

**Display titles.** A title can be sensitive on its own ("Termination – J. Smith.docx"). A model
proposes a neutral display title with `proposeDisplayTitle()`, and the owner confirms, edits or
clears it with `setDisplayTitle()`. Non-readers see:

- the owner's display title, or the real title if the owner cleared it;
- `Document` while a model's proposal waits, because model output never reaches non-readers
  unconfirmed;
- the real title when nobody has flagged it.

A rename lets models propose again, even over the owner's earlier decision. `markProcessed()`,
`proposeDisplayTitle()` and `setDisplayTitle()` take the object's lock before comparing the title,
so a decision about a title never lands on a rename that committed meanwhile.

## Reading, behind policy

What a caller may know goes through one gate, `viewObjects()`, which authorizes `read` and
applies the file's levels (T-206). The read API is built on it, in a snapshot (`VIEW_TRANSACTION`):

- `viewObject(id)` and `viewBySource({ source, externalId })`: the caller's view (card or
  title-only), or null, alike for an unknown, deleted, hidden or other tenant's file.
- `listVersions(id)`: newest first, metadata only (id, seq, media type, size, author, created,
  processed, current); null unless the caller can read the file. A restored file keeps its
  history.
- `openContent(id, { versionId? })`: which bytes to serve (blob id, and location for a managed
  zone), never the bytes; the caller reads them from core/storage. It takes a reader, `open`
  authorized, and levels that let the client have content (an AI client's trust against the
  file's exposure: `viewObjects(…, { content: true })`). An earlier version opens only for the
  file's owner, through a first-party client, since the levels and rules describe the current
  content. Null otherwise, alike for every reason; when only the exposure stood in the way, the
  refusal is recorded in the request's recorder (`activity.withhold()`, `takeWithheld()` on an
  `ActivityBuffer`) for the caller to audit (the MCP server does).
- **Exposure (T-604).** An object's exposure resolves like its visibility (above). A card for an
  AI client whose trust label the exposure doesn't reach is `metadataOnly`: title, type, owner,
  tags and dates, never what was derived from the content (summaries and extracted fields attach
  only when it is false, T-404/T-405). OpenHoard's own apps aren't limited by exposure.
  A metadata-only card shows trusted tags only (no unreviewed model tag, a model's reading of the
  content), and search counts facets from, and matches tags against, what the card shows.
  `enrichmentExposure(objectId)` is the exposure the tags give a file before it is processed, for
  the enrichment pipeline's model steps (core/jobs): capped at `commercial-only` until a trusted
  tag gives it one, so an unclassified file never reaches a consumer provider whatever the
  tenant default. Everyone else sees an unprocessed file as `metadata-only`. Search matches a
  metadata-only card on its title and trusted tags only, never its content (text, summary,
  vectors), which it matches only where the client's trust reaches the exposure (Search, below).
- Each checks for a snapshot before it reads anything, and treats input that can't name
  anything (a malformed id, a NUL byte) as unknown.

Views carry `primaryTag`, the file's home, when the caller is shown that tag. The other reading
functions (`levelsFor`, `explainAccess`, `primaryTagOf`, `sourceItemState`, `listOpenReviews`…)
answer without a caller's policy, for enrichment, connectors, admins and the API's own checks.
`read-surface.test.ts` classifies every export as gated, write, trusted, pure or value, and fails
on a new export until it is classified; it also checks each gated read reaches the gate before
reading anything but source refs, and answers nothing for a caller `authorize()` refuses.

## Activity

`activity_events` records who viewed, opened, edited or shared which file, when, and through
which client (T-205), for `recent` (T-506), ranking and the Health Report. It is not the audit
log: no hash chain, no advisory lock, repeat views merge, and `pruneActivity()` drops old
events in bounded batches.

- `viewObject`, `viewBySource` and `listVersions` record a `view` when a reader looked at the
  file (a non-reader's card or title isn't one); `openContent` an `open` of the version it
  served. Listings (`viewObjects`) and search record nothing, and a refused or unknown file
  leaves no event.
- They run in a read-only snapshot, so they record into `request.activity` (an
  `ActivityBuffer`), which their request type (`RecordedRequest`) requires: without one they
  throw before reading. The caller writes it with `writeActivity()` in its own transaction after
  the snapshot, never nested in it.
- `ingest` records an `edit` by the version's author when the source names the author as a
  user (`user:usr_…`) and when they saved it (`modifiedAt`), with the source as `origin`.
  Without both, nothing: a first crawl isn't today's work.
- An AI read is a view or open through a client that isn't first-party: events keep the
  client's id and trust, and `listActivity({ clientTrusts })` filters on it.
- A view or open repeating one (same person, file, version, client) less than
  `REPEAT_WINDOW_MS` (15 minutes) after it merges into it. Imported events (the M365 feed,
  T-307) carry their origin's event id, so a re-import adds nothing.
- `listActivity()` is trusted: it names files the caller may not know about. `recent` passes
  them through the gate before showing any. It pages newest first with `after` (the last
  event's time and id).
- `recentObjects()` (T-506) is that `recent`: the caller's own events only (the actor is the
  request's principal, never a parameter), by action, time range and media type, newest first
  per file, every file through `viewObjects()`. A gated listing: it records nothing.
- An insert takes FOR KEY SHARE on its object row (the foreign key). In a transaction that also
  appends audit, write activity first: audit's lock is last.
- `share` is a type waiting for the share feature; nothing records it yet.

`read-surface.test.ts` sorts every gated read into recording or listing, and checks each
recording read requires a recorder, records exactly its event, and nothing for a refusal.

## Search

`searchObjects({ query, limit, vectors?, snippets? }, tuning?)` (T-504, hybrid since T-501..T-503)
filters inside the query, then uses the gate, then fuses:

1. SQL picks the candidates the caller may see: files they own or read by a grant (on the file,
   or on one of its trusted tags), and, for members, files whose effective level is discoverable
   or readable (the same rule as `levelsFor()`). A key's scope narrows it, and needs both
   `search` and `read`.
2. **Keyword (T-501).** Words match each object's search document (core/db `search_documents`,
   kept by triggers: title A, tag values B, summary C, extracted text D; `simple` configuration,
   no stemming, see core/db), through its GIN indexes, ranked by weighted `ts_rank`. Each
   candidate is matched once per way it may be shown: a reader whose card isn't metadata-only
   on everything (the summary only while the file's exposure still allows the provider that
   wrote it, as the card shows it); a reader's metadata-only card (T-604) on the title and
   trusted tags; anyone else on the title they are shown and trusted tags of public facets.
   `facet:value` terms filter by the tags that view shows. Up to `SEARCH_CANDIDATES` (1,000).
3. **Vector (T-502).** `vectors` are the query's words embedded, one per model (core/models
   `embedQuery()`: local providers only by default). For each, the nearest summaries and chunks
   (`VECTOR_NEIGHBOURS`, 50, from cosine similarity 0.3 up) among files SQL expects the caller
   may have the content of: a reader, the file's exposure reaching the client. The plan is spike
   S1's rule, chosen here, never by the planner: count the visible vectors (capped at
   `EXACT_SEARCH_ROWS`, 50,000, so the count is bounded); at or below it, exact search; above it,
   the model size's partial HNSW index with `hnsw.iterative_scan = relaxed_order` and
   `hnsw.ef_search = 200`, set for that statement only. `vectorPlans` says which ran. Sizes
   without an index (not 384, 768, 1024 or 1536) are always searched exactly.
4. `viewObjects(…, { search: true })` checks every candidate from both: `read` and `search`,
   pack rules included (a forbid on `search` takes a file out), and the levels. A keyword match
   is kept only if it holds for the view the caller got; a vector match only for a reader's card
   that isn't metadata-only. So a file can only match on what its card shows the caller:
   nothing content-derived (text, summary, model tags, vectors) reaches a caller who may not
   have the content, through hits, ranks, counts, facets or suggestions.
5. **Fusion (T-503).** The survivors are ranked per channel (keyword; vector, one list per
   model; activity: the caller's own views, opens and edits in the last 30 days, T-205, at half
   weight) and fused with Reciprocal Rank Fusion (`fuseChannels()`, rank.ts). Ranks count
   survivors only, so a file the gate removed moves nobody. Title-only views are ordered
   without their update time, which they don't show. Each hit has an `explanations[i]`: the
   fused score, and per channel its rank (keyword: the fields its words matched, only among
   those the view shows; vector: the model and similarity).

**Snippets.** `snippets: true` adds highlighted lines of extracted text to a hit's explanation,
only for OpenHoard's own apps (first-party) and a hit whose keyword match was on the text: plain
text with highlight offsets, control characters folded, never markup. Document text can carry
instructions for an AI, so AI clients get no snippets in M1 (the T-405 output filter is for
model answers, not documents).

**Degrading.** Without an embeddings model (or when it fails), callers pass no `vectors` and
search is keyword only. Without extracted text, titles and tags still match.

**Facets and suggestions (T-505).** `facets` counts, per facet and value, every match in `total`
(not only the hits), from the tags each match shows the caller: a hidden file, or a tag the
caller isn't shown, adds nothing. `suggestTitles({ prefix, limit })` returns distinct titles as
the caller is shown them, with a word starting with `prefix`, from the same candidates and gate
as search. The leak harness (packages/testkit) probes results, totals, facets, suggestions and
card text against a fake tenant imported into the database.

Titles and queries are split on `.`, `_`, `/` and `\` first: Postgres reads `Forecast.xlsx` as
one token.

**Limits (option 1).** SQL knows grants, ownership and levels, not a pack's Cedar rules. A file
someone may read only through a pack permit may be missed by their search (it still opens by
id), and is never matched on its content. Past the candidate cap, or among the nearest vectors,
SQL's guess picks which candidates are checked, so a pack-forbidden file can crowd out a
visible one or set `totalIsLowerBound` (it is never shown or counted). Keyword candidates come
through the GIN indexes; working out who may see them, and the vector search's eligible set
(every file the caller reads), still visits each of the caller's files per query: fine at tens
of thousands, seconds at 100,000+ (`scripts/vector-recall.ts` measures it). Spike S1's
per-principal visible-row counts and a set-based level computation are the next step.

**Timing.** Because SQL works out every candidate's levels, a search takes longer the more files
there are that the caller can't see: about 6 ms per 4,000 hidden files (review measurement). A patient
caller can estimate, from response times, roughly how many files exist that they can't see (a
count, never which files or what is in them). Padding responses or precomputing visible sets
closes it; neither is done in M1.

**One HNSW index per size, shared by every tenant.** An iterative scan filters by tenant and
access as it goes, so another tenant's dense cluster near a query can use up its tuple budget
(`hnsw.max_scan_tuples`, set to `HNSW_MAX_SCAN_TUPLES`, 40,000, for the HNSW statement). A scan
that comes back with fewer than the neighbours asked for falls back to exact search, and
`vectorPlans` reports the plan that answered. Partition the vector indexes by tenant before
hosting many tenants on one database.

**Vectors and their provider.** Like a summary, a vector matches only while the file's exposure
still allows the kind of provider that made it: a file tightened to local-only since a commercial
model embedded it isn't found by those vectors (its words still match). Re-embedding it with an
allowed provider is `reembed()` after a model change; tightening doesn't enqueue it yet.

**Recall (T-502).** `vector-recall.test.ts` builds 1,200 files of 384-dimension vectors and
checks filtered recall@10 on the HNSW path stays within 5 points of unfiltered, and that the
production plan is exact for small visible sets; `pnpm --filter @openhoard/core-catalog
bench:recall -- --url postgres://…` runs the same at scale on native PostgreSQL.

**Upgrade (option 3).** Compile the subset of Cedar that packs use (tag, zone, group and client
conditions) into the candidate SQL, keep the gate as the final check, and drop the candidate cap
so counts are exact. `search.test.ts` pins today's behaviour; flip that test when this lands.

## Why can X see this?

`whoCanAccess()` (T-806) is the list view of the same question for one file: its owner, every
live grant that reaches it (on the file, or on one of its grantable tags) with the user's or
group's name, the grants on tags only a model guessed, and its levels. Like `explainAccess()`,
it is for the file's owner and admins only.

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

## File Health Report

`healthReport(tx, tenant, { userId }, options)` (T-1001) is what a tenant's admin should look at
among the files OpenHoard indexes, found from what the catalog already holds:

| Section         | A live file is listed when                                                                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publicLinks`   | its source shares it by a link anyone can open                                                                                                                                                     |
| `organization`  | its source shares it with the whole organization, or a group holding most of the tenant's current members (`wideGroupShare`, 0.5) has a grant reaching it                                          |
| `sensitiveWide` | it is in either of those and carries a trusted tag whose value restricts it: visibility `hidden`, or exposure `metadata-only` or `local-only`                                                      |
| `guests`        | its source shares it with someone outside, or a guest, or a group a guest is in, holds a grant reaching it                                                                                         |
| `formerStaff`   | someone locked, disabled by the identity provider or retired made it or changed it last (as the source says, unless they were provisioned again), owns it, or holds a grant reaching it themselves |
| `unmatched`     | its source shares it with a person or group OpenHoard doesn't know (a SharePoint site group, someone not provisioned): they get nothing here                                                       |
| `stale`         | its source last saw it change more than `staleAfterDays` ago (1095)                                                                                                                                |
| `duplicates`    | another live file's current content is the same, byte for byte (empty files aside); `bytes` is what the extra copies take                                                                          |
| `large`         | its current content is over `largeBytes` (1 GiB)                                                                                                                                                   |

A grant reaches a file when it is live and on the file, or on a tag the file carries as a
trusted tag, as `authorize()` reads grants. Each section has a count and bytes over all its
files, and the first `limit` (100) of them, largest (or oldest) first, each with its title,
where it is at its source, its size and a line saying why.

What it reads: sharing beyond grants is `source_shares` (core/jobs keeps it equal to a source's
permissions: links, "everyone", guests, and people or groups that matched nobody here), read
while it hasn't lapsed; who made and last changed a file and when is on `source_refs`, as the
source said at the last sync, matched to users by their `external_id` when the report is read
(someone provisioned again under the same id has not left).

What it can't say:

- A file no source dated isn't judged for `stale` (`undated`), and one no source named a maker
  or changer of isn't judged for those (`unattributed`). Makers and changers are matched by the
  id the identity provider gave them (`external_id`) only: one that matches nobody provisioned
  here is counted, not listed (`unknownPeople`), since unknown is not gone. That is someone who
  left before OpenHoard was connected, and every file in a tenant whose people are local
  accounts.
- What someone who left can still reach through a group they are in isn't listed file by file
  (it would be every file of a site): `formerStaffInGroups` counts those people, to take out of
  their groups.
- Sharing is known only for sources whose permissions are imported, and for files synced since
  it has been kept: complete after the source's next full crawl. A file with none kept reads as
  not shared.
- A file every member can find or read by its visibility level alone isn't listed (that is the
  tenant's own setting; `explainLevels()` says why), and pack rules that permit beyond grants
  aren't followed.
- Of the problems the fake tenant is seeded with (packages/testkit), it finds public links,
  guests, files made by someone who left, stale files, duplicates and sensitive files in an
  open site. It does not look for broken inheritance or over-long paths (the catalog keeps
  neither an item's path nor which matched permissions are inherited); a file name carrying
  instructions is the injection detector's flag (`risk:injection`), not a section here.

Each file listed carries its `reasons` (who can open it and how, who left, since when) and the
same as one compact `detail` line. [`health-format.ts`](src/health-format.ts) (T-1002) turns a
report into what its reader gets, in words that need no knowledge of OpenHoard ("can view",
"your own labels", "people outside your organization"): `healthText()`, a page for the tenant's
owner (each finding, most pressing first, with why it matters, what to do and its first files;
then what is clean and what couldn't be checked), and `healthCsv()`, a line for every file
listed. `reasonText()` words one reason; `healthWording()` a finding, for the thresholds it was
judged by. An operator runs both as `openhoard admin health report`
([apps/server](../../apps/server/README.md)).

It is for tenant admins only, like `whoCanAccess()`, and checks the asker is one itself
(`HealthError` `not-admin`): it names every live file by its real title, whoever may read it.
It opens nothing: a file's content still goes through the gate. Run it in one snapshot
(`VIEW_TRANSACTION`). Every section reads each live file's current version, and the sections
that follow grants do so file by file: about twenty statements over the tenant's files, not
measured on a large one.

## Tagging

Nothing creates vocabulary, and nothing a model guesses changes who can see a file, without a
person saying yes. `proposeTag()` applies a tag straight away only when that is safe:

| The value is…                                                  | From a rule, pack or person | From a model           |
| -------------------------------------------------------------- | --------------------------- | ---------------------- |
| not in the approved vocabulary                                 | review: new-value           | review: new-value      |
| approved, and sets visibility or exposure, or has a live grant | applied                     | review: sensitive      |
| approved, and below the confidence threshold (0.75)            | applied                     | review: low-confidence |
| approved, otherwise                                            | applied                     | applied                |

A single-value facet (`single` in a pack, e.g. `sensitivity`) holds one value per file. A second
value replaces the first straight away only when a person proposes it and it loosens no level
(`internal` → `restricted` does; `restricted` → `internal` doesn't). Anything else waits in
review (`conflict`, unless another reason came first). A decision that would take another value
off, whatever the item's reason, is refused (`TagError` `conflict`) until the reviewer passes
`replace: true`; the value chosen is then the reviewer's, so a rule change can't leave the facet
empty, and it takes over the file's home. Rules never propose a value where a person chose one,
and on one facet only the first rule in the list that matches proposes (`skipped` lists the rest).

A tag with an open review item waits for that item, whoever proposes it again, with one exception:
a rule, pack or person proposing an approved value that waits only because a model proposed it
applies it. A person's proposal also closes the model's item, as approved by them; a rule's or
pack's leaves it open, since nothing automated records a sensitive tag as approved.

A trusted source proposing a tag the object carries as an unreviewed model tag takes it over, so
grants match it. A rule or pack keeps the model's guess on the tag (`model_applied_by`,
`model_confidence`), so when the rule stops giving it the tag goes back to being the model's
unreviewed tag, and still tightens visibility, rather than disappearing. A person proposing a
tag the object carries from any other source makes it theirs, and approving a model's item for
a tag a rule gives does the same: rule changes no longer take it off.

Inputs are checked before anything is written. A refused proposal or decision throws `TagError`
with a `code`: `invalid` (a value that isn't a slug, a label over 200 characters…),
`unknown-facet`, `unknown-object`, `unknown-review` or `already-resolved` (another reviewer
decided the item first).

The inbox is `tag_reviews` in core/db. `approveReview()`, `rejectReview()` and `mergeReview()`
decide items, and items stay as the record of who decided:

- **Approve:** the tag applies, marked reviewed. A new value joins the vocabulary.
- **Reject:** nothing applies. Rejecting a new value closes every item that proposes it, unless
  the value has been approved since.
- **Merge:** an existing approved value is applied instead.

Those three trust their caller. [`review-inbox.ts`](src/review-inbox.ts) (T-1403) is the inbox
as one person may have it: `reviewInbox()` lists, and `reviewItemFor()` gives, only items on
files that person may tag (`viewObjects()` with `tag: true`: they read the file and `tag` is
authorized; a tenant admin as such gets nothing more). `decisionReach()` says how far a
decision goes: `vocabulary` (approving or rejecting a value that isn't approved: it counts for
every file) and `loosens` (rejecting a value that sets a level, which tightens the file while
it waits, or replacing a tighter value of a single-value facet) also take a tenant admin;
merging a new value into an approved one doesn't. `decideReview()` makes the decision and
appends the `tag.review` audit record in the same transaction. Check in a snapshot, then decide
in a write transaction, as the `tag` tool does; `decideReview()` checks again that the person
is still current and, under the decision's locks, how far it reaches.

Access decisions read tags through `tagsForDecisions()`:

- **All tags set visibility and exposure.** These resolve most-restrictive-wins, so an extra tag
  can only tighten them.
- **Grants match only trusted or reviewed tags.** This holds even when a value gains levels or a
  grant after a model has used it.

## Primary tag

A file's primary tag is its home (T-409): the one tag that says where it belongs, as its folder
did. It decides the default view and breadcrumb, the path a native open or a sync uses, who a
file goes to at offboarding, and the project's email-in and digest. It grants nothing; access
comes from the tag itself.

- At most one per file, and always one of its trusted tags. The database holds both rules.
- A person sets or clears it: `setPrimaryTag()`, `clearPrimaryTag()`, `primaryTagOf()`.
- A rule with `primary: true` sets it when it applies its tag (a folder layout carries over:
  `Projects/Apollo/**` → `project:apollo`). A home a rule set goes when no primary rule applies
  its tag any more, including while that tag waits in review. Rules never replace or clear a
  home a person chose; the first matching primary rule wins.
- A model proposes it with `proposePrimaryTag()`: a review item (reason `primary`, one open per
  file) that a person approves or rejects. It applies nothing and doesn't tighten levels. A
  waiting proposal whose tag has left the file is withdrawn when the model proposes again.
- It goes when its tag goes, and when a rule hands its tag back to a model. A value a person
  chose on a single-value facet takes over the home from the value it replaces, as theirs.
- Setting and clearing it trust the caller, like tagging: the API authorizes and audits.

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
- **Unicode:** rules and inputs are compared in NFC, so a decomposed name (macOS writes "é" as
  "e" and a combining accent) matches a rule written with the composed one.
- **Applying:** `applyRuleTags()` makes the object's rule tags exactly what the rules give now.
  Matches apply with source `rule`; values that aren't in the approved vocabulary go to review
  like anyone else's. Rule tags no rule gives any more are taken off and returned as `removed`: a
  file moved from `Clients/Acme/` to `HR/` loses `client:acme` and the grants on it, even when a
  person approved the new value the rule proposed. A model's guess a rule took over goes back to
  the model instead (`reverted`), and the rules' open items for tags no rule gives are closed as
  `withdrawn`. Tags from people, packs and models are left alone. Pass the complete rule set.

## Locks

Catalog functions take advisory locks (`locks.ts`) in one order, so they can queue behind each
other but never deadlock among themselves:

```text
source item (7423) → tag value (7425) → object (7422) → the object's rows → audit appends (7421)
```

Ingest takes the source item, then the object. Review decisions take the value, then the object,
then the item; rejecting a new value locks the other items for it in id order. Everything that
tags, titles or marks an object takes its lock before touching its rows. A transaction that makes
several decisions can still deadlock with another doing the same in another order: decide one item
per transaction, or retry on `40P01`.
