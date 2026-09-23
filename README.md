# OpenHoard

**Your company's files, guarded by a dragon that remembers everything.**

OpenHoard is an open-source, AI-managed file layer. Instead of folders you have to
maintain, it keeps a governed *hoard*: every file indexed, tagged, summarized and
access-controlled, so people (and their AI agents) can simply ask for what they need.

> "Open the Acme Q3 deck." · "What CSVs was I looking at yesterday?" ·
> "Share the forecast with Acme, read-only, until Oct 31."

> **Status: pre-alpha.** We are designing in the open. Nothing here is production-ready yet.

---

## Why

Folders pack four jobs into one brittle structure: *where bytes live*, *how things are
organized*, *who can see them*, and *how long they're kept*. When the structure drifts,
everything breaks at once: files can't be found, former staff keep access, versions
multiply, and audits find gaps too late.

AI can now do the organizing people never did. OpenHoard lets it, safely.

## What it does

- **Find by intent.** Permission-aware hybrid search (keyword + vector + tags + activity).
  Zero LLM tokens per query; agents get compact *file cards*, not whole files.
- **Tags, not folders.** An approved tag vocabulary per organization; AI proposes tags,
  people confirm sensitive ones. Folders become live views.
- **Governed actions.** Share, revoke, move and retag through one policy engine, with an
  append-only, hash-chained audit log and 30-day undo.
- **Works where your files already are.** Index SharePoint/OneDrive in place, or move shared
  work into an S3 / Azure Blob bucket. Git stays the source of truth for code.
- **You control what AI sees.** Per-tag exposure levels (`full`, `commercial-only`,
  `local-only`, `metadata-only`) and an allowlist of AI clients.
- **Any agent.** Claude, GPT, Kimi, Hermes, Copilot: OpenHoard speaks
  [MCP](https://modelcontextprotocol.io) and ships skills. No custom model.

## Design philosophy: small trusted core, big edges

```
            ┌──────────────── Trusted core (small, audited) ────────────────┐
            │ identity · permissions/policy · index/search · summaries ·    │
            │ audit · plugin sandbox                                        │
            └───────────────────────────────▲───────────────────────────────┘
                                            │ versioned contracts + capability manifests
   connectors · enrichers · policy/vocabulary packs · skills · client integrations
```

The core makes every trust decision. Plugins extend what OpenHoard can **reach** and
**understand**; they can never decide who gets access. Text in files can inform an action
but never authorize one. See [docs/architecture.md](docs/architecture.md) and
[docs/threat-model.md](docs/threat-model.md).

## Repository layout

| Path | What lives there |
| --- | --- |
| `core/` | The trusted core: `identity`, `policy`, `catalog` (index + search), `summarize`, `audit`, `sandbox` |
| `connectors/` | Storage and source connectors (S3, Azure Blob, SharePoint, Git hosts, …) |
| `enrichers/` | Extractors and taggers for specific file types |
| `packs/` | Policy and tag-vocabulary packs (legal, healthcare, manufacturing, …) |
| `skills/` | Agent skills built on the core MCP tools |
| `clients/` | Web app, desktop client, Office/Teams integrations |
| `schemas/` | Versioned JSON Schemas for plugin manifests and other contracts |
| `packages/cli-js`, `packages/cli-py` | The `openhoard` CLI (npm and PyPI) |
| `docs/` | Architecture, threat model, roadmap |

## Try the CLI

The CLI currently validates plugin manifests against the published schema.

```bash
npx openhoard --version
npx openhoard manifest validate connectors/example/openhoard.plugin.json

pipx run openhoard manifest validate connectors/example/openhoard.plugin.json
```

## Roadmap (short version)

| Milestone | Scope |
| --- | --- |
| M0 Validate | Interviews, design partners |
| M1 Read-only pilot | SSO, SharePoint indexing, AI tagging, permission-aware search, MCP server, audit |
| M2 Governance | Governed sharing, access reviews, web app, tray + quick search |
| M3 Bucket + Code | S3/Azure bucket, copy/move ingest, Git linking, local models, Company Files drive |
| M4 Desktop + Compliance | Virtual drive everywhere, HIPAA / SOC 2 packs, more connectors |

Details in [docs/roadmap.md](docs/roadmap.md).

## Contributing

We want this to be a community project. Start with [CONTRIBUTING.md](CONTRIBUTING.md).
Connectors, enrichers, packs and skills are the best places to begin.

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE)
