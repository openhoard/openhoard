# RFC-0001: Hosting single-page apps

- Status: draft
- Author: @RevBooyah
- Tracking issue: #

## Summary

Let a tenant publish a single-page app (a folder of static files: `index.html`, scripts, styles,
images) from OpenHoard, and serve it to the people allowed to use it. An app reuses what the
core already has:

- versioned, content-addressed storage;
- sign-in;
- grants, visibility and exposure;
- audit.

It adds two pieces: a serving extension on its own origin, and an optional per-app data store.
Any agent can publish through an MCP tool, and any machine through the CLI.

Target: after M2, which delivers sign-in for the web, sharing links and the web app.

## Motivation

People build small single-page tools all the time, more and more with AI help: a quote
calculator, an intake form, a dashboard over a spreadsheet, a team checklist. Today each one
ends up somewhere different: a personal Vercel or Netlify project, a GitHub Pages repo, an
artifact in one AI product, a file on someone's desktop. The results are predictable:

- **Nobody can find them.** They aren't where the team's files are, and they aren't tagged.
- **Access is all or nothing.** It's usually a public URL, or a login the team doesn't share.
- **They outlive their owner.** When the author leaves, the app keeps running on their account,
  or silently stops.
- **Each AI tool publishes to its own silo.** An app built with Claude on one machine can't be
  updated from ChatGPT on another.

OpenHoard already knows who people are, which groups they are in, what they may see, and keeps
a versioned, audited copy of every file. An app is a folder of files with one more question:
"serve this to whoever may see it". Hosting it where the files live gives apps the same
governance as documents: owners, tags, access reviews, offboarding handoff and audit.

**Not in scope:** being a general hosting platform. There are no server-side runtimes, no
arbitrary backends and no build pipelines. Apps are built elsewhere (by a person, an agent or
CI) and published as finished static files.

## Proposal

### Model

An app is a catalog object in a Managed zone, with the object kind `app`. Each publish creates a
new version. A version is a manifest listing every file with its path, blob id, size and media
type:

```json
{
  "entry": "index.html",
  "fallback": "index.html",
  "files": [
    { "path": "index.html", "blob": "b3t:…", "size": 1234, "type": "text/html" },
    { "path": "assets/app-4f2a.js", "blob": "b3t:…", "size": 88211, "type": "text/javascript" }
  ]
}
```

- **Deduplication.** Files are ordinary blobs (core/storage), so a redeploy stores only the files
  that changed. An unchanged asset is the same blob in every version.
- **Rollback.** The app has a `current` pointer to one version. Rolling back moves that pointer;
  it is instant and audited.
- **Governance.** Tags, owners, grants, visibility and exposure apply to the app object exactly as
  they do to a document. The app's tags decide who may open it.
- **Limits per version.** At most 2,000 files, 100 MiB in total, and 25 MiB per file; the defaults
  are configurable per tenant. The manifest lists every file, so there are no directory listings.

### Publishing

- **MCP tool `publish_app`** takes `{ app?: id, name, files: [{ path, content | blob }] }`. It
  creates the app, or a new version of one, and returns its URL. As with every MCP write, it
  needs a confirmation token from an OpenHoard client (T-605): an agent can prepare a publish,
  and a person confirms it.
- **CLI:** `openhoard publish ./dist --app quote-calculator` uploads what changed and prints the
  URL. It works from any machine the user is signed in on, and from CI with a scoped token.
- **Web app:** drag a folder or a zip onto an app, then see its versions, current pointer and
  rollback.
- **Upload validation:**
  - paths are relative, normalized, with no `..` or backslashes, and unique;
  - media types come from the file extension, never from the uploader;
  - `entry` and `fallback` must be listed files.

### Serving

A serving extension (a new plugin type, `host`) answers requests on a **separate origin**,
`https://<app>--<tenant>.<apps-domain>`: one hostname per app, and never the OpenHoard web app's
origin. Custom domains map onto it when a tenant verifies them.

For each request, the server:

1. Resolves the host to the app and its `current` version.
2. Authorizes the viewer with `authorize({ action: "open" })`. How the viewer is identified
   depends on the app's access:
   - **Private or group access:** an OpenHoard sign-in redirect (OIDC) that sets a session cookie
     scoped to that app's hostname only.
   - **A sharing link:** a token in the URL, exchanged for that same cookie. Link sharing depends
     on M2's sharing links and their expiry rules.
   - **Public:** allowed only when a tenant policy permits public apps. Off by default.
3. Maps the path to a file in the manifest. A path that isn't a file gets the `fallback` for
   client-side routes, returned with status 200.
4. Streams the blob with fixed headers:
   - `Content-Type` from the manifest;
   - `Content-Security-Policy` (see below);
   - `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`;
   - `Cross-Origin-Opener-Policy: same-origin`;
   - `Cache-Control: public, max-age=31536000, immutable` for content-hashed file names, and
     `no-cache` with an ETag (the blob id) for everything else.
5. Audits the first open per viewer per session, the same way T-704 audits AI reads. Asset
   requests are not audited individually.

The default content security policy:

```
default-src 'self'; connect-src 'self' https://<openhoard-api>; img-src 'self' data: blob:;
style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none';
form-action 'self'
```

- Apps that need other hosts declare them in the manifest (`csp.connect`, `csp.img`, …). The
  declared hosts show on the publish confirmation, and tenant policy can restrict them.
