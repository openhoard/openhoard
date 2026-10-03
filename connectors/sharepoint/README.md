# @openhoard/connector-sharepoint

SharePoint sites, indexed in place through Microsoft Graph. **It signs in (T-302) and crawls a
site's document libraries with checkpoints (T-303).** It doesn't yet follow changes (T-304),
import permissions (T-305) or pace itself under throttling (T-306). In the server it is a
source with `"connector": "sharepoint"` (apps/server README, "SharePoint sites on a schedule").

## Crawling a site (T-303)

```ts
import { graphAuth, sharepointConnector } from "@openhoard/connector-sharepoint";

const connector = sharepointConnector({
  auth: graphAuth({ tenant, clientId, credential }),
  site: "contoso.sharepoint.com:/sites/finance", // or the site's id
});
```

- **One source is one site.** Each of its document libraries is a folder at the top, named
  after the library (two of one name are told apart by their ids); files and folders are below.
  An item's externalId is `<drive id>:<item id>`: it survives renames and moves in a library.
- **How.** Library by library, through Graph's delta enumeration from the start
  (`/drives/{id}/root/delta`), 200 items a page (`pageSize`). A checkpoint follows every page,
  holding the link to the next one: a crawl killed anywhere goes on from the last page
  recorded, and keeps nothing on disk. The `done` cursor holds each library's delta link, which
  is what following changes will start from.
- **Paths without an order.** Delta gives an item its parent's id, no path, and promises no
  order. Folders seen are remembered for the library under way; a parent not seen yet (a child
  came first, or the crawl resumed mid-library) is asked for by id, with those above it, and
  yielded first. Parents always come before their children.
- **Versions.** A file's `contentVersion` is its content hash when Graph gives one
  (`quickXorHash`, or `sha256Hash`), else its eTag, which also changes on a rename (the bytes are then read
  again, never missed). Never its cTag: SharePoint's delta feed leaves it out and an item asked
  for by id has it. `read()` compares like with like: the version of the kind the crawl
  recorded. The item's `etag` is made of Graph's eTag and the path, since Graph's own doesn't
  change for what is inside a renamed folder.
- **Reading.** `read()` checks the file is still the version (and size) crawled, follows Graph's
  download link **without the token**, counts the bytes, and asks once more at the end: a file
  replaced meanwhile is `changed`, never passed off as the version crawled. The link must be on
  Graph's origin or an https host in `downloadHosts` (default `.sharepoint.com`), and nothing
  it redirects to is followed.
- **What can't be served is there, not gone.** An item Graph says nonsense of, or whose name
  the catalog can't hold, is a warning `invalid-item`; one whose folder can't be placed
  (misnamed, too deep, gone or refused when asked for) is `unplaced-item`; what is neither a
  file nor a folder is `unsupported-item`. Each names the item, and the runner takes an item a
  warning names as mentioned: it is not reconciled away. Only an entry that can't even be named
  is `unreadable`: the runner then removes nothing after that crawl. A deletion in the feed is
  not said as one: the crawl's reconcile removes what it didn't see, behind the runner's guard.
- **Where requests go.** To Graph's origin only. A link Graph hands back (a next page, a delta
  link, one in a token) is followed only when it is on that origin; a token holding any other
  is refused (`resync`), and so is a token's link Graph no longer takes.
- **Failures** are the contract's: 403 on the site, its libraries or a page is `auth` (the site
  isn't granted); 404 `not-found`; 410 `resync`; 429 (and 503 or 504 with Retry-After)
  `throttled`; other 5xx `retryable`; a site that isn't there `permanent`; the app's token
  refused twice `auth`. One file whose content or download is refused is `permanent`: it is
  passed over and the sync goes on (a site whose policy blocks every download ends `done` with
  every file skipped: look at the skipped count).
- **Limits.** A token holds a delta link per finished library and may be 65,536 characters: a
  site with more libraries than fit (some hundred) fails as `permanent`. A folder renamed
  while a crawl is under way leaves items yielded before it at their old path, and a file
  deleted after the crawl yielded it stays, until the next crawl (every sync is one until
  T-304, which must say such deletions).

Tested (`src/connector.test.ts`, `src/graph.test.ts`, `src/e2e.test.ts`) against the fake
Graph, whose delta feed is shaped as Graph documents it, and through the sync runner into the
catalog: a 10,000-item tenant fully indexed, and a killed sync resumed (`test:slow`, in CI on
PostgreSQL; 600 items in the ordinary run).

**Not yet tried on a real tenant.** What to look at there first: whether `Sites.Selected` is
enough for `delta` (Graph's page names `Files.Read.All`); whether a file's `size` always equals
the bytes downloaded (SharePoint is known to differ for some Office files, and the runner would
then skip the file as `changed`); which hosts download links point at, and whether they
redirect (`downloadHosts`); what Graph answers for a next-page link that has lapsed; how many
items a page really holds, and how often Graph throttles.

## Signing in to Graph (T-302)

Two kinds of token, both from Entra ID's v2 token endpoint (`src/auth.ts`):

| Token               | Grant              | For                                                              |
| ------------------- | ------------------ | ---------------------------------------------------------------- |
| App-only            | client credentials | the connector as itself: crawling, delta, reading                |
| On behalf of a user | on-behalf-of       | acting as one signed-in person, with no more than they can reach |

```ts
import { graphAuth, probeSites } from "@openhoard/connector-sharepoint";

const auth = graphAuth({
  tenant: "contoso.onmicrosoft.com", // or the tenant's id
  clientId: "…",
  credential: { kind: "certificate", certificate: pem, privateKey: keyPem }, // or { kind: "secret", secret }
});
const token = await auth.appToken(signal);
const asUser = await auth.onBehalfOf(usersAccessTokenForThisApp, signal);
await probeSites(auth, ["contoso.sharepoint.com:/sites/finance"], signal);
```

- **Least privilege: `Sites.Selected`.** With it the app holds nothing tenant-wide: an admin
  grants it each site, and it reaches no other. It can't list sites, so the sites are named in
  configuration. `probeSites()` asks Graph for each one and says `ok`, `denied` (not granted) or
  `not-found`, so a missing grant reads as that and not as an empty crawl.
- **Credentials.** A certificate (preferred: the private key signs a five-minute PS256 assertion
  and never leaves the process) or a client secret. Either comes from the environment or a file
  the admin names, never from config.json.
- **Where credentials go.** To the configured authority's token endpoint only: an origin (https,
  or http on this machine for tests). A redirect is never followed, and is reported as a
  mistake in the address. The defaults are the global cloud's; a national cloud is set with
  `authority` and `graph`, and its hosts must then be added to the manifest's `network`.
