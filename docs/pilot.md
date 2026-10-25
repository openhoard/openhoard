# Running the M1 pilot: one SharePoint site, three people, Claude

This is the whole path from nothing to the M1 exit (T-1105): one real SharePoint site indexed
in place, and three named people finding its files through Claude. It ties together steps that
are documented in more detail elsewhere; each step links there.

Plan on an hour, most of it in the Entra admin center. You need:

- a Microsoft 365 tenant where you are a Global Administrator, or can get one to grant consent;
- one SharePoint site whose files the three people already use;
- a machine that stays on (Windows 11, macOS or Linux) with Node 24 and a clone of this
  repository, built (`pnpm install && pnpm build`);
- an https address that reaches that machine: a named Cloudflare tunnel on a domain you own, or
  a reverse proxy with a certificate. Entra's provisioning and Graph's notifications call it
  from Microsoft's cloud, so it must be public and fixed. A quick tunnel's address changes on
  every run and won't do.

Below, `oh` is `node <clone>/apps/cli/dist/bin.js --data-dir <data dir>` (docs/dogfood.md shows
how to make it an alias), `files.contoso.com` is the public address and
`contoso.sharepoint.com:/sites/finance` is the site.

## 1. Two apps in Entra

Both are made in [entra.microsoft.com](https://entra.microsoft.com). Note each one's
**Application (client) ID** and the **Directory (tenant) ID**, which both share.

**OpenHoard sign-in**, for people signing in and for SCIM provisioning. Make it as an enterprise
app, which provisioning needs:

1. **Entra ID** › **Enterprise apps** › **New application** › **Create your own application**.
2. Name it, choose _Integrate any other application you don't find in the gallery
   (Non-gallery)_, and create it.
3. Under **App registrations**, open the app of the same name:
   - add a Web redirect URI, `https://files.contoso.com/auth/callback/entra`;
   - under **Certificates & secrets**, create a client secret and copy its value.

**OpenHoard reader**, for reading the site. Make it under **App registrations** › **New
registration**, single tenant, with no redirect URI. Then:

- under **API permissions**, add the application permission `Sites.Selected` under Microsoft
  Graph **and** under SharePoint, then **Grant admin consent**;
- under **Certificates & secrets**, upload a certificate and keep its private key. A certificate
  is required for SharePoint groups.

Make a certificate with OpenSSL if you have none:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 730 -subj "/CN=OpenHoard reader" \
  -keyout reader.key -out reader.pem
```

Upload `reader.pem`. Keep `reader.key` on the server machine, readable by the account that runs
OpenHoard only.

Then grant the reader app the one site. `Sites.Selected` reaches nothing until this is done.
In [Graph Explorer](https://developer.microsoft.com/graph/graph-explorer), sign in as an
admin and consent Graph Explorer to `Sites.FullControl.All` (**Modify permissions**). Granting a
site needs it; the reader app never gets it. Then:

```http
GET  https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/finance
POST https://graph.microsoft.com/v1.0/sites/{id from the GET}/permissions
{ "roles": ["read"],
  "grantedToIdentities": [{ "application": { "id": "<reader client id>", "displayName": "OpenHoard reader" } }] }
```

Check it from the server machine. This is spike S4's first step (T-1401):

```sh
export OPENHOARD_GRAPH_TENANT=<directory id> OPENHOARD_GRAPH_CLIENT_ID=<reader client id>
export OPENHOARD_GRAPH_CERTIFICATE_FILE=reader.pem OPENHOARD_GRAPH_PRIVATE_KEY_FILE=reader.key
node connectors/sharepoint/dist/check.js contoso.sharepoint.com:/sites/finance contoso.sharepoint.com:/sites/another
```

It should print the site as reached, with site groups readable, and the other site as REFUSED.
Write what it prints into `docs/spikes/s4-graph-crawl.md`. More:
[connectors/sharepoint, "Checking a tenant"](../connectors/sharepoint/README.md#checking-a-tenant).

## 2. `init --team`

```sh
oh init --team --name "Contoso" --public-url https://files.contoso.com \
  --directory <directory id> --client-id <sign-in client id> \
  --site contoso.sharepoint.com:/sites/finance --owner it@contoso.com \
  --graph-client-id <reader client id> --certificate reader.pem --private-key reader.key
```

Before it makes anything, it checks the config it would write, the certificate against its key,
and the database. The database is the embedded one unless `OPENHOARD_DATABASE_URL` names a
PostgreSQL 17+ with pgvector 0.8+. On the embedded one, admin commands run with the server
stopped. For three people that is fine.

It prints the tenant id and a SCIM token (once), and writes `config.json` with:

- sign-in through Entra;
- the site, crawled every 15 minutes, its permissions imported, its files' text extracted for
  search, and `it@contoso.com` as their owner. The owner reads every file of the site here.

No model is set up, so there are no summaries yet, and search works on words. To add them, see
apps/server, ["Models"](../apps/server/README.md#models-t-404-t-405).

## 3. Provisioning: who the pilot's people are

In Entra, **Enterprise apps** › the sign-in app › **Provisioning**:

- Mode Automatic. Tenant URL `https://files.contoso.com/scim/v2`. Secret Token: the token from
  step 2.
- Mappings: change `externalId` to `objectId`. This is how a person's first sign-in finds their
  account, and how SharePoint's permissions find them.
- Scope: assigned users and groups only. Assign:
  - the three people;
  - you, the first admin;
  - the `--owner` account (`it@contoso.com`). The site doesn't sync until its owner is here;
  - the Entra or Microsoft 365 groups the site shares with.

The server has to be running for **Test Connection** (step 4). Every step, with the attribute
mappings: apps/server, ["Testing with a new Entra
tenant"](../apps/server/README.md#testing-with-a-new-entra-tenant-t-102-and-t-103-together).

## 4. Start it

Set the sign-in app's secret where the server runs. It never goes in config.json:

```sh
export OPENHOARD_AUTH_ENTRA_CLIENT_SECRET=<sign-in app secret>
oh serve
```

Point the public address at it. With a named Cloudflare tunnel, in a second window:

```sh
cloudflared tunnel run --url http://127.0.0.1:7420 <tunnel name>
```

Then:

- `https://files.contoso.com/healthz` answers;
- Test Connection succeeds in Entra; start provisioning, or **Provision on demand** each person.
  The first crawl starts once the owner is provisioned.

To keep it running after a restart, run both as a service (Windows: Task Scheduler, at startup;
Linux: a systemd unit; macOS: a launchd agent). T-1102 will make that one command.

## 5. The first admin, and the starter pack

Once Entra has provisioned you, stop the server on the embedded database, then:

```sh
oh admin source status --tenant <ten_…> --source sp-finance
oh admin user grant-admin --tenant <ten_…> --user <your UPN>
oh admin pack plan --tenant <ten_…> --file <clone>/packs/general-business/pack.json
oh admin pack apply --tenant <ten_…> --file <clone>/packs/general-business/pack.json --plan-hash <hash it printed>
```

The first says how the crawl went.

The plan lists every change. A `!` marks a loosening: the pack makes files discoverable and lets
their content reach commercial AI such as Claude. Read it before applying. Without the pack,
Claude sees names and metadata only.

Then start the server again and sign in at `https://files.contoso.com/admin/`.

## 6. Claude, for each of the three

In claude.ai, **Settings** › **Connectors** › **Add custom connector**: the address
`https://files.contoso.com/mcp`.

- The first time, you approve Claude as the admin, with the trust label `commercial`, on the page
  that opens.
- Each person then signs in with their Microsoft account and consents.
- They see only files SharePoint lets them see.
- The admin app's audit page (`/admin/audit`) shows every read, while the server runs.

The same connector works in Claude Desktop and on the phone.

## 7. What the exit needs

- The site stays indexed: crawl, changes followed every 15 minutes, permissions imported (T-305).
- The three find files through Claude weekly for two weeks without being prompted. The audit log
  is the record.
- PRD scenarios 1, 2, 4 and 7 run on this site.

Write down what differs from this page as you go. Every difference is a bug in this page or in
OpenHoard.
