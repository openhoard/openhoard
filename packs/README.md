# packs/

Declarative bundles of tag facets, values, visibility/exposure defaults, tag rules and Cedar
policies with tests, e.g. legal, healthcare (HIPAA), manufacturing, accounting.

Packs contain **no code** and request **no capabilities or network**. Admins review a diff
before a pack is applied.

- [`general-business/`](general-business/): the starter pack.

## Layout

Each pack is a folder with two files:

- `openhoard.plugin.json`: its manifest (`"type": "pack"`, `"runtime": "declarative"`, no
  capabilities, no network).
- `pack.json`: the content, described below. core/catalog `validatePack()` checks it.

| Field                             | What                                                                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pack_version`, `name`, `version` | `1`, a slug, semver                                                                                                                                      |
| `defaults`                        | the tenant's `visibility` and `exposure` for files no level tag covers                                                                                   |
| `facets`                          | `key`, `label`, `public` (shown on title-only cards), `single` (one value per file), and `values` with optional `visibility` and `exposure`              |
| `rules`                           | tag rules (core/catalog `rules.ts`): path globs, sites, extensions, media types, client dictionaries; `primary: true` makes a rule's tag the file's home |
| `policies`                        | local id → Cedar text, applied as `pack/<name>/<id>`                                                                                                     |
| `tests.policies`                  | a principal, an action, a resource's tags, zone and a client, and the expected `allow`, `deny` or `forbid`                                               |
| `tests.levels`                    | tags and the levels they should resolve to                                                                                                               |

**Homes.** A file's primary tag is its home: the one tag that says where it belongs, as its
folder did (core/catalog `primary.ts`). A rule such as
`{ "id": "apollo", "tag": "project:apollo", "when": { "path": "Projects/Apollo/**" }, "primary": true }`
carries a folder layout over; a home a person chose is never replaced by a rule. A `single`
facet (`sensitivity`) holds one value per file: a second value from a rule, pack or model, or a
person's that would loosen a level, waits in review, and only a reviewer's explicit choice
replaces the first. Where several rules give one such facet a value, the first in the list wins.

In policies, match `resource.allTags.contains("x")` in a `forbid` (it sees model guesses too),
and `resource in OpenHoard::Tag::"x"` in a `permit` (trusted tags only). See core/policy.

**Actions.** Listings (core/catalog `viewObjects()`, which builds every card and title-only
card) authorize `read`; search (`searchObjects()`) authorizes `read` and `search`. A forbid on
`read` takes away a file's content and full card, but a member still sees the title-only card of
a file whose level is `discoverable`. A forbid on `search` takes a file out of search results
(for readers too) but not out of listings. To keep a file out of both, give its tag
`visibility: hidden` (or set the tenant default to hidden).

**Zones.** `resource.zone` is the zone's kind: `managed`, `indexed`, `local-only` or `code`,
never its name. A policy test's `zone` must be one of those, and policy text that compares
`resource.zone` with any other string literal (`resource.zone == "x"`, `!=`, either way round,
or `["x"].contains(resource.zone)`) is refused. That check reads the text, comments included,
so it catches typos rather than every spelling.

**Text.** Policy text may not contain control or format characters other than line breaks and
tabs: a NUL or a bidi override in a comment would make the reviewed diff read differently from
what runs.

## Applying

1. `planPack()` returns the diff against the tenant, with every loosening flagged, the
   results of the tests, and a plan hash. The tests are the pack's own and, named
   `<pack>: <test>`, every other applied pack's, all run against the tenant as the pack would
   leave it, so one pack can't silently break another's guarantees. A policy test naming tags
   that won't be approved vocabulary gets a warning: a typo there can make it pass vacuously.
2. `applyPack()` takes that hash. It refuses if anything changed since the plan was made, or
   if any test fails. It writes only the facets and values the plan changes.

A pack only adds and updates vocabulary. Values it no longer lists stay, because tags and grants
may use them. Its rules and policies replace those of its earlier version.

A stored pack that no longer validates against today's rules stops everything that reads the
tenant's packs (fail closed), naming it. To get out, plan a fixed version of the same pack (the
plan shows all of the stored rules and policies as removed and the new ones as added, flagged),
or remove it.

## Removing

`planPackRemoval()` and `removePack()` work the same way: the plan lists the rules and policies
that go (removing a forbid is flagged), the vocabulary stays, and the other packs' tests run
without it. It works on a stored pack that no longer validates.