- **Tokens** are kept in memory until five minutes before they lapse (halfway, for a shorter
  life), asked for once when callers arrive together, and never written or logged.
- **On behalf of a user.** The person's token must be a JWT that says when it lapses; anything
  else, or one already lapsed, is refused without asking Entra (each request to Entra carries
  the app's credential). The Graph token is kept no longer than the person's own token lasts:
  someone signed out of OpenHoard isn't acted for from a cache. A token Entra refused for good
  (`invalid_grant`) is refused again for a minute without asking; "sign in again" is asked
  anew each time. At most 64 exchanges run at once, and a slot is held until Entra answers or
  the request times out: what calls `onBehalfOf` must have authenticated its caller first, or
  forged tokens can hold the slots.
- **Failures** are `ConnectorError`s. Entra refusing is `auth`, as a `GraphAuthError` that says
  whether the **app** was refused (nothing works until an admin fixes the registration, the
  credential or consent) or the **user** (that person signs in again; a claims challenge is
  passed on), with Entra's error and AADSTS codes and a plain reason for the common ones. A busy
  Entra is `throttled` (waiting as long as `Retry-After` says) or `retryable`, and so is a
  refusal that doesn't say why as Entra does (a proxy on the way): it never stops a sync as a
  wrong credential would.
- **Sites** are named by id (`contoso.sharepoint.com,<guid>,<guid>`), by host and path
  (`contoso.sharepoint.com:/sites/Team Finance`, the path as people read it, not encoded), by
  host alone, or `root`. What can't be one of those (other path segments, Graph's own names,
  characters a SharePoint name can't hold) is refused before a request is made.

Nothing here verifies a token's signature: Graph does, when the token is used. What the check
command prints from a token ("permissions", "scopes") is what the token says, shown for setup.

## Checking a tenant

The done-when of T-302 is both tokens working against the fake **and a dev tenant**. The fake
is covered by the tests. For a real tenant (a Microsoft 365 developer or test tenant, never
production):

1. **Register an app** (Entra admin center → App registrations → New registration; single
   tenant; no redirect URI).
2. **Permissions** (API permissions → Microsoft Graph): application permission
   `Sites.Selected`, then "Grant admin consent". For the on-behalf-of exchange also the
   delegated permissions `Sites.Selected` and `User.Read`, consented.
3. **A credential** (Certificates & secrets): upload a certificate's `.cer`/`.pem` and keep its
   private key, or create a client secret and copy its **value**.
4. **Grant the app a site.** `Sites.Selected` reaches nothing until this is done, by someone
   who may (an app or admin with `Sites.FullControl.All`), for example in Graph Explorer:

   ```http
   POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions
   { "roles": ["read"],
     "grantedToIdentities": [{ "application": { "id": "<client id>", "displayName": "OpenHoard" } }] }
   ```

   (`GET https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/finance` gives the
   site's id. PnP PowerShell's `Grant-PnPAzureADAppSitePermission` does the same.)

5. **Run the check**, credentials in the environment:

   ```sh
   pnpm --filter @openhoard/connector-sharepoint build
   export OPENHOARD_GRAPH_TENANT=contoso.onmicrosoft.com
   export OPENHOARD_GRAPH_CLIENT_ID=<client id>
   export OPENHOARD_GRAPH_CERTIFICATE_FILE=app.pem OPENHOARD_GRAPH_PRIVATE_KEY_FILE=app.key
   # or: export OPENHOARD_GRAPH_CLIENT_SECRET=<the secret's value>
   node connectors/sharepoint/dist/check.js contoso.sharepoint.com:/sites/finance <a site you did not grant>
   ```

   Expected: the granted site "reached", the other "REFUSED", exit status 1 because of the
   second (2 is a mistake in the arguments, the variables or the files). It prints no token
   and no secret.

6. **On behalf of a user** (optional). The exchange takes an access token issued to a person
   **for this app** (its audience is the app, not Graph). To make one by hand: under "Expose an
   API" set the Application ID URI (`api://<client id>`) and add a scope (`access_as_user`);
   get a token for `api://<client id>/access_as_user` as a test user (any OAuth client you have
   authorized for that scope); save it in a file and set `OPENHOARD_GRAPH_USER_TOKEN_FILE`.
   Expected: "on behalf of a user: issued", with that person's name and the delegated scopes.

Not yet tried against a real tenant. What that run should also settle, since the fake only
follows the documentation: the status Graph gives an ungranted site and `GET /sites` under
`Sites.Selected` (the fake answers 403), and the error for a missing delegated consent.

## Tests

`src/auth.test.ts` and `src/probe.test.ts` run against the testkit's fake Entra and fake Graph
(`@openhoard/testkit`: `FakeEntra`, `FakeGraph` with `entra`), with certificates made at run
time: no key is kept in the repository.
