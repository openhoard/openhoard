<p align="center">
  <img src="assets/logo-banner.svg" alt="OpenHoard: The AI filesystem that remembers everything and guards it all." width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-F2A93B"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/openhoard/openhoard"><img alt="OpenSSF Scorecard" src="https://api.scorecard.dev/projects/github.com/openhoard/openhoard/badge"></a>
  <a href="https://www.bestpractices.dev/projects/15005"><img alt="OpenSSF Best Practices" src="https://www.bestpractices.dev/projects/15005/badge"></a>
  <a href="https://github.com/openhoard/openhoard/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/openhoard/openhoard/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Status: pre-alpha" src="https://img.shields.io/badge/status-pre--alpha-B23A1F">
  <img alt="Works with any MCP agent" src="https://img.shields.io/badge/MCP-any%20agent-15110D">
  <img alt="SharePoint: index in place" src="https://img.shields.io/badge/SharePoint-index%20in%20place-0078D4">
</p>

<h1 align="center">Folders are dead. Long live the Hoard.</h1>

<p align="center">
  <b>The first open-source AI filesystem.</b><br>
  Stop filing. Stop searching. Stop wondering who can see what.<br>
  <i>Just ask, and the dragon brings it back.</i>
</p>

---

> **"Open the Acme Q3 deck."** · **"What CSVs was I working on yesterday?"** ·
> **"Find the onboarding checklist HR wrote last spring."** · **"Who can see payroll, and why?"**

OpenHoard replaces the folder tree with an AI-managed, **governed** file layer. Every file is
indexed, tagged, summarized and access-controlled, so people and their AI agents find
things by _meaning_, not by path. Every action is checked by policy and written to a
tamper-evident audit log.

> **Status: pre-alpha, designed in the open.** What the headlines say is in `main` today,
> tested against a simulated SharePoint tenant; the first real site is next. What is
> **planned** is listed as such, below them. The [roadmap](docs/roadmap.md) has the order.

## The headlines

|                                           |                                                                                                                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🐉 **Your files, finally findable**       | Ask in plain English. Permission-aware search over SharePoint and local folders; full-text search needs no AI at all.                                                              |
| 🔒 **Every file has a guardian**          | Access follows tags, not folders, and a grant ends after 90 days unless you say otherwise. Someone removed in your identity provider (SCIM) loses access at once.                  |
| 🧠 **The filesystem that remembers**      | OpenHoard keeps each file's versions and what each person opened through it, so "what was I working on yesterday?" has an answer.                                                  |
| 🤖 **Bring any AI. Keep control.**        | AI assistants connect over MCP, each person signing in with OAuth 2.1, from an allowlist you approve. You decide, per tag, what each kind of AI may read.                          |
| 🛡️ **Built for auditors, not just users** | Every decision, allowed or refused, goes into a hash-chained audit log you can verify and export.                                                                                  |
| 🩺 **A health check for your files**      | The File Health Report lists what to look at: files open to anyone with a link, shared outside, tied to people who left, labelled restricted yet widely shared, stale, duplicated. |
| 📦 **No migration required**              | SharePoint is indexed in place, with `Sites.Selected`, and who can open what comes with it. Nothing is copied or moved.                                                            |
| 🧩 **Open core, open edges**              | Apache-2.0. Connectors, enrichers, policy packs and skills are separate packages on a public SDK and manifest schema.                                                              |

**Planned** (on the [roadmap](docs/roadmap.md), not in `main`):

- **Governed sharing:** "Share the forecast with Acme, read-only, until Oct 31", with external links that expire by default.
- **Cloud buckets and Git:** index and move shared work in S3 or Azure Blob; link GitHub repositories. (The files OpenHoard keeps itself, uploads and mail-in, can already live in your own S3 or Azure Blob bucket, set up from the admin Storage page.)
- **SFTP is over:** send customers a link, and they drag in 1 GB+ files from any browser, with no account and no client.
- **No more `Final_v2_FINAL.docx`:** AI that names files, spots the real final version and warns you before you send an old one.
- **30-day undo** on everything, and HIPAA / SOC 2 / legal-hold packs.
- **Plugins in a sandbox**, with the capabilities they declare and nothing more.
- **Checked live with Claude, ChatGPT and Microsoft Copilot.** OpenHoard speaks standard MCP with OAuth 2.1; it is tested against the protocol, not yet against those apps.

## Why your company needs this (the slide for your boss)

The folder tree was designed for filing cabinets. It's failing modern teams:

