# General business pack

A starting vocabulary for most organizations. Edit it freely, or copy it as the base for your
own pack.

| Facet         | Values                                                                                                                               | Public |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `sensitivity` | `public` (readable, full), `internal` (discoverable, commercial AI), `confidential` (hidden, local AI), `restricted` (hidden, no AI) | yes    |
| `department`  | executive, finance, hr, legal, sales, marketing, engineering, operations, it                                                         | yes    |
| `kind`        | contract, invoice, report, presentation, spreadsheet, policy, proposal, minutes, handbook                                            | yes    |
| `risk`        | `injection` (no AI): set only by OpenHoard's injection detector (T-408), never by a model                                            | no     |
| `client`      | none: values arrive through the review inbox                                                                                         | no     |
| `project`     | none: values arrive through the review inbox                                                                                         | no     |

**Defaults.** Untagged work is discoverable, and only commercial or local AI clients may
receive its content.

**Risk flags.** `risk:injection` is how enrichment marks a file whose name or content looks like
it carries instructions for an AI (hidden text with instructions, "ignore all previous
instructions", fake tool calls…). The value sets `exposure: metadata-only` and nothing else: AI
clients get a metadata-only card and no content, no model summarizes the file, and people in
OpenHoard's own apps still see and open it as before. It is built-in vocabulary: every tenant
has it whether or not this pack is applied, and its levels can't be changed: a pack that lists
it with another exposure, or any visibility, is refused (only its label is yours).

**Rules.** Department folders (`**/Finance/**`, `**/HR/**`, …) tag the department. HR files are
also tagged `sensitivity:confidential`. `**/Confidential/**` sets confidentiality. Contract and
invoice folders set the kind, and file extensions tag spreadsheets and presentations.

**Policies.**

- `guests-no-hr-or-legal`: guests never reach HR or legal files, even with a grant, and even when
  only a model has guessed the department.
- `consumer-ai-no-confidential`: consumer AI clients can't read or open confidential or restricted
  files (no card, which carries the summary, and no content). Both levels are hidden, and
  listings check `read`, so through a consumer client these files don't appear at all: people
  who can't read them see nothing anyway, and readers get no card either.

`pack.json` carries policy and level tests. OpenHoard runs them before applying the pack, and an
admin reviews the diff first.
