# skills/

Agent skills (SKILL.md) that orchestrate OpenHoard's MCP tools: client onboarding,
quarterly access review, retiring an old share, audit export, and more.

Skills run in the user's own agent, bound by that user's permissions. They can only call
core MCP tools.

## Format

One folder per skill, with a `SKILL.md` in the
[Agent Skills](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview) format:
YAML front matter with `name` (lower case, digits and hyphens, at most 64 characters, the
folder's name) and `description` (what it does and when to use it, at most 1,024 characters),
then the instructions. apps/server's `skills.test.ts` checks both, and that a skill names only
tools the server serves.

## Skills v0 (T-806)

| Skill                                         | For                                                                  | Tools                                |
| --------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------ |
| [find-and-open](find-and-open/SKILL.md)       | "find the Acme QBR deck and open it" (PRD scenario 1)                | `find`, `open`                       |
| [catch-me-up](catch-me-up/SKILL.md)           | project recaps; "what CSVs was I looking at yesterday?" (scenario 2) | `recent`, `find`, `describe`, `open` |
| [who-can-see-this](who-can-see-this/SKILL.md) | "who can see this, and why can Bo?" (scenario 4, read side)          | `find`, `explain`                    |

The tools (apps/server `src/tools/`): `find`, `recent`, `describe`, `open` (link or content),
`tag` (proposals for a person to approve, never applied) and `explain` (owners only), plus
`whoami`. Every answer is limited to what the person may see through the connecting app; file
text and summaries come back as untrusted data, and every call and every AI read is audited.

## Running them in Claude against a dev tenant

1. **Serve OpenHoard over HTTPS.** Run the server with `auth.publicUrl` set to a public HTTPS
   address. For testing, a Cloudflare quick tunnel:
   `cloudflared tunnel --url http://localhost:<port>`, then set publicUrl to the printed
   `https://….trycloudflare.com`. Sign-in needs a configured provider (apps/server/README.md).
2. **Add the connector in Claude.** Settings → Connectors → Add custom connector, URL
   `<publicUrl>/mcp`. Claude registers itself (Client ID Metadata Document) and sends the
   person through OpenHoard's sign-in and consent: allow `files:read` (and `files:tag` to let
   it propose tags).
3. **Approve the client** as a tenant admin (OpenHoard's admin API, `/api/admin`, or
   `auth.clients` in the config) with a trust label: `commercial` for Claude. Files whose
   exposure doesn't reach that label come back as metadata only (scenario 7).
4. **Add the skills.** `pnpm package:skills` writes each one as a zip in `dist/skills/` (the
   skill's folder, with its SKILL.md at the top of the folder): upload them in Claude,
   Settings → Capabilities → Skills → Upload skill. In Claude Code, install the plugin
   instead, which brings the connector too:
   `claude plugin marketplace add openhoard/openhoard`, then
   `claude plugin install openhoard@openhoard --config mcp_url=<publicUrl>/mcp`. See [docs/listings.md](../docs/listings.md).
5. **Try them:** "Find the Acme QBR deck and open it", "What CSVs was I looking at yesterday?
   I'm in America/Denver", "Who can see the salary sheet? Can Bo?"

The audit log (`openhoard admin audit export --tenant ten_…`) shows what
happened: one `mcp.tool` record per call, `ai.read` for every content read and summary shown,
`tag.propose` for proposals, and `object.open` denials where exposure kept content back.
