# @openhoard/connector-sharepoint

SharePoint sites, indexed in place through Microsoft Graph. **It signs in (T-302), crawls a
site's document libraries with checkpoints (T-303), follows what changes in them through
Graph's delta (T-304), and reads each item's permissions for the core to turn into grants
(T-305), keeping to a budget of requests and waiting when Graph says to (T-306).** It isn't yet
told of changes as they happen (change notifications). In the server it is a source with `"connector": "sharepoint"`
(apps/server README, "SharePoint sites on a schedule").

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
  (`/drives/{id}/root/delta`), 40 items a page at the default budget (`pageSize`). A checkpoint follows every page,
  holding the link to the next one: a crawl killed anywhere goes on from the last page
  recorded. The `done` cursor holds each library's delta link, which is what following changes
  starts from.
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
  is `unreadable`: the runner then removes nothing after that crawl. Without a state directory
  a deletion in the feed is not said as one: the crawl's reconcile removes what it didn't see,
  behind the runner's guard.
- **Where requests go.** To Graph's origin only. A link Graph hands back (a next page, a delta
  link, one in a token) is followed only when it is on that origin; a token holding any other
  is refused (`resync`), and so is a token's link Graph no longer takes.
- **Failures** are the contract's: 403 on the site, its libraries or a page is `auth` (the site
  isn't granted); 404 `not-found`; 410 `resync`; 429 (and 503 or 504 with Retry-After)
  `throttled`, once waiting in place is over (see "Pacing"); other 5xx `retryable`, after two
  more tries; a site that isn't there `permanent`; the app's token
  refused twice `auth`. One file whose content or download is refused is `permanent`: it is
  passed over and the sync goes on (a site whose policy blocks every download ends `done` with
  every file skipped: look at the skipped count).
- **Limits.** A token holds a delta link per finished library and may be 65,536 characters: a
  site with more libraries than fit (some hundred) fails as `permanent`. A folder renamed
  while a crawl is under way leaves items yielded before it at their old path, and a file
  deleted after the crawl yielded it stays, until the next crawl; with a state directory the
  deltas that follow say both.

Tested (`src/connector.test.ts`, `src/graph.test.ts`, `src/e2e.test.ts`) against the fake
Graph, whose delta feed is shaped as Graph documents it, and through the sync runner into the
catalog: a 10,000-item tenant fully indexed, and a killed sync resumed (`test:slow`, in CI on
PostgreSQL; 600 items in the ordinary run).

## Following changes (T-304)

```ts
const connector = sharepointConnector({ auth, site, stateDir: "/var/lib/openhoard/sp-finance" });
```

With a `stateDir` (a directory of this source's own, used by one sync at a time) the connector
has `delta()`: after a crawl, a sync asks each library's delta link what changed since, and
yields that.

- **A round at a time.** A library's changes are read whole before anything is yielded: Graph
  may give an item more than once and the last word counts. Then folders (nearest the top
  first), then files, then deletions; a checkpoint after each library that had any. A sync
  with nothing changed asks for the site's libraries and one page per library, and yields
  nothing but `done`.
- **Renamed and moved folders.** Graph says the folder changed and nothing of what is in it,
  whose paths changed too. The connector keeps each library's folders (id, parent, name: no
  file's name, no content) in `stateDir`, sees the folder isn't where or what it kept, and
  lists everything under it (`/items/{id}/children`, folder by folder) to yield each at its
  new path. The bytes aren't read again as long as the listing gives the same content version
  as the feed did. A folder it may not list (403) is warned of (`unlisted-folder`), what is in
  it stays where the catalog has it, and the next round tries again.
- **A round is bounded.** At most `roundRequests` requests (default 1000: pages of the feed,
  folder listings, folders asked for by id) and 100,000 entries or events. One that would take
  more (a folder with thousands of folders in it renamed) is `resync`: a crawl does the same
  work a page at a time, with checkpoints. A round is all or nothing: cut short, it starts
  again at the next sync. A throttle doesn't cut it short unless Graph asks for more waiting
  than a request may do in place (below).
- **Deletions** are yielded as `deleted`; the runner counts them against its guard before
  applying any. Graph is taken to say every item in a deleted folder. If it says a folder went
  and not the folders kept under it, it can't have said the files either: `resync`.
- **What a crawl leaves for the deltas after it.** A crawl says no deletion (the runner would
  make it uncounted): ids the feed said were deleted are kept and said by the deltas that
  follow, 200 a round, each only if Graph still has no such item (and one Graph won't answer
  for waits). A folder the crawl met under two names or in two places (renamed while the crawl
  was under way) is listed again by the first delta, and a crawl that was stopped places what
  follows as it placed what came before, so a folder renamed meanwhile is seen to differ when
  Graph reports it: either way what the crawl yielded under the old name is put right.
- **What is kept** (`src/state.ts`): `folders.<generation>.json`, named by the cursor it goes
  with, written whole before that cursor exists and never changed after, so whichever cursor
  the runner saved, its folders are the ones written for it; and `crawl.<id>.jsonl`, what a
  crawl under way has met, which a checkpoint names with its length so a resumed crawl cuts it
  back to there (and places what follows as it placed what came before). Old generations go
  as later deltas run. Files are the server user's alone (0600, and the directory 0700 where it can be made so), read and
  written whole and synchronously: some tens of bytes a folder, at each sync that has changes.
  Nothing removes the directory when its source is taken out of the configuration.
- **When it crawls again** (`resync`): Graph no longer takes the link (410, or refuses it), a
  library was added, removed or renamed, the generation the cursor names is missing or
  unreadable, the cursor has none (one from before T-304, or from a crawl that lost its log),
  a round is over its bounds, a folder went without the folders in it, or the crawl is older
  than `recrawlAfterDays` (default 7, fractions allowed; 0 never) or stamped more than a day
  ahead of the clock. The periodic crawl's reconcile mends whatever a delta missed.
- **Several nodes need the same `stateDir`.** A crawl resumed where its log isn't (another
  node's disk, or lost) goes on and ends, with a cursor changes can't be followed from: the
  next sync crawls again. Per-node directories therefore mean every sync is a crawl, as before
  T-304, never a wrong catalog.
- **Not covered, until the next crawl.** A folder that couldn't be placed at the crawl (its
  name, its depth, refused) and can be now: Graph says the folder, not what is in it, and the
  connector never kept it. Files in a deleted folder if Graph doesn't say each (see below). A
  file the crawl yielded and was then told is deleted, when it was told of more than 5,000
  deletions in that library (a feed listing the recycle bin): none are kept. So
  `recrawlAfterDays: 0` is for a site where none of these can happen.