- **54%** of US office workers say they waste time searching for files in disorganized systems ([Elastic / Wakefield Research via TechRepublic](https://www.techrepublic.com/article/more-than-50-of-office-pros-spend-more-time-searching-for-files-than-on-work/)).
- **77%** of organizations had at least one Microsoft 365 governance incident in the past year ([ShareGate survey via WindowsForum](https://windowsforum.com/news/microsoft-365-copilot-38-report-stale-access-in-sharegate-survey.445625/)).
- **38%** had former employees or guests keep access they should have lost, and **26%** had sensitive content reach the wrong people (same survey).
- AI assistants now read everything a user can access, so **oversharing that used to be hidden is now one prompt away.**

**OpenHoard's pitch in one line:** _keep your storage, lose the chaos_. Findable files,
provable access control, and AI you can actually trust with company data.

<details>
<summary><b>For IT: the 60-second version</b></summary>

- **Deploys like any managed app:** SSO (Entra ID, Google, or any OIDC provider) and SCIM today; silent sign-in and MDM packages planned.
- **Least privilege by design:** SharePoint access via `Sites.Selected`; AI clients on an allowlist; plugin sandboxing planned.
- **One policy layer** for everything OpenHoard indexes, readable as "who can see this and why".
- **Security-first AI:** prompt injection is in the threat model from day one. Text in a file can never authorize an action, and files that look like they try are kept from AI assistants.
- **No lock-in:** open source, self-hostable; the audit history exports today, files and tags export planned.

</details>

**Presenting OpenHoard to your IT team?** Use the [IT overview deck](docs/presentations/openhoard-it-overview.pptx)
([PDF](docs/presentations/openhoard-it-overview.pdf)): architecture, data flow, storage, tags,
security and status in 15 slides with speaker notes.

## How it works

```
            ┌──────────────── Trusted core (small, audited) ────────────────┐
            │ identity · permissions/policy · index/search · summaries ·    │
            │ audit · plugin sandbox                                        │
            └───────────────────────────────▲───────────────────────────────┘
                                            │ versioned contracts + capability manifests
   connectors · enrichers · policy/vocabulary packs · skills · client integrations
```

The core makes every trust decision. Plugins extend what OpenHoard can **reach** and
**understand**; they can never decide who gets access. Deep dives:
[architecture](docs/architecture.md) · [threat model](docs/threat-model.md) · [roadmap](docs/roadmap.md).

## Repository layout

| Path                      | What lives there                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `core/`                   | The trusted core: `identity`, `policy`, `catalog` (index + search), `summarize`, `audit`, `sandbox`         |
| `connectors/`             | Source connectors: SharePoint and local folders (`fs`), and an example to start from                        |
| `enrichers/`              | Extractors and taggers for specific file types                                                              |
| `packs/`                  | Policy and tag-vocabulary packs: a general-business starter so far                                          |
| `skills/`                 | Agent skills built on the core MCP tools                                                                    |
| `clients/`                | Client integrations: a browser extension so far                                                             |
| `packages/schemas`        | Versioned JSON Schemas for plugin manifests and other contracts                                             |
| `apps/server`, `apps/cli` | The gateway (HTTP API, MCP server, admin CLI) and the `openhoard` CLI (npm; PyPI twin in `packages/cli-py`) |
| `apps/web`                | The admin web app (React, Vite): static files the server serves at `/admin/`                                |
| `assets/`                 | Logo and brand assets                                                                                       |

## Try it

On your own machine, over your own folder, in a few commands. Node 24, pnpm and git are all
the server needs; no Docker, no database to install:

```bash
git clone https://github.com/openhoard/openhoard
cd openhoard
pnpm install
pnpm build
node apps/server/dist/main.js init --solo
```

`init --solo` sets up one person, a folder (`OpenHoard` in your home folder, made if missing;
or `--folder <an existing folder>`, the path written out) and a starter policy pack. It then
prints the two commands that are left: one connects Claude Desktop (`connect claude-desktop`),
one starts the server. Follow what they print (a sign-in link to open, Claude Desktop to
restart, Allow to press), put a file in the folder, and ask Claude for it.

- Search works with no AI key. For summaries, set `OPENHOARD_MODEL_CLAUDE_API_KEY` in the
  environment (never in a config file).
- No Claude Desktop (Linux has none), or you want claude.ai or your phone: start it with
  `tunnel` instead (needs `cloudflared`) and follow what it prints. Add files in a browser at
  `<its address>/app/`.

The details are in [apps/server/README.md](apps/server/README.md) ("One person on one
machine"). This is pre-alpha: it never writes to the folder you name, but expect rough edges.

The CLI validates plugin manifests against the published schema, the first contract every plugin must meet.

```bash
npx openhoard manifest validate connectors/example/openhoard.plugin.json
pipx run openhoard manifest validate connectors/example/openhoard.plugin.json
```

## Join the hoard

We're building this in the open and want the community to own the edges.
Start with [CONTRIBUTING.md](CONTRIBUTING.md). Connectors, enrichers, packs and skills
are the best places to begin. Found a security issue? See [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE) · "OpenHoard" and the dragon-eye logo are trademarks of the OpenHoard project.
