# core/storage

Part of the OpenHoard trusted core. See [../README.md](../README.md),
[ADR-0006](../../docs/adr/0006-storage-abstraction.md) and
[ADR-0013](../../docs/adr/0013-content-hash.md).

Content-addressed blob storage on local disk, S3 or Azure Blob, through
[Apache OpenDAL](https://opendal.apache.org/) (native binaries for Windows, macOS and Linux).

```ts
import { BlobStore } from "@openhoard/core-storage";

const blobs = BlobStore.open({ kind: "fs", root: ".openhoard/blobs" });
const { blobId, created } = await blobs.put({ id: tenantId, key: tenantBlobKey }, fileStream);
const stream = await blobs.open(tenantId, blobId, { offset: 0, length: 1024 });
```

## Ids and layout

- A blob's id is `b3t:<hex>`: a BLAKE3 hash of the content's BLAKE3 hash, keyed with the
  tenant's 32-byte secret (`scopedBlobId`, [hash.ts](src/hash.ts)).
  - Identical bytes in one tenant are stored once; `put()` reports `created: false`.
  - Identical bytes in two tenants get unrelated ids. Neither storage paths nor
    de-duplication reveal that another tenant holds the same file.
  - The raw content hash is never stored or used as a path.
- Paths are `<tenant>/<hex[0:2]>/<hex[2:4]>/<hex>`. Every path is built from a validated
  tenant id and a validated blob id, so a malformed id cannot reach outside its tenant.
- Every upload, streamed or not, is written to `<tenant>/.incoming/<uuid>` while it is
  hashed, and moves to its final path only when it is complete. So a blob id never names
  partial bytes.
  - The move is a rename where the service has one, which is atomic.
  - Otherwise it is a copy, checked before the upload is deleted.
  - Otherwise it is a streamed copy, which removes what it wrote if it fails.
- A failed upload removes its incoming file. `sweepIncoming()` clears what a crashed
  process left behind, as far as the service lists it:
  - On S3, a large upload is a multipart upload, and one a crash interrupts is not an object:
    listing doesn't show it, so `sweepIncoming()` can't remove it, and its parts are billed
    until aborted. Give the bucket a lifecycle rule with `AbortIncompleteMultipartUpload`
    (for example after 1 day).
  - On Azure Blob, uncommitted blocks aren't listed either; Azure discards them after 7 days.
- On local disk, writes aren't fsynced before the rename. After a power loss a blob can be
  torn (its final path holding short or zeroed bytes); `verify()` detects that, since the
  bytes no longer match the id.
- An existing blob of the wrong size is replaced rather than trusted.

## Reading

- `open()` streams a blob or a byte range; ranges are read in 4 MiB requests.
- `read()` loads a small blob or range into memory.
- `verify()` re-hashes a blob and reports whether it still matches its id.

## Enrichment

`blobContentSource(store, { tenantKey })` is how enrichment reads the bytes OpenHoard holds
(`ContentSource`, T-402): only a managed zone's version, whose blob has a
location, streams from the store by its content-addressed id; anything else (an indexed or
local-only zone) is null. The stream is checked as it is read: its size against the
version's, and, given the tenant's blob key, its BLAKE3 hash against the blob id
(ContentMismatchError at the end otherwise); OpenHoard keeps no tenant keys yet, so today it is
the size. When the signal it is given aborts, the store's stream is destroyed. A blob the
catalog says is stored but the store doesn't have throws, so the job retries and then
dead-letters for an operator instead of treating the content as absent.

## A tenant's own bucket

[`tenant-storage.ts`](src/tenant-storage.ts): where each tenant's blobs live, chosen by its admin
(the admin app's Storage page, over the server's admin API); the server's disk (`local`) until
then. One row a tenant in `tenant_storage` (forced RLS).

- **Choosing.** [`settings.ts`](src/settings.ts) `checkChoice()` takes `local`, `s3` (bucket,
  region, access key ID and secret, a folder) or `azblob` (account, container, key, a folder),
  with the clouds' own naming rules. An `endpoint` (an S3-compatible service, Azurite) is refused
  unless the server allows it: it is a host the server connects to. `probeStorage()` looks
  for a file that isn't there (a 403 means the key can't list: `cant-list`, which would hide a
  missing file as refused), then writes, reads back and removes `<tenant>/.probe/<uuid>`, and
  says how each step went, in an admin's terms (`not-found`, `denied`, `cant-list`,
  `wrong-region`, `unreachable`, `busy`, `timeout`…) with the
  service's error code; `changeTenantStorage()` keeps the choice.
- **Keys.** [`secrets.ts`](src/secrets.ts) seals a bucket's key (AES-256-GCM) with the server's
  storage key, the tenant and kind as associated data. A tenant's store is opened with its key
  only: S3's environment and EC2 metadata credentials are turned off for it
  (`ambientCredentials: false`).
- **Reading and writing.** `TenantBlobStores` routes each tenant's `put()` to its place, and
  `open()` there, then to the old place while its copies are kept; it reads a tenant's choice
  again after `ttlMs` (10 s). Uploads, mail-in and enrichment take it as a `BlobStorage`.
- **Moving.** A change of place records the old one (`previous`) and `phase: moving`;
  `moveTenantBlobs()` (a core/jobs `storage` job) copies every blob OpenHoard holds, each
  checked against its id with the tenant's key, skipping those already there, recording
  progress (`failed`, and `lost` for a blob in neither place, which doesn't block removal);
  then `active`, the old copies kept. `cleanTenantBlobs()` removes them, checking or copying
  over first each blob in the new place, then once more for blobs put since it began. Both
  first check, with a marker file, that the two places aren't one (`BlobStore.sameStorageAs()`):
  if they are, nothing is copied or removed. A job for an older `version` stops. One move at a
  time: `StorageBusyError` until the old copies are gone.
- **Tests.** Against a fake S3 (`@openhoard/core-storage/testing` `startFakeS3()`, S3's own protocol in
  memory) and memory stores; checked by hand against s3rver and Azurite.

## Limits

- S3's CopyObject handles up to 5 GiB, so on S3 a single upload larger than that fails at
  the move. Large-file exchange (M3) needs a multipart path.
- Deleting a blob is the catalog's job: it must delete only blobs no version references,
  under the same lock as new references. A `put()` that races a `delete()` of the same
  bytes can report `created: false` for a blob that is then removed.

## Tests

The suite runs on local disk and in memory on every PR. The memory service has neither
rename nor copy, which covers the streaming fallback. To run the same suite on real
services, set:

- S3: `OPENHOARD_TEST_S3_BUCKET` and optionally `OPENHOARD_TEST_S3_REGION`. Credentials
  come from the usual AWS environment variables.
- Azure Blob: `OPENHOARD_TEST_AZBLOB_CONTAINER`, `OPENHOARD_TEST_AZBLOB_ACCOUNT` and
  `OPENHOARD_TEST_AZBLOB_KEY`.
