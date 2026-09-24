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

| Field                             | What                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pack_version`, `name`, `version` | `1`, a slug, semver                                                                                          |
| `defaults`                        | the tenant's `visibility` and `exposure` for files no level tag covers                                       |
| `facets`                          | `key`, `label`, `public` (shown on title-only cards), and `values` with optional `visibility` and `exposure` |
| `rules`                           | tag rules (core/catalog `rules.ts`): path globs, sites, extensions, media types, client dictionaries         |
| `policies`                        | local id → Cedar text, applied as `pack/<name>/<id>`                                                         |
| `tests.policies`                  | a principal, an action, a resource's tags and a client, and the expected `allow` or `deny`                   |
| `tests.levels`                    | tags and the levels they should resolve to                                                                   |

In policies, match `resource.allTags.contains("x")` in a `forbid` (it sees model guesses too),
and `resource in OpenHoard::Tag::"x"` in a `permit` (trusted tags only). See core/policy.

## Applying

1. `planPack()` returns the diff against the tenant, with every loosening flagged, the
   results of the pack's tests, and a plan hash.
2. `applyPack()` takes that hash. It refuses if anything changed since the plan was made, or
   if any test fails.

A pack only adds and updates vocabulary. Values it no longer lists stay, because tags and grants
may use them. Its rules and policies replace those of its earlier version.
