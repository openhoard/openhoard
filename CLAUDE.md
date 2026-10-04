# OpenHoard: instructions for coding agents

Read this before changing anything. It is the repository's copy of the project direction set on
2026-10-03; the project docs (Concept Brief, Dev Plan, Task List) hold the detail and win if they
disagree with this file on a date later than this one.

## What we are building, and for whom

An agent-neutral, open-core governance layer (tags, permissions, audit) over files that stay where
they are, starting with SharePoint, reached by any AI over MCP. The customer is a **team on
Microsoft 365, 10 to 200 seats**. It is not a personal file tool.

## The current milestone: M1, a read-only SharePoint pilot

M1 exits when:

1. one real SharePoint site is indexed in place: crawl, delta, permission import;
2. three named people find files through Claude weekly for two weeks without being prompted;
3. PRD scenarios 1, 2, 4 and 7 pass end to end.

Nothing else is M1. Work in this order (Task List epic E14):

1. SharePoint: wire `connector: "sharepoint"` into `apps/server` config; delta and change
   notifications; permission import to grants; throttling (T-1402, T-304, T-305, T-306).
2. Doors for built code: `admin review list|approve|reject|merge` over the tag review inbox;
   `admin audit verify|export` (T-1403, T-1404).
3. File Health Report (queries + CSV), then the minimal admin UI (E10, E9).
4. Run S5 against real MCP clients with write confirmation (T-1412, T-605).

Refactors (one ingest path, layering, CLI consolidation, migration squash, CI matrix: T-1405 to
T-1409) are done in passing when touching that code, never as separate projects.

## Frozen until M1 exits

- **The solo track**, at what is merged: `tunnel`, passkeys, mail-in, uploads and the PWA share
  target, the browser extension, Explorer pinning, the native sync root. Fix bugs in them only when
  they block dogfooding. `init --solo`, the fs connector and `connect claude-desktop` stay as the
  dogfood path.
- The public website, demo video, Show HN, registry listings (E13, T-1211). The README is
  corrected first (T-1410): S3, Azure Blob, guest file exchange and "30-day undo" are planned, not
  shipped, and must read that way.
- RFC-0001 app hosting; any M2 or M3 feature; new connectors; new MCP client surfaces; new
  credential paths.

If a task you are handed is in this list, stop and say so instead of building it.

## Rules every change keeps

- **Every catalog read goes through `viewObjects()` with an `Authorizer`.** No route or tool
  selects from `objects`, `versions` or `source_refs` directly. (`GET /api/uploads` is the one
  known exception; T-1405 removes it.)
- **No package under `core/` imports a model client or an enricher.** Model calls happen in
  enrichment steps and the `find` tool's query embedding only. (`core/models` and
  `core/jobs → enricher-extract` are the known exceptions; T-1406 removes them.)
- **Business logic lives in a `core/*` package; `apps/server` wires.** A route or tool that decides
  something (who may propose a tag, how an upload is ingested) is a decision that moves into core.
- **Before building a second way to do something that exists** (approve a client, create a zone,
  ingest a file, sign a user in), use or extend the first.
- **Text never authorizes an action.** File content, filenames and metadata are hostile input; the
  policy engine decides, and everything fails closed.
- **A task's Done-when is the whole bar.** "Merged, real run left" is In progress, not Done.

## Working here

- `pnpm install && pnpm build && pnpm test`. Node 24, pnpm 12, no Docker anywhere. PGlite for dev
  and tests; native Postgres 17+ with pgvector 0.8+ in production.
- Conventional commits with a lower-case subject, DCO sign-off (`-s`). Every PR gets a separate
  reviewer pass before it goes up.
- Claim a task in the Task List (set In progress) before working on it; `git fetch` and check open
  PRs first; keep parallel sessions on separate epics.
- Code graph: `graphify update .` (local AST, no tokens; `uv tool install 'graphifyy[sql]'` once) writes
  `graphify-out/` (gitignored). `graphify explain "<symbol>"` and `graphify path "A" "B"` answer who-calls-what
  before a structural change; `.graphifyignore` keeps `dist/` and `coverage/` out.
- Architecture: `docs/architecture.md`. Threat model: `docs/threat-model.md`. Decisions:
  `docs/adr/`. Spike results: `docs/spikes/`.
