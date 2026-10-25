# Connecting an AI client to OpenHoard

An AI client reaches OpenHoard at one address, `<publicUrl>/mcp` (below,
`https://files.contoso.com/mcp`). Each person signs in as themselves, through the server's own
sign-in (Entra, for a team), and consents. From then on the client sees only what that person
may see. Every read goes in the audit log.

This page covers what M1 uses, Claude, and what any MCP client needs. ChatGPT, VS Code and
others are not tried yet (T-1307).

## Before anyone connects

- **The address must be https and reachable from the internet**, exactly `<publicUrl>/mcp`: no
  trailing slash. Claude on the web, desktop and phone connects through Anthropic's cloud, from
  `160.79.104.0/21`, so a firewall or conditional-access rule in front of the server has to let
  that range through. Claude Code connects from the person's own machine.
  [docs/pilot.md](pilot.md) step 4 sets up the address.
- **An admin approves each client once, with one of three kinds.** The first time a client
  connects, OpenHoard holds it until a tenant admin approves it. When the person connecting is
  an admin, the page that opens asks them, so the admin should connect first. Otherwise the
  admin approves it on the admin app's **AI clients** page (`/admin/`). The kind decides how much
  of a file's content that client may get (core/policy, "Exposure"); the pages describe each:
  - **Organization AI** (`commercial`): an AI service your organization has a business
    agreement with. It gets everything except files marked for your own computers only.
  - **Personal AI** (`consumer`): an AI app on personal or free terms, including paid personal
    plans. It gets the content only of files cleared for any AI.
  - **Stays on our computers** (`local`): the AI runs on your own machines. A desktop app that
    uses a cloud AI doesn't count.
  - The page shows where the client's answers go. The name is the client's own claim, so
    approve only a client you just started connecting yourself.
- **Without a pack, AI clients get names and metadata only.** Claude still finds files by title
  and tags, but reads none of them, until an admin applies the starter pack or your own
  (pilot.md step 5).

## Claude on the web, desktop and phone

The same connector serves all three: it is part of the Claude account, and Desktop and the
mobile apps use it once it is added on the web.

**Team and Enterprise plans.** An Owner adds it once for the organization:

1. claude.ai › **Organization settings** › **Connectors** › **Add** › **Custom** › **Web**.
2. Name it `OpenHoard`. The URL is `https://files.contoso.com/mcp`. Then **Continue**.
3. Review the authentication settings Claude found and **Continue**.
4. Under **Authentication**, don't choose **No sign in**: OpenHoard needs each person signed
   in. Leave **OAuth client** at **Use Claude's published identity**, add no request headers
   (OpenHoard takes its own tokens only), and **Add**.

Each person then connects it: **Customize** › **Connectors**, find OpenHoard and click
**Connect**. Approve Claude as **Organization AI**.

**Pro and Max plans.** Each person adds it themselves: **Customize** › **Connectors** › **+ Add**
› **Add custom connector**, with the same steps. By OpenHoard's own words that is **Personal
AI**. OpenHoard can't tell Claude's plans apart: claude.ai is one client, so the kind an admin
gives it covers everyone who connects it, from any plan.

**What each person sees.** Connecting opens OpenHoard's sign-in, then its consent page, which
names Claude and asks to let it find, read and propose tags for files as them. After **Allow**,
the connector is on. In a chat, **+** › **Connectors** turns it on or off.

**Signing in again.** A grant lasts 30 days by default (`auth.grantDays`, at most 90); after
that, Claude asks the person to connect again. Locking someone in OpenHoard ends their
connection at once. When an admin revokes Claude, it stays refused, and people are told so,
until an admin approves it again.

**The menus above are Anthropic's**, as of October 2026, from
[their help page](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
If they have moved, that page has the current ones.

## Claude Code

```sh
claude mcp add --transport http openhoard https://files.contoso.com/mcp
```

Then `/mcp` in Claude Code signs in, in the browser. The plugin in this repository adds the same
connector with three skills ([listings.md](listings.md)). Claude Code is a client of its own, with
its own metadata document on claude.ai and a redirect to this machine (`localhost`, a port of the
moment): an admin approves it once, as for Claude on the web, as Organization AI or Personal AI
by the same test (the model runs at Anthropic, so never Stays on our computers).

## Claude Desktop on one person's own machine

For the solo install (`init --solo`), `connect claude-desktop` writes Claude Desktop's local
config instead (apps/server README, "Claude Desktop"). A team's server uses the connector
above.

## Any other MCP client

What a client needs, if you are trying one:

| It needs                          | OpenHoard                                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Transport                         | Streamable HTTP, at `<publicUrl>/mcp`; JSON responses, no sessions, one message per request                             |
| Discovery                         | `401` with `WWW-Authenticate` → `/.well-known/oauth-protected-resource/mcp` (RFC 9728) → RFC 8414 metadata              |
| Client identity                   | A client ID metadata document (an https client id), or dynamic registration (RFC 7591), public clients only             |
| Flow                              | Authorization code with PKCE S256; `resource` = `<publicUrl>/mcp`                                                       |
| Redirects                         | https, or http on this machine (`127.0.0.1`, `localhost`, `[::1]`), any port                                            |
| Scopes                            | `files:read`, `files:tag` (and `files:add` where uploads are on: the upload API, not MCP)                               |
| Tokens                            | Access 1 hour; refresh tokens rotate, and a reused one revokes the grant                                                |
| Browser-based clients (an Origin) | `publicUrl`'s origin, any `localhost`, `127.0.0.1` or `[::1]` origin (the browser's own machine), and `auth.mcpOrigins` |

A client that can't do OAuth (some only take a fixed API key in a header) can't connect.
[mcp-remote](https://www.npmjs.com/package/mcp-remote) bridges a local-only client to the
address. The routes are in apps/server's README, "MCP clients: OAuth 2.1". Write down what
worked: T-1307 turns it into tested steps.

## When it doesn't connect

| What happens                                    | Why, usually                                                                                                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Couldn't reach the MCP server"                 | The address isn't reachable (from Anthropic's range, or for Claude Code from this machine), isn't https, or isn't exactly `<publicUrl>/mcp`; `<publicUrl>/healthz` should answer |
| OpenHoard says the client "isn't approved yet"  | No admin approved it: an admin connects first, or approves it on **AI clients**                                                                                                  |
| OpenHoard says "Your admin refused this client" | An admin refused or revoked it: approving it again on **AI clients** lets it back                                                                                                |
| The sign-in ends on "sign-in failed"            | The person isn't provisioned, or is locked: the audit log's `auth.sign-in` event says which. If Entra stops it first, its AADSTS code says why                                   |
| Connected, but Claude finds nothing             | The crawl hasn't finished (`admin source status`), or the person may see nothing there                                                                                           |
| Claude finds files but can't read them          | No pack applied yet (metadata only), or the file's exposure doesn't reach the client's kind                                                                                      |
| Claude lists a file without a title             | It is still being processed, or it is flagged as possibly carrying instructions for an AI                                                                                        |

The admin app's **Audit log** shows each `oauth.authorize` and `oauth.token` decision, with why
one was refused.
