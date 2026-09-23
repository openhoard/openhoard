# Contributing to OpenHoard

Thanks for helping build the hoard. OpenHoard is designed to grow at its edges: most
contributions will be **connectors, enrichers, packs, skills and client integrations**,
while the trusted core stays small and carefully reviewed.

## Where to start

| You want to…                                                 | Go to         | Review bar                                                   |
| ------------------------------------------------------------ | ------------- | ------------------------------------------------------------ |
| Connect a new source (Box, Dropbox, NAS, …)                  | `connectors/` | Standard + conformance kit                                   |
| Understand a file type (invoices, CAD, Parquet, …)           | `enrichers/`  | Standard + conformance kit + red-team suite                  |
| Ship an industry vocabulary or policy set                    | `packs/`      | Standard + policy test cases                                 |
| Write an agent workflow                                      | `skills/`     | Standard                                                     |
| Integrate an app (Office, Teams, Slack, …)                   | `clients/`    | Standard                                                     |
| Change identity, policy, search, summaries, audit or sandbox | `core/`       | **Core review** (two maintainers + RFC for contract changes) |

Every plugin needs an `openhoard.plugin.json` manifest. Validate it with:

```bash
npx openhoard manifest validate path/to/openhoard.plugin.json
```

## Ground rules for plugins

1. **Declare everything.** Capabilities, network hosts and `max_exposure` go in the manifest.
   Anything not declared is denied.
2. **Propose, never decide.** Plugins can propose tags and fields. Only the core grants
   access, shares files or writes audit events.
3. **Treat content as hostile.** File text, filenames and metadata may contain prompt
   injection. Never turn content into instructions or actions.
4. **No surprise network calls.** An enricher with no `network` entries must work offline.

## Contracts and RFCs

Extension-point interfaces and schemas in `schemas/` are versioned (semver). Breaking
changes need an RFC: open an issue using the **RFC** template, discuss, then submit the PR.

## Development

Requirements: **Node 24 LTS** and **pnpm** (`corepack enable`). No Docker, ever: the database
(PGlite), storage and identity provider all run in-process for development.

```bash
pnpm install        # install the workspace
pnpm dev            # run the server on http://127.0.0.1:7420 (data in ./.openhoard)
pnpm check          # lint + format check + typecheck + tests with coverage
pnpm changeset      # describe changes to published packages
```

**Privacy:** Turborepo sends anonymous usage telemetry by default. OpenHoard is privacy-first,
so we turn it off in CI and recommend you do too, once per machine:
`pnpm exec turbo telemetry disable` (or set `DO_NOT_TRACK=1` in your shell profile).

Useful filters: `pnpm --filter @openhoard/core-policy test`, `pnpm --filter openhoard build`.

Security invariants (fail-closed levels, card sanitising, audit-chain tamper detection, capability
narrowing) are checked with property-based tests using [fast-check](https://fast-check.dev/) in
`*.property.test.ts` files. When you touch one of those functions, keep its properties passing and
add one for any new guarantee. A failing property prints a minimal counterexample. Add it as a
plain unit test too, so the regression stays pinned.

Decisions live in [`docs/adr/`](docs/adr/), contract changes go through [`docs/rfc/`](docs/rfc/),
and spike reports go in [`docs/spikes/`](docs/spikes/).

Python CLI (PyPI name only): `cd packages/cli-py && python -m pip install -e . pytest && pytest`.

## Pull requests

- One logical change per PR, with tests.
- Describe the user-visible effect and any security considerations.
- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`…).
- Sign off your commits (`git commit -s`) under the
  [Developer Certificate of Origin](https://developercertificate.org/).
- Be kind. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Security issues

Never file security issues publicly. See [SECURITY.md](SECURITY.md).
