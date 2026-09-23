# Security policy

OpenHoard guards other people's files, so we take security reports seriously.

## Reporting a vulnerability

Please **do not** open a public issue. Instead, use GitHub's
[private vulnerability reporting](https://github.com/openhoard/openhoard/security/advisories/new)
for this repository.

Include what you found, how to reproduce it, and the impact you expect. We aim to
acknowledge reports within 3 business days and to agree on a disclosure timeline with you.

## In scope

- Anything that lets a user, agent, guest or plugin **see, share, move or change** files
  beyond what policy allows
- **Prompt injection** that causes an unauthorized action or leaks content across users
- Search results, counts, autocomplete or summaries that reveal files a user can't see
- Audit log tampering or gaps
- Plugin sandbox escapes or capability bypasses
- Cross-tenant data access

## Design principles we hold ourselves to

- Text in files can inform an action but never authorize one.
- The core makes every access decision; plugins only propose.
- Every read by an AI client and every write is audited.

See [docs/threat-model.md](docs/threat-model.md) for the full threat model.
