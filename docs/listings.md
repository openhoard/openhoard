# Listings: where OpenHoard can be installed from (T-1210)

OpenHoard is self-hosted: there is no OpenHoard-run endpoint, and nothing here depends on one.
Every listing below points an AI client at **the server you run**, by asking for its address.

What is in the repository, and what still takes the project's own accounts:

| Where                         | What is here                                            | To be listed                                         |
| ----------------------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| Claude Code                   | A plugin and its marketplace: works from the repo today | Optional: submit the plugin to Anthropic's directory |
| Claude (web, desktop, mobile) | The skills as zips to upload                            | Nothing: people upload them                          |
| The official MCP registry     | `server.json`                                           | Publish it with `mcp-publisher`                      |
| Claude's connector directory  | The server meets what the tools must declare            | A submission, with what is listed below              |

## Claude Code: the plugin

```sh
claude plugin marketplace add openhoard/openhoard
claude plugin install openhoard@openhoard --config mcp_url=https://files.example.com/mcp
```

It adds OpenHoard's MCP server as a connector (at the address you give) and the three skills
(`/openhoard:find-and-open`, `/openhoard:catch-me-up`, `/openhoard:who-can-see-this`). The first
use opens your server's sign-in; the first time, an admin approves Claude Code on that page
(apps/server README, "MCP clients").

- The marketplace is `.claude-plugin/marketplace.json`; the plugin is the `skills/` folder with
  `skills/.claude-plugin/plugin.json`.
- Check both after a change: `claude plugin validate .` and `claude plugin validate ./skills`.

## Claude: the skills

```sh
pnpm package:skills        # → dist/skills/<name>.zip
```

Upload each zip in Claude: Settings → Capabilities → Skills → Upload skill. The connector itself
is added as a custom connector (Settings → Connectors, `<your server>/mcp`), which needs an
address Claude can reach: `openhoard tunnel`, or your own domain. The zips are the same bytes
for the same files (stored, no times), so a published zip can be checked against the source.

## Claude Desktop

Nothing to install: add `<your server>/mcp` as a custom connector (Settings → Connectors), or,
on the machine that runs the server, `openhoard connect claude-desktop` (it also approves the
client and prints a sign-in link).

There is no desktop extension (`.mcpb`). One was written for this task and dropped: it could
only wrap `npx mcp-remote`, an unpinned download run on every start, and Anthropic's directory
no longer takes desktop extensions.

## The official MCP registry

`server.json` at the repository's root describes OpenHoard as a remote server whose address is
a variable (`https://{server_host}/mcp`): the registry has no hosted OpenHoard to point at.

To publish, as an **owner** of the `openhoard` GitHub organization (the name is
`io.github.openhoard/openhoard`, and the registry checks the organization's membership):

```sh
mcp-publisher login github
mcp-publisher publish
```

Keep `version` the same in `server.json` and `skills/.claude-plugin/plugin.json` (a test checks
it), and publish again when it changes. From CI, a token needs `read:org` to publish under the
organization's name. The registry lists https addresses only: a server on `127.0.0.1` is not
what this entry is for.

## Claude's connector directory

Anthropic's directory takes remote MCP servers, and a server need not be at one address: the
submission form has "users connect to different URLs" (several URLs, or a URL pattern), and,
separately, a custom connection where each person gives their own URL. Nothing in the guide
says a server on any domain of the person's own is accepted, and some of these modes are
arranged with the review team: so a self-hosted OpenHoard **may** be submittable, and the first
step is to ask them.
What a submission needs
([Anthropic's submission guide](https://claude.com/docs/connectors/building/submission)):

| Asked for                                                      | OpenHoard                                                 |
| -------------------------------------------------------------- | --------------------------------------------------------- |
| A remote server over https, with OAuth                         | Yes (OAuth 2.1, `<your server>/mcp`)                      |
| Every tool has a `title`, and `readOnlyHint`/`destructiveHint` | Yes: a test checks it (`listings.test.ts`)                |
| Tested as a custom connector in Claude                         | By hand (skills/README.md); not repeated for this task    |
| A server the reviewers can reach, with a test account          | **Missing**: an instance someone runs for the review      |
| A privacy policy at a URL                                      | **Missing**                                               |
| Documentation and a support contact                            | The repository's README and issues; a contact to be named |
| An icon                                                        | `apps/server` draws one; a file to be exported            |

It is submitted at `claude.ai/directory/manage` from a paid Claude plan, by someone who can
make the form's compliance statements for the project. The review instance is the real cost: it
is the one thing here that someone has to keep running, and it must not become an endpoint the
product depends on.

Skills are not listed on their own: they go in with the plugin, which has its own submission
page (`claude.com/docs/plugins/submit`). The guide asks for the server to be submitted as a
connector even when a plugin points at it.

## Not done here

These need the project's accounts, and a person to agree to each catalogue's terms:

- Publishing `server.json` to the registry.
- Submitting the plugin, and the connector, to Anthropic's directory.
- Attaching the skills' zips to a GitHub release (there is no release yet).

Checked here: the plugin validates and installs in Claude Code (`claude plugin validate`,
`claude plugin install`) with its three skills and its connector, and the zips unpack. Not
checked: the plugin against a live server, and `server.json` against the registry itself.
