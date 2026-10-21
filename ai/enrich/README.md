# @openhoard/ai-enrich

The enrichment steps that read a version's content or send it to a model: text extraction
(`extract-text`), summaries and model tags (`summarize`), embeddings (`embed`). They are
[core/jobs](../../core/jobs/README.md) `EnrichStep`s, kept out of the core so that no `core/*`
package imports a model client ([ai/models](../models/README.md)) or an enricher
([enrichers/extract](../../enrichers/extract/README.md)) (T-1406). The pipeline itself (one job
per version, guarded writes, exposure checks before a step that names a provider, retries and
the salvage run) is core/jobs'.

`defaultEnrichSteps({ content, extract, summarize, embed })` is the list a server passes to
`startJobs({ steps })`, in this order:

```text
extract-text → injection-flag → rule-tags → summarize → embed
```

- `extract-text` (`extractStep`, [extract.ts](src/extract.ts), T-402), when the server passes
  `content` (where versions' bytes are read: core/storage `blobContentSource()`, connectors'
  sources);
- `injection-flag` and `rule-tags`, the core's (core/jobs `coreEnrichSteps()`), always;
- `summarize` (`summarizeStep`, [summarize.ts](src/summarize.ts), T-405), only with `content`
  and `summarize: { router, budget }` (ai/models): no model runs unless an admin configures one
  (the PRD's cost guard: nothing reads the whole corpus through a model by default);
- `embed` (`embedStep`, [embed.ts](src/embed.ts), T-407), only with `content` and `embed: {
router, budget }` with a provider that has an `embedModel`. Without one, search is keyword
  only.

**Text extraction** (`extract-text`, [extract.ts](src/extract.ts), T-402). The step reads the
version's bytes through the `ContentSource` (core/storage), extracts them in a limited child
process ([@openhoard/enricher-extract](../../enrichers/extract/README.md)), and stores the result
per version with core/catalog `saveExtract()` through `write`:

| The extractor answers                                            | Stored        | The job           |
| ---------------------------------------------------------------- | ------------- | ----------------- |
| text and metadata                                                | `extracted`   | goes on           |
| a type it doesn't read (checked before any byte is read)         | `unsupported` | goes on           |
| no source reaches the bytes (no connector serves the source)     | `unavailable` | goes on           |
| the file's own failure: malformed, encrypted, a zip bomb, out of | `failed`      | goes on           |
| memory, a crash                                                  |               |                   |
| a timeout, or killed by a signal nobody sent: tried once more    | the second    | goes on           |
| (a timeout with twice the time, if that fits the step's budget)  | answer        |                   |
| the source failed, stalled, or sent the wrong size (or hash)     | nothing       | fails and retries |
| no process could start                                           | nothing       | fails and retries |

So a hostile file costs at most two child processes, never the job's retries, and its version
is processed like any other. Each row names the extractor's version. A job that runs again for
the same version (a later step failed, a rename, the sweep) skips extraction when the row is
this extractor version's and final (`extracted`, `failed`, `unsupported`); `unavailable` is
tried again. A newer extractor can find the rows it would do better (failed, unsupported, or
simply older) and re-run them; no job for that exists yet. Each attempt's ContentSource gets a signal the step aborts when the attempt
ends, so a stalled store stream is closed.

Only a managed zone's content is read by default. `startJobs({ content, extract: {
indexedZones: true } })` opts indexed zones in (their bytes come from the customer's store);
local-only and code zones are never read on the server. `extract.limits` and
`extract.budgetMs` (13 minutes, under the job's lease) tune the rest.

**Summaries and model tags** (`summarize`, T-405). For each version with extracted text, once
per version and prompt version (`PROMPT_VERSION`), the step:

1. records `skipped` (core/catalog `saveCard()`) when there is no text (`no-text`), when the
   detector flags it (`flagged`, checked again here), or when no provider may have it
   (`no-provider`);
2. picks a provider through the router (ai/models), asking `context.mayProcess` for
   each candidate in order;
3. reserves tokens (call plus one repair, each at its output cap) from the tenant's daily
   budget; a spent budget records `skipped` / `budget`, logs a warning, and the version is still
   processed (it just has no summary until a later run);
4. sends the prompt (core/summarize `buildSummaryPrompt()`: the document as data between
   nonce-carrying markers, the tenant's approved vocabulary without the `risk` facet); the
   provider's client asks `mayProcess` again right before every HTTP attempt;
5. validates the answer against the strict card schema, repairs once, and records `skipped` /
   `model-output` if the repair fails too;
6. filters it (`filterCardOutput()`: sentences with instructions, links, emails, markup or role
   labels go; tags outside the vocabulary and in `risk` go) and writes in one guarded
   transaction: the settled token count, the card (`version_cards`), the model's tags through
   `proposeTag()` (unreviewed; anything with levels or grants waits in review) and a display
   title proposal (`proposeDisplayTitle()`: non-readers see `Document` until the owner
   confirms).

What a model can't do is recorded, not retried at a cost: an answer that fails the schema twice
(`model-output`), a refusal (`refused`: a content filter's 400, a wrong key, a blocked address),
an answer of the wrong shape (`bad-response`) or over the cap (`too-large`) is stored as
`skipped` with that reason and a warning, and the version is processed without a summary.
Transient errors (rate-limited, 5xx, timeouts, network) fail the step so the job retries with its
backoff; on the job's last attempt (`context.finalAttempt`, from pg-boss's retry count) they are
recorded as `unavailable` instead, so no version is dead-lettered and left hidden for want of a
summary. Errors name the provider and the status, never the key or the content. Reported usage
is clamped (whole, not negative, at most the call's share of the reservation) and the
reservation is always settled, with the HTTP requests that went out counted in `calls`.

`resummarize(db, jobs, tenant, reasons)` re-enqueues the tenant's current versions skipped as
`refused`, `unavailable` or `budget` (after an admin fixed a key or raised the budget; the
server's `admin resummarize` audits it); core/catalog `cardSkipCounts()` gives the counts per
reason. Versions skipped for `budget` are also enqueued again by themselves once a day, after
the budget renews (`budget-retry`, below), so a first crawl of more files than a day's budget
covers catches up over the following days.

**Embeddings** (`embed`, T-407). After the summary, the step embeds the version's summary and
chunks of its extracted text (1,200 characters overlapping by 200, cut at a space, at most 16
per version, spread evenly over a longer text, each cut to the provider's `maxInputChars`) in
one call, and stores them with core/catalog `saveEmbeddings()` under `<provider id>/<model>`:

- **Which provider:** the router's `embed` order (local first by default; the intended setup is
  a local Ollama model such as `nomic-embed-text`, which every exposure but `metadata-only`
  allows), the first the file's exposure allows now; the client asks again right before the
  call. A commercial provider gets only files whose exposure allows it. A `metadata-only` file,
  which includes every file flagged `risk:injection`, reaches none: the pipeline skips the step,
  so such a file has no content vectors and matches search only on what its card shows.
- **Idempotent:** each text's SHA-256 is stored with its vector; a re-run embeds only texts that
  changed (a new summary) and writes nothing when none did.
- **Another model** (a new `embedModel`, another provider first) is another name: its vectors
  are written beside the old ones. `reembed(db, jobs, tenant, model)` enqueues the tenant's
  current versions with text or a summary but no vectors under `model`; afterwards core/catalog
  `pruneEmbeddings(keep)` drops the old model's. Until then searches use the old vectors.
- **Failures:** vectors that can't be stored (mixed sizes, zeros), a refusal or a bad answer are
  logged and the version is processed without vectors; a provider down or rate-limited fails the
  step so the job retries, except on its last attempt. A spent budget skips it with a warning.

On the S8 corpus v0 through the real extractor ([s8-corpus.slow.test.ts](src/s8-corpus.slow.test.ts)),
48 of 50 attack files are flagged (96%) and none of 20 benign files with the same kinds of
hidden parts. The two misses: a hidden sheet (its text is left out of the extraction, so no
model sees it either) and an HTML file (no extractor for HTML yet, so no text at all).
