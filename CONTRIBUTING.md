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

```bash
# JS CLI
cd packages/cli-js && npm install && npm test

# Python CLI
cd packages/cli-py && python -m pip install -e . pytest && pytest
```

## Pull requests

- One logical change per PR, with tests.
- Describe the user-visible effect and any security considerations.
- Sign off your commits (`git commit -s`) under the
  [Developer Certificate of Origin](https://developercertificate.org/).
- Be kind. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Security issues

Never file security issues publicly. See [SECURITY.md](SECURITY.md).