Tested in `src/delta.test.ts` by one measure: a catalog after a crawl and the deltas that
followed equals a fresh crawl of the site as it is now (files and folders added, changed,
renamed, moved, deleted; items given twice; two libraries, resumed between them; a delta run
again from a kept cursor; a crawl killed and resumed, with a folder renamed meanwhile), in
`src/state.test.ts` for what is kept, and through the sync runner in `src/e2e.test.ts`.

## Permissions (T-305)

`aclImport()` asks Graph for an item's permissions (`/items/{id}/permissions`, every page) and
gives them in the contract's terms (`src/permissions.ts`); `permissions: false` turns it off.
What gives nobody a grant here (sharing links, "everyone", guests and people who matched
nobody) is kept by the core all the same, with who made and last changed each file
(`createdBy`, `lastModifiedBy`) and when: the File Health Report (T-1001, core/catalog
`healthReport()`) reads them.

| Graph says                                         | entry                                |
| -------------------------------------------------- | ------------------------------------ |
| an Entra user                                      | user, by object id, with the email   |
| the same with an invitation (taken up)             | guest, by object id, with an email   |
| an Entra group                                     | group, by object id                  |
| a SharePoint group (a site's Members, Visitors)    | group, id `sitegroup:<site id>:<id>` |
| "Everyone", "Everyone except external users"       | organization                         |
| a site user that is a person, with an email        | user, id `siteuser:<login>`          |
| a link to view or edit, for anyone or the org      | link                                 |
| a link to view or edit, for named people or groups | link, and each of them               |
| anything else                                      | nothing                              |

"Anything else" is the rule, since what an entry gives here is the file's content: an
application, an invitation nobody has taken up, what only the older `grantedTo` fields say, an
expiry that can't be read, a claim that isn't a person's (a Microsoft 365 group's owners, a security group
seen as a site user), a link that isn't to view or edit or that prevents download, a role that
gives less than the file (view only, limited access) or that this doesn't know. `owner` and
full control are owner, `write` write, `read` read; a link's role is its type. Graph's "never"
(year 1) is no expiry.

What an entry is worth is the core's decision (core/jobs `acl.ts`): users and groups the tenant
has provisioned under those ids get grants, a link and the organization grant nothing, and a
SharePoint group matches no group there, so its members get nothing until something can say
who they are.

- **One request an item**, each time the source mentions it, asked once however often
  recording it is retried. A crawl of a site asks once per file (the spike, S4, measured this
  as most of a crawl's time), and each costs five of Graph's resource units, which is what
  the budget below is counted in: asking only for items with unique permissions is the next
  saving (`$batch` saves round trips, not units).
- **Changes.** The crawl and every delta ask Graph to mark items whose sharing changed
  (`Prefer: deltashowsharingchanges`); a folder, or the library itself, so marked has
  everything under it listed again (as a renamed folder has), so the runner asks for each
  item's permissions again. While permissions are imported a round may mention only what the
  budget lets one run ask (400 items at the default, see "Pacing"), whatever the reason: each is a request
  more, all before the round's checkpoint. More is `resync`, and a crawl asks them a page at
  a time, with checkpoints. What a delta doesn't report
  waits for the next crawl (`recrawlAfterDays`).
- **Refused** (403 or another refusal of one item's permissions, or a list that doesn't end)
  is `permanent`: the item is passed over, the
  runner withdraws what the source had granted on it, and the site goes on. A site where every
  file is skipped that way is an app that can't read permissions.

Tested in `src/permissions.test.ts` (Graph's documented shapes), `src/connector.test.ts`
(against the fake), and `src/e2e.test.ts`: with the fake tenant's directory provisioned, **who
can read each file through OpenHoard's grants is exactly who the fake SharePoint lets read
it**, before and after permissions change there. The fake has users, groups, guests and
anyone-links; SharePoint groups, organization links and links for named people are covered by
the mapping's own tests only.

**Not yet tried on a real tenant.** What to look at there first:

- Permissions: whether listing an item's permissions works under `Sites.Selected` with the
  read role; what a team site's item permissions really hold (SharePoint groups, the Microsoft
  365 group's claim and its owners') and how to say who is in them; whether the delta honours
  `deltashowsharingchanges` with this app's permissions (Microsoft's scan guidance asks for
  more), and whether it then also lists what inherits from a changed folder.
