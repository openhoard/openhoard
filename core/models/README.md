# core/models

Part of the OpenHoard trusted core. See [../README.md](../README.md). Model providers for
enrichment (T-404): the adapters, routing by exposure, and the daily token budget. The step that
uses them is core/jobs' `summarize` (T-405).

## Providers

A provider is an API endpoint plus its **kind**, which says where it runs and so which files'
content it may have (core/policy `mayProcess()`):

| Kind         | Meaning                              | Gets content at                         |
| ------------ | ------------------------------------ | --------------------------------------- |
| `local`      | on the tenant's own machines         | `full`, `commercial-only`, `local-only` |
| `commercial` | a service under a business agreement | `full`, `commercial-only`               |
| `consumer`   | a service on consumer terms          | `full`                                  |

`metadata-only` content goes to no provider.

| Adapter     | Speaks                                                                   | Key                  |
| ----------- | ------------------------------------------------------------------------ | -------------------- |
| `ollama`    | Ollama `POST /api/chat`, `POST /api/embed`                               | none                 |
| `openai`    | OpenAI chat completions and embeddings: OpenAI, Azure OpenAI (v1 API,    | bearer, or `api-key` |
|             | `auth: "api-key"`), LM Studio, vLLM                                      | (optional)           |
| `anthropic` | Anthropic Messages `POST /v1/messages` (`anthropic-version: 2023-06-01`) | `x-api-key` (needed) |
| `stub`      | nothing: answers in-process, for tests, CI and trying OpenHoard          | none                 |

The request and answer shapes are pinned by [clients.test.ts](src/clients.test.ts) against fake
servers. Every answer field is checked before use; an answer of the wrong shape is a
`bad-response`, never a guess.

**Keys come from the environment only**: `OPENHOARD_MODEL_<ID>_API_KEY` (the id upper-cased, `-`
as `_`), read by the server into the provider's client and nowhere else. The server's config
schema has no field for a key, so one pasted into `config.json` fails loudly.

## Every call

`postJson()` ([http.ts](src/http.ts)) gives every HTTP call the same guarantees:

- **The guard**, asked right before every attempt, retries included: may this content go to
  this provider now? Enrichment's guard re-reads the file's exposure, so a file tightened while
  a job runs is withheld (`ModelError` `withheld`) before anything is sent. It is required.
- **Bounded input**: the document is cut to `maxInputChars` (default 24,000) by the prompt
  builder (core/summarize), and the answer to `maxOutputTokens` (default 800).
- **Timeouts** per attempt (`timeoutMs`, default 60 s), and the caller's signal (the job's
  lease, the step's budget).
- **Retries** on 408, 409, 425, 429, 5xx and Anthropic's 529, timeouts and connection failures:
  `maxRetries` (default 2), exponential backoff with jitter (1 s doubling, at most 30 s), or the
  answer's `Retry-After` (seconds or a date) when it is at most `maxRetryAfterMs` (60 s); a longer
  one ends the call as `rate-limited` so the job's own retry waits instead.
- **A capped answer**: `maxResponseBytes` (1 MiB), checked on `content-length` and while
  streaming.
- **No redirects**: a 3xx fails the call at once as `refused`, never followed or retried (a key
  must not follow one to another host).
- **https, or plain http to private addresses only**: http is allowed in the settings only for
  loopback URLs and `local` providers, and every http request may only connect to loopback,
  RFC 1918, carrier-grade NAT (100.64.0.0/10: Tailscale and similar), link-local or IPv6
  unique-local addresses, never a cloud metadata service (169.254.169.254, 169.254.170.2,
  100.100.100.200, fd00:ec2::254). The check runs inside the connection's own
  DNS lookup, on every address returned, so the socket connects to an address that was checked
  (a name re-pointed between check and connect, DNS rebinding, changes nothing); IP literals are
  checked as written. Anything else fails as `blocked` before a byte is sent. Node's http client
  is used rather than fetch for exactly this.
- **Nothing secret in logs or errors**: a `ModelError` carries a code, the provider's id and the
  HTTP status; log lines carry the id, status, attempt and wait. Never the request, the answer,
  a header or a key.
- **Concurrency** per provider (`concurrency`, default 2) in each process.

## Routing

`createModelRouter(clients, order)` gives each task (`summarize`, `embed`) an ordered list of
providers: the configured order, or every provider with local ones first, then commercial, then
consumer. `pick(task, exposure)` returns the first one the exposure allows; `pickAllowed(task,
allowed)` asks a predicate instead (enrichment passes `context.mayProcess`). So local-only content
can only ever reach a local provider, whatever the order (a property test checks it for any
providers and order), and no provider is picked for `metadata-only` content.

**Local first by default**: the content stays home and costs nothing per token. An admin who
prefers a stronger commercial model lists it first for the task; local-only files still go to a
local one, or to none.

## The daily token budget

`reserveTokens()` reserves a call's most (input estimate plus output caps) against the tenant's
budget for the UTC day, in one statement that adds only if the total stays within it, so
concurrent jobs in any number of processes can't spend past it together. `settleTokens()`
replaces the reservation with what the provider reported (clamped by the caller), or the
estimate when it reported nothing: a token per Chinese, Japanese or Korean character, four other
characters a token (so CJK text isn't undercounted fourfold). `calls` counts the HTTP requests
that went out, retries and repairs included. Table `model_usage` (tenant, day), under row-level
security.

A spent budget is a clear, quiet failure: the summarize step records the version as skipped
(`budget`), logs a warning, and the file is processed and visible by its tags without a summary.
Default 5 million tokens a day per tenant (`models.dailyTokenBudget`), with per-tenant overrides
(`models.tenantBudgets`). Local providers count too.

## Server configuration

```json
{
  "models": {
    "providers": [
      {
        "id": "ollama",
        "kind": "local",
        "adapter": "ollama",
        "chatModel": "llama3.2",
        "embedModel": "nomic-embed-text"
      },
      { "id": "claude", "kind": "commercial", "adapter": "anthropic" },
      {
        "id": "azure",
        "kind": "commercial",
        "adapter": "openai",
        "auth": "api-key",
        "baseUrl": "https://contoso.openai.azure.com/openai/v1",
        "chatModel": "gpt-4.1-mini"
      }
    ],
    "tasks": { "summarize": ["ollama", "claude"] },
    "dailyTokenBudget": 2000000,
    "summarize": { "budgetMs": 480000 }
  }
}
```

with `OPENHOARD_MODEL_CLAUDE_API_KEY` and `OPENHOARD_MODEL_AZURE_API_KEY` in the service's
environment. The anthropic adapter defaults to `https://api.anthropic.com` and the Haiku-class
`claude-haiku-4-5`; ollama to `http://localhost:11434`. Without providers, no model runs.