- There is no `unsafe-eval`. There is no inline script unless the manifest lists its hash.

In the reference server, `host` runs inside `openhoard serve` behind the same process manager.
Deployments that want a CDN put one in front: every response is either immutable or
ETag-validated.

### App data (optional, phase 2)

Most single-page SaaS tools need a little state. Each app gets a small document store through
the OpenHoard API, reached from the app's origin with the viewer's session:

- `GET/PUT/DELETE /apps/<app>/data/<collection>/<key>`
- `GET /apps/<app>/data/<collection>?prefix=&limit=`

Documents are JSON, up to 256 KiB each and 100 MiB per app by default.

- **Scopes.** Each collection is declared in the manifest with a scope:
  - `user`: each viewer has their own documents;
  - `shared`: everyone with access sees the same documents;
  - `owner-write`: everyone reads and only the app's writers write.
- **Authorization.** The scope becomes rules in `authorize()`, so the policy engine and audit
  cover app data like any other access.
- **Storage.** Tables live in core/db with the same forced tenant row-level security as
  everything else, keyed by (tenant, app, collection, scope owner, key).

No server-side code runs in this RFC. If apps later need it, it would run in the WASM plugin
runtime (ADR-0012) under its capabilities and limits, and would be a separate RFC.

### New pieces, by package

| Package      | Change                                                                                |
| ------------ | ------------------------------------------------------------------------------------- |
| core/db      | `app` object kind, `app_versions` (manifest), `apps.current_version`, app-data tables |
| core/catalog | Publish (manifest check, blob upload with dedupe), versions, rollback                 |
| core/policy  | Actions `publish` and `open`; tenant settings for public apps and allowed CSP hosts   |
| schemas      | `app-manifest.v1` JSON Schema; plugin type `host`                                     |
| apps/server  | `host` extension: host → app resolution, sign-in, file serving; app-data API          |
| apps/cli     | `openhoard publish`                                                                   |
| MCP server   | `publish_app`, and `open` returning app URLs                                          |

## Security impact

- **Origin isolation is the whole game.** An app's JavaScript runs with its own origin's
  authority. If it shared an origin with the OpenHoard web app, any app could act as the
  signed-in user. Hence:
  - one hostname per app;
  - session cookies scoped to that hostname;
  - `frame-ancestors 'none'`;
  - the OpenHoard API answers an app origin only for that app's own data routes, and only with
    that app's session, never with the web app's.
  - The apps domain is registered separately from the product domain. It goes on the Public
    Suffix List, so browsers treat each app host as its own site. This is what GitHub Pages and
    similar services do.
- **Access fails closed.** A new app is private to its owner. Visibility and exposure resolve
  from its tags like any object. Public serving needs a tenant policy, and every public publish
  is audited.
- **Abuse.** A tenant can already host files; serving them as pages adds phishing and malware
  risk on the public apps domain. So:
  - public apps are off by default;
  - publishing needs a confirmation from a person;
  - uploads go through the same malware scanning as guest file exchange (M3);
  - there is a per-tenant kill switch.
- **Prompt injection.** An agent can prepare a publish, but only a person's confirmation token
  makes it live (T-605). Text in files never grants anything.
- **Supply chain.** Apps can load only what their CSP allows. Third-party hosts are visible at
  publish time and can be restricted by tenant policy.
- **Data.** App data sits behind forced tenant row-level security and `authorize()`. The app's
  origin can reach only its own collections, within the viewer's rights.
- **Audit.** Every publish, rollback, access change and first open per session is recorded.

## Compatibility

Everything is additive:

- a new object kind;
- new tables and migrations;
- a new plugin type (manifest schema v1 gets `host` added to its `type` enum, a minor change);
- a new MCP tool and a new CLI command.

Nothing existing changes. The apps domain is new configuration and is optional: without it,
hosting is off.

## Alternatives considered

- **Leave it to Vercel, Netlify or Cloudflare Pages.** These are fine for public sites, but they
  sit outside the tenant's identity, groups, tags and audit, which is exactly the motivation.
  OpenHoard could integrate with them later as publish targets (a connector) for public apps.
- **Serve apps from the OpenHoard web app's origin, under a path.** Rejected: one app's script
  could act as the signed-in user across all of OpenHoard.
- **Sandboxed iframes inside the web app.** A `sandbox` iframe without `allow-same-origin` gets
  an opaque origin, which is safe. But apps then lose normal URLs, deep links and storage, and
  can't be opened outside OpenHoard. It could still be a preview mode.
- **Server-side functions from the start.** Much larger security surface and operating cost.
  Deferred until app data shows real need.

## Unresolved questions

- The apps domain name, and whether self-hosters get a wildcard certificate flow (ACME DNS-01)
  or per-app certificates.
- Whether app data counts against the tenant's storage quota, or has its own.
- How offboarding hands over apps. Probably the same flow as documents, with a check that every
  app has an owner.
- Whether `publish_app` from an agent should be able to update an existing app without a
  confirmation when its access and CSP don't change (a "trusted redeploy" setting).

## Milestone

The first step comes **after M2**:

- the static model and serving;
- `publish_app`, `openhoard publish` and rollback;
- private and group access.

App data follows in a second step. Public apps and custom domains come with M3 (malware scanning
and large-file exchange).