- Following changes: whether Graph reports each item of a deleted folder, and of a folder
  moved to another library (the connector takes it that it does); whether a folder's children
  listing gives the same hashes as the feed (if not, everything under a renamed folder is
  downloaded again); whether a crawl's enumeration lists deleted items at all.
- Crawling: whether `Sites.Selected` is enough for `delta` (Graph's page names
  `Files.Read.All`); whether a file's `size` always equals the bytes downloaded (SharePoint is
  known to differ for some Office files, and the runner would then skip the file as
  `changed`); which hosts download links point at, and whether they redirect
  (`downloadHosts`); what Graph answers for a next-page link that has lapsed; how many items a
  page really holds, and how often Graph throttles.

## Pacing (T-306)

Graph limits an app in a tenant by resource units a minute and a day (a permissions list costs
five, a list of children or a delta from its beginning two, an item or a delta with its token
one), answers 429 past the limit, and throttles longer an app that keeps asking. The costs, the
limits and the `RateLimit` headers below are Microsoft's as documented when this was written,
not measured: its page on avoiding throttling in SharePoint Online has the current ones. So the
connector (`src/pace.ts`, `src/graph.ts`):

- **Keeps a budget.** `unitsPerMinute` (default 800, under the smallest tenant's limits a
  minute and a day) is spent before a request is sent: a request waits its turn rather than
  being sent to be refused. A sixth of a minute's budget may go at once. The budget is **one
  for an app in a tenant, in a process**: every source signed in as the same app shares it
  (they are throttled together), and the first to start sets it. Several nodes each have their
  own: divide the budget by their number, or run the sources on one. Spell the tenant the same
  way in each source (its id, or its domain): the two are not known to be one.
- **Waits when told.** A throttled answer stops the sending of that app's requests from this
  process for as long as Graph said (30 s when it didn't; an hour at most, whatever it said),
  and the request is asked again in place. A request waits no more than about `maxWaitMs` in
  all (default 60 s) for its turn, its own throttles and those others met meanwhile, and is
  asked again at most eight times: past that it is `throttled`, with how long is left, and the
  runner comes back after that from the last checkpoint. (Waits of up to a second for the
  budget to fill are always taken.) A throttled download tells the pacer too.
- **Adapts.** Each pause halves the rate it allows itself, down to a tenth of the budget; every
  fifty answers without one, and every minute without one, give a tenth back. Graph's own
  warning that most of the limit is used (`RateLimit-Remaining` under a fifth) halves what is
  left again until the reset it names (five minutes at most; a minute when it names none).
- **Tries again** twice, one and two seconds later, when Graph gives no answer or a 5xx without
  a wait, before reporting `retryable`.
- **Sizes its work to one run.** Everything between two checkpoints is asked in one run, so it
  is sized to take about four minutes of budget at some eight units a file. A crawl's page
  (`pageSize`) is sized for a pacer slowed to a tenth: 40 files at the default budget, 12 at the
  least the server takes (250), 50 at most. A delta round with permissions imported may mention
  what the full budget allows (400 items at the default, 500 at most): more is a crawl's work
  (`resync`). A round that fits the budget but not the rate the pacer allows itself just now
  waits (`throttled`, five minutes) for the rate to come back, rather than crawl the site at
  the moment Graph asked for less. Lists of a folder's children are asked 200 at a time: a
  list costs the same whatever its size.

What this is not: the budget, not concurrency, bounds a sync (a sync asks one request at a
time, and a file read for someone meanwhile takes its turn in the same budget; the task's
"adaptive concurrency" is an adaptive rate). File downloads go to SharePoint's
own hosts and are not counted in the budget. A first crawl costs some eight units a file (its
permissions, and three requests to read it): 20,000 files at 800 a minute are over three hours
of budget, and a later crawl (permissions only) about two. A larger tenant's limit is worth
setting.

Tested in `src/pace.test.ts` (the budget, on a clock the test moves), `src/graph.test.ts`
(waiting in place and its limits, two sources on one pacer, Graph's warning), and
`src/e2e.test.ts` against a fake Graph that throttles: **a site is indexed whole in one run,
with nothing lost, through a fake Graph that allows ten requests a minute; and a connector kept
to a budget under the fake's limit is never throttled by it.** (The fake counts requests in a
fixed window: it has no daily or tenant-wide limit.)

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
